"""Read-only structural inspection for an existing SQLite file. Standard library only.

Point at a database by reference; the file is never copied, imported,
converted, or modified. Two reads:

- GET /sqlite/schema — tables, views, columns, declared keys, foreign keys.
- GET /sqlite/rows — a server-side window of one table or view.

A recorded SQL row is not an adopted conceptual assertion. Tables without
a verified key stay table-only: rows are shown without invented identities.

The reported SHA-256 is taken once at startup. It names the bytes the
adapter opened with; it is not re-checked on later reads and verifies
nothing about a live file that keeps changing. Neither the filesystem
path nor the startup hash is a durable conceptual identity.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


class BadRequest(Exception):
    """400: the request names something this backend has no record of."""


class NotFound(Exception):
    """404: no such read on this plane."""


LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


def _host_of(authority: str) -> str:
    """The bare host inside a Host header or URL authority, lowercased."""
    host = authority.strip().lower()
    if host.startswith("["):
        host = host[1:].split("]", 1)[0]
    else:
        host = host.split(":", 1)[0]
    return host.rstrip(".")


def request_allowed(headers) -> bool:
    """True only for callers that arrived as loopback.

    Binding to 127.0.0.1 is not enough on its own: a browser that resolves
    an attacker's hostname to 127.0.0.1 (DNS rebinding) still reaches this
    socket, so the Host it asked for is checked too. An Origin header, when
    present, must likewise be loopback. Plain non-browser callers send no
    Origin and pass on Host alone; the local Vite proxy forwards the page's
    loopback Origin with a rewritten loopback Host, so it passes as well.
    """
    if _host_of(headers.get("Host", "")) not in LOOPBACK_HOSTS:
        return False
    origin = headers.get("Origin", "")
    if not origin:
        return True
    parsed = urlparse(origin)
    if parsed.scheme not in ("http", "https"):
        return False
    return _host_of(parsed.netloc.rsplit("@", 1)[-1]) in LOOPBACK_HOSTS


def quote(name: str) -> str:
    """Quote one SQLite identifier. Callers validate against sqlite_master first."""
    return '"' + name.replace('"', '""') + '"'


def json_value(value: object) -> object:
    if isinstance(value, bytes):
        digest = hashlib.sha256(value).hexdigest()[:14]
        return f"[BLOB {len(value)} bytes; sha256={digest}]"
    return value


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def connect(db_path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    return db


def user_objects(db: sqlite3.Connection) -> tuple[set[str], set[str]]:
    tables = {
        row["name"]
        for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
    }
    views = {
        row["name"]
        for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='view' AND name NOT LIKE 'sqlite_%'"
        )
    }
    return tables, views


# SQLite's table_xinfo `hidden` values: 0 ordinary, 1 hidden
# virtual-table implementation detail, 2/3 generated VIRTUAL/STORED.
_GENERATED = {2: "VIRTUAL", 3: "STORED"}


def xinfo_rows(db: sqlite3.Connection, name: str) -> list[sqlite3.Row]:
    """Visible columns only: ordinary and generated columns are
    structural facts; hidden implementation columns are not row data."""
    return [
        row
        for row in db.execute(f"PRAGMA table_xinfo({quote(name)})")
        if row["hidden"] != 1
    ]


def table_info(db: sqlite3.Connection, name: str) -> tuple[list[dict], list[str], list[list[dict]]]:
    columns = [
        {
            "name": row["name"],
            "type": row["type"] or "",
            "notnull": row["notnull"],
            "pk": row["pk"],
            "generated": _GENERATED.get(row["hidden"]),
        }
        for row in xinfo_rows(db, name)
    ]
    pk = [column["name"] for column in sorted(columns, key=lambda c: c["pk"]) if column["pk"]]
    # Implicit FK targets (recorded `to` is null) resolve to the parent
    # primary-key columns in seq order, where that mapping is known:
    # the parent exists and its PK has exactly the group's arity.
    parent_pk: dict[str, list[str]] = {}
    grouped: dict[int, list[dict]] = defaultdict(list)
    for row in db.execute(f"PRAGMA foreign_key_list({quote(name)})"):
        parent_pk.setdefault(row["table"], [])
        grouped[row["id"]].append(
            {"id": row["id"], "seq": row["seq"], "table": row["table"], "from": row["from"], "to": row["to"]}
        )
    fks = []
    for _, group in sorted(grouped.items()):
        ordered = sorted(group, key=lambda item: item["seq"])
        parent = ordered[0]["table"]
        if parent not in {known for known in parent_pk if parent_pk[known]}:
            try:
                parent_pk[parent] = [
                    row["name"]
                    for row in sorted(
                        (r for r in xinfo_rows(db, parent) if r["pk"]),
                        key=lambda r: r["pk"],
                    )
                ]
            except sqlite3.Error:
                parent_pk[parent] = []
        pk_columns = parent_pk[parent]
        resolvable = len(pk_columns) == len(ordered)
        for item in ordered:
            item["resolved_to"] = (
                pk_columns[item["seq"]]
                if item["to"] is None and resolvable
                else None
            )
        fks.append(ordered)
    return columns, pk, fks


def pk_is_addressable(db: sqlite3.Connection, name: str, pk: list[str]) -> bool:
    """A key is navigable only when it is declared, complete, and unique.

    Ordinary rowid tables may hold NULLs in a composite PRIMARY KEY, and a
    declared key may contain duplicates in practice. Neither case yields a
    durable per-row identity, so both stay table-only.
    """
    if not pk:
        return False
    nulls = " OR ".join(f"{quote(column)} IS NULL" for column in pk)
    if db.execute(f"SELECT 1 FROM {quote(name)} WHERE {nulls} LIMIT 1").fetchone():
        return False
    fields = ", ".join(quote(column) for column in pk)
    total = db.execute(f"SELECT COUNT(*) FROM {quote(name)}").fetchone()[0]
    unique = db.execute(
        f"SELECT COUNT(*) FROM (SELECT {fields} FROM {quote(name)} GROUP BY {fields})"
    ).fetchone()[0]
    return total == unique


def view_columns(db: sqlite3.Connection, name: str) -> list[str]:
    return [row["name"] for row in xinfo_rows(db, name)]


def schema(db: sqlite3.Connection, db_path: Path, fingerprint: str) -> dict:
    tables, views = user_objects(db)
    found = []
    for name in sorted(tables):
        columns, pk, fks = table_info(db, name)
        count = db.execute(f"SELECT COUNT(*) FROM {quote(name)}").fetchone()[0]
        found.append({"name": name, "columns": columns, "pk": pk, "fks": fks, "rows": count})
    return {
        "file": db_path.name,
        "file_sha256": fingerprint,
        "tables": found,
        "views": sorted(views),
    }


def rows(db: sqlite3.Connection, query: dict[str, list[str]]) -> dict:
    name = query.get("table", [""])[0]
    if not name:
        raise BadRequest("table is required")
    tables, views = user_objects(db)
    if name not in tables and name not in views:
        raise NotFound(f"no table or view {name!r} in this database")
    try:
        limit = int(query.get("limit", ["50"])[0] or 50)
        offset = int(query.get("offset", ["0"])[0] or 0)
    except ValueError:
        raise BadRequest("limit and offset must be integers")
    limit = max(1, min(limit, 500))
    offset = max(0, offset)
    columns = view_columns(db, name)
    total = db.execute(f"SELECT COUNT(*) FROM {quote(name)}").fetchone()[0]
    navigable = False
    ordering = "none; rows are not durable identities"
    order_clause = ""
    if name in tables:
        _, pk, _ = table_info(db, name)
        if pk_is_addressable(db, name, pk):
            navigable = True
            ordering = "declared key"
            order_clause = " ORDER BY " + ", ".join(quote(column) for column in pk)
    fetched = db.execute(
        f"SELECT * FROM {quote(name)}{order_clause} LIMIT ? OFFSET ?", (limit, offset)
    ).fetchall()
    return {
        "name": name,
        "columns": columns,
        "rows": [{key: json_value(row[key]) for key in columns} for row in fetched],
        "total": total,
        "offset": offset,
        "navigable": navigable,
        "ordering_guarantee": ordering,
    }


def route(path: str, query: dict[str, list[str]], db: sqlite3.Connection) -> tuple[int, object]:
    db_path: Path = Handler.db_path
    fingerprint: str = Handler.fingerprint
    if path == "/health":
        return 200, {"ok": True, "file": db_path.name, "file_sha256": fingerprint}
    if path == "/sqlite/schema":
        return 200, schema(db, db_path, fingerprint)
    if path == "/sqlite/rows":
        return 200, rows(db, query)
    raise NotFound(f"no read {path!r} on this plane")


class Handler(BaseHTTPRequestHandler):
    server_version = "SQLiteInspector/1.0"
    db_path: Path = Path("missing.sqlite")
    fingerprint: str = ""

    def log_message(self, *args: object) -> None:
        pass

    def _send(self, status: int, payload: object) -> None:
        # No CORS headers, deliberately: without them a foreign browser origin
        # cannot read these responses, so the user's database stays unreachable
        # from untrusted pages. The local UI reads same-origin via Vite.
        body = json.dumps(payload, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if not request_allowed(self.headers):
            self._send(403, {"error": "refused: this adapter serves loopback callers only"})
            return
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        # A sqlite3 connection's context manager commits but does not close,
        # so the close is explicit: every request opens and closes its own.
        db = connect(self.db_path)
        try:
            try:
                status, payload = route(parsed.path, query, db)
            except BadRequest as failure:
                status, payload = 400, {"error": str(failure)}
            except NotFound as failure:
                status, payload = 404, {"error": str(failure)}
        finally:
            db.close()
        self._send(status, payload)

    def _reject_write(self) -> None:
        self._send(405, {"error": "this plane is read-only"})

    do_POST = _reject_write
    do_PUT = _reject_write
    do_PATCH = _reject_write
    do_DELETE = _reject_write


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True, help="Existing .sqlite/.db file, opened read-only")
    parser.add_argument("--port", type=int, default=8139)
    args = parser.parse_args()
    if not args.db.is_file():
        raise SystemExit(f"no database file: {args.db}")
    Handler.db_path = args.db
    # Once, at startup: names the opening bytes, not a per-read check.
    Handler.fingerprint = file_sha256(args.db)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"sqlite inspector: http://127.0.0.1:{args.port}/ ({args.db})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

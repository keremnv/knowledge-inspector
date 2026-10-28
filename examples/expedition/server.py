"""Expedition example: the generic World adapter plus herbarium-specific reading.

Stdlib only. All World reads come from the generic adapter
(adapters/world/server.py); this module adds ONLY what is specific to the
expedition example:

- an embedded declaration loader: the expedition fixture predates the
  external declaration file, so its ki_entity / ki_relation / ki_role
  tables are read from the example database and converted to the external
  declaration shape before the generic checks run;
- a per-model coverage rule: every determination record must be asserted
  or obligated, never silent;
- the herbarium demand frontier over v_determination_unmatched;
- the expedition world identity ("expedition:<hash>").

Anything else in this file is a re-export of the generic adapter, kept so
existing expedition readers and tests keep working unchanged.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from http.server import ThreadingHTTPServer
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from adapters.world import server as _generic  # noqa: E402

# Re-exported generic surface: errors, guards, reads, and helpers.
BadRequest = _generic.BadRequest
NotFound = _generic.NotFound
LOOPBACK_HOSTS = _generic.LOOPBACK_HOSTS
FIELDS_PER_RELATION = _generic.FIELDS_PER_RELATION
UNSTATED_ORIGIN = _generic.UNSTATED_ORIGIN
request_allowed = _generic.request_allowed
quote_ident = _generic.quote_ident
json_value = _generic.json_value
file_sha256 = _generic.file_sha256
connect = _generic.connect
split_columns = _generic.split_columns
encode_id = _generic.encode_id
decode_id = _generic.decode_id
fetch_row = _generic.fetch_row
role_out = _generic.role_out
values_out = _generic.values_out
tuple_out = _generic.tuple_out
view_sql = _generic.view_sql
grounding_out = _generic.grounding_out
mentions = _generic.mentions
extension = _generic.extension
sort_key = _generic.sort_key
relation_out = _generic.relation_out
schema = _generic.schema
referents = _generic.referents
labels = _generic.labels
search = _generic.search
referent = _generic.referent
expand = _generic.expand
rows = _generic.rows
assertion = _generic.assertion
derivation = _generic.derivation
support = _generic.support


def read_embedded_declaration(db: sqlite3.Connection) -> dict:
    """Convert the expedition's embedded ki_* tables to declaration shape.

    Explicitly example-specific: the generic adapter never reads a
    declaration from the producer file. This exists only so the historic
    expedition fixture keeps serving unchanged.
    """
    tables = {
        row["name"]
        for row in db.execute("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
    }
    for needed in ("ki_entity", "ki_relation", "ki_role"):
        if needed not in tables:
            raise ValueError(f"no conceptual declaration: {needed} is missing")
    entities = []
    for row in db.execute("SELECT * FROM ki_entity ORDER BY kind"):
        entities.append({
            "kind": row["kind"],
            "source": row["source"],
            "key_columns": split_columns(row["key_columns"]),
            "label_column": row["label_column"],
        })
    relations = []
    for row in db.execute("SELECT * FROM ki_relation ORDER BY name"):
        # Rowid order, not key order: the declaration lists roles in the
        # presentation order, and the primary-key index would alphabetize.
        roles = [
            dict(item)
            for item in db.execute(
                "SELECT role, column_name, target_kind FROM ki_role"
                " WHERE relation = ? ORDER BY rowid",
                (row["name"],),
            )
        ]
        relations.append({
            "name": row["name"],
            "source": row["source"],
            "key_columns": split_columns(row["key_columns"]),
            "origin": row["origin"],
            "occurrence_state": row["occurrence_state"],
            "description": row["description"],
            "roles": roles,
        })
    if not relations:
        raise ValueError("no conceptual declaration: ki_relation is empty")
    return {"entities": entities, "relations": relations}


class Model(_generic.Model):
    """The expedition interpretation: generic checks plus coverage."""

    def __init__(self, db: sqlite3.Connection, declaration: dict | None = None) -> None:
        super().__init__(db, read_embedded_declaration(db) if declaration is None else declaration)
        self._check_determination_coverage(db)

    def _check_determination_coverage(self, db: sqlite3.Connection) -> None:
        """Every determination record is asserted or obligated — never silent.

        Expedition-specific, deliberately: interpretation completeness is a
        per-model rule, and this example keeps it as explicit code rather
        than inventing another declaration table for it.
        """
        served = set()
        for view in (
            "v_determination_adopted",
            "v_determination_proposed",
            "v_determination_rejected",
        ):
            served.update(
                row["det_id"] for row in db.execute(f"SELECT det_id FROM {quote_ident(view)}")
            )
        obligated = {
            row["det_id"] for row in db.execute("SELECT det_id FROM v_determination_unmatched")
        }
        missing = {
            row["det_id"] for row in db.execute("SELECT det_id FROM determination")
        } - served - obligated
        if missing:
            raise ValueError(
                "determination records neither asserted nor obligated:"
                f" {sorted(missing)}"
            )


DEMAND_PURPOSE = (
    "Interpret the expedition's determination records as adopted, proposed, "
    "and rejected taxon claims. Every determination row must appear as an "
    "assertion or as an unresolved obligation below — silence about a "
    "record is a defect."
)


def demand_out(db: sqlite3.Connection) -> dict:
    obligations = []
    for row in db.execute("SELECT * FROM v_determination_unmatched ORDER BY det_id"):
        obligations.append({
            "relation": "determination_proposed",
            "values": {
                "specimen": encode_id("specimen", [row["catalog_no"]]),
                "asserted_name": row["asserted_name"],
            },
            "demanded_by": {"name": "expedition-interpretation", "revision": 1},
            "state": "UNRESOLVED",
            "assertion_id": None,
            # Rejections are served by their own relation, so obligations
            # here mean exactly one thing: the name resolved nowhere.
            "reason": (
                f"determination {row['det_id']} (stance '{row['stance']}'):"
                f" asserted name {row['asserted_name']!r} matches no known taxon alias"
            ),
        })
    return {
        "purpose": {"statement": DEMAND_PURPOSE},
        "rule": "adopted, proposed, and rejected stances with resolvable names"
        " become assertions; determinations whose names resolve nowhere are obligations",
        "demanded": len(obligations),
        "obligations": obligations,
        "requirements": [
            {
                "name": "adopted determinations asserted",
                "kind": "assertion",
                "relation": "determination",
                "note": "resolvable adopted stances appear as determination tuples",
                "failures": 0,
            },
            {
                "name": "every determination record interpreted",
                "kind": "coverage",
                "relation": None,
                "note": "asserted or obligated, never silent",
                "failures": len(obligations),
            },
        ],
    }


def overview(db: sqlite3.Connection, model: Model, world_id: str) -> dict:
    found = _generic.overview(db, model, world_id)
    demand = demand_out(db)
    found["demand"] = {
        "purpose": demand["purpose"],
        "obligations": len(demand["obligations"]),
        "demanded": demand["demanded"],
    }
    return found


def route(
    path: str, query: dict[str, list[str]], db: sqlite3.Connection, model: Model, world_id: str
) -> tuple[int, object]:
    # The generic route would answer these without the expedition demand,
    # so the extension serves them itself and delegates everything else.
    if path == "/world/overview":
        return 200, overview(db, model, world_id)
    if path == "/world/demand":
        return 200, {"demand": demand_out(db)}
    return _generic.route(path, query, db, model, world_id)


class Handler(_generic.Handler):
    server_version = "ExpeditionWorld/1.0"
    route_fn = staticmethod(route)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True, help="expedition database file, opened read-only")
    parser.add_argument("--port", type=int, default=8139)
    args = parser.parse_args()
    if not args.db.is_file():
        raise SystemExit(f"no database file: {args.db}")
    db = connect(args.db)
    try:
        model = Model(db)
    except ValueError as failure:
        raise SystemExit(f"cannot serve {args.db}: {failure}")
    finally:
        db.close()
    Handler.db_path = args.db
    Handler.fingerprint = file_sha256(args.db)
    Handler.model = model
    Handler.world_id = f"expedition:{Handler.fingerprint[:12]}"
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"expedition world: http://127.0.0.1:{args.port}/ ({args.db})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

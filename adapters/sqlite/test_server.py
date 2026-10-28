"""Backend tests over real SQLite files. No mocks, no invented identities."""

from __future__ import annotations

import hashlib
import http.client
import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from contextlib import closing
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fixture import build  # noqa: E402
from server import Handler, connect, file_sha256  # noqa: E402


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class TestStructuralPlane(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "producer.sqlite"
        build(self.path)
        self.before = sha256(self.path)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_schema_discovers_tables_views_columns_keys_and_composite_fks(self) -> None:
        with closing(connect(self.path)) as db:
            from server import schema

            found = schema(db, self.path, file_sha256(self.path))
        self.assertEqual(found["file"], "producer.sqlite")
        self.assertEqual(found["file_sha256"], self.before)
        by_name = {table["name"]: table for table in found["tables"]}
        self.assertEqual(sorted(by_name), ["events", "links", "loose", "targets"])
        self.assertEqual(found["views"], ["v_link_detail"])
        targets = by_name["targets"]
        self.assertEqual(targets["pk"], ["scope", "code"])
        self.assertEqual(targets["rows"], 2)
        self.assertEqual([c["name"] for c in targets["columns"]], ["scope", "code", "label"])
        links = by_name["links"]
        self.assertEqual(links["pk"], ["id"])
        self.assertEqual(len(links["fks"]), 1)
        group = links["fks"][0]
        self.assertEqual([item["from"] for item in group], ["target_scope", "target_code"])
        self.assertEqual([item["to"] for item in group], ["scope", "code"])
        self.assertEqual({item["table"] for item in group}, {"targets"})
        self.assertEqual(by_name["events"]["pk"], [])
        self.assertEqual(by_name["loose"]["pk"], ["scope", "code"])

    def test_keyless_duplicates_have_no_identity(self) -> None:
        with closing(connect(self.path)) as db:
            from server import rows

            found = rows(db, {"table": ["events"]})
        self.assertEqual(found["total"], 2)
        self.assertEqual(found["rows"], [{"payload": "repeat"}, {"payload": "repeat"}])
        self.assertFalse(found["navigable"])
        self.assertIn("not durable", found["ordering_guarantee"])

    def test_nullable_composite_key_stays_table_only(self) -> None:
        with closing(connect(self.path)) as db:
            from server import rows

            found = rows(db, {"table": ["loose"]})
        self.assertEqual(found["total"], 2)
        self.assertFalse(found["navigable"])
        self.assertIn("not durable", found["ordering_guarantee"])

    def test_pagination_orders_by_declared_key(self) -> None:
        with closing(connect(self.path)) as db:
            from server import rows

            first = rows(db, {"table": ["targets"], "limit": ["1"], "offset": ["0"]})
            second = rows(db, {"table": ["targets"], "limit": ["1"], "offset": ["1"]})
        self.assertTrue(first["navigable"])
        self.assertEqual(first["ordering_guarantee"], "declared key")
        self.assertEqual(first["rows"], [{"scope": "A", "code": "1", "label": "first"}])
        self.assertEqual(second["rows"], [{"scope": "B", "code": "1", "label": "second"}])
        self.assertEqual(second["offset"], 1)
        self.assertEqual(second["total"], 2)

    def test_views_browse_without_identity(self) -> None:
        with closing(connect(self.path)) as db:
            from server import rows

            found = rows(db, {"table": ["v_link_detail"]})
        self.assertEqual(found["columns"], ["link_id", "scope", "code", "label"])
        self.assertEqual(found["total"], 1)
        self.assertEqual(
            found["rows"], [{"link_id": "l1", "scope": "A", "code": "1", "label": "first"}]
        )
        self.assertFalse(found["navigable"])

    def test_unknown_and_system_objects_are_rejected(self) -> None:
        with closing(connect(self.path)) as db:
            from server import NotFound, rows

            for name in ("missing", 'targets"; DROP TABLE targets;--', "sqlite_master"):
                with self.subTest(name=name), self.assertRaises(NotFound):
                    rows(db, {"table": [name]})
        self.assertEqual(sha256(self.path), self.before)

    def test_read_only_connection_refuses_writes(self) -> None:
        with closing(connect(self.path)) as db, self.assertRaises(sqlite3.OperationalError):
            db.execute("DELETE FROM events")
        self.assertEqual(sha256(self.path), self.before)

    def test_http_endpoints_and_write_rejection(self) -> None:
        Handler.db_path = self.path
        Handler.fingerprint = file_sha256(self.path)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            root = f"http://127.0.0.1:{server.server_port}"
            with urlopen(root + "/sqlite/schema") as response:
                found = json.load(response)
            self.assertEqual(found["file"], "producer.sqlite")
            self.assertEqual(len(found["tables"]), 4)
            with urlopen(root + "/sqlite/rows?table=events") as response:
                window = json.load(response)
            self.assertFalse(window["navigable"])
            self.assertEqual(window["total"], 2)
            with self.assertRaises(HTTPError) as missing:
                urlopen(root + "/sqlite/rows?table=missing")
            self.assertEqual(missing.exception.code, 404)
            with self.assertRaises(HTTPError) as rejected:
                urlopen(Request(root + "/sqlite/schema", data=b"{}", method="POST"))
            self.assertEqual(rejected.exception.code, 405)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
        self.assertEqual(sha256(self.path), self.before)
        leftovers = list(Path(self.tmp.name).glob("producer.sqlite-*"))
        self.assertEqual(leftovers, [])


class TestLoopbackSecurity(unittest.TestCase):
    """Untrusted browser origins must not read the local database."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "producer.sqlite"
        build(self.path)
        Handler.db_path = self.path
        Handler.fingerprint = file_sha256(self.path)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.root = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.tmp.cleanup()

    def _raw_get(
        self, path: str, host: str | None = None, origin: str | None = None
    ) -> tuple[int, bytes, list[tuple[str, str]]]:
        port = self.server.server_port
        conn = http.client.HTTPConnection("127.0.0.1", port)
        try:
            conn.putrequest("GET", path, skip_host=True)
            conn.putheader("Host", host if host is not None else f"127.0.0.1:{port}")
            if origin is not None:
                conn.putheader("Origin", origin)
            conn.endheaders()
            response = conn.getresponse()
            return response.status, response.read(), response.getheaders()
        finally:
            conn.close()

    def test_no_cors_headers_are_sent(self) -> None:
        status, _, headers = self._raw_get("/health", origin="http://127.0.0.1:8143")
        self.assertEqual(status, 200)
        names = {name.lower() for name, _ in headers}
        self.assertNotIn("access-control-allow-origin", names)

    def test_foreign_origin_is_refused(self) -> None:
        for origin in (
            "https://evil.example",
            "http://evil.example:8080",
            "http://127.0.0.1.evil.example",
            "null",
            "file://",
        ):
            with self.subTest(origin=origin):
                status, body, _ = self._raw_get("/sqlite/schema", origin=origin)
                self.assertEqual(status, 403)
                self.assertIn("loopback", body.decode())

    def test_foreign_host_is_refused(self) -> None:
        # DNS rebinding still arrives at this socket when evil.example
        # resolves to 127.0.0.1, so the requested Host must be loopback too.
        for host in ("evil.example", "127.0.0.1.evil.example", ""):
            with self.subTest(host=host):
                status, _, _ = self._raw_get("/sqlite/schema", host=host)
                self.assertEqual(status, 403)

    def test_loopback_callers_are_served(self) -> None:
        cases = [
            # Plain non-browser caller: no Origin, loopback Host.
            ("127.0.0.1:9", None, 200),
            # Local Vite proxy shape: loopback Origin, rewritten loopback Host.
            ("127.0.0.1:9", "http://127.0.0.1:8143", 200),
            ("localhost:9", "http://localhost:5173", 200),
            ("[::1]:9", "https://[::1]:5173", 200),
        ]
        for host, origin, expected in cases:
            with self.subTest(host=host, origin=origin):
                status, _, _ = self._raw_get("/health", host=host, origin=origin)
                self.assertEqual(status, expected)

    @unittest.skipUnless(Path("/proc/self/fd").exists(), "needs a /proc fd inventory")
    def test_requests_do_not_leak_database_handles(self) -> None:
        def db_handles() -> int:
            count = 0
            for fd in Path("/proc/self/fd").iterdir():
                try:
                    if os.readlink(fd) == str(self.path):
                        count += 1
                except OSError:
                    continue
            return count

        before = db_handles()
        for _ in range(25):
            with urlopen(self.root + "/sqlite/rows?table=events"):
                pass
        for _ in range(100):
            if db_handles() <= before:
                break
            time.sleep(0.05)
        self.assertLessEqual(db_handles(), before)


STRUCTURE_DDL = """
CREATE TABLE parent2 (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE parent (a TEXT, b TEXT, code TEXT UNIQUE, PRIMARY KEY (a, b));
CREATE TABLE measure (
  id INTEGER PRIMARY KEY, qty REAL,
  doubled REAL GENERATED ALWAYS AS (qty * 2) VIRTUAL,
  label TEXT GENERATED ALWAYS AS ('item-' || id) STORED,
  big REAL GENERATED ALWAYS AS (CASE WHEN qty > 10 THEN qty END) VIRTUAL
);
INSERT INTO measure VALUES (1, 3), (2, 20);
CREATE TABLE child_single (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent2);
CREATE TABLE child_composite (x TEXT, y TEXT, FOREIGN KEY (x, y) REFERENCES parent);
CREATE TABLE child_explicit (id INTEGER PRIMARY KEY, pa TEXT, pb TEXT,
  FOREIGN KEY (pa, pb) REFERENCES parent (a, b));
CREATE TABLE child_unique (id INTEGER PRIMARY KEY, pcode TEXT REFERENCES parent (code));
CREATE TABLE child_mismatch (id INTEGER PRIMARY KEY, ref TEXT REFERENCES parent);
CREATE TABLE child_missing (id INTEGER PRIMARY KEY, ref TEXT REFERENCES missing_parent);
"""


class TestGeneratedAndImplicitTargets(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "structure.sqlite"
        with closing(sqlite3.connect(self.path)) as db:
            db.executescript(STRUCTURE_DDL)
            db.commit()
        self.before = sha256(self.path)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _schema(self):
        with closing(connect(self.path)) as db:
            from server import schema

            return schema(db, self.path, file_sha256(self.path))

    def test_generated_columns_are_structural_columns(self) -> None:
        by_name = {t["name"]: t for t in self._schema()["tables"]}
        columns = by_name["measure"]["columns"]
        self.assertEqual([c["name"] for c in columns], ["id", "qty", "doubled", "label", "big"])
        generated = {c["name"]: c["generated"] for c in columns}
        self.assertEqual(generated, {
            "id": None, "qty": None, "doubled": "VIRTUAL", "label": "STORED", "big": "VIRTUAL",
        })
        with closing(connect(self.path)) as db:
            from server import rows

            found = rows(db, {"table": ["measure"]})
        self.assertEqual(found["columns"], ["id", "qty", "doubled", "label", "big"])
        self.assertEqual(found["rows"][0], {"id": 1, "qty": 3.0, "doubled": 6.0, "label": "item-1", "big": None})
        self.assertEqual(found["rows"][1]["big"], 20.0)
        self.assertEqual(sha256(self.path), self.before)

    def test_implicit_fk_targets_resolve_to_parent_pk_or_stay_qualified(self) -> None:
        by_name = {t["name"]: t for t in self._schema()["tables"]}
        single = by_name["child_single"]["fks"][0][0]
        self.assertIsNone(single["to"])
        self.assertEqual(single["resolved_to"], "id")
        composite = by_name["child_composite"]["fks"][0]
        self.assertEqual([item["resolved_to"] for item in composite], ["a", "b"])
        explicit = by_name["child_explicit"]["fks"][0]
        self.assertEqual([item["to"] for item in explicit], ["a", "b"])
        self.assertEqual([item["resolved_to"] for item in explicit], [None, None])
        unique = by_name["child_unique"]["fks"][0][0]
        self.assertEqual(unique["to"], "code")
        self.assertIsNone(unique["resolved_to"])
        # Mismatched arity and missing parents resolve nothing.
        self.assertIsNone(by_name["child_mismatch"]["fks"][0][0]["resolved_to"])
        self.assertIsNone(by_name["child_missing"]["fks"][0][0]["resolved_to"])

    def test_hidden_virtual_table_columns_stay_hidden(self) -> None:
        probe = sqlite3.connect(":memory:")
        try:
            probe.execute("CREATE VIRTUAL TABLE docs USING fts5(body)")
            hidden = [row[1] for row in probe.execute("PRAGMA table_xinfo(docs)") if row[6] == 1]
        except sqlite3.OperationalError:
            self.skipTest("FTS5 unavailable in this SQLite build")
        finally:
            probe.close()
        if not hidden:
            self.skipTest("this SQLite build exposes no hidden FTS5 columns")
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("CREATE VIRTUAL TABLE docs USING fts5(body)")
            db.commit()
        names = [c["name"] for t in self._schema()["tables"] if t["name"] == "docs" for c in t["columns"]]
        for column in hidden:
            self.assertNotIn(column, names)

if __name__ == "__main__":
    unittest.main(verbosity=2)

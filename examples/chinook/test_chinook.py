"""Chinook demonstration checks against the real v1.4.5 artifact.

Run after `python3 examples/chinook/prepare.py --view-copy`:

    python3 examples/chinook/test_chinook.py

Both adapters run as real processes on free loopback ports, exactly as the
demo starts them; expectations are read from the same file through a
separate immutable SQLite connection, never typed in by hand. Skips (does
not fail) when the prepared files are absent.
"""

from __future__ import annotations

import hashlib
import json
import socket
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from urllib.request import urlopen

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DATA = HERE / "data"
UPSTREAM = DATA / "Chinook_Sqlite.sqlite"
VIEW_COPY = DATA / "Chinook_Sqlite.with-view.sqlite"
DECLARATION = HERE / "declaration.json"
VIEW_DECLARATION = HERE / "declaration-view.json"
VIEW_SQL = HERE / "views" / "invoice_line_customer.sql"

sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "adapters" / "world"))
from prepare import UPSTREAM_SHA256  # noqa: E402
from server import declaration_fingerprint  # noqa: E402

PREPARED = UPSTREAM.exists() and VIEW_COPY.exists()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def state(path: Path) -> tuple[str, int, list[str]]:
    sidecars = sorted(p.name for p in path.parent.glob(path.name + "-*"))
    return sha256(path), path.stat().st_mtime_ns, sidecars


@contextmanager
def source(path: Path):
    """An independent, immutable read of the same file, for expectations."""
    db = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True)
    db.row_factory = sqlite3.Row
    try:
        yield db
    finally:
        db.close()


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@contextmanager
def adapter(*args: str):
    port = free_port()
    process = subprocess.Popen(
        [sys.executable, *args, "--port", str(port)],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        # Both adapters print their address once they are serving.
        if not process.stdout.readline():
            raise RuntimeError(f"{args[0]} did not start: {process.stderr.read()}")

        def get(path: str) -> object:
            with urlopen(f"http://127.0.0.1:{port}{path}") as response:
                return json.load(response)

        yield get
    finally:
        process.terminate()
        process.wait(timeout=10)
        process.stdout.close()
        process.stderr.close()


def structural(path: Path = UPSTREAM):
    return adapter("adapters/sqlite/server.py", "--db", str(path))


def conceptual(path: Path = UPSTREAM, declaration: Path = DECLARATION):
    return adapter("adapters/world/server.py", "--db", str(path), "--declaration", str(declaration))


BEFORE: dict[Path, tuple[str, int, list[str]]] = {}


def setUpModule() -> None:
    if PREPARED:
        for path in (UPSTREAM, VIEW_COPY):
            BEFORE[path] = state(path)


def tearDownModule() -> None:
    # Every adapter run above read these files; none may have changed them.
    for path, before in BEFORE.items():
        after = state(path)
        if after != before:
            raise AssertionError(f"{path.name} changed: {before} -> {after}")


@unittest.skipUnless(PREPARED, "run examples/chinook/prepare.py --view-copy first")
class Source(unittest.TestCase):
    def test_upstream_is_the_pinned_artifact(self) -> None:
        self.assertEqual(sha256(UPSTREAM), UPSTREAM_SHA256)

    def test_upstream_has_no_views_and_the_view_is_in_the_copy_only(self) -> None:
        with source(UPSTREAM) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='view'").fetchone()[0], 0)
        with source(VIEW_COPY) as db:
            views = db.execute("SELECT name, sql FROM sqlite_master WHERE type='view'").fetchall()
        self.assertEqual([row["name"] for row in views], ["InvoiceLineCustomer"])
        # The stored definition is the reviewed text, disclosure included.
        authored = VIEW_SQL.read_text(encoding="utf-8")
        statement = authored[authored.index("CREATE VIEW"):].rstrip().rstrip(";")
        self.assertEqual(views[0]["sql"], statement)
        self.assertIn("NOT part of", views[0]["sql"])

    def test_copy_differs_from_upstream_only_by_the_view(self) -> None:
        self.assertNotEqual(sha256(VIEW_COPY), sha256(UPSTREAM))
        with source(UPSTREAM) as up, source(VIEW_COPY) as copy:
            for table in ("InvoiceLine", "Invoice", "Track", "Customer"):
                self.assertEqual(
                    up.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall(),
                    copy.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall(),
                )


@unittest.skipUnless(PREPARED, "run examples/chinook/prepare.py --view-copy first")
class Structural(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = structural()
        cls.get = staticmethod(cls.server.__enter__())
        cls.schema = cls.get("/sqlite/schema")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.__exit__(None, None, None)

    def table(self, name: str) -> dict:
        return next(table for table in self.schema["tables"] if table["name"] == name)

    def test_schema_is_the_file_as_stored(self) -> None:
        with source(UPSTREAM) as db:
            names = [row[0] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
            counts = {name: db.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0] for name in names}
        self.assertEqual(self.schema["file_sha256"], UPSTREAM_SHA256)
        self.assertEqual([table["name"] for table in self.schema["tables"]], names)
        self.assertEqual(len(names), 11)
        self.assertEqual(self.schema["views"], [])
        self.assertEqual({table["name"]: table["rows"] for table in self.schema["tables"]}, counts)
        # Structure carries no reading of its own.
        self.assertNotIn("reading", self.schema)

    def test_declared_keys_and_foreign_keys(self) -> None:
        track = self.table("Track")
        self.assertEqual(track["pk"], ["TrackId"])
        self.assertEqual(
            sorted((group[0]["from"], group[0]["table"], group[0]["to"]) for group in track["fks"]),
            [("AlbumId", "Album", "AlbumId"), ("GenreId", "Genre", "GenreId"), ("MediaTypeId", "MediaType", "MediaTypeId")],
        )
        line = self.table("InvoiceLine")
        self.assertEqual(
            sorted((group[0]["from"], group[0]["table"]) for group in line["fks"]),
            [("InvoiceId", "Invoice"), ("TrackId", "Track")],
        )
        self.assertEqual(
            [(column["name"], column["type"]) for column in line["columns"]],
            [("InvoiceLineId", "INTEGER"), ("InvoiceId", "INTEGER"), ("TrackId", "INTEGER"),
             ("UnitPrice", "NUMERIC(10,2)"), ("Quantity", "INTEGER")],
        )

    def test_joining_table_has_a_composite_verified_key(self) -> None:
        playlist_track = self.table("PlaylistTrack")
        self.assertEqual(playlist_track["pk"], ["PlaylistId", "TrackId"])
        window = self.get("/sqlite/rows?table=PlaylistTrack&limit=3&offset=0")
        self.assertTrue(window["navigable"])
        self.assertEqual(window["ordering_guarantee"], "declared key")
        with source(UPSTREAM) as db:
            expected = [dict(row) for row in db.execute(
                "SELECT * FROM PlaylistTrack ORDER BY PlaylistId, TrackId LIMIT 3")]
        self.assertEqual(window["rows"], expected)

    def test_rows_page_by_declared_key(self) -> None:
        first = self.get("/sqlite/rows?table=Track&limit=2&offset=0")
        last = self.get("/sqlite/rows?table=Track&limit=50&offset=3500")
        self.assertEqual(first["total"], 3503)
        self.assertEqual([row["TrackId"] for row in first["rows"]], [1, 2])
        self.assertEqual([row["TrackId"] for row in last["rows"]], [3501, 3502, 3503])

    def test_values_are_served_as_stored(self) -> None:
        with source(UPSTREAM) as db:
            for table, key, value in (("Track", "TrackId", 2), ("Artist", "ArtistId", 6), ("Invoice", "InvoiceId", 1)):
                stored = dict(db.execute(f'SELECT * FROM "{table}" WHERE "{key}" = ?', (value,)).fetchone())
                window = self.get(f"/sqlite/rows?table={table}&limit=1&offset={value - 1}")
                self.assertEqual(window["rows"], [stored])
        track = self.get("/sqlite/rows?table=Track&limit=1&offset=1")["rows"][0]
        self.assertIsNone(track["Composer"])
        self.assertEqual(track["UnitPrice"], 0.99)
        self.assertEqual(self.get("/sqlite/rows?table=Artist&limit=1&offset=5")["rows"][0]["Name"], "Antônio Carlos Jobim")


@unittest.skipUnless(PREPARED, "run examples/chinook/prepare.py --view-copy first")
class Conceptual(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = conceptual()
        cls.get = staticmethod(cls.server.__enter__())
        cls.overview = cls.get("/world/overview")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.__exit__(None, None, None)

    def test_reading_is_attributed_to_the_external_declaration(self) -> None:
        declaration = json.loads(DECLARATION.read_text(encoding="utf-8"))
        reading = self.overview["reading"]
        digest = declaration_fingerprint(declaration)
        self.assertEqual(reading["interpretation_source"], "external_reader_declaration")
        self.assertEqual(reading["declaration_digest"], digest)
        self.assertEqual(reading["reader_note"], declaration["world"]["description"])
        self.assertTrue(self.overview["world_id"].startswith("chinook:"))
        self.assertTrue(self.overview["world_id"].endswith("+" + digest[:12]))
        self.assertEqual(
            {(rel["name"], rel["source"]["name"], rel["source"]["kind"]) for rel in reading["relations"]},
            {("album_listed_under_artist", "Album", "table"), ("track_on_album", "Track", "table"),
             ("invoice_line_track", "InvoiceLine", "table")},
        )

    def test_nothing_undeclared_is_claimed(self) -> None:
        self.assertEqual(self.overview["origins"], {})
        self.assertIsNone(self.overview["demand"])
        self.assertIsNone(self.overview["governed_obligations"])
        for relation in self.overview["reading"]["relations"]:
            self.assertIsNone(relation["origin"])
            self.assertIsNone(relation["occurrence_state"])
        for relation in self.get("/world/schema")["relations"]:
            self.assertEqual(relation["origins"], [])
            self.assertIsNone(relation["completeness"])
        claim = self.get("/world/assertion?id=track_on_album:2")
        self.assertNotIn("occurrence_state", claim)
        self.assertEqual(claim["origin"], "UNSTATED")
        self.assertEqual(claim["governing_obligations"], [])

    def test_counts_are_the_source_tables(self) -> None:
        counts = {rel["name"]: rel["count"] for rel in self.get("/world/schema")["relations"]}
        with source(UPSTREAM) as db:
            self.assertEqual(counts, {
                "album_listed_under_artist": db.execute("SELECT COUNT(*) FROM Album").fetchone()[0],
                "track_on_album": db.execute("SELECT COUNT(*) FROM Track").fetchone()[0],
                "invoice_line_track": db.execute("SELECT COUNT(*) FROM InvoiceLine").fetchone()[0],
            })

    def test_identities_come_from_stored_keys_and_page_cleanly(self) -> None:
        first = self.get("/world/rows?relation=track_on_album&limit=3&offset=0")
        tail = self.get("/world/rows?relation=track_on_album&limit=10&offset=3500")
        self.assertEqual(first["total"], 3503)
        self.assertEqual([row["assertion_id"] for row in first["rows"]],
                         ["track_on_album:1", "track_on_album:2", "track_on_album:3"])
        self.assertEqual([row["assertion_id"] for row in tail["rows"]],
                         ["track_on_album:3501", "track_on_album:3502", "track_on_album:3503"])
        with source(UPSTREAM) as db:
            for row in first["rows"] + tail["rows"]:
                stored = db.execute("SELECT * FROM Track WHERE TrackId = ?",
                                    (int(row["assertion_id"].split(":")[1]),)).fetchone()
                self.assertEqual(row["values"], {
                    "track": f"track:{stored['TrackId']}", "album": f"album:{stored['AlbumId']}",
                    "composer": stored["Composer"], "milliseconds": stored["Milliseconds"],
                    "unit_price": stored["UnitPrice"],
                })

    def test_nulls_and_numbers_survive(self) -> None:
        claim = self.get("/world/assertion?id=track_on_album:2")
        self.assertIsNone(claim["values"]["composer"])
        self.assertEqual(claim["values"]["unit_price"], 0.99)
        self.assertIsInstance(claim["values"]["milliseconds"], int)
        line = self.get("/world/assertion?id=invoice_line_track:1")["values"]
        with source(UPSTREAM) as db:
            stored = db.execute("SELECT * FROM InvoiceLine WHERE InvoiceLineId = 1").fetchone()
        self.assertEqual(line, {"invoice": f"invoice:{stored['InvoiceId']}", "track": f"track:{stored['TrackId']}",
                                "unit_price": stored["UnitPrice"], "quantity": stored["Quantity"]})

    def test_grounding_names_the_stored_row(self) -> None:
        grounding = self.get("/world/assertion?id=track_on_album:2")["grounding"]
        self.assertEqual(len(grounding), 1)
        self.assertEqual(grounding[0]["kind"], "SOURCE")
        self.assertEqual(grounding[0]["native_location"], "row TrackId=2 in Track")
        self.assertEqual(grounding[0]["detail"]["key"], {"TrackId": 2})
        self.assertNotIn("derivation_definition", grounding[0]["detail"])
        referent = self.get("/world/referent?id=album:2")
        self.assertEqual(referent["label"], "Balls to the Wall")
        self.assertEqual(referent["grounding"][0]["native_location"], "row AlbumId=2 in Album")

    def test_traversal_follows_declared_references(self) -> None:
        listed = self.get("/world/rows?relation=album_listed_under_artist&subject=artist:1&limit=50&offset=0")
        with source(UPSTREAM) as db:
            albums = [row[0] for row in db.execute("SELECT AlbumId FROM Album WHERE ArtistId = 1 ORDER BY AlbumId")]
        self.assertEqual([row["values"]["album"] for row in listed["rows"]], [f"album:{album}" for album in albums])
        self.assertTrue(all(row["values"]["artist"] == "artist:1" for row in listed["rows"]))

    def test_same_reading_same_world_and_different_reading_different_world(self) -> None:
        with conceptual() as again:
            self.assertEqual(again("/world/overview")["world_id"], self.overview["world_id"])
        changed = json.loads(DECLARATION.read_text(encoding="utf-8"))
        changed["relations"] = [rel for rel in changed["relations"] if rel["name"] != "invoice_line_track"]
        changed["entities"] = [ent for ent in changed["entities"] if ent["kind"] != "invoice"]
        with tempfile.TemporaryDirectory() as directory:
            other = Path(directory) / "narrower.json"
            other.write_text(json.dumps(changed), encoding="utf-8")
            with conceptual(declaration=other) as narrower:
                world = narrower("/world/overview")
        file_half, reading_half = self.overview["world_id"].split("+")
        self.assertEqual(world["world_id"].split("+")[0], file_half)
        self.assertNotEqual(world["world_id"].split("+")[1], reading_half)
        self.assertNotEqual(world["reading"]["declaration_digest"], self.overview["reading"]["declaration_digest"])


    def test_referent_fields_are_the_occurrences_own_and_match_the_rows(self) -> None:
        album = self.get("/world/referent?id=album:1")
        with source(UPSTREAM) as db:
            tracks = db.execute(
                "SELECT TrackId, Composer, Milliseconds, UnitPrice FROM Track WHERE AlbumId = 1 ORDER BY TrackId"
            ).fetchall()
        self.assertEqual(len(tracks), 10)
        expected = [
            (f"track_on_album:{row['TrackId']}", role, row[column])
            for row in tracks
            for role, column in (("composer", "Composer"), ("milliseconds", "Milliseconds"), ("unit_price", "UnitPrice"))
        ]
        got = [(f["assertion_id"], f["role"], f["value"]) for f in album["fields"] if f["relation"] == "track_on_album"]
        self.assertEqual(sorted(got), sorted(expected))
        # Thirty values, ten occurrences; the album fills the `album` role in each.
        self.assertEqual(len(album["fields"]), 30)
        self.assertEqual(len({f["assertion_id"] for f in album["fields"]}), 10)
        self.assertTrue(all(f["referent_roles"] == ["album"] for f in album["fields"]))
        self.assertEqual({f["role"] for f in album["fields"]}, {"composer", "milliseconds", "unit_price"})
        # A zero is a zero: the invoice-line relation has no `album` role at all.
        self.assertEqual({r["name"]: r["count"] for r in album["relations"]},
                         {"album_listed_under_artist": 1, "invoice_line_track": 0, "track_on_album": 10})
        self.assertEqual(album["grounding"][0]["native_location"], "row AlbumId=1 in Album")
        self.assertEqual(album["grounding"][0]["detail"], {"source": "Album", "key": {"AlbumId": 1}})

    def test_track_referent_and_track_occurrence_are_different_identities(self) -> None:
        track = self.get("/world/referent?id=track:10")
        occurrence = self.get("/world/assertion?id=track_on_album:10")
        self.assertEqual(track["id"], "track:10")
        self.assertEqual(occurrence["assertion_id"], "track_on_album:10")
        self.assertEqual({f["assertion_id"] for f in track["fields"]}, {"track_on_album:10", "invoice_line_track:5"})
        by_occurrence = {}
        for field in track["fields"]:
            by_occurrence.setdefault(field["assertion_id"], {})[field["role"]] = field["value"]
        self.assertEqual(by_occurrence["track_on_album:10"], {
            "composer": occurrence["values"]["composer"],
            "milliseconds": occurrence["values"]["milliseconds"],
            "unit_price": occurrence["values"]["unit_price"],
        })
        self.assertEqual(by_occurrence["invoice_line_track:5"], {"unit_price": 0.99, "quantity": 1})
        self.assertTrue(all(f["referent_roles"] == ["track"] for f in track["fields"]))
        # Same stored row, two readings of it: the occurrence discloses how its references were read.
        self.assertEqual(track["grounding"][0]["detail"], {"source": "Track", "key": {"TrackId": 10}})
        self.assertIn("reference_participants", occurrence["grounding"][0]["detail"])

    def test_label_columns_say_who_chose_them(self) -> None:
        declaration = json.loads(DECLARATION.read_text(encoding="utf-8"))
        declared = {e["kind"]: "label_column" in e for e in declaration["entities"]}
        self.assertEqual(declared, {"artist": True, "album": True, "track": True, "invoice": False})
        for entity in self.overview["reading"]["entities"]:
            self.assertEqual(entity["label_column_source"], "declared" if declared[entity["kind"]] else "adapter_default")
        invoice = next(e for e in self.overview["reading"]["entities"] if e["kind"] == "invoice")
        self.assertEqual(invoice["label_column"], "InvoiceId")
        # The identity does not move because the default is disclosed.
        self.assertEqual(self.overview["reading"]["declaration_digest"], declaration_fingerprint(declaration))
        self.assertEqual(self.get("/world/labels?ids=invoice:1")["labels"], {"invoice:1": "1"})

    def test_role_types_are_declared_types_and_affinities_not_values(self) -> None:
        relations = {r["name"]: {role["name"]: role for role in r["roles"]} for r in self.get("/world/schema")["relations"]}
        with source(UPSTREAM) as db:
            declared = {
                (table, row["name"]): row["type"]
                for table in ("Track", "InvoiceLine")
                for row in db.execute(f"PRAGMA table_info({table})")
            }
            for relation, table, columns in (
                ("track_on_album", "Track", {"composer": "Composer", "milliseconds": "Milliseconds", "unit_price": "UnitPrice"}),
                ("invoice_line_track", "InvoiceLine", {"unit_price": "UnitPrice", "quantity": "Quantity"}),
            ):
                for role, column in columns.items():
                    found = relations[relation][role]
                    self.assertEqual(found["declared_type"], declared[(table, column)])
                    self.assertEqual(found["type_basis"], "sqlite_affinity")
        self.assertEqual(relations["track_on_album"]["unit_price"]["type"], "NUMERIC")
        self.assertEqual(relations["track_on_album"]["milliseconds"]["type"], "INTEGER")
        self.assertEqual(relations["track_on_album"]["composer"]["type"], "TEXT")

    def test_stored_classes_and_values_are_served_exactly(self) -> None:
        with source(UPSTREAM) as db:
            rows = db.execute(
                "SELECT TrackId, Composer, Milliseconds, UnitPrice, typeof(Composer) AS c, "
                "typeof(Milliseconds) AS m, typeof(UnitPrice) AS u FROM Track WHERE TrackId IN (1, 2, 10, 3503)"
            ).fetchall()
        self.assertEqual(len(rows), 4)
        for row in rows:
            found = self.get(f"/world/assertion?id=track_on_album:{row['TrackId']}")
            self.assertEqual(found["values"]["composer"], row["Composer"])
            self.assertEqual(found["values"]["milliseconds"], row["Milliseconds"])
            self.assertEqual(found["values"]["unit_price"], row["UnitPrice"])
            self.assertEqual(found["grounding"][0]["detail"]["scalar_storage"],
                             {"Composer": row["c"], "Milliseconds": row["m"], "UnitPrice": row["u"]})
        # NULL composer (track 2) and REAL prices, as stored.
        self.assertIsNone(self.get("/world/assertion?id=track_on_album:2")["values"]["composer"])
        self.assertEqual(self.get("/world/assertion?id=track_on_album:2")["grounding"][0]["detail"]["scalar_storage"]["Composer"], "null")


@unittest.skipUnless(PREPARED, "run examples/chinook/prepare.py --view-copy first")
class ViewReading(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = conceptual(VIEW_COPY, VIEW_DECLARATION)
        cls.get = staticmethod(cls.server.__enter__())

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.__exit__(None, None, None)

    def test_view_is_read_as_defined_not_stored(self) -> None:
        overview = self.get("/world/overview")
        self.assertEqual(overview["reading"]["relations"][0]["source"], {"name": "InvoiceLineCustomer", "kind": "view"})
        grounding = self.get("/world/assertion?id=invoice_line_with_recorded_customer:1")["grounding"][0]
        self.assertEqual(grounding["native_location"],
                         "output of view InvoiceLineCustomer for InvoiceLineId=1 — defined, not stored")
        self.assertEqual(grounding["detail"]["lineage"], "not recorded")
        self.assertIn("NOT part of", grounding["detail"]["derivation_definition"])

    def test_view_rows_are_the_upstream_join(self) -> None:
        rows: list[dict] = []
        while True:
            window = self.get(f"/world/rows?relation=invoice_line_with_recorded_customer&limit=200&offset={len(rows)}")
            rows.extend(window["rows"])
            if not window["rows"] or len(rows) >= window["total"]:
                break
        self.assertEqual(len(rows), 2240)
        self.assertEqual(len({row["assertion_id"] for row in rows}), 2240)
        with source(UPSTREAM) as db:
            for row in rows:
                line = int(row["assertion_id"].split(":")[1])
                stored = db.execute(
                    "SELECT l.InvoiceId, i.CustomerId, l.TrackId, l.UnitPrice, l.Quantity "
                    "FROM InvoiceLine l JOIN Invoice i ON i.InvoiceId = l.InvoiceId WHERE l.InvoiceLineId = ?",
                    (line,)).fetchone()
                self.assertEqual(row["values"], {
                    "invoice": f"invoice:{stored['InvoiceId']}", "customer": f"customer:{stored['CustomerId']}",
                    "track": f"track:{stored['TrackId']}", "unit_price": stored["UnitPrice"],
                    "quantity": stored["Quantity"],
                })

    def test_customer_reference_does_not_make_the_line_the_customers_property(self) -> None:
        customer = self.get("/world/referent?id=customer:2")
        with source(VIEW_COPY) as db:
            lines = db.execute(
                "SELECT InvoiceLineId, UnitPrice, Quantity FROM InvoiceLineCustomer WHERE CustomerId = 2 ORDER BY InvoiceLineId"
            ).fetchall()
        self.assertEqual(len(lines), 38)
        got = sorted((f["assertion_id"], f["role"], f["value"]) for f in customer["fields"])
        want = sorted(
            (f"invoice_line_with_recorded_customer:{row['InvoiceLineId']}", role, row[column])
            for row in lines for role, column in (("unit_price", "UnitPrice"), ("quantity", "Quantity"))
        )
        self.assertEqual(got, want)
        self.assertTrue(all(f["referent_roles"] == ["customer"] for f in customer["fields"]))
        self.assertEqual(customer["relations"][0]["count"], 38)
        self.assertEqual(customer["grounding"][0]["native_location"], "row CustomerId=2 in Customer")
        # The occurrence, not the customer, is where the view's definition is cited.
        one = self.get("/world/assertion?id=invoice_line_with_recorded_customer:1")
        self.assertIn("derivation_definition", one["grounding"][0]["detail"])
        self.assertNotIn("derivation_definition", customer["grounding"][0]["detail"])
        self.assertEqual(one["grounding"][0]["detail"]["lineage"], "not recorded")
        for key in ("origin", "occurrence_state"):
            self.assertNotIn(key, customer)

    def test_copy_is_a_different_world(self) -> None:
        with conceptual() as upstream:
            upstream_world = upstream("/world/overview")["world_id"]
        self.assertNotEqual(self.get("/world/overview")["world_id"].split("+")[0].split(":")[1],
                            upstream_world.split("+")[0].split(":")[1])


if __name__ == "__main__":
    unittest.main(verbosity=2)

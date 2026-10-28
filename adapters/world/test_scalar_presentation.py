"""Scalar presentation: what the API serves is what SQLite stores.

The UI can only tell NULL from the empty string, zero and literal text if the
plane keeps them apart in the first place. These tests read the same file two
ways (an independent SQL connection and the adapter's own read functions) and
require them to agree on every value and its storage class. They also pin the
compatibility defaults the plane keeps reporting unchanged: the UI qualifies
how they are *displayed*, never what the API says.
"""
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

import server as world
from scalar_fixture import PROBE_VALUES, build_fixture
import summary_fixture


class ScalarCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.path = Path(cls.tmp.name) / "source.sqlite"
        cls.declaration = build_fixture(cls.path)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def read(self, fn, *args):
        with closing(world.connect(self.path)) as db:
            return fn(db, world.Model(db, self.declaration), *args)

    def sql(self, query):
        with closing(sqlite3.connect(f"file:{self.path}?mode=ro", uri=True)) as db:
            return db.execute(query).fetchall()


class TestStoredValuesAreServedExactly(ScalarCase):
    def test_fixture_stores_what_it_says(self):
        stored = self.sql("SELECT id, value, typeof(value) FROM probe ORDER BY id")
        self.assertEqual([(i, v) for i, v, _ in stored], PROBE_VALUES)
        self.assertEqual(
            {i: t for i, _, t in stored},
            {1: "null", 2: "text", 3: "integer", 4: "real", 5: "integer", 6: "real",
             7: "integer", 8: "real", 9: "text", 10: "text", 11: "text", 12: "text",
             13: "text", 14: "text", 15: "text", 16: "text"})

    def test_rows_serve_each_value_with_its_own_json_type(self):
        served = self.read(world.rows, {"relation": ["probe"], "limit": ["100"]})
        by_id = {int(row["assertion_id"].split(":")[1]): row["values"] for row in served["rows"]}
        self.assertEqual({i: v["value"] for i, v in by_id.items()}, dict(PROBE_VALUES))
        # Python's == treats 0 == 0.0 == False; the JSON type must also match.
        for i, stored in PROBE_VALUES:
            self.assertIs(type(by_id[i]["value"]), type(stored), i)
        # NULL is None, the empty string is "", and neither is the other.
        self.assertIsNone(by_id[1]["value"])
        self.assertEqual(by_id[2]["value"], "")
        self.assertEqual(by_id[3]["value"], 0)
        self.assertEqual(by_id[11]["value"], "null")
        self.assertEqual(by_id[13]["value"], "—")
        self.assertEqual(by_id[9]["value"], "   ")

    def test_second_scalar_column_keeps_null_and_empty_apart(self):
        served = self.read(world.rows, {"relation": ["probe"], "limit": ["100"]})
        memos = {int(r["assertion_id"].split(":")[1]): r["values"]["memo"] for r in served["rows"]}
        stored = {i: m for i, m in self.sql("SELECT id, memo FROM probe")}
        self.assertEqual(memos, stored)
        self.assertIsNone(memos[1])
        self.assertEqual(memos[2], "")

    def test_assertion_and_referent_agree_with_the_rows(self):
        for n, stored in PROBE_VALUES:
            claim = self.read(world.assertion, f"probe:{n}")
            self.assertEqual(claim["values"]["value"], stored)
            self.assertIs(type(claim["values"]["value"]), type(stored))
        found = self.read(world.referent, "item:1")
        fields = {(f["assertion_id"], f["role"]): f["value"] for f in found["fields"]}
        for n, stored in PROBE_VALUES:
            self.assertEqual(fields[(f"probe:{n}", "value")], stored)
            self.assertIs(type(fields[(f"probe:{n}", "value")]), type(stored))

    def test_storage_class_is_reported_per_value_beside_the_value(self):
        classes = {i: t for i, t in self.sql("SELECT id, typeof(value) FROM probe")}
        for n, _ in PROBE_VALUES:
            claim = self.read(world.assertion, f"probe:{n}")
            source = [g for g in claim["grounding"] if g["kind"] == "SOURCE"][0]
            self.assertEqual(source["detail"]["scalar_storage"]["value"], classes[n])

    def test_untyped_column_is_blob_affinity_so_values_are_not_coerced(self):
        schema = self.read(world.schema)
        role = [r for r in schema["relations"] if r["name"] == "probe"][0]["roles"]
        value = [r for r in role if r["name"] == "value"][0]
        self.assertEqual((value["declared_type"], value["type"]), ("", "BLOB"))

    def test_a_null_participant_is_still_refused_not_served_as_a_null_referent(self):
        # Nullable referent roles are not part of the contract: tuples must be
        # complete to be assertions, so the UI never receives a null referent.
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "s.sqlite"
            declaration = build_fixture(path)
            with closing(sqlite3.connect(path)) as db:
                db.execute("INSERT INTO probe VALUES (99, NULL, 'x', 'y')")
                db.commit()
            with closing(world.connect(path)) as db, self.assertRaises(ValueError) as caught:
                world.Model(db, declaration)
            self.assertIn("null participants", str(caught.exception))


class TestCompatibilityDefaultsAreStillReported(ScalarCase):
    """The UI qualifies how defaults are displayed; the API still says them."""

    def test_overview_revision_and_schema_mode(self):
        overview = self.read(world.overview, "scalartest:fixture")
        self.assertEqual(overview["revision"], 1)
        self.assertEqual(overview["stale"], [])
        schema = self.read(world.schema)
        self.assertEqual({r["mode"] for r in schema["relations"]}, {"BASE"})
        self.assertEqual({r["stale"] for r in schema["relations"]}, {False})

    def test_assertion_compat_fields(self):
        claim = self.read(world.assertion, "probe:1")
        self.assertEqual(
            (claim["mode"], claim["created_revision"], claim["assertion_state"],
             claim["relation_stale"], claim["warrant"]["bases"], claim["candidate_for"]),
            ("BASE", 1, "UNKNOWN", False, [], []))

    def test_rows_report_base_mode_and_not_stale(self):
        served = self.read(world.rows, {"relation": ["probe"]})
        self.assertEqual((served["mode"], served["stale"]), ("BASE", False))

    def test_identity_and_digest_are_those_of_the_declaration_not_of_any_display(self):
        prepared = world.prepare_world(self.path, self.declaration, declaration_source="external_file")
        try:
            reading = prepared.model.reading
            self.assertEqual(reading["adapter"], "generic_sqlite_v1")
            self.assertEqual(reading["interpretation_source"], "external_reader_declaration")
            self.assertEqual(reading["declaration_digest"], world.declaration_fingerprint(self.declaration))
            self.assertTrue(prepared.world_id.startswith("scalartest:"))
        finally:
            prepared.cleanup()


class TestSummaryFixtureServesDistinctValues(unittest.TestCase):
    """The one-line-summary browser test relies on these exact stored values."""

    def test_values_are_served_with_their_own_json_types(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.sqlite"
            declaration = summary_fixture.build_fixture(path)
            with closing(world.connect(path)) as db:
                model = world.Model(db, declaration)
                for relation in ("mark", "tie"):
                    served = world.rows(db, model, {"relation": [relation], "limit": ["100"]})
                    values = {int(r["assertion_id"].split(":")[1]): r["values"]["value"] for r in served["rows"]}
                    self.assertEqual(values, dict(summary_fixture.VALUES), relation)
                    self.assertIsNone(values[1])
                    self.assertEqual(values[2], "NULL")
                    self.assertEqual(values[3], "")
                    self.assertEqual(values[4], '""')
                    self.assertEqual({r["values"]["memo"] for r in served["rows"]}, {"m"})


if __name__ == "__main__":
    unittest.main()

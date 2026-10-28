"""Evidence attribution: what the plane says belongs to which subject.

Real SQLite file, real Model, real read functions. The invariants:

* a scalar stated by an occurrence stays attached to that occurrence's
  `assertion_id`; the plane never supplies it as a property of a referent;
* which role(s) a referent fills in an occurrence is reported, never guessed;
* an adapter default is distinguishable from a reader declaration;
* declared type, SQLite affinity and per-row storage class are different
  things, and the values themselves are never converted.
"""
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

import server as world
from attribution_fixture import LEDGER_OCCURRENCES, build_fixture


class AttributionCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.path = Path(cls.tmp.name) / "source.sqlite"
        cls.declaration = build_fixture(cls.path)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def model(self, db):
        return world.Model(db, self.declaration)

    def read(self, fn, *args):
        with closing(world.connect(self.path)) as db:
            return fn(db, self.model(db), *args)


class TestReferentFieldsBelongToOccurrences(AttributionCase):
    def test_every_field_names_its_occurrence_relation_role_and_participation(self):
        found = self.read(world.referent, "person:2")
        fields = [f for f in found["fields"] if f["relation"] == "assignment"]
        by_occurrence = {}
        for field in fields:
            by_occurrence.setdefault(field["assertion_id"], []).append(field)
        # Three occurrences mention person 2; none is lost to the repeated values.
        self.assertEqual(sorted(by_occurrence), ["assignment:1", "assignment:2", "assignment:3"])
        # Eight scalar roles each: one occurrence stays one occurrence.
        self.assertTrue(all(len(rows) == 8 for rows in by_occurrence.values()))
        self.assertEqual(
            {k: rows[0]["referent_roles"] for k, rows in by_occurrence.items()},
            {"assignment:1": ["helper"], "assignment:2": ["helper"],
             "assignment:3": ["lead", "helper"]},
        )
        # The participation list is the same on every field of one occurrence.
        for rows in by_occurrence.values():
            self.assertEqual(len({tuple(f["referent_roles"]) for f in rows}), 1)

    def test_repeated_scalar_values_stay_distinct_occurrences(self):
        found = self.read(world.referent, "person:1")
        hours = [f for f in found["fields"] if f["relation"] == "assignment" and f["role"] == "hours"]
        self.assertEqual([(f["assertion_id"], f["value"]) for f in hours],
                         [("assignment:1", 8), ("assignment:2", 8)])
        self.assertEqual([f["referent_roles"] for f in hours], [["lead"], ["lead"]])

    def test_null_empty_zero_and_numbers_are_preserved_exactly(self):
        found = self.read(world.referent, "person:2")
        third = {f["role"]: f["value"] for f in found["fields"] if f["assertion_id"] == "assignment:3"}
        self.assertEqual(third, {
            "hours": 0, "rate": 1, "amount": "n/a", "started": "", "note": "",
            "extra": 2.0, "blobby": None, "untyped": 3,
        })
        self.assertIs(type(third["hours"]), int)
        self.assertIs(type(third["rate"]), int)
        self.assertIs(type(third["extra"]), float)
        first = {f["role"]: f["value"] for f in found["fields"] if f["assertion_id"] == "assignment:1"}
        self.assertEqual(first["rate"], 0.99)
        # '1.50' was coerced to REAL by the NUMERIC affinity when it was stored;
        # the plane serves what is stored, not what was typed.
        self.assertEqual(first["amount"], 1.5)
        self.assertEqual(first["started"], "2024-01-01 00:00:00")
        self.assertIsNone(first["note"])
        self.assertTrue(first["blobby"].startswith("[BLOB 2 bytes; sha256="))

    def test_same_role_name_in_different_relations_stays_distinct(self):
        found = self.read(world.referent, "person:1")
        verdicts = [(f["relation"], f["assertion_id"]) for f in found["fields"] if f["role"] == "verdict"]
        self.assertEqual(verdicts, [("review_adopted", "review_adopted:1"),
                                    ("review_rejected", "review_rejected:1")])

    def test_states_and_origins_stay_with_their_occurrence(self):
        found = self.read(world.referent, "person:1")
        adopted = next(f for f in found["fields"] if f["relation"] == "review_adopted")
        rejected = next(f for f in found["fields"] if f["relation"] == "review_rejected")
        plain = next(f for f in found["fields"] if f["relation"] == "assignment")
        self.assertEqual((adopted["occurrence_state"], adopted["origin"]), ("ADOPTED", "SEMANTIC"))
        self.assertEqual((rejected["occurrence_state"], rejected["origin"]), ("REJECTED", "MECHANICAL"))
        # Neutral relation: no state key, and the reserved placeholder origin.
        self.assertNotIn("occurrence_state", plain)
        self.assertEqual(plain["origin"], "UNSTATED")
        self.assertNotIn("origins", plain)
        # The referent itself carries no state, origin or ownership of any of it.
        for key in ("occurrence_state", "origin", "origins", "fields_owner"):
            self.assertNotIn(key, found)

    def test_bounded_preview_counts_occurrences_not_fields(self):
        found = self.read(world.referent, "person:9")
        fields = [f for f in found["fields"] if f["relation"] == "ledger"]
        relation = next(r for r in found["relations"] if r["name"] == "ledger")
        self.assertEqual(relation["count"], LEDGER_OCCURRENCES)
        self.assertEqual(len(fields), 200)
        self.assertEqual(len({f["assertion_id"] for f in fields}), world.FIELDS_PER_RELATION)
        self.assertEqual(fields[0]["referent_roles"], ["person"])
        # First occurrence: zero and the empty string, not null; second: nulls.
        head = {(f["assertion_id"], f["role"]): f["value"] for f in fields}
        self.assertEqual(head[("ledger:1", "qty")], 0)
        self.assertEqual(head[("ledger:1", "memo")], "")
        self.assertIsNone(head[("ledger:2", "qty")])
        self.assertIsNone(head[("ledger:2", "memo")])
        # Full access to all occurrences remains through the ordinary expansion.
        full = self.read(world.expand, "person:9", "ledger", 2000)
        self.assertEqual(len(full["tuples"]), LEDGER_OCCURRENCES)

    def test_zero_participation_is_reported_as_a_zero_count_and_no_fields(self):
        found = self.read(world.referent, "person:8")
        self.assertEqual(found["fields"], [])
        self.assertEqual({r["name"]: r["count"] for r in found["relations"]},
                         {"assignment": 0, "ledger": 0, "review_adopted": 0, "review_rejected": 0})

    def test_one_and_many_participation_counts(self):
        counts = lambda ident: {r["name"]: r["count"] for r in self.read(world.referent, ident)["relations"]}
        self.assertEqual(counts("person:3")["assignment"], 0)
        self.assertEqual(counts("project:10")["assignment"], 1)
        self.assertEqual(counts("person:2")["assignment"], 3)

    def test_referent_payload_has_no_scalar_of_its_own(self):
        # Referent-level data is only identity and its own source row.
        found = self.read(world.referent, "person:2")
        self.assertEqual(set(found), {"id", "label", "grounding", "fields", "relations"})
        self.assertEqual(found["grounding"][0]["reference"], "person:id=2")
        self.assertEqual(found["label"], "Ben")


class TestLabelProvenance(AttributionCase):
    def reading(self):
        with closing(world.connect(self.path)) as db:
            model = self.model(db)
            return world.external_reading(db, model, self.declaration), model

    def test_declared_and_defaulted_label_columns_are_distinguished(self):
        reading, _ = self.reading()
        entities = {e["kind"]: e for e in reading["entities"]}
        self.assertEqual((entities["person"]["label_column"], entities["person"]["label_column_source"]),
                         ("name", "declared"))
        self.assertEqual((entities["project"]["label_column"], entities["project"]["label_column_source"]),
                         ("id", "adapter_default"))

    def test_declaring_the_same_column_as_the_default_is_still_a_declaration(self):
        declared = json.loads(json.dumps(self.declaration))
        declared["entities"][1]["label_column"] = "id"
        with closing(world.connect(self.path)) as db:
            reading = world.external_reading(db, world.Model(db, declared), declared)
        project = next(e for e in reading["entities"] if e["kind"] == "project")
        self.assertEqual((project["label_column"], project["label_column_source"]), ("id", "declared"))
        # A different declaration is a different reading: the digest moves.
        self.assertNotEqual(world.declaration_fingerprint(declared),
                            world.declaration_fingerprint(self.declaration))

    def test_disclosing_the_default_changes_neither_labels_ids_nor_digest(self):
        reading, model = self.reading()
        self.assertEqual(reading["declaration_digest"], world.declaration_fingerprint(self.declaration))
        with closing(world.connect(self.path)) as db:
            directory = world.referents(db, model)["referents"]
        projects = [item for item in directory if item["id"].startswith("project:")]
        self.assertEqual(projects, [{"id": "project:10", "label": "10"}, {"id": "project:20", "label": "20"}])
        # The digest covers the declaration only: neither the new field nor
        # any adapter-resolved value is part of it.
        self.assertNotIn("label_column_source", json.dumps(self.declaration))


class TestSqliteTypesAreDescribedNotConverted(AttributionCase):
    EXPECTED = {
        # role: (declared type, SQLite affinity)
        "hours": ("INTEGER", "INTEGER"),
        "rate": ("NUMERIC(10,2)", "NUMERIC"),
        "amount": ("DECIMAL(10,2)", "NUMERIC"),
        "started": ("DATETIME", "NUMERIC"),
        "note": ("TEXT", "TEXT"),
        "extra": ("REAL", "REAL"),
        "blobby": ("BLOB", "BLOB"),
        "untyped": ("", "BLOB"),
    }

    def roles(self):
        with closing(world.connect(self.path)) as db:
            schema = world.schema(db, self.model(db))
        relation = next(r for r in schema["relations"] if r["name"] == "assignment")
        return {role["name"]: role for role in relation["roles"]}

    def test_roles_report_declared_type_and_affinity_not_a_guess(self):
        roles = self.roles()
        for name, (declared, affinity) in self.EXPECTED.items():
            self.assertEqual((roles[name]["declared_type"], roles[name]["type"]), (declared, affinity), name)
            self.assertEqual(roles[name]["type_basis"], "sqlite_affinity")
            self.assertFalse(roles[name]["referent"])
        # Referent roles are untouched by scalar typing.
        self.assertEqual(roles["lead"]["type"], "REFERENT")
        self.assertNotIn("declared_type", roles["lead"])

    def test_no_declared_type_is_an_empty_string_never_a_made_up_name(self):
        self.assertEqual(self.roles()["untyped"]["declared_type"], "")

    def test_no_temporal_type_is_invented(self):
        types = {role["type"] for role in self.roles().values()}
        self.assertFalse({"DATE", "DATETIME", "TIMESTAMP", "DECIMAL"} & types)

    def test_runtime_storage_class_is_per_row_and_values_are_exact(self):
        first = self.read(world.assertion, "assignment:1")
        third = self.read(world.assertion, "assignment:3")
        storage = lambda found: found["grounding"][0]["detail"]["scalar_storage"]
        # A NUMERIC column holding a real, and one holding an integer.
        self.assertEqual(storage(first)["rate"], "real")
        self.assertEqual(storage(third)["rate"], "integer")
        # DECIMAL: '1.50' was stored as REAL, 'n/a' stays TEXT; DATETIME stays
        # text, even when empty. NULL storage is covered by `note` below.
        self.assertEqual((storage(first)["amount"], first["values"]["amount"]), ("real", 1.5))
        self.assertEqual((storage(third)["amount"], third["values"]["amount"]), ("text", "n/a"))
        self.assertEqual((storage(first)["note"], first["values"]["note"]), ("null", None))
        self.assertEqual((storage(third)["note"], third["values"]["note"]), ("text", ""))
        self.assertEqual((storage(first)["started"], first["values"]["started"]),
                         ("text", "2024-01-01 00:00:00"))
        self.assertEqual((storage(third)["started"], third["values"]["started"]), ("text", ""))
        # REAL affinity converts 2 to 2.0 on storage; the storage class says so.
        self.assertEqual(storage(third)["extra"], "real")
        # A BLOB's value remains the existing size/digest preview.
        self.assertEqual(storage(first)["blobby"], "blob")
        # Untyped column: whatever was inserted.
        self.assertEqual((storage(first)["untyped"], storage(third)["untyped"]), ("text", "integer"))

    def test_scalar_storage_is_keyed_by_source_column_and_excludes_references(self):
        found = self.read(world.assertion, "assignment:1")
        detail = found["grounding"][0]["detail"]
        self.assertEqual(sorted(detail["scalar_storage"]),
                         sorted(("hours", "rate", "amount", "started", "note", "extra", "blobby", "untyped")))
        self.assertEqual(sorted(detail["reference_participants"]), ["helper", "lead", "project"])

    def test_values_match_direct_sqlite(self):
        with closing(sqlite3.connect(f"file:{self.path}?mode=ro", uri=True)) as db:
            for ident in (1, 2, 3):
                row = db.execute("SELECT hours,rate,amount,started,note,extra,untyped FROM assignment WHERE id=?",
                                 (ident,)).fetchone()
                found = self.read(world.assertion, f"assignment:{ident}")["values"]
                self.assertEqual(
                    tuple(found[k] for k in ("hours", "rate", "amount", "started", "note", "extra", "untyped")),
                    tuple(row))


class TestSqliteAffinityRules(unittest.TestCase):
    def test_follows_the_published_order(self):
        cases = {
            "INT": "INTEGER", "BIGINT": "INTEGER", "UNSIGNED BIG INT": "INTEGER",
            "VARCHAR(70)": "TEXT", "NVARCHAR(160)": "TEXT", "CLOB": "TEXT", "TEXT": "TEXT",
            "BLOB": "BLOB", "": "BLOB",
            "REAL": "REAL", "DOUBLE PRECISION": "REAL", "FLOAT": "REAL",
            "NUMERIC": "NUMERIC", "NUMERIC(10,2)": "NUMERIC", "DECIMAL(10,5)": "NUMERIC",
            "BOOLEAN": "NUMERIC", "DATE": "NUMERIC", "DATETIME": "NUMERIC",
            # INT is tested first: CHARACTER INT is INTEGER, and a name with
            # both INT and TEXT is INTEGER, as SQLite documents.
            "POINT": "INTEGER", "INTEGER TEXT": "INTEGER",
        }
        for declared, affinity in cases.items():
            self.assertEqual(world.sqlite_affinity(declared), affinity, declared)

    def test_agrees_with_what_sqlite_actually_does_to_stored_text(self):
        # SQLite coerces text on INSERT according to the column's affinity.
        # Storing '1.0' reveals it: TEXT and BLOB keep text; REAL stores a
        # real; INTEGER and NUMERIC store the integer 1.
        observed = {"TEXT": "text", "BLOB": "text", "REAL": "real", "INTEGER": "integer", "NUMERIC": "integer"}
        for declared in ["INT", "BIGINT", "INTEGER", "NVARCHAR(160)", "VARCHAR(70)", "CLOB", "TEXT", "BLOB", "",
                         "REAL", "DOUBLE PRECISION", "FLOAT", "NUMERIC", "NUMERIC(10,2)", "DECIMAL(10,5)",
                         "BOOLEAN", "DATE", "DATETIME"]:
            with closing(sqlite3.connect(":memory:")) as db:
                db.execute(f"CREATE TABLE t(c {declared})")
                db.execute("INSERT INTO t VALUES ('1.0')")
                stored = db.execute("SELECT typeof(c) FROM t").fetchone()[0]
            self.assertEqual(stored, observed[world.sqlite_affinity(declared)], declared)


if __name__ == "__main__":
    unittest.main()

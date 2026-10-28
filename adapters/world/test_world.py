"""Generic World adapter tests: external declarations over read-only SQLite.

No mocks of the database: every case builds a real file, serves it through
the real Model and HTTP plane, and checks the bytes afterward. The frozen
Run 000 artifact is covered by TestFrozenArtifact, which runs only when
KI_KNOWLEDGE_SQLITE names the file — otherwise it skips, and the synthetic
fixture proves the same behaviors.
"""

from __future__ import annotations

import hashlib
import http.client
import importlib.util
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import closing
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server as world  # noqa: E402
from fixture import build  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent.parent
KNOWLEDGE_DECLARATION = ROOT / "examples" / "knowledge-flow" / "declaration.json"


def _structural():
    spec = importlib.util.spec_from_file_location(
        "structural_server", ROOT / "adapters" / "sqlite" / "server.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def declaration(**overrides) -> dict:
    """A valid reader declaration over the synthetic fixture.

    Origin and occurrence_state are deliberately absent: undeclared means
    unstated, and the tests pin that.
    """
    found = {
        "version": 1,
        "world": {"id_prefix": "flowtest"},
        "entities": [
            {"kind": "flow", "source": "flow", "key_columns": ["id"], "label_column": "name"}
        ],
        "relations": [
            {
                "name": "step",
                "source": "hop",
                "key_columns": ["flow_id", "seq"],
                "description": "reader wording for an ordered hop",
                "roles": [
                    {"role": "flow", "column_name": "flow_id", "target_kind": "flow"},
                    {"role": "seq", "column_name": "seq", "target_kind": None},
                    {"role": "who", "column_name": "who", "target_kind": None},
                    {"role": "what", "column_name": "what", "target_kind": None},
                ],
            }
        ],
    }
    found.update(overrides)
    return found


class WorldCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "producer.sqlite"
        build(self.path)
        self.before = sha256(self.path)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def model(self, declared: dict | None = None) -> world.Model:
        with closing(world.connect(self.path)) as db:
            return world.Model(db, declaration() if declared is None else declared)

    def scratch(self) -> Path:
        """A writable copy for building broken sources or declarations."""
        other = Path(self.tmp.name) / "scratch.sqlite"
        shutil.copy(self.path, other)
        return other


class TestDeclarationShape(unittest.TestCase):
    def test_example_declaration_is_valid(self) -> None:
        found = world.load_declaration(KNOWLEDGE_DECLARATION)
        self.assertEqual(found["version"], 1)
        self.assertEqual(found["world"]["id_prefix"], "knowledge")
        self.assertEqual([item["kind"] for item in found["entities"]], ["data_flow"])
        (relation,) = found["relations"]
        self.assertEqual(relation["name"], "flow_step")
        self.assertNotIn("origin", relation)
        self.assertNotIn("occurrence_state", relation)

    def test_unknown_keys_are_refused(self) -> None:
        bad = declaration()
        bad["relations"][0]["roles"][0]["target"] = "flow"
        with self.assertRaises(ValueError):
            world.validate_declaration(bad)
        bad = declaration()
        bad["typo"] = 1
        with self.assertRaises(ValueError):
            world.validate_declaration(bad)

    def test_version_and_empties_are_refused(self) -> None:
        with self.assertRaises(ValueError):
            world.validate_declaration(declaration(version=2))
        with self.assertRaises(ValueError):
            world.validate_declaration(declaration(relations=[]))
        bad = declaration()
        bad["relations"][0]["roles"] = []
        with self.assertRaises(ValueError):
            world.validate_declaration(bad)
        bad = declaration()
        bad["entities"].append(dict(bad["entities"][0]))
        with self.assertRaises(ValueError):
            world.validate_declaration(bad)

    def test_reserved_unstated_is_refused(self) -> None:
        bad = declaration()
        bad["relations"][0]["origin"] = "UNSTATED"
        with self.assertRaises(ValueError):
            world.validate_declaration(bad)
        bad = declaration()
        bad["relations"][0]["occurrence_state"] = "UNSTATED"
        with self.assertRaises(ValueError):
            world.validate_declaration(bad)

    def test_missing_or_broken_files_are_refused(self) -> None:
        with self.assertRaises(ValueError):
            world.load_declaration(Path("/nonexistent/declaration.json"))
        with tempfile.TemporaryDirectory() as tmp:
            broken = Path(tmp) / "broken.json"
            broken.write_text("{not json", encoding="utf-8")
            with self.assertRaises(ValueError):
                world.load_declaration(broken)

    def test_duplicates_are_refused(self) -> None:
        bad = declaration()
        bad["relations"].append(dict(bad["relations"][0]))
        with self.assertRaises(ValueError):
            world.validate_declaration(bad)
        bad = declaration()
        bad["relations"][0]["roles"].append(dict(bad["relations"][0]["roles"][0]))
        with self.assertRaises(ValueError):
            world.validate_declaration(bad)

    def test_kind_colliding_with_relation_name_is_refused(self) -> None:
        bad = declaration()
        bad["entities"][0]["kind"] = "step"
        with self.assertRaises(ValueError):
            world.validate_declaration(bad)

    def test_colons_in_kinds_and_names_are_refused(self) -> None:
        bad = declaration()
        bad["entities"][0]["kind"] = "fl:ow"
        with self.assertRaises(ValueError):
            world.validate_declaration(bad)
        bad = declaration()
        bad["relations"][0]["name"] = "st:ep"
        with self.assertRaises(ValueError):
            world.validate_declaration(bad)


class TestDeclarationIdentity(unittest.TestCase):
    def test_formatting_equivalent_files_share_identity(self) -> None:
        base = declaration()
        with tempfile.TemporaryDirectory() as tmp:
            first = Path(tmp) / "a.json"
            second = Path(tmp) / "b.json"
            first.write_text(json.dumps(base, indent=2, sort_keys=True), encoding="utf-8")
            shuffled = {
                key: base[key] for key in ("relations", "entities", "world", "version")
            }
            second.write_text(json.dumps(shuffled), encoding="utf-8")
            one = world.load_declaration(first)
            two = world.load_declaration(second)
        self.assertEqual(world.declaration_fingerprint(one), world.declaration_fingerprint(two))
        self.assertEqual(
            world.build_world_id("flowtest", "0" * 64, one),
            world.build_world_id("flowtest", "0" * 64, two),
        )

    def test_reader_note_edits_keep_identity(self) -> None:
        noted = declaration(world={"id_prefix": "flowtest", "description": "a reader note"})
        self.assertEqual(
            world.declaration_fingerprint(declaration()),
            world.declaration_fingerprint(world.validate_declaration(noted)),
        )

    def test_meaningful_differences_move_identity(self) -> None:
        base = world.declaration_fingerprint(declaration())

        def differs(mutator) -> None:
            other = declaration()
            mutator(other)
            self.assertNotEqual(
                base, world.declaration_fingerprint(world.validate_declaration(other))
            )

        differs(lambda found: found["relations"][0]["roles"].pop())
        differs(lambda found: found["entities"][0].update(label_column="id"))
        differs(lambda found: found["relations"][0].update(origin="SEMANTIC"))
        differs(lambda found: found["relations"][0].update(occurrence_state="RECORDED"))
        differs(lambda found: found["relations"][0]["roles"].__setitem__(
            slice(None), list(reversed(found["relations"][0]["roles"]))))
        differs(lambda found: found["relations"][0].update(name="stride"))

    def test_world_id_keeps_the_file_fingerprint_identifiable(self) -> None:
        found = world.build_world_id("flowtest", "ab" * 32, declaration())
        prefix, rest = found.split(":")
        file_part, declaration_part = rest.split("+")
        self.assertEqual(prefix, "flowtest")
        self.assertEqual(file_part, "ab" * 6)
        self.assertEqual(len(declaration_part), 12)


class TestNamespaces(WorldCase):
    def test_model_refuses_collisions_and_colons(self) -> None:
        bad = declaration()
        bad["entities"][0]["kind"] = "step"
        with closing(world.connect(self.path)) as db, self.assertRaises(ValueError):
            world.Model(db, bad)
        bad = declaration()
        bad["entities"][0]["kind"] = "fl:ow"
        with closing(world.connect(self.path)) as db, self.assertRaises(ValueError):
            world.Model(db, bad)
        bad = declaration()
        bad["relations"][0]["name"] = "st:ep"
        with closing(world.connect(self.path)) as db, self.assertRaises(ValueError):
            world.Model(db, bad)

    def test_composite_tuple_keys_still_resolve(self) -> None:
        model = self.model()
        entry, parts = world.decode_id("step:F1/1", model.relations, "assertion")
        self.assertEqual(entry["name"], "step")
        self.assertEqual(parts, ["F1", 1])
        with closing(world.connect(self.path)) as db:
            one = world.assertion(db, model, "step:F1/1")
            grown = world.expand(db, model, "flow:F1", "step", 200)
        self.assertEqual(one["assertion_id"], "step:F1/1")
        self.assertEqual(
            [item["assertion_id"] for item in grown["tuples"]], ["step:F1/1", "step:F1/2"]
        )
        with self.assertRaises(world.NotFound):
            world.decode_id("step:F1", model.relations, "assertion")
        with self.assertRaises(world.NotFound):
            world.decode_id("missing:F1/1", model.relations, "assertion")


def declaration_omitted_scalar() -> dict:
    """The default declaration with scalar `target_kind` keys omitted."""
    found = declaration()
    for role in found["relations"][0]["roles"]:
        if role["target_kind"] is None:
            del role["target_kind"]
    return found


class TestOmittedTargetKind(WorldCase):
    def test_omitted_and_null_scalar_targets_read_identically(self) -> None:
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("INSERT INTO pair VALUES ('C', '1', NULL)")
            db.commit()
        outputs = {}
        for label, declared in (("omitted", declaration_omitted_scalar()), ("null", declaration())):
            with closing(world.connect(self.path)) as db:
                model = world.Model(db, world.validate_declaration(declared))
                schema = world.schema(db, model)
                window = world.rows(db, model, {"relation": ["step"]})
                expanded = world.expand(db, model, "flow:F1", "step", 10)
                single = world.assertion(db, model, window["rows"][0]["assertion_id"])
                referent = world.referent(db, model, "flow:F1")
            outputs[label] = (schema, window, expanded, single, referent)
        self.assertEqual(outputs["omitted"], outputs["null"])
        schema, window, _, single, referent = outputs["omitted"]
        roles = schema["relations"][0]["roles"]
        self.assertEqual([role["name"] for role in roles], ["flow", "seq", "who", "what"])
        self.assertEqual(roles[0]["type"], "REFERENT")
        self.assertEqual(roles[1]["type"], "INTEGER")
        self.assertEqual(roles[2]["type"], "TEXT")
        self.assertEqual(window["rows"][0]["values"], {"flow": "flow:F1", "seq": 1, "who": "browser", "what": "loads"})
        self.assertEqual(single["values"]["seq"], 1)
        self.assertTrue(all(field["value"] is not None for field in referent["fields"]))

    def test_null_scalar_value_survives_with_omitted_target(self) -> None:
        declared = declaration()
        declared["relations"].append({
            "name": "pair", "source": "pair", "key_columns": ["scope", "code"],
            "roles": [
                {"role": "scope", "column_name": "scope"},
                {"role": "code", "column_name": "code"},
                {"role": "label", "column_name": "label"},
            ],
        })
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("INSERT INTO pair VALUES ('C', '1', NULL)")
            db.commit()
        with closing(world.connect(self.path)) as db:
            model = world.Model(db, world.validate_declaration(declared))
            window = world.rows(db, model, {"relation": ["pair"], "order": ["scope"]})
        by_scope = {row["values"]["scope"]: row for row in window["rows"]}
        self.assertIsNone(by_scope["C"]["values"]["label"])
        self.assertEqual(by_scope["A"]["values"]["label"], "a-one")

    def test_unknown_target_and_missing_column_still_refused(self) -> None:
        bad = declaration()
        bad["relations"][0]["roles"][1]["target_kind"] = "nope"
        with self.assertRaises(ValueError):
            with closing(world.connect(self.path)) as db:
                world.Model(db, world.validate_declaration(bad))
        bad = declaration_omitted_scalar()
        bad["relations"][0]["roles"][1]["column_name"] = "missing"
        with self.assertRaises(ValueError):
            with closing(world.connect(self.path)) as db:
                world.Model(db, world.validate_declaration(bad))


class TestGeneratedColumns(WorldCase):
    def test_generated_column_works_as_scalar_role_and_label(self) -> None:
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("ALTER TABLE flow ADD COLUMN shout TEXT GENERATED ALWAYS AS (upper(name)) VIRTUAL")
            db.execute("ALTER TABLE hop ADD COLUMN shout TEXT GENERATED ALWAYS AS (upper(what)) VIRTUAL")
            db.commit()
        declared = declaration()
        declared["entities"][0]["label_column"] = "shout"
        declared["relations"][0]["roles"].append({"role": "shout", "column_name": "shout"})
        with closing(world.connect(self.path)) as db:
            model = world.Model(db, world.validate_declaration(declared))
            schema = world.schema(db, model)
            window = world.rows(db, model, {"relation": ["step"]})
            referent = world.referent(db, model, "flow:F1")
            self.assertEqual(referent["label"], "FIRST")
        roles = {role["name"]: role for role in schema["relations"][0]["roles"]}
        self.assertEqual(roles["shout"]["type"], "TEXT")
        self.assertFalse(roles["shout"]["referent"])
        self.assertEqual(window["rows"][0]["values"]["shout"], "LOADS")


class TestGenericModel(WorldCase):
    def test_rows_pagination_bounds(self) -> None:
        with closing(world.connect(self.path)) as db:
            model = self.model()
            default = world.rows(db, model, {"relation": ["step"]})
            self.assertEqual((default["total"], default["offset"], len(default["rows"])), (3, 0, 3))
            for query in (
                {"relation": ["step"], "limit": ["-1"]},
                {"relation": ["step"], "limit": ["0"]},
                {"relation": ["step"], "limit": ["abc"]},
                {"relation": ["step"], "limit": ["1.5"]},
                {"relation": ["step"], "offset": ["-1"]},
                {"relation": ["step"], "offset": ["x"]},
            ):
                with self.assertRaises(world.BadRequest, msg=str(query)):
                    world.rows(db, model, query)
            clamped = world.rows(db, model, {"relation": ["step"], "limit": ["999999999"]})
            self.assertEqual(len(clamped["rows"]), 3)
            self.assertEqual(clamped["offset"], 0)
            past = world.rows(db, model, {"relation": ["step"], "offset": ["50"]})
            self.assertEqual((past["total"], past["offset"], past["rows"]), (3, 50, []))
            page1 = world.rows(db, model, {"relation": ["step"], "limit": ["2"], "offset": ["0"]})
            page2 = world.rows(db, model, {"relation": ["step"], "limit": ["2"], "offset": ["2"]})
            joined = [row["assertion_id"] for row in page1["rows"] + page2["rows"]]
            self.assertEqual(joined, [row["assertion_id"] for row in default["rows"]])
            searched = world.rows(db, model, {"relation": ["step"], "search": ["proxy"], "limit": ["1"]})
            self.assertEqual((searched["total"], len(searched["rows"])), (1, 1))
            ordered = world.rows(db, model, {"relation": ["step"], "order": ["seq"], "desc": ["1"], "limit": ["2"]})
            self.assertEqual([row["values"]["seq"] for row in ordered["rows"]], [2, 1])
            narrowed = world.rows(db, model, {"relation": ["step"], "subject": ["flow:F1"], "limit": ["1"], "offset": ["1"]})
            self.assertEqual((narrowed["total"], narrowed["offset"], len(narrowed["rows"])), (2, 1, 1))

    def test_overview_reports_no_governance_model(self) -> None:
        # No governance model was supplied to this generic World: the
        # nullable overview field says so, instead of advertising a
        # synthetic zero-count governance collection. The compatibility
        # obligations endpoint itself keeps answering with an empty list.
        with closing(world.connect(self.path)) as db:
            model = self.model()
            found = world.overview(db, model, "flowtest:abc")
            _, collection = world.route("/world/obligations", {}, db, model, "flowtest:abc")
            _, single = world.route("/world/obligation", {"obligation_id": ["missing:1"]}, db, model, "flowtest:abc")
        self.assertIsNone(found["governed_obligations"])
        self.assertEqual(collection["obligations"], [])
        self.assertIsNone(single)

    def test_declared_occurrence_state_reaches_tuple_reads(self) -> None:
        declared = declaration()
        declared["relations"][0]["occurrence_state"] = "PROPOSED"
        with closing(world.connect(self.path)) as db:
            model = world.Model(db, world.validate_declaration(declared))
            window = world.rows(db, model, {"relation": ["step"]})
            expanded = world.expand(db, model, "flow:F1", "step", 10)
            single = world.assertion(db, model, window["rows"][0]["assertion_id"])
            referent = world.referent(db, model, "flow:F1")
        for row in window["rows"]:
            self.assertEqual(row["occurrence_state"], "PROPOSED")
        for item in expanded["tuples"]:
            self.assertEqual(item["occurrence_state"], "PROPOSED")
        self.assertEqual(single["occurrence_state"], "PROPOSED")
        self.assertTrue(referent["fields"])
        for field in referent["fields"]:
            self.assertEqual(field["occurrence_state"], "PROPOSED")

    def test_undeclared_occurrence_state_stays_absent_from_tuple_reads(self) -> None:
        with closing(world.connect(self.path)) as db:
            model = self.model()
            window = world.rows(db, model, {"relation": ["step"]})
            expanded = world.expand(db, model, "flow:F1", "step", 10)
            single = world.assertion(db, model, window["rows"][0]["assertion_id"])
            referent = world.referent(db, model, "flow:F1")
        for row in window["rows"]:
            self.assertNotIn("occurrence_state", row)
        for item in expanded["tuples"]:
            self.assertNotIn("occurrence_state", item)
        self.assertNotIn("occurrence_state", single)
        for field in referent["fields"]:
            self.assertNotIn("occurrence_state", field)

    def test_external_declaration_serves_counts(self) -> None:
        with closing(world.connect(self.path)) as db:
            found = world.overview(db, self.model(), "flowtest:abc")
        self.assertEqual(found["relations"], 1)
        self.assertEqual(found["referents"], 2)
        self.assertEqual(found["assertions"], 3)
        self.assertEqual(found["demand"], None)
        with closing(world.connect(self.path)) as db:
            window = world.rows(db, self.model(), {"relation": ["step"]})
        self.assertEqual(window["total"], 3)
        self.assertEqual(window["rows"][0]["values"]["flow"], "flow:F1")

    def test_missing_declaration_is_refused(self) -> None:
        with closing(world.connect(self.path)) as db:
            with self.assertRaises(ValueError):
                world.Model(db, {})  # type: ignore[arg-type]
            with self.assertRaises(ValueError):
                world.Model(db, declaration(relations=[]))

    def test_two_declarations_over_identical_bytes_get_distinct_worlds(self) -> None:
        """Same file, two readings: both serve, neither shares an identity."""
        narrow = declaration()
        narrow["relations"][0]["roles"] = narrow["relations"][0]["roles"][:2]
        wide = declaration()
        with closing(world.connect(self.path)) as db:
            narrow_model = world.Model(db, world.validate_declaration(narrow))
            wide_model = world.Model(db, world.validate_declaration(wide))
            narrow_found = world.overview(
                db, narrow_model, world.build_world_id("flowtest", self.before, narrow)
            )
            wide_found = world.overview(
                db, wide_model, world.build_world_id("flowtest", self.before, wide)
            )
        self.assertEqual(narrow_found["assertions"], 3)
        self.assertEqual(wide_found["assertions"], 3)
        self.assertNotEqual(narrow_found["world_id"], wide_found["world_id"])
        for found in (narrow_found, wide_found):
            self.assertTrue(found["world_id"].startswith(f"flowtest:{self.before[:12]}+"))
        self.assertEqual(sha256(self.path), self.before)

    def test_embedded_tables_are_never_read(self) -> None:
        """ki_* tables in the file are producer data, not a declaration."""
        scratch = self.scratch()
        db = sqlite3.connect(scratch)
        db.executescript(
            """
            CREATE TABLE ki_entity(kind TEXT PRIMARY KEY, source TEXT, key_columns TEXT, label_column TEXT);
            CREATE TABLE ki_relation(name TEXT PRIMARY KEY, source TEXT, key_columns TEXT);
            CREATE TABLE ki_role(relation TEXT, role TEXT, column_name TEXT, target_kind TEXT);
            INSERT INTO ki_entity VALUES ('sneaky', 'flow', 'id', 'name');
            INSERT INTO ki_relation VALUES ('sneaky_rel', 'hop', 'flow_id, seq');
            INSERT INTO ki_role VALUES ('sneaky_rel', 'flow', 'flow_id', 'sneaky');
            """
        )
        db.commit()
        db.close()
        with closing(world.connect(scratch)) as ro:
            model = world.Model(ro, declaration())
            self.assertEqual(sorted(model.relations), ["step"])
            with self.assertRaises(ValueError):
                world.Model(ro, {})  # type: ignore[arg-type]

    def test_unknown_sources_columns_and_targets_are_refused(self) -> None:
        bad = declaration()
        bad["relations"][0]["source"] = "missing"
        with closing(world.connect(self.path)) as db, self.assertRaises(ValueError):
            world.Model(db, bad)
        bad = declaration()
        bad["relations"][0]["key_columns"] = ["flow_id", "nope"]
        with closing(world.connect(self.path)) as db, self.assertRaises(ValueError):
            world.Model(db, bad)
        bad = declaration()
        bad["relations"][0]["roles"][0]["column_name"] = "nope"
        with closing(world.connect(self.path)) as db, self.assertRaises(ValueError):
            world.Model(db, bad)
        bad = declaration()
        bad["relations"][0]["roles"][0]["target_kind"] = "missing"
        with closing(world.connect(self.path)) as db, self.assertRaises(ValueError):
            world.Model(db, bad)
        bad = declaration()
        bad["entities"][0]["label_column"] = "missing"
        with closing(world.connect(self.path)) as db, self.assertRaises(ValueError):
            world.Model(db, bad)

    def test_null_and_duplicate_keys_are_refused(self) -> None:
        scratch = self.scratch()
        db = sqlite3.connect(scratch)
        db.execute("CREATE TABLE loose (k TEXT, v TEXT)")
        db.execute("INSERT INTO loose VALUES (NULL, 'x'), ('a', 'y')")
        db.commit()
        db.close()
        bad = declaration(relations=[
            {
                "name": "step", "source": "loose", "key_columns": ["k"],
                "roles": [{"role": "v", "column_name": "v", "target_kind": None}],
            }
        ])
        with closing(world.connect(scratch)) as ro, self.assertRaises(ValueError):
            world.Model(ro, bad)
        db = sqlite3.connect(scratch)
        db.execute("DELETE FROM loose")
        db.execute("INSERT INTO loose VALUES ('a', 'x'), ('a', 'y')")
        db.commit()
        db.close()
        with closing(world.connect(scratch)) as ro, self.assertRaises(ValueError):
            world.Model(ro, bad)

    def test_null_and_dangling_participants_are_refused(self) -> None:
        scratch = self.scratch()
        db = sqlite3.connect(scratch)
        db.execute("INSERT INTO hop VALUES ('F-?', 9, 'ghost', 'nowhere')")
        db.commit()
        db.close()
        with closing(world.connect(scratch)) as ro, self.assertRaises(ValueError):
            world.Model(ro, declaration())

    def test_composite_key_targets_are_refused(self) -> None:
        bad = declaration(
            entities=[
                {
                    "kind": "pair", "source": "pair",
                    "key_columns": ["scope", "code"], "label_column": "label",
                }
            ],
            relations=[
                {
                    "name": "step", "source": "hop", "key_columns": ["flow_id", "seq"],
                    "roles": [
                        {"role": "p", "column_name": "flow_id", "target_kind": "pair"},
                    ],
                }
            ],
        )
        with closing(world.connect(self.path)) as db, self.assertRaises(ValueError):
            world.Model(db, bad)

    def test_undeclared_origin_and_state_stay_unstated(self) -> None:
        model = self.model()
        with closing(world.connect(self.path)) as db:
            one = world.assertion(db, model, "step:F1/1")
            window = world.rows(db, model, {"relation": ["step"]})
            (relation,) = world.schema(db, model)["relations"]
            found = world.overview(db, model, "flowtest:abc")
        self.assertEqual(one["origin"], "UNSTATED")
        self.assertNotIn("origins", one)
        self.assertNotIn("occurrence_state", one)
        self.assertNotIn("SEMANTIC", json.dumps(window))
        self.assertNotIn("RECORDED", json.dumps(window))
        self.assertEqual(relation["origins"], [])
        self.assertEqual(found["origins"], {})
        self.assertEqual(one["warrant"]["assertion_origin"], "UNSTATED")
        self.assertEqual(one["warrant"]["construction_origins"], [])
        self.assertEqual(one["warrant"]["bases"], [])
        self.assertEqual(one["assertion_state"], "UNKNOWN")

    def test_declared_origin_and_state_are_served(self) -> None:
        declared = declaration()
        declared["relations"][0]["origin"] = "SEMANTIC"
        declared["relations"][0]["occurrence_state"] = "RECORDED"
        model = self.model(declared)
        with closing(world.connect(self.path)) as db:
            one = world.assertion(db, model, "step:F1/1")
            found = world.overview(db, model, "flowtest:abc")
        self.assertEqual(one["origin"], "SEMANTIC")
        self.assertEqual(one["origins"], ["SEMANTIC"])
        self.assertEqual(one["occurrence_state"], "RECORDED")
        self.assertEqual(found["origins"], {"SEMANTIC": 3})

    def test_grounding_cites_source_rows(self) -> None:
        with closing(world.connect(self.path)) as db:
            one = world.assertion(db, self.model(), "step:F1/2")
            person = world.referent(db, self.model(), "flow:F1")
        (grounding,) = one["grounding"]
        self.assertEqual(grounding["native_handle"], "SQLite")
        self.assertEqual(grounding["native_location"], "row flow_id=F1, seq=2 in hop")
        self.assertEqual(
            person["grounding"][0]["native_location"], "row id=F1 in flow"
        )


class TestIdentitySafety(WorldCase):
    def keyed_declaration(self, column_type, records, keys=("k",), entity=True):
        """All writes are to WorldCase's disposable synthetic source."""
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("DROP TABLE IF EXISTS keyed")
            db.execute(f"CREATE TABLE keyed(k {column_type}, tail TEXT, label)")
            db.executemany("INSERT INTO keyed VALUES (?, ?, ?)", records)
            db.commit()
        declared = declaration()
        entry = {"source": "keyed", "key_columns": list(keys)}
        if entity:
            declared["entities"].append({"kind": "record", **entry, "label_column": "label"})
        else:
            declared["relations"].append({
                "name": "record", **entry,
                "roles": [{"role": "value", "column_name": "label", "target_kind": None}],
            })
        return declared

    def test_sql_unique_integer_and_text_encoded_collision_is_refused(self):
        for entity in (True, False):
            with self.subTest(entity=entity):
                declared = self.keyed_declaration("BLOB", [(1, "a", None), ("1", "b", None)], entity=entity)
                before = sha256(self.path)
                with closing(world.connect(self.path)) as db:
                    self.assertEqual(db.execute("SELECT COUNT(*) FROM (SELECT k FROM keyed GROUP BY k)").fetchone()[0], 2)
                    with self.assertRaisesRegex(ValueError, r"(?:entity|relation) record.*source 'keyed'.*key columns.*encoded identifier collision"):
                        world.Model(db, declared)
                self.assertEqual(sha256(self.path), before)

    def test_composite_component_collision_is_refused_even_with_distinct_full_ids(self):
        for entity in (True, False):
            with self.subTest(entity=entity):
                declared = self.keyed_declaration("BLOB", [(1, "a", None), ("1", "b", None)], ("k", "tail"), entity)
                self.assertNotEqual(world.encode_id("record", [1, "a"]), world.encode_id("record", ["1", "b"]))
                with closing(world.connect(self.path)) as db, self.assertRaisesRegex(ValueError, r"key columns \['k', 'tail'\].*collision in component 'k'"):
                    world.Model(db, declared)

    def test_blob_components_are_refused_for_entities_and_occurrences(self):
        for entity in (True, False):
            for keys in (("k",), ("tail", "k")):
                with self.subTest(entity=entity, keys=keys):
                    declared = self.keyed_declaration("BLOB", [(b"ab", "second", None)], keys, entity)
                    with closing(world.connect(self.path)) as db, self.assertRaisesRegex(ValueError, r"source 'keyed'.*key columns.*unsupported identity component 'k'.*bytes"):
                        world.Model(db, declared)

    def test_cli_refuses_blob_identity_before_serving_with_source_context(self):
        declared = self.keyed_declaration("BLOB", [(b"ab", "a", None)])
        config = Path(self.tmp.name) / "declaration.json"
        config.write_text(json.dumps(declared), encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(ROOT / "adapters/world/server.py"),
             "--db", str(self.path), "--declaration", str(config), "--port", "0"],
            capture_output=True, text=True, timeout=10,
        )
        self.assertNotEqual(result.returncode, 0)
        for text in ("cannot serve", "entity record", "source 'keyed'", "key columns ['k']", "unsupported identity component"):
            self.assertIn(text, result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertNotIn("sqlite world:", result.stdout)

    def test_integer_in_no_affinity_column_is_refused_when_decoder_cannot_resolve_it(self):
        declared = self.keyed_declaration("BLOB", [(1, "a", None)])
        with closing(world.connect(self.path)) as db, self.assertRaisesRegex(ValueError, "round-trip to exactly one source record"):
            world.Model(db, declared)

    def test_incompatible_declared_decoder_and_storage_are_refused(self):
        for entity in (True, False):
            with self.subTest(entity=entity):
                declared = self.keyed_declaration("INTEGER", [("not-an-integer", "a", None)], entity=entity)
                with closing(world.connect(self.path)) as db, self.assertRaisesRegex(ValueError, "cannot round-trip through the current decoder"):
                    world.Model(db, declared)

    def test_nonfinite_real_keys_are_refused(self):
        for value in (float("inf"), -float("inf")):
            declared = self.keyed_declaration("REAL", [(value, "a", None)])
            with closing(world.connect(self.path)) as db, self.assertRaisesRegex(ValueError, "finite REAL required"):
                world.Model(db, declared)

    def test_decoding_to_a_different_existing_record_is_refused(self):
        # SQLite gives REAL TEXT a TEXT affinity; the present decoder sees
        # REAL and binds a float. '1' would incorrectly read the '1.0' row.
        for entity in (True, False):
            with self.subTest(entity=entity):
                declared = self.keyed_declaration("REAL TEXT", [("1", "a", "first"), ("1.0", "b", "second")], entity=entity)
                with closing(world.connect(self.path)) as db, self.assertRaisesRegex(ValueError, "does not round-trip to its source key"):
                    world.Model(db, declared)

    def test_supported_storage_and_affinity_round_trip_to_the_original_record(self):
        for column_type, value in (("INTEGER", 1), ("NUMERIC", 1), ("TEXT", "001"), ("BLOB", "text"), ("REAL", 1.25)):
            for entity in (True, False):
                with self.subTest(column_type=column_type, value=value, entity=entity):
                    declared = self.keyed_declaration(column_type, [(value, "a", "label")], entity=entity)
                    with closing(world.connect(self.path)) as db:
                        model = world.Model(db, declared)
                        identifier = "record:" + quote(str(value), safe="")
                        pool = model.entities if entity else model.relations
                        entry, decoded = world.decode_id(identifier, pool, "record")
                        row = world.fetch_row(db, entry, decoded)
                        self.assertIs(type(row["k"]), type(value))
                        self.assertEqual(row["k"], value)
                        self.assertEqual(row["label"], "label")
                        if entity:
                            self.assertIn(identifier, [r["id"] for r in world.referents(db, model)["referents"]])
                        else:
                            self.assertEqual(world.assertion(db, model, identifier)["values"]["value"], "label")

    def test_reserved_text_components_and_composite_ids_preserve_source_identity(self):
        values = ["", " /% ,:#?&+= Ω\n", "a/b", "a%2Fb", "comma,value", "nul\x00key"]
        for entity in (True, False):
            declared = self.keyed_declaration("TEXT", [(v, "tail/% Ω", v) for v in values], ("k", "tail"), entity)
            with closing(world.connect(self.path)) as db:
                model = world.Model(db, declared)
                pool = model.entities if entity else model.relations
                ids = []
                for value in values:
                    identifier = "record:" + quote(value, safe="") + "/tail%2F%25%20%CE%A9"
                    entry, decoded = world.decode_id(identifier, pool, "record")
                    row = world.fetch_row(db, entry, decoded)
                    self.assertEqual((row["k"], row["tail"]), (value, "tail/% Ω"))
                    ids.append(identifier)
                self.assertEqual(len(set(ids)), len(values))

    def numeric_declaration(self, label_column=None):
        with closing(sqlite3.connect(self.path)) as db:
            db.executescript("""
                CREATE TABLE numbered(id INTEGER PRIMARY KEY, label, note TEXT);
                CREATE TABLE numbered_event(id INTEGER PRIMARY KEY, participant, note TEXT);
                INSERT INTO numbered VALUES (1, 7.5, 'first'), (2, NULL, 'second');
                INSERT INTO numbered_event VALUES (10, 1, 'event');
            """)
            db.commit()
        entity = {"kind": "number", "source": "numbered", "key_columns": ["id"]}
        if label_column is not None:
            entity["label_column"] = label_column
        return declaration(entities=[entity], relations=[{
            "name": "event", "source": "numbered_event", "key_columns": ["id"],
            "roles": [{"role": "participant", "column_name": "participant", "target_kind": "number"}],
        }])

    def test_integer_keys_directory_participants_and_reads_keep_existing_ids(self):
        declared = self.numeric_declaration()
        with closing(world.connect(self.path)) as db:
            model = world.Model(db, declared)
            self.assertEqual(world.referents(db, model)["referents"], [{"id": "number:1", "label": "1"}, {"id": "number:2", "label": "2"}])
            one = world.assertion(db, model, "event:10")
            self.assertEqual(one["values"], {"participant": "number:1"})
            self.assertEqual(one["grounding"][0]["detail"]["key"], {"id": 10})
            detail = world.referent(db, model, "number:1")
            self.assertEqual(detail["grounding"][0]["detail"]["key"], {"id": 1})
            self.assertEqual([r["assertion_id"] for r in world.expand(db, model, "number:1", "event", 10)["tuples"]], ["event:10"])

    def test_numeric_default_labels_are_strings_on_all_label_reads(self):
        declared = self.numeric_declaration()
        with closing(world.connect(self.path)) as db:
            model = world.Model(db, declared)
            self.assertEqual(world.referents(db, model)["referents"][0]["label"], "1")
            self.assertEqual(world.labels(db, model, "number:1,number:2,number:99")["labels"], {"number:1": "1", "number:2": "2", "number:99": None})
            self.assertEqual(world.search(db, model, "1", 10)["results"][0]["label"], "1")
            self.assertEqual(world.search(db, model, "zzz", 10)["results"], [])
            self.assertEqual(world.referent(db, model, "number:1")["label"], "1")

    def test_explicit_numeric_and_null_labels_are_preserved_as_display_text_or_absence(self):
        declared = self.numeric_declaration("label")
        with closing(world.connect(self.path)) as db:
            model = world.Model(db, declared)
            self.assertEqual(world.referents(db, model)["referents"], [{"id": "number:1", "label": "7.5"}, {"id": "number:2", "label": None}])
            self.assertEqual(world.labels(db, model, "number:1,number:2")["labels"], {"number:1": "7.5", "number:2": None})
            self.assertEqual(world.search(db, model, "7.5", 10)["results"][0]["label"], "7.5")
            self.assertIsNone(world.referent(db, model, "number:2")["label"])
            self.assertEqual(db.execute("SELECT typeof(label) FROM numbered WHERE id=1").fetchone()[0], "real")

    def test_binary_labels_are_previews_not_binary_identities(self):
        declared = self.keyed_declaration("INTEGER", [(1, "a", b"ab")])
        with closing(world.connect(self.path)) as db:
            model = world.Model(db, declared)
            expected = "[BLOB 2 bytes; sha256=fb8e20fc2e4c3f]"
            self.assertEqual(world.referents(db, model)["referents"][-1]["label"], expected)
            self.assertEqual(world.labels(db, model, "record:1")["labels"]["record:1"], expected)
            self.assertEqual(world.search(db, model, "BLOB", 10)["results"][0]["label"], expected)
            self.assertEqual(world.referent(db, model, "record:1")["label"], expected)
            self.assertEqual(world.referent(db, model, "record:1")["grounding"][0]["detail"]["key"], {"k": 1})

    def test_text_labels_are_not_normalized_and_zero_is_not_absence(self):
        self.assertEqual(world.label_out("  Label Ω\n"), "  Label Ω\n")
        self.assertEqual(world.label_out(""), "")
        self.assertEqual(world.label_out(0), "0")
        self.assertIsNone(world.label_out(None))

    def test_real_participant_uses_safe_canonical_integer_target(self):
        declared = self.numeric_declaration()
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("UPDATE numbered_event SET participant=1.0")
            db.commit()
        with closing(world.connect(self.path)) as db:
            model = world.Model(db, declared)
            one = world.assertion(db, model, "event:10")
            self.assertEqual(one["values"], {"participant": "number:1"})
            self.assertEqual(one["grounding"][0]["detail"]["reference_participants"]["participant"],
                             {"column": "participant", "value": 1.0, "storage_class": "real"})

    def test_sql_equal_participant_storage_classes_are_checked_separately(self):
        declared = self.numeric_declaration()
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("INSERT INTO numbered_event VALUES(20,1.0,'real participant')")
            db.commit()
        with closing(world.connect(self.path)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM (SELECT DISTINCT participant FROM numbered_event)").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT typeof(participant) FROM numbered_event ORDER BY id").fetchall()[1][0], "real")
            model = world.Model(db, declared)
            self.assertEqual(len(model.relations["event"]["references"]["participant"]), 2)
            self.assertEqual(world.assertion(db, model, "event:10")["values"], {"participant": "number:1"})
            self.assertEqual(world.assertion(db, model, "event:20")["values"], {"participant": "number:1"})
            self.assertEqual(world.assertion(db, model, "event:20")["grounding"][0]["detail"]["reference_participants"]["participant"]["storage_class"], "real")

    def test_nocase_reference_uses_canonical_target(self):
        with closing(sqlite3.connect(self.path)) as db:
            db.executescript("""
                CREATE TABLE case_target(id TEXT COLLATE NOCASE PRIMARY KEY);
                CREATE TABLE case_event(id INTEGER PRIMARY KEY, participant TEXT);
                INSERT INTO case_target VALUES ('ABC');
                INSERT INTO case_event VALUES (1, 'abc');
            """)
            db.commit()
        declared = declaration(entities=[{"kind": "case", "source": "case_target", "key_columns": ["id"]}], relations=[{
            "name": "case_link", "source": "case_event", "key_columns": ["id"],
            "roles": [{"role": "participant", "column_name": "participant", "target_kind": "case"}],
        }])
        with closing(world.connect(self.path)) as db:
            model = world.Model(db, declared)
            self.assertEqual(world.referents(db, model)["referents"][0]["id"], "case:ABC")
            self.assertEqual(world.assertion(db, model, "case_link:1")["values"]["participant"], "case:ABC")
            self.assertEqual(world.referent(db, model, "case:ABC")["grounding"][0]["detail"]["key"], {"id": "ABC"})
            with self.assertRaises(world.NotFound):
                world.referent(db, model, "case:abc")

    def test_affinity_reference_uses_canonical_target(self):
        declared = self.numeric_declaration()
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("UPDATE numbered_event SET participant='01'")
            db.commit()
        with closing(world.connect(self.path)) as db:
            model = world.Model(db, declared)
            self.assertEqual(world.referents(db, model)["referents"][0]["id"], "number:1")
            self.assertEqual(world.assertion(db, model, "event:10")["values"]["participant"], "number:1")
            self.assertEqual(world.referent(db, model, "number:1")["grounding"][0]["detail"]["key"], {"id": 1})
            with self.assertRaises(world.NotFound):
                world.referent(db, model, "number:01")


class TestArchivedIdentity(unittest.TestCase):
    def test_original_and_repaired_run001_identifiers_are_unchanged(self):
        declared = world.load_declaration(ROOT / "interop-runs/run-001/inspector-consumer/declaration.json")
        for folder, expected_count in (("producer", 196), ("repair", 201)):
            with self.subTest(artifact=folder):
                path = ROOT / "interop-runs/run-001" / folder / "knowledge.sqlite"
                before = sha256(path)
                sidecars = sorted(path.parent.glob(path.name + "*"))
                with closing(world.connect(path)) as db:
                    model = world.Model(db, declared)
                    records = db.execute("SELECT test_file, target_path FROM test_link ORDER BY test_file,target_path").fetchall()
                    expected = ["test_imports:" + quote(row[0], safe="") + "/" + quote(row[1], safe="") for row in records]
                    actual = world.rows(db, model, {"relation": ["test_imports"], "limit": ["500"]})["rows"]
                    self.assertEqual([r["assertion_id"] for r in actual], expected)
                    self.assertEqual(len(expected), expected_count)
                    for row, identifier in zip(records, expected):
                        one = world.assertion(db, model, identifier)
                        self.assertEqual(one["grounding"][0]["detail"]["key"], {"test_file": row[0], "target_path": row[1]})
                        self.assertEqual(one["values"], {"test": "test_file:" + quote(row[0], safe=""), "target": "source_file:" + quote(row[1], safe="")})
                    for item in world.referents(db, model)["referents"]:
                        kind, encoded = item["id"].split(":", 1)
                        detail = world.referent(db, model, item["id"])
                        key = detail["grounding"][0]["detail"]["key"]
                        self.assertEqual(item["id"], kind + ":" + quote(next(iter(key.values())), safe=""))
                self.assertEqual(sha256(path), before)
                self.assertEqual(sorted(path.parent.glob(path.name + "*")), sidecars)


class TestFrozenArtifact(unittest.TestCase):
    """Run 000 acceptance: the frozen file, read through Model/routes here
    and through a private startup snapshot in the KI-003 identity test."""

    def setUp(self) -> None:
        path = os.environ.get("KI_KNOWLEDGE_SQLITE", "")
        if not path or not Path(path).is_file():
            self.skipTest("requires KI_KNOWLEDGE_SQLITE naming the frozen knowledge.sqlite")
        self.path = Path(path)
        self.before = sha256(self.path)
        self.sidecars_before = sorted(
            p.name for p in self.path.parent.glob(self.path.name + "*")
        )

    def test_flow_step_in_place(self) -> None:
        declared = world.load_declaration(KNOWLEDGE_DECLARATION)
        world_id = world.build_world_id("knowledge", self.before, declared)
        self.assertTrue(world_id.startswith(f"knowledge:{self.before[:12]}+"))
        self.assertEqual(len(world_id.split("+")[1]), 12)
        with closing(world.connect(self.path)) as db:
            model = world.Model(db, declared)
            found = world.overview(db, model, world_id)
            schema = world.schema(db, model)
            window = world.rows(db, model, {"relation": ["flow_step"]})
            one = world.assertion(db, model, "flow_step:F1/1")
            flow = world.referent(db, model, "data_flow:F1")
            grown = world.expand(db, model, "data_flow:F1", "flow_step", 200)
        self.assertEqual(found["relations"], 1)
        self.assertEqual(found["referents"], 5)
        self.assertEqual(found["assertions"], 19)
        self.assertEqual(window["total"], 19)
        self.assertEqual(len(grown["tuples"]), 5)
        self.assertEqual(one["values"]["flow"], "data_flow:F1")
        self.assertEqual(
            one["grounding"][0]["native_location"], "row flow_id=F1, seq=1 in flow_hop"
        )
        self.assertEqual(
            flow["grounding"][0]["native_location"], "row id=F1 in data_flow"
        )
        self.assertEqual(found["demand"], None)
        # Adapter-authored surfaces carry no herbarium purpose text and no
        # stance or origin claims. (Producer row VALUES may mention the
        # expedition — the adapter serves them faithfully, not silently.)
        authored = json.dumps({"found": found, "schema": schema})
        for word in ("SEMANTIC", "RECORDED", "determination", "herbarium", "expedition"):
            self.assertNotIn(word, authored)
        self.assertNotIn("occurrence_state", json.dumps(one))

    def test_snapshot_identity_is_snapshot_derived_and_deterministic(self):
        # KI-003 compatibility gate, measured on this frozen source: the
        # snapshot-backed World ID intentionally differs from the historical
        # producer-bytes ID (backup output is a logically equal, physically
        # distinct file), while identical restarts reproduce it exactly.
        # See docs/SNAPSHOT_CONSISTENCY.md for the integration decision.
        declared = world.load_declaration(KNOWLEDGE_DECLARATION)
        prepared = world.prepare_world(self.path, declared)
        try:
            historical = world.build_world_id("knowledge", self.before, declared)
            self.assertNotEqual(prepared.world_id, historical)
            self.assertTrue(prepared.world_id.startswith("knowledge:"))
            again = world.prepare_world(self.path, declared)
            try:
                self.assertEqual(prepared.world_id, again.world_id)
            finally:
                again.cleanup()
            with closing(world.connect_snapshot(prepared.snapshot_path)) as db:
                found = world.overview(db, prepared.model, prepared.world_id)
                self.assertEqual(found["assertions"], 19)
                self.assertEqual(found["world_id"], prepared.world_id)
        finally:
            prepared.cleanup()

    def test_all_run000_keys_keep_existing_identifiers_and_source_records(self):
        declared = world.load_declaration(KNOWLEDGE_DECLARATION)
        with closing(world.connect(self.path)) as db:
            model = world.Model(db, declared)
            entities = db.execute("SELECT id FROM data_flow ORDER BY id").fetchall()
            expected_entities = ["data_flow:" + quote(row[0], safe="") for row in entities]
            self.assertEqual([row["id"] for row in world.referents(db, model)["referents"]], expected_entities)
            for row, identifier in zip(entities, expected_entities):
                detail = world.referent(db, model, identifier)
                self.assertEqual(detail["grounding"][0]["detail"]["key"], {"id": row[0]})
            occurrences = db.execute("SELECT flow_id,seq FROM flow_hop ORDER BY flow_id,seq").fetchall()
            expected_occurrences = ["flow_step:" + quote(row[0], safe="") + "/" + str(row[1]) for row in occurrences]
            self.assertEqual([row["assertion_id"] for row in world.rows(db, model, {"relation": ["flow_step"]})["rows"]], expected_occurrences)
            for row, identifier in zip(occurrences, expected_occurrences):
                one = world.assertion(db, model, identifier)
                self.assertEqual(one["grounding"][0]["detail"]["key"], {"flow_id": row[0], "seq": row[1]})

    def tearDown(self) -> None:
        if hasattr(self, "path"):
            self.assertEqual(sha256(self.path), self.before)
            self.assertEqual(
                sorted(p.name for p in self.path.parent.glob(self.path.name + "*")),
                self.sidecars_before,
            )


class TestHttpPlane(WorldCase):
    def setUp(self) -> None:
        super().setUp()
        declared_path = Path(self.tmp.name) / "declaration.json"
        declared_path.write_text(json.dumps(declaration()), encoding="utf-8")
        world.Handler.db_path = self.path
        world.Handler.fingerprint = world.file_sha256(self.path)
        with closing(world.connect(self.path)) as db:
            world.Handler.model = world.Model(db, world.load_declaration(declared_path))
        world.Handler.world_id = "flowtest:test"
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), world.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.root = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        super().tearDown()

    def _raw(self, path: str, host: str | None = None, origin: str | None = None) -> int:
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        try:
            conn.putrequest("GET", path, skip_host=True)
            conn.putheader("Host", host if host is not None else f"127.0.0.1:{self.server.server_port}")
            if origin is not None:
                conn.putheader("Origin", origin)
            conn.endheaders()
            response = conn.getresponse()
            response.read()
            return response.status
        finally:
            conn.close()

    def test_rows_rejects_bad_pagination_over_http(self) -> None:
        self.assertEqual(self._raw("/world/rows?relation=step&limit=-1"), 400)
        self.assertEqual(self._raw("/world/rows?relation=step&limit=0"), 400)
        self.assertEqual(self._raw("/world/rows?relation=step&offset=-2"), 400)
        self.assertEqual(self._raw("/world/rows?relation=step&limit=many"), 400)
        self.assertEqual(self._raw("/world/rows?relation=step&limit=999999999"), 200)

    def test_endpoints_errors_and_write_rejection(self) -> None:
        with urlopen(self.root + "/world/schema") as response:
            found = json.load(response)
        self.assertEqual(len(found["relations"]), 1)
        with urlopen(self.root + "/world/overview") as response:
            overview = json.load(response)
        self.assertEqual(overview["demand"], None)
        with urlopen(self.root + "/world/demand") as response:
            self.assertEqual(json.load(response), {"demand": None})
        with self.assertRaises(HTTPError) as missing:
            urlopen(self.root + "/world/rows?relation=missing")
        self.assertEqual(missing.exception.code, 400)
        with self.assertRaises(HTTPError) as gone:
            urlopen(self.root + "/world/assertion?id=step:F9/9")
        self.assertEqual(gone.exception.code, 404)
        with self.assertRaises(HTTPError) as rejected:
            urlopen(Request(self.root + "/world/schema", data=b"{}", method="POST"))
        self.assertEqual(rejected.exception.code, 405)

    def test_loopback_gate_and_no_cors(self) -> None:
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        try:
            conn.request("GET", "/world/overview")
            response = conn.getresponse()
            response.read()
            names = {name.lower() for name, _ in response.getheaders()}
        finally:
            conn.close()
        self.assertNotIn("access-control-allow-origin", names)
        self.assertEqual(self._raw("/world/schema", origin="https://evil.example"), 403)
        self.assertEqual(self._raw("/world/schema", host="evil.example"), 403)
        self.assertEqual(self._raw("/world/schema", origin="http://127.0.0.1:8143"), 200)

    def test_read_only_bytes(self) -> None:
        with closing(world.connect(self.path)) as db, self.assertRaises(sqlite3.OperationalError):
            db.execute("DELETE FROM hop")
        with urlopen(self.root + "/world/overview"):
            pass
        self.assertEqual(sha256(self.path), self.before)
        self.assertEqual(list(Path(self.tmp.name).glob("producer.sqlite-*")), [])

    def test_cli_requires_a_declaration(self) -> None:
        missing = subprocess.run(
            [sys.executable, str(ROOT / "adapters" / "world" / "server.py"),
             "--db", str(self.path)],
            capture_output=True, text=True, timeout=30,
        )
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("--declaration", missing.stderr)


class TestCoexistence(WorldCase):
    """The structural and conceptual planes read one file at the same time."""

    def test_sqlite_and_world_read_the_same_file(self) -> None:
        structural = _structural()
        world.Handler.db_path = self.path
        world.Handler.fingerprint = world.file_sha256(self.path)
        with closing(world.connect(self.path)) as db:
            world.Handler.model = world.Model(db, declaration())
        world.Handler.world_id = "flowtest:test"
        structural.Handler.db_path = self.path
        structural.Handler.fingerprint = structural.file_sha256(self.path)
        first = ThreadingHTTPServer(("127.0.0.1", 0), structural.Handler)
        second = ThreadingHTTPServer(("127.0.0.1", 0), world.Handler)
        threads = [
            threading.Thread(target=item.serve_forever, daemon=True)
            for item in (first, second)
        ]
        for thread in threads:
            thread.start()
        try:
            with urlopen(f"http://127.0.0.1:{first.server_port}/sqlite/schema") as response:
                schema = json.load(response)
            with urlopen(f"http://127.0.0.1:{second.server_port}/world/overview") as response:
                found = json.load(response)
            with urlopen(
                f"http://127.0.0.1:{first.server_port}/sqlite/rows?table=hop&limit=1"
            ) as response:
                rows = json.load(response)
            with urlopen(
                f"http://127.0.0.1:{second.server_port}/world/rows?relation=step&limit=1"
            ) as response:
                window = json.load(response)
        finally:
            first.shutdown()
            second.shutdown()
            first.server_close()
            second.server_close()
            for thread in threads:
                thread.join(timeout=5)
        self.assertEqual(
            sorted(table["name"] for table in schema["tables"]), ["flow", "hop", "pair"]
        )
        self.assertEqual(rows["total"], 3)
        self.assertEqual(found["assertions"], 3)
        self.assertEqual(window["total"], 3)
        self.assertEqual(sha256(self.path), self.before)
        self.assertEqual(list(Path(self.tmp.name).glob("producer.sqlite-*")), [])


class TestReferentPreviewAndOpaqueSearch(WorldCase):
    """KI-019/020: named scalar roles, bounded preview, search category,
    and comma-containing opaque IDs over the real HTTP plane."""

    def setUp(self) -> None:
        super().setUp()
        self.db_path = self.scratch()
        with closing(sqlite3.connect(self.db_path)) as db:
            db.execute(
                "CREATE TABLE det (flow_id TEXT, seq INTEGER, date TEXT, basis TEXT, "
                "amount INTEGER, note TEXT, PRIMARY KEY (flow_id, seq))"
            )
            db.execute("INSERT INTO flow VALUES ('K,1', 'comma key')")
            for i in range(1, 106):
                db.execute(
                    "INSERT INTO det VALUES ('F1', ?, ?, ?, ?, ?)",
                    (i, "2024-01-01", "evidence" if i % 2 else None, i, "" if i == 3 else None),
                )
            db.commit()
        self.before_bytes = sha256(self.db_path)
        self.before_mtime = self.db_path.stat().st_mtime_ns
        declared = declaration(
            entities=[{"kind": "flow,kind", "source": "flow", "key_columns": ["id"], "label_column": "name"}],
            relations=[{
                "name": "determination", "source": "det", "key_columns": ["flow_id", "seq"],
                "roles": [
                    {"role": "flow", "column_name": "flow_id", "target_kind": "flow,kind"},
                    {"role": "date", "column_name": "date", "target_kind": None},
                    {"role": "basis", "column_name": "basis", "target_kind": None},
                    {"role": "amount", "column_name": "amount", "target_kind": None},
                    {"role": "note", "column_name": "note", "target_kind": None},
                ],
            }],
        )
        with closing(world.connect(self.db_path)) as db:
            self.model_instance = world.Model(db, world.validate_declaration(declared))
        world.Handler.db_path = self.db_path
        world.Handler.fingerprint = world.file_sha256(self.db_path)
        world.Handler.model = self.model_instance
        world.Handler.world_id = "flowtest:test"
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), world.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.root = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.assertEqual(sha256(self.db_path), self.before_bytes)
        self.assertEqual(self.db_path.stat().st_mtime_ns, self.before_mtime)
        super().tearDown()

    def _get(self, path: str) -> dict:
        with urlopen(self.root + path) as response:
            return json.load(response)

    def test_referent_fields_keep_roles_values_and_preview_bound(self) -> None:
        found = self._get("/world/referent?id=" + quote("flow,kind:F1", safe=""))
        self.assertEqual(found["relations"][0]["count"], 105)
        roles = {(f["assertion_id"], f["role"]) for f in found["fields"]}
        self.assertIn(("determination:F1/1", "date"), roles)
        self.assertIn(("determination:F1/1", "basis"), roles)
        self.assertEqual(len({f["assertion_id"] for f in found["fields"]}), 100)
        by_role = {f["role"]: f["value"] for f in found["fields"] if f["assertion_id"] == "determination:F1/2"}
        self.assertEqual(by_role["amount"], 2)
        self.assertIsNone(by_role["basis"])
        third = {f["role"]: f["value"] for f in found["fields"] if f["assertion_id"] == "determination:F1/3"}
        self.assertEqual(third["note"], "")

    def test_search_kind_is_referent_category_not_namespace(self) -> None:
        by_id = self._get("/world/search?q=" + quote("flow,kind:F1"))["results"]
        self.assertEqual(by_id[0]["kind"], "referent")
        self.assertEqual(by_id[0]["entity_kind"], "flow,kind")
        self.assertEqual(by_id[0]["id"], "flow,kind:F1")
        by_label = self._get("/world/search?q=second")["results"]
        self.assertEqual(by_label[0]["id"], "flow,kind:F2")

    def test_key_component_with_comma_round_trips_through_labels(self) -> None:
        found = self._get("/world/search?q=" + quote("comma key"))["results"]
        self.assertEqual(len(found), 1)
        opaque = found[0]["id"]
        labels = self._get("/world/labels?id=" + quote(opaque, safe=""))["labels"]
        self.assertEqual(labels, {opaque: "comma key"})

    def test_labels_repeated_id_params_preserve_comma_ids(self) -> None:
        query = "&".join([
            "id=" + quote("flow,kind:F2", safe=""),
            "id=" + quote("flow:F1", safe=""),
            "id=" + quote("flow,kind:F9", safe=""),
        ])
        found = self._get("/world/labels?" + query)["labels"]
        self.assertEqual(found, {"flow,kind:F2": "second", "flow:F1": None, "flow,kind:F9": None})
        # Legacy comma-joined form still serves comma-free IDs.
        legacy = self._get("/world/labels?ids=" + quote("flow,kind:F2", safe=","))["labels"]
        self.assertEqual(legacy, {"flow": None, "kind:F2": None})  # documented legacy limit
        self.assertEqual(sha256(self.db_path), self.before_bytes)


if __name__ == "__main__":
    unittest.main(verbosity=2)

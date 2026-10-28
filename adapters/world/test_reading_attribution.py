"""KI-010: real external CLI HTTP; identical source bytes, distinct readings."""
import copy
import hashlib
import json
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests/fixtures"))
from reading_attribution import declarations, get, serve_readings, world


class ReadingAttribution(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.served = serve_readings(Path(cls.tmp.name))
        cls.info = cls.served.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.served.__exit__(None, None, None)
        cls.tmp.cleanup()

    def read(self, name, path="/world/overview"):
        return get(self.info["ports"][name], path)

    def test_digest_uses_original_declaration_not_normalized_model_or_world_id(self):
        for name, decl in declarations().items():
            canonical = json.dumps({k: decl[k] for k in ["version", "entities", "relations"]},
                                   sort_keys=True, separators=(",", ":"), ensure_ascii=True)
            expected = hashlib.sha256(canonical.encode()).hexdigest()
            self.assertEqual(self.read(name)["reading"]["declaration_digest"], expected)
            note = copy.deepcopy(decl)
            note["world"]["description"] = "changed note"
            self.assertEqual(world.declaration_fingerprint(note), expected)
            prepared = world.prepare_world(Path(self.info["source"]), decl)
            try:
                self.assertEqual(world.build_world_id("attribution", prepared.fingerprint, decl),
                                 self.read(name)["world_id"])
            finally:
                prepared.cleanup()

    def test_two_readings_same_source_values_and_native_locations(self):
        a, b = self.read("a"), self.read("b")
        self.assertNotEqual(a["world_id"], b["world_id"])
        self.assertNotEqual(a["reading"]["declaration_digest"], b["reading"]["declaration_digest"])
        aa = self.read("a", "/world/assertion?id=step:F1/1")
        bb = self.read("b", "/world/assertion?id=passage:F1/1")
        self.assertEqual(aa["values"]["participant"], bb["values"]["operator"])
        for role in ["flow", "order", "action"]:
            self.assertEqual(aa["values"][role], bb["values"][role])
        self.assertEqual(aa["grounding"], bb["grounding"])
        self.assertEqual((aa["origin"], aa["occurrence_state"]), ("SEMANTIC", "ADOPTED"))
        self.assertEqual((bb["origin"], bb["occurrence_state"]), ("MECHANICAL", "REJECTED"))
        self.assertEqual(aa["grounding"][0]["detail"]["lineage"], "not recorded")
        a_rows = self.read("a", "/world/rows?relation=step")["rows"]
        b_rows = self.read("b", "/world/rows?relation=passage")["rows"]
        self.assertEqual(len(a_rows), len(b_rows))
        for ar, br in zip(a_rows, b_rows):
            self.assertEqual(ar["values"], {("participant" if k == "operator" else k): v
                                           for k, v in br["values"].items()})
            self.assertEqual(self.read("a", "/world/assertion?id=" + ar["assertion_id"])["grounding"],
                             self.read("b", "/world/assertion?id=" + br["assertion_id"])["grounding"])
        self.assertEqual(Path(self.info["source"]).stat().st_mtime_ns, self.info["before"]["mtime_ns"])
        self.assertEqual(world.file_sha256(Path(self.info["source"])), self.info["before"]["sha256"])

    def test_filtered_mapping_and_reader_note(self):
        for name, decl in declarations().items():
            reading = self.read(name)["reading"]
            self.assertEqual(reading["interpretation_source"], "external_reader_declaration")
            self.assertEqual(reading["reader_note"], decl["world"]["description"])
            self.assertEqual(reading["adapter"], "generic_sqlite_v1")
            entity, = reading["entities"]
            self.assertEqual(entity, {"kind": "flow", "source": {"kind": "table", "name": "flow"},
                                      "key_columns": ["id"], "label_column": "name",
                                      "label_column_source": "declared"})
            relation, = reading["relations"]
            original = decl["relations"][0]
            self.assertEqual(relation["source"], {"kind": "view", "name": "v_hop"})
            self.assertEqual(relation["name"], original["name"])
            self.assertEqual(relation["description"], original["description"])
            self.assertEqual(relation["roles"], [{"name": r["role"], "column": r["column_name"],
                                                  "target_kind": r.get("target_kind")} for r in original["roles"]])
            self.assertEqual(relation["origin"], original.get("origin"))
            self.assertEqual(relation["occurrence_state"], original.get("occurrence_state"))
            self.assertNotIn(self.tmp.name, json.dumps(reading))
            self.assertNotIn("world", reading)

    def test_neutral_absence_is_not_a_negative_decision(self):
        overview = self.read("neutral")
        self.assertIsNone(overview["governed_obligations"])
        self.assertIsNone(overview["demand"])
        assertion = self.read("neutral", "/world/assertion?id=step:F1/1")
        self.assertEqual(assertion["origin"], "UNSTATED")
        self.assertNotIn("occurrence_state", assertion)
        self.assertEqual(assertion["assertion_state"], "UNKNOWN")
        self.assertEqual(assertion["commitment_id"], assertion["assertion_id"])
        self.assertEqual(assertion["warrant"]["bases"], [])
        self.assertEqual(assertion["candidate_assessments"], [])
        self.assertIsNone(assertion["completeness"])
        decl = declarations()["neutral"]
        decl["relations"][0].update(origin=None, occurrence_state=None)
        with closing(world.connect(Path(self.info["source"]))) as db:
            m = world.Model(db, decl)
            r = world.external_reading(db, m, decl)["relations"][0]
            self.assertIsNone(r["origin"])
            self.assertIsNone(r["occurrence_state"])

    def test_missing_reader_note_stays_absent(self):
        decl = declarations()["neutral"]
        del decl["world"]["description"]
        prepared = world.prepare_world(Path(self.info["source"]), decl, declaration_source="external_file")
        try:
            self.assertIsNone(prepared.model.reading["reader_note"])
        finally:
            prepared.cleanup()

    def test_dictionary_and_embedded_models_do_not_claim_external_ownership(self):
        self.assertNotIn("reading", self.read("legacy"))
        decl = world.validate_declaration(declarations()["neutral"])
        prepared = world.prepare_world(Path(self.info["source"]), decl)
        try:
            self.assertIsNone(prepared.model.reading)
        finally:
            prepared.cleanup()
        from examples.expedition.seed import build
        from examples.expedition import server as expedition
        p = build(Path(self.tmp.name) / "expedition.sqlite")
        before = world.file_sha256(p)
        with closing(expedition.connect(p)) as db:
            m = expedition.Model(db)
            overview = expedition.overview(db, m, "expedition:" + before[:12])
            self.assertNotIn("reading", overview)
            self.assertIsNotNone(overview["demand"])
            self.assertIsNone(overview["governed_obligations"])
        self.assertEqual(world.file_sha256(p), before)


if __name__ == "__main__":
    unittest.main()

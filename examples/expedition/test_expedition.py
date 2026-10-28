"""Expedition slice tests: declaration, World reads, SQL parity, read-only."""

from __future__ import annotations

import hashlib
import http.client
import json
import shutil
import sqlite3
import sys
import tempfile
import threading
import unittest
from contextlib import closing
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))

from consumer import adopted, proposed, rejected, unresolvable  # noqa: E402
from seed import build  # noqa: E402
from server import (  # noqa: E402
    Handler,
    connect,
    file_sha256,
)
from server import Model


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class ExpeditionCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "expedition.sqlite"
        build(self.path)
        self.before = sha256(self.path)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def model(self) -> Model:
        with closing(connect(self.path)) as db:
            return Model(db)

    def scratch(self) -> Path:
        """A writable copy for building broken declarations."""
        other = Path(self.tmp.name) / "scratch.sqlite"
        shutil.copy(self.path, other)
        return other


class TestSeed(ExpeditionCase):
    def test_build_is_deterministic(self) -> None:
        first = Path(self.tmp.name) / "a.sqlite"
        second = Path(self.tmp.name) / "b.sqlite"
        build(first)
        build(second)
        dump = sqlite3.connect(first).iterdump()
        self.assertEqual(list(dump), list(sqlite3.connect(second).iterdump()))


class TestDeclaration(ExpeditionCase):
    def test_missing_declaration_is_refused(self) -> None:
        scratch = self.scratch()
        db = sqlite3.connect(scratch)
        db.execute("DROP TABLE ki_role")
        db.commit()
        db.close()
        with closing(connect(scratch)) as ro, self.assertRaises(ValueError):
            Model(ro)

    def test_unknown_source_is_refused(self) -> None:
        scratch = self.scratch()
        db = sqlite3.connect(scratch)
        db.execute("UPDATE ki_relation SET source = 'missing' WHERE name = 'collection'")
        db.commit()
        db.close()
        with closing(connect(scratch)) as ro, self.assertRaises(ValueError):
            Model(ro)

    def test_duplicate_keys_are_refused(self) -> None:
        scratch = self.scratch()
        db = sqlite3.connect(scratch)
        db.execute("CREATE TABLE dupes (k TEXT, v TEXT)")
        db.execute("INSERT INTO dupes VALUES ('x', '1'), ('x', '2')")
        db.execute(
            "INSERT INTO ki_relation (name, source, key_columns) VALUES ('dupes', 'dupes', 'k')"
        )
        db.execute(
            "INSERT INTO ki_role (relation, role, column_name) VALUES ('dupes', 'v', 'v')"
        )
        db.commit()
        db.close()
        with closing(connect(scratch)) as ro, self.assertRaises(ValueError):
            Model(ro)

    def test_dangling_participants_are_refused(self) -> None:
        scratch = self.scratch()
        db = sqlite3.connect(scratch)
        db.execute("INSERT INTO specimen VALUES ('K-999', 'S-1', 'P-7', '2024-01-01', 'sheet')")
        db.execute("UPDATE specimen SET site_id = 'S-?' WHERE catalog_no = 'K-999'")
        db.commit()
        db.close()
        with closing(connect(scratch)) as ro, self.assertRaises(ValueError):
            Model(ro)

    def test_coverage_check_runs(self) -> None:
        scratch = self.scratch()
        db = sqlite3.connect(scratch)
        db.execute("DROP VIEW v_determination_unmatched")
        db.commit()
        db.close()
        with closing(connect(scratch)) as ro, self.assertRaises(sqlite3.OperationalError):
            Model(ro)


class TestWorldReads(ExpeditionCase):
    def setUp(self) -> None:
        super().setUp()
        import server as plane

        self.plane = plane
        self.model = self.model()

    def test_overview_counts(self) -> None:
        with closing(connect(self.path)) as db:
            found = self.plane.overview(db, self.model, "expedition:test")
        self.assertEqual(found["relations"], 4)
        self.assertEqual(found["referents"], 9)
        self.assertEqual(found["assertions"], 7)
        self.assertEqual(found["origins"], {"SEMANTIC": 7})
        self.assertEqual(found["demand"]["demanded"], 1)

    def test_route_serves_overview_with_expedition_demand(self) -> None:
        """The extension's route must not fall through to the generic
        overview, which carries demand null by design."""
        with closing(connect(self.path)) as db:
            status, found = self.plane.route(
                "/world/overview", {}, db, self.model, "expedition:test"
            )
        self.assertEqual(status, 200)
        self.assertEqual(found["demand"]["demanded"], 1)

    def test_determination_has_three_participants(self) -> None:
        with closing(connect(self.path)) as db:
            (relation,) = [
                item
                for item in self.plane.schema(db, self.model)["relations"]
                if item["name"] == "determination"
            ]
        referents = [role for role in relation["roles"] if role["referent"]]
        self.assertEqual([role["name"] for role in referents], ["specimen", "taxon", "determiner"])
        self.assertEqual(relation["referent_arity"], 3)
        self.assertEqual(relation["count"], 2)

    def test_proposals_stay_out_of_the_adopted_relation(self) -> None:
        with closing(connect(self.path)) as db:
            adopted_rows = self.plane.rows(db, self.model, {"relation": ["determination"]})
            proposed_rows = self.plane.rows(
                db, self.model, {"relation": ["determination_proposed"]}
            )
        self.assertEqual(adopted_rows["total"], 2)
        self.assertEqual(proposed_rows["total"], 1)
        self.assertTrue(all(row["origin"] == "SEMANTIC" for row in adopted_rows["rows"]))
        self.assertTrue(all(row["origin"] == "SEMANTIC" for row in proposed_rows["rows"]))
        adopted_ids = {row["assertion_id"] for row in adopted_rows["rows"]}
        proposed_ids = {row["assertion_id"] for row in proposed_rows["rows"]}
        self.assertFalse(adopted_ids & proposed_ids)

    def test_rows_support_subject_search_and_order(self) -> None:
        with closing(connect(self.path)) as db:
            subject = self.plane.rows(
                db, self.model, {"relation": ["determination"], "subject": ["taxon:T-042"]}
            )
            searched = self.plane.rows(
                db, self.model, {"relation": ["determination"], "search": ["fruit"]}
            )
            ordered = self.plane.rows(
                db, self.model, {"relation": ["determination"], "order": ["det_on"], "desc": ["1"]}
            )
        self.assertEqual(subject["total"], 2)
        self.assertEqual(searched["total"], 1)
        self.assertEqual(
            [row["values"]["det_on"] for row in ordered["rows"]], ["2024-04-02", "2024-04-01"]
        )

    def test_referent_fields_and_expansion_costs(self) -> None:
        with closing(connect(self.path)) as db:
            found = self.plane.referent(db, self.model, "specimen:K-118")
        self.assertEqual(found["label"], "K-118")
        costs = {item["name"]: item["count"] for item in found["relations"]}
        self.assertEqual(costs, {
            "collection": 1,
            "determination": 1,
            "determination_proposed": 1,
            "determination_rejected": 0,
        })
        self.assertTrue(all("assertion_id" in field for field in found["fields"]))

    def test_expand_assertion_derivation_support(self) -> None:
        with closing(connect(self.path)) as db:
            grown = self.plane.expand(db, self.model, "taxon:T-042", "determination", 200)
            one = self.plane.assertion(db, self.model, "determination:1")
            closure = self.plane.derivation(db, self.model, "determination")
            drilled = self.plane.support(db, self.model, "determination:1")
        self.assertEqual(len(grown["tuples"]), 2)
        self.assertEqual(one["values"]["taxon"], "taxon:T-042")
        self.assertEqual(one["grounding"][0]["native_handle"], "SQLite")
        self.assertIsNone(closure["run"])
        self.assertFalse(drilled["derived"])
        self.assertEqual(drilled["inputs"], [])
        self.assertEqual(
            drilled["referents"], ["person:P-9", "specimen:K-118", "taxon:T-042"]
        )

    def test_grounding_separates_definitions_from_stored_rows(self) -> None:
        with closing(connect(self.path)) as db:
            view_backed = self.plane.assertion(db, self.model, "determination:1")
            table_backed = self.plane.assertion(db, self.model, "collection:K-118")
        view_grounding = view_backed["grounding"][0]
        self.assertIn("defined, not stored", view_grounding["native_location"])
        self.assertIn("CREATE VIEW", view_grounding["detail"]["derivation_definition"])
        self.assertEqual(view_grounding["detail"]["lineage"], "not recorded")
        table_grounding = table_backed["grounding"][0]
        self.assertEqual(table_grounding["native_location"], "row catalog_no=K-118 in specimen")
        self.assertNotIn("derivation_definition", table_grounding["detail"])

    def test_occurrence_states_distinguish_stance(self) -> None:
        with closing(connect(self.path)) as db:
            states = {
                identifier: self.plane.assertion(db, self.model, identifier)["occurrence_state"]
                for identifier in (
                    "determination:1",
                    "determination_proposed:2",
                    "determination_rejected:5",
                    "collection:K-118",
                )
            }
        self.assertEqual(states, {
            "determination:1": "ADOPTED",
            "determination_proposed:2": "PROPOSED",
            "determination_rejected:5": "REJECTED",
            "collection:K-118": "RECORDED",
        })

    def test_origin_is_not_inferred_from_stance(self) -> None:
        with closing(connect(self.path)) as db:
            pairs = {
                identifier: self.plane.assertion(db, self.model, identifier)
                for identifier in (
                    "determination:1",
                    "determination_proposed:2",
                    "determination_rejected:5",
                    "collection:K-118",
                )
            }
        origins = {identifier: payload["origin"] for identifier, payload in pairs.items()}
        states = {
            identifier: payload["occurrence_state"] for identifier, payload in pairs.items()
        }
        self.assertEqual(set(origins.values()), {"SEMANTIC"})
        self.assertEqual(
            set(states.values()), {"ADOPTED", "PROPOSED", "REJECTED", "RECORDED"}
        )
        self.assertEqual(origins["determination_proposed:2"], "SEMANTIC")
        self.assertEqual(states["determination_proposed:2"], "PROPOSED")
        self.assertEqual(origins["determination_rejected:5"], "SEMANTIC")
        self.assertEqual(states["determination_rejected:5"], "REJECTED")

    def test_legacy_assertion_state_claims_nothing(self) -> None:
        with closing(connect(self.path)) as db:
            for identifier in (
                "determination:1",
                "determination_proposed:2",
                "determination_rejected:5",
                "collection:K-118",
            ):
                self.assertEqual(
                    self.plane.assertion(db, self.model, identifier)["assertion_state"],
                    "UNKNOWN",
                )

    def test_undeclared_occurrence_state_is_omitted(self) -> None:
        scratch = self.scratch()
        db = sqlite3.connect(scratch)
        db.execute(
            "INSERT INTO ki_relation (name, source, key_columns) VALUES ('site_record', 'site', 'site_id')"
        )
        db.execute(
            "INSERT INTO ki_role (relation, role, column_name) VALUES ('site_record', 'name', 'name')"
        )
        db.commit()
        db.close()
        import server as plane

        with closing(connect(scratch)) as ro:
            found = plane.assertion(ro, Model(ro), "site_record:S-1")
        self.assertNotIn("occurrence_state", found)
        self.assertEqual(found["assertion_state"], "UNKNOWN")

    def test_warrant_shape_is_mandated_not_recorded(self) -> None:
        """The contract requires warrant/commitment fields on every assertion,
        including proposals, so the adapter fills them minimally: ids echo the
        assertion, origins echo the relation, and no evidential bases are
        invented. An empty bases list means none recorded."""
        with closing(connect(self.path)) as db:
            found = self.plane.assertion(db, self.model, "determination_proposed:2")
        self.assertEqual(found["commitment_id"], "determination_proposed:2")
        self.assertEqual(found["warrant"]["bases"], [])
        self.assertEqual(found["warrant"]["construction_origins"], ["SEMANTIC"])

    def test_directory_search_and_labels(self) -> None:
        with closing(connect(self.path)) as db:
            directory = self.plane.referents(db, self.model)
            hits = self.plane.search(db, self.model, "k-118", 10)
            names = self.plane.labels(db, self.model, "taxon:T-117,missing:x")
        self.assertEqual(directory["total"], 9)
        self.assertFalse(directory["truncated"])
        self.assertEqual(hits["results"][0]["id"], "specimen:K-118")
        self.assertEqual(names["labels"], {"taxon:T-117": "Maesopsis eminii", "missing:x": None})

    def test_rejected_determinations_are_recorded_not_adopted(self) -> None:
        with closing(connect(self.path)) as db:
            window = self.plane.rows(db, self.model, {"relation": ["determination_rejected"]})
            one = self.plane.assertion(db, self.model, "determination_rejected:5")
        self.assertEqual(window["total"], 1)
        self.assertEqual(one["origin"], "SEMANTIC")
        self.assertEqual(one["occurrence_state"], "REJECTED")
        self.assertEqual(one["values"]["taxon"], "taxon:T-117")

    def test_demand_obligates_every_unserved_record(self) -> None:
        with closing(connect(self.path)) as db:
            demand = self.plane.demand_out(db)
            served = set()
            for name in ("determination", "determination_proposed", "determination_rejected"):
                window = self.plane.rows(db, self.model, {"relation": [name]})
                served.update(int(row["assertion_id"].split(":")[1]) for row in window["rows"])
            obligated = set()
            for item in demand["obligations"]:
                self.assertEqual(item["state"], "UNRESOLVED")
                self.assertIsNone(item["assertion_id"])
                obligated.add(int(item["reason"].split(" ")[1].rstrip(":")))
            recorded = {
                row["det_id"] for row in db.execute("SELECT det_id FROM determination")
            }
        self.assertEqual(demand["demanded"], 1)
        self.assertEqual(served | obligated, recorded)

    def test_unknown_names_are_rejected_safely(self) -> None:
        with closing(connect(self.path)) as db:
            with self.assertRaises(self.plane.BadRequest):
                self.plane.rows(db, self.model, {"relation": ['determination"; DROP TABLE--']})
            with self.assertRaises(self.plane.NotFound):
                self.plane.assertion(db, self.model, "determination:999")
            with self.assertRaises(self.plane.NotFound):
                self.plane.referent(db, self.model, "specimen:K-118:extra")
        self.assertEqual(sha256(self.path), self.before)


class TestNoSilentDisappearance(ExpeditionCase):
    def _served_and_obligated(self, path: Path) -> tuple[set[int], set[int]]:
        import server as plane

        with closing(connect(path)) as db:
            model = Model(db)
            served = set()
            for name in ("determination", "determination_proposed", "determination_rejected"):
                window = plane.rows(db, model, {"relation": [name]})
                served.update(int(row["assertion_id"].split(":")[1]) for row in window["rows"])
            obligated = {
                int(item["reason"].split(" ")[1])
                for item in plane.demand_out(db)["obligations"]
            }
            recorded = {row["det_id"] for row in db.execute("SELECT det_id FROM determination")}
        self.assertEqual(served | obligated, recorded)
        return served, obligated

    def test_unresolvable_record_moves_to_obligations(self) -> None:
        scratch = self.scratch()
        db = sqlite3.connect(scratch)
        db.execute("DELETE FROM taxon_alias WHERE alias = 'S. globulifera'")
        db.commit()
        db.close()
        served, obligated = self._served_and_obligated(scratch)
        self.assertNotIn(1, served)
        self.assertIn(1, obligated)

    def test_rejected_record_moves_to_the_rejected_relation(self) -> None:
        scratch = self.scratch()
        db = sqlite3.connect(scratch)
        db.execute("UPDATE determination SET stance = 'rejected' WHERE det_id = 3")
        db.commit()
        db.close()
        served, _ = self._served_and_obligated(scratch)
        import server as plane

        with closing(connect(scratch)) as ro:
            model = Model(ro)
            rejected_ids = {
                row["assertion_id"]
                for row in plane.rows(ro, model, {"relation": ["determination_rejected"]})["rows"]
            }
        self.assertIn("determination_rejected:3", rejected_ids)
        self.assertIn(3, served)

    def test_consumer_imports_no_inspector_code(self) -> None:
        import ast

        tree = ast.parse(Path(sys.modules["consumer"].__file__).read_text())
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(part.name.split(".")[0] for part in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split(".")[0])
        self.assertLessEqual(imported, {"__future__", "argparse", "pathlib", "sqlite3"})


class TestConsumerParity(ExpeditionCase):
    def test_sql_answers_match_world_answers(self) -> None:
        with closing(connect(self.path)) as db:
            _, adopted_rows = adopted(db)
            _, proposed_rows = proposed(db)
            _, rejected_rows = rejected(db)
            _, unmatched_rows = unresolvable(db)
            model = self.model()
            import server as plane

            adopted_world = plane.rows(db, model, {"relation": ["determination"]})
            proposed_world = plane.rows(db, model, {"relation": ["determination_proposed"]})
            rejected_world = plane.rows(db, model, {"relation": ["determination_rejected"]})
            demand = plane.demand_out(db)
        self.assertEqual(len(adopted_rows), adopted_world["total"])
        self.assertEqual(len(proposed_rows), proposed_world["total"])
        self.assertEqual(len(rejected_rows), rejected_world["total"])
        self.assertEqual(
            {row["det_id"] for row in unmatched_rows},
            {
                int(item["reason"].split(" ")[1].rstrip(":"))
                for item in demand["obligations"]
                if "matches no known taxon alias" in item["reason"]
            },
        )
        self.assertEqual(sha256(self.path), self.before)


class TestHttpPlane(ExpeditionCase):
    def setUp(self) -> None:
        super().setUp()
        Handler.db_path = self.path
        Handler.fingerprint = file_sha256(self.path)
        with closing(connect(self.path)) as db:
            Handler.model = Model(db)
        Handler.world_id = "expedition:test"
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
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

    def test_endpoints_errors_and_write_rejection(self) -> None:
        with urlopen(self.root + "/world/schema") as response:
            found = json.load(response)
        self.assertEqual(len(found["relations"]), 4)
        with self.assertRaises(HTTPError) as missing:
            urlopen(self.root + "/world/rows?relation=missing")
        self.assertEqual(missing.exception.code, 400)
        with self.assertRaises(HTTPError) as gone:
            urlopen(self.root + "/world/assertion?id=determination:999")
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
        with closing(connect(self.path)) as db, self.assertRaises(sqlite3.OperationalError):
            db.execute("DELETE FROM determination")
        with urlopen(self.root + "/world/overview"):
            pass
        self.assertEqual(sha256(self.path), self.before)
        self.assertEqual(list(Path(self.tmp.name).glob("expedition.sqlite-*")), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)

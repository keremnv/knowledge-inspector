"""Verification judges whole tables; a handle is kept once it is handed out.

Run: python3 -m unittest adapters.source.test_identity_issue -v

`verified` keeps its meaning: every row of the table passed every check. What
the session keeps is the table's verdict and the handles it has handed out,
not every verified row's handle. These tests pin both halves: the verdicts on
adversarial keys, and the handles' lifecycle.
"""
from __future__ import annotations

import hashlib
import json
import unittest
from unittest.mock import patch

from adapters.source.model import framed
from adapters.source.test_source import Fixture


class TestVerdicts(Fixture):
    """Every check the whole-table verifier made is still made, over every row."""

    def verdict(self, table, **options):
        m = self.manager(reader_options=options)
        token = m.initial_session
        with m.lease(token, m.descriptor(token)["generation"]) as (_, reader, db), reader.operation(db):
            state = reader.identity(db, table, verify=True)
        return (state["status"], state["reason"], state["verified_rows"]), m

    def handles(self, m, table):
        return [r["record_id"] for r in self.query(m, "rows", table=table, limit=5)["rows"]]

    def test_adversarial_keys_get_the_same_verdicts(self):
        self.build("""
            CREATE TABLE nulls(a TEXT, b INTEGER, PRIMARY KEY(a, b)); INSERT INTO nulls VALUES ('x', 1), (NULL, 2);
            CREATE TABLE late_null(a TEXT PRIMARY KEY);
            CREATE TABLE nocase(k TEXT COLLATE NOCASE, PRIMARY KEY(k COLLATE BINARY)); INSERT INTO nocase VALUES ('a'), ('A');
            CREATE TABLE unindexed(k TEXT COLLATE NOCASE, PRIMARY KEY(k COLLATE BINARY)); INSERT INTO unindexed VALUES ('a'), ('b');
            CREATE TABLE blobs(k BLOB PRIMARY KEY); INSERT INTO blobs VALUES (x'00ff');
            CREATE TABLE infinite(k REAL PRIMARY KEY); INSERT INTO infinite VALUES (1e999);
            CREATE TABLE wide(k TEXT PRIMARY KEY);
            CREATE TABLE mixed(k PRIMARY KEY); INSERT INTO mixed VALUES (1), ('1'), ('01'), (1.5);
            CREATE TABLE odd("a b" TEXT, "c""d" TEXT, PRIMARY KEY("c""d", "a b")) WITHOUT ROWID;
            INSERT INTO odd VALUES ('x/y', 'z'), ('x', 'y/z'), ('Ω,%', char(0)), ('', ' ');
            CREATE TABLE empty(id INTEGER PRIMARY KEY);""",
            [("INSERT INTO late_null VALUES (?)", [(str(i),) for i in range(300)] + [(None,)]),
             ("INSERT INTO wide VALUES (?)", [("w" * (1024 * 1024 + 1),)])])
        expected = {
            "nulls": ("invalid", "null_primary_key_component", None),
            "late_null": ("invalid", "null_primary_key_component", None),
            "nocase": ("invalid", "duplicate_primary_key", None),
            "unindexed": ("unsupported", "identity_lookup_plan_unsupported", None),
            "blobs": ("unsupported", "unsupported_identity_component", None),
            "infinite": ("unsupported", "unsupported_identity_component", None),
            "wide": ("budget_exceeded", "identity_component_budget_exceeded", None),
            "mixed": ("verified", None, 4),
            "odd": ("verified", None, 4),
            "empty": ("verified", None, 0),
        }
        for table, verdict in expected.items():
            with self.subTest(table=table):
                got, m = self.verdict(table)
                self.assertEqual(got, verdict)
                if table != "wide":  # its 1 MiB key cell is beyond a row window's cell limit
                    handles = self.handles(m, table)
                    self.assertEqual(all(handles), verdict[0] == "verified")
                    self.assertTrue(verdict[0] != "verified" or len(set(handles)) == len(handles))
                    self.assertTrue(verdict[0] == "verified" or not any(handles))

    def test_a_table_beyond_the_verification_row_limit_is_judged_on_that_limit_alone(self):
        self.build("CREATE TABLE t(id INTEGER PRIMARY KEY);", [("INSERT INTO t VALUES (?)", [(i,) for i in range(11)])])
        got, m = self.verdict("t", verify_rows=10)
        self.assertEqual(got, ("budget_exceeded", "identity_verification_budget_exceeded", None))
        self.assertEqual(self.handles(m, "t"), [None] * 5)
        self.assertEqual(m.sessions[m.initial_session]["reader"].records, {})
        self.assertEqual(self.verdict("t", verify_rows=11)[0], ("verified", None, 11))

    def test_a_collision_with_a_handed_out_handle_refuses_the_second_table(self):
        self.build("CREATE TABLE a(id INTEGER PRIMARY KEY); INSERT INTO a VALUES (1);"
                   "CREATE TABLE b(id INTEGER PRIMARY KEY); INSERT INTO b VALUES (1);")
        m = self.manager()
        with patch("adapters.source.model.hashlib.sha256") as digest:
            digest.return_value.hexdigest.return_value = "0" * 64
            first = self.query(m, "rows", table="a")
            second = self.query(m, "rows", table="b")
        self.assertEqual(first["identity"]["status"], "verified")
        self.assertEqual((second["identity"]["status"], second["identity"]["reason"]), ("unsupported", "identity_hash_collision"))
        self.assertEqual([r["record_id"] for r in second["rows"]], [None])


class TestHandedOutHandles(Fixture):
    def setUp(self):
        super().setUp()
        self.build("CREATE TABLE parent(id INTEGER PRIMARY KEY, name TEXT);"
                   "CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id), note TEXT);",
                   [("INSERT INTO parent VALUES (?, ?)", [(i, f"p{i}") for i in range(1, 31)]),
                    ("INSERT INTO child VALUES (?, ?, ?)", [(i, 1 + i % 3, f"c{i}") for i in range(1, 61)])])

    def reader(self, m):
        return m.sessions[m.initial_session]["reader"]

    def computed(self, m, table, column, value):
        context = m.descriptor(m.initial_session)
        return "sr1:" + hashlib.sha256(framed(["ki.source.record.v1", context["source_namespace"], context["capture_digest"],
                                               "main", table, [column], [value]])).hexdigest()

    def test_verification_keeps_the_verdict_and_hands_out_only_what_is_read(self):
        m = self.manager()
        page = self.query(m, "rows", table="child", limit=7)
        self.assertEqual((page["identity"]["status"], page["identity"]["verified_rows"]), ("verified", 60))
        self.assertEqual(len(self.reader(m).records), 7)
        self.assertEqual({r["record_id"] for r in page["rows"]}, set(self.reader(m).records))
        # Each handle is exactly the documented framing of the row's typed key.
        self.assertEqual(page["rows"][0]["record_id"], self.computed(m, "child", "id", 1))

    def test_a_row_has_one_handle_whichever_answer_hands_it_out(self):
        m = self.manager()
        by_rows = self.query(m, "rows", table="parent", limit=3)["rows"][1]["record_id"]
        by_key = self.query(m, "search", table="parent", mode="primary_key", limit=1,
                            key=json.dumps([{"column": "id", "storage_class": "integer", "exact": "2"}]))["rows"][0]["record_id"]
        by_find = next(h["record_id"] for h in self.query(m, "find", text="p2")["hits"] if h["table"] == "parent" and h["key"][0]["exact"] == "2")
        child = self.query(m, "rows", table="child", limit=1)["rows"][0]["record_id"]
        by_reference = self.query(m, "references", record=child)["observations"][0]["parent"]["record_id"]
        self.assertEqual({by_rows, by_key, by_find, by_reference}, {by_rows})
        self.assertEqual(self.query(m, "record", id=by_rows)["key"][0]["exact"], "2")

    def test_a_handle_never_handed_out_is_not_a_record_until_the_row_is_read(self):
        m = self.manager()
        self.query(m, "rows", table="parent", limit=1)
        computed = self.computed(m, "parent", "id", 30)
        with self.assertRaises(Exception) as refused:
            self.query(m, "record", id=computed)
        self.assertEqual((refused.exception.code, refused.exception.status), ("source_record_not_found_in_generation", 404))
        found = self.query(m, "search", table="parent", mode="primary_key", limit=1,
                           key=json.dumps([{"column": "id", "storage_class": "integer", "exact": "30"}]))["rows"][0]["record_id"]
        self.assertEqual(found, computed)
        self.assertEqual(self.query(m, "record", id=computed)["record_id"], computed)

    def test_a_window_is_handed_out_whole_or_not_at_all_and_the_table_stays_verified(self):
        m = self.manager(reader_options={"key_rows": 10})
        first = self.query(m, "rows", table="parent", limit=6)
        self.assertTrue(all(r["record_id"] for r in first["rows"]))
        # Six more do not fit beside the six handed out: none of them is handed out.
        refused = self.query(m, "rows", table="parent", limit=6, offset=6)
        self.assertEqual((refused["identity"]["status"], refused["identity"]["reason"]), ("budget_exceeded", "identity_registry_budget_exceeded"))
        self.assertEqual([r["record_id"] for r in refused["rows"]], [None] * 6)
        self.assertEqual(len(self.reader(m).records), 6)
        # The table's verdict is unchanged, what was handed out still reads, and a window that fits is handed out.
        self.assertEqual(next(r for r in self.query(m, "overview")["relations"] if r["name"] == "parent")["identity"]["status"], "verified")
        self.assertEqual(self.query(m, "record", id=first["rows"][0]["record_id"])["identity"]["status"], "verified")
        again = self.query(m, "rows", table="parent", limit=6)
        self.assertEqual([r["record_id"] for r in again["rows"]], [r["record_id"] for r in first["rows"]])
        fits = self.query(m, "rows", table="parent", limit=4, offset=6)
        self.assertTrue(all(r["record_id"] for r in fits["rows"]))
        # Full now: an incoming group says so before anything is asked of it.
        groups = self.query(m, "references", record=first["rows"][0]["record_id"], direction="incoming")["groups"]
        self.assertEqual((groups[0]["child_identity"]["status"], groups[0]["child_identity"]["reason"]),
                         ("budget_exceeded", "identity_registry_budget_exceeded"))
        reference = self.query(m, "rows", table="child", limit=1)
        self.assertEqual(reference["rows"][0]["record_id"], None)

    def test_a_parent_that_cannot_be_handed_out_is_resolved_but_not_addressable(self):
        m = self.manager(reader_options={"key_rows": 1})
        child = self.query(m, "rows", table="child", limit=1)["rows"][0]["record_id"]
        observation = self.query(m, "references", record=child)["observations"][0]
        self.assertEqual(observation["status"], "resolved_unaddressable")
        self.assertEqual((observation["parent"]["record_id"], observation["parent"]["identity"]["reason"]),
                         (None, "identity_registry_budget_exceeded"))
        self.assertEqual(observation["parent"]["target_values"][0]["exact"], "2")


if __name__ == "__main__":
    unittest.main()

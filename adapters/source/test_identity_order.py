"""Whether a record can be placed does not depend on what was read before it.

Run: python3 -m unittest adapters.source.test_identity_order -v

Small fixtures reproduce, deterministically, the order dependence measured on
Stack Exchange (see docs/ENGINEERING_EVIDENCE.md):

1. verified tables used to share one capture-wide registry, so the tables
   verified first decided which later tables could be;
2. a verification ran in whatever budget window the request was in, so work
   done earlier in the same request could cut it short, and that was
   recorded as the table's final verdict;
3. global find verified every table it searched and so filled that registry.

Each test reads the same tables in two orders (or after a find) in fresh
sessions and requires the same answer for the same record.
"""
from __future__ import annotations

import json
import unittest

from adapters.source.test_source import Fixture


class Orders(Fixture):
    def identities(self, m):
        return {r["name"]: r["identity"]["status"] for r in self.query(m, "overview", limit=50)["relations"]}

    def addressable(self, m, table, key):
        """The browser's restore path: find the record by its key, then read it."""
        rows = self.query(m, "search", table=table, mode="primary_key", limit=1,
                          key=json.dumps([{"column": "id", "storage_class": "integer", "exact": str(key)}]))["rows"]
        return bool(rows and rows[0]["record_id"] and self.query(m, "record", id=rows[0]["record_id"])["record_id"])

    def steps_to_verify(self, table):
        """VM instructions one whole-table verification of `table` uses here."""
        m = self.manager()
        token = m.initial_session
        with m.lease(token, m.descriptor(token)["generation"]) as (_, reader, db), reader.operation(db):
            usage = reader.reset_budget(db)
            state = {"status": "checking", "key_columns": reader.pk(db, table), "verified_rows": None, "reason": None}
            reader._verify(db, table, state)
            self.assertEqual(state["status"], "verified")
            return usage["steps"]


class TestRegistryOrder(Orders):
    def setUp(self):
        super().setUp()
        self.build("CREATE TABLE alpha(id INTEGER PRIMARY KEY, v TEXT);"
                   "CREATE TABLE beta(id INTEGER PRIMARY KEY, v TEXT);",
                   [("INSERT INTO alpha(v) VALUES (?)", [("a",)] + [("x",)] * 7), ("INSERT INTO beta(v) VALUES (?)", [("b",)] * 8)])

    def test_opening_order_does_not_decide_which_table_can_be_placed(self):
        # Ten handles fit; each table has eight rows; a person reads two rows of each.
        outcomes = []
        for order in (["alpha", "beta"], ["beta", "alpha"]):
            m = self.manager(reader_options={"key_rows": 10})
            for table in order:
                self.query(m, "rows", table=table, limit=2)
            outcomes.append((self.identities(m), self.addressable(m, "alpha", 3), self.addressable(m, "beta", 3)))
        self.assertEqual(outcomes[0], outcomes[1])
        self.assertEqual(outcomes[0], ({"alpha": "verified", "beta": "verified"}, True, True))

    def test_a_find_does_not_use_up_what_later_tables_need(self):
        # The find searches both tables and finds one record; then beta is opened.
        m = self.manager(reader_options={"key_rows": 12, "incoming_page_steps": 10**9})
        page = self.query(m, "find", text="a")
        self.assertEqual((page["completion"], [h["table"] for h in page["hits"]]), ("complete", ["alpha"]))
        self.query(m, "rows", table="beta", limit=2)
        self.assertEqual(self.identities(m)["beta"], "verified")
        self.assertTrue(self.addressable(m, "beta", 8))


class TestBudgetWindowOrder(Orders):
    ROWS = 20_000

    def setUp(self):
        super().setUp()
        self.build("CREATE TABLE p1(id INTEGER PRIMARY KEY); CREATE TABLE p2(id INTEGER PRIMARY KEY);"
                   "CREATE TABLE child(id INTEGER PRIMARY KEY, a INTEGER REFERENCES p1(id), b INTEGER REFERENCES p2(id));"
                   "INSERT INTO child VALUES (1, 1, 1);",
                   [("INSERT INTO p1(id) VALUES (?)", [(i,) for i in range(1, self.ROWS + 1)]),
                    ("INSERT INTO p2(id) VALUES (?)", [(i,) for i in range(1, self.ROWS + 1)])])
        # A budget one verification fits in and two do not.
        self.steps = int(self.steps_to_verify("p1") * 1.5)

    def test_a_parent_verified_inside_a_crowded_request_is_not_judged_by_that_request(self):
        m = self.manager(reader_options={"vm_steps": self.steps})
        child = self.query(m, "rows", table="child")["rows"][0]["record_id"]
        observations = self.query(m, "references", record=child)["observations"]
        self.assertEqual(observations[0]["status"], "resolved")
        # The parent resolved second did not get a budget of its own in that request:
        # whatever that answer says, it is not that table's verdict, and it verifies when read.
        for table in ("p1", "p2"):
            self.assertNotIn(self.identities(m)[table], {"budget_exceeded", "unsupported", "invalid"})
            self.assertEqual(self.query(m, "rows", table=table, limit=1)["identity"]["status"], "verified")
            self.assertTrue(self.addressable(m, table, 1))
        # Read the other way round, the same records are addressable.
        other = self.manager(reader_options={"vm_steps": self.steps})
        for table in ("p2", "p1"):
            self.query(other, "rows", table=table, limit=1)
        self.assertEqual((self.addressable(other, "p1", 1), self.addressable(other, "p2", 1)), (True, True))



class TestFindWindowOrder(Orders):
    def test_a_table_searched_after_one_that_spent_its_window_is_verified_on_its_own_budget(self):
        # Stack Exchange: postHistory's search ran out of its window, and postLinks,
        # next in the catalogue, was verified in what was left: nothing.
        self.build("CREATE TABLE a_notes(v TEXT); CREATE TABLE b_keyed(id INTEGER PRIMARY KEY);",
                   [("INSERT INTO a_notes VALUES (?)", [("note",)] * 5000),
                    ("INSERT INTO b_keyed(id) VALUES (?)", [(i,) for i in range(1, 101)])])
        # A window too small to search a_notes, ample for verifying b_keyed; find's cap far larger.
        m = self.manager(reader_options={"vm_steps": 50_000, "incoming_page_steps": 10**9, "incoming_page_seconds": 60})
        page = self.query(m, "find", text="zz-no-such-text")
        self.assertEqual([s["table"] for s in page["skipped"]], ["a_notes"])
        self.assertEqual(self.identities(m)["b_keyed"], "verified")
        self.assertTrue(self.addressable(m, "b_keyed", 1))


if __name__ == "__main__":
    unittest.main()

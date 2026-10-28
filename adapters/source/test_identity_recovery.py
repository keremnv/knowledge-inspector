"""A verification cut short by another request's cap is not a table's verdict.

Run: python3 -m unittest adapters.source.test_identity_recovery -v

Global find runs every table's search under one request-wide cap. A table it
touches first is verified inside that cap; when the cap runs out mid-way the
table used to be recorded as `budget_exceeded` for the rest of the session.
Now nothing is registered, the answer still says the table is not verified,
and a later read retries under its own budget. Failures that belong to the
table itself (its own budget, its verification row limit) stay as they were.
"""
from __future__ import annotations

import unittest

from adapters.source.test_source import Fixture

BIG = 40_000


class TestTransientVerification(Fixture):
    def setUp(self):
        super().setUp()
        self.build("CREATE TABLE zbig(id INTEGER PRIMARY KEY, v TEXT);"
                   "CREATE TABLE parent(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO parent VALUES (1, 'p');"
                   "CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));"
                   "INSERT INTO child VALUES (1, 1), (2, 1);",
                   [("INSERT INTO zbig(v) VALUES (?)", [("x",)] * BIG)])

    def identities(self, m):
        return {r["name"]: r["identity"] for r in self.query(m, "overview", limit=50)["relations"]}

    def find_to_end(self, m, text):
        page = self.query(m, "find", text=text)
        while page["completion"] != "complete":
            page = self.query(m, "find", text=text, cursor=page["next_cursor"])

    def test_a_find_cut_short_does_not_stop_a_later_read_from_verifying(self):
        # A cap far too small to verify `zbig`: the find is constrained, the table is not.
        m = self.manager(reader_options={"incoming_page_steps": 100_000})
        page = self.query(m, "find", text="x")
        # The first request reaches zbig after smaller tables have spent part of its cap.
        self.assertEqual((page["completion"], page["next_cursor"]), ("budget_exceeded", "2:0"))
        state = self.identities(m)["zbig"]
        self.assertEqual((state["status"], state["verified_rows"]), ("not_started", None))
        rows = self.query(m, "rows", table="zbig", limit=3)
        self.assertEqual((rows["identity"]["status"], rows["identity"]["verified_rows"]), ("verified", BIG))
        self.assertTrue(all(r["record_id"] for r in rows["rows"]))
        # Before the fix the same sequence left zbig budget_exceeded for the session.
        self.find_to_end(m, "x")
        record = self.query(m, "record", id=rows["rows"][0]["record_id"])
        self.assertEqual(record["identity"]["status"], "verified")

    def test_the_interrupted_answer_publishes_no_handles_and_says_it_is_not_verified(self):
        m = self.manager(reader_options={"incoming_page_steps": 100_000})
        token = m.initial_session
        with m.lease(token, m.descriptor(token)["generation"]) as (_, reader, db), reader.operation(db):
            with reader._capped(5.0, 100_000):
                reader.reset_budget(db)
                answer = reader.identity(db, "zbig", verify=True)
            self.assertEqual((answer["status"], answer["reason"]), ("interrupted", "verification_interrupted_by_request_budget"))
            self.assertEqual(reader.identities["zbig"]["status"], "not_started")
            self.assertFalse(any(name == "zbig" for name, _, _ in reader.records.values()))
            # A later, independent read under its own budget verifies it.
            reader.reset_budget(db)
            self.assertEqual(reader.identity(db, "zbig", verify=True)["status"], "verified")

    def test_a_tables_own_budget_failure_is_still_its_verdict(self):
        m = self.manager(reader_options={"vm_steps": 20_000})
        state = self.query(m, "rows", table="zbig", limit=1)["identity"]
        self.assertEqual(state["status"], "budget_exceeded")
        self.assertEqual(self.identities(m)["zbig"]["status"], "budget_exceeded")

    def test_the_tables_own_row_limit_is_not_treated_as_transient(self):
        # Met inside a find, a limit of the table's own is still its verdict.
        m = self.manager(reader_options={"verify_rows": 10, "incoming_page_steps": 10**9})
        self.find_to_end(m, "x")
        self.assertEqual(self.identities(m)["zbig"], {"status": "budget_exceeded", "key_columns": ["id"],
                                                     "verified_rows": None, "reason": "identity_verification_budget_exceeded"})


class TestKnownIdentityInAnswers(Fixture):
    """The records window and incoming groups say what is known of a table's identity."""

    def setUp(self):
        super().setUp()
        self.build("CREATE TABLE parent(id INTEGER PRIMARY KEY); INSERT INTO parent VALUES (1);"
                   "CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));"
                   "INSERT INTO child VALUES (1, 1), (2, 1), (3, 1);"
                   "CREATE TABLE loose(parent_id INTEGER REFERENCES parent(id)); INSERT INTO loose VALUES (1);")
        self.m = self.manager()
        self.parent = self.query(self.m, "rows", table="parent")["rows"][0]["record_id"]

    def test_incoming_groups_carry_the_child_identity_without_verifying_it(self):
        groups = {g["declaration"]["child_table"]: g for g in
                  self.query(self.m, "references", record=self.parent, direction="incoming")["groups"]}
        self.assertEqual(groups["child"]["child_identity"]["status"], "not_started")
        self.assertEqual(groups["loose"]["child_identity"]["status"], "no_declared_key")
        self.assertEqual(groups["child"]["count"], {"status": "exact", "value": 3, "reason": None})

    def test_the_records_window_reports_the_identity_it_placed_under(self):
        fk = self.query(self.m, "references", record=self.parent, direction="incoming")["groups"]
        loose = next(g for g in fk if g["declaration"]["child_table"] == "loose")["declaration"]["declaration_id"]
        child = next(g for g in fk if g["declaration"]["child_table"] == "child")["declaration"]["declaration_id"]
        placed = self.query(self.m, "records", table="child", mode="reference", record=self.parent, fk=child)
        self.assertEqual((placed["identity"]["status"], len(placed["records"]), placed["skipped"]), ("verified", 3, 0))
        unplaceable = self.query(self.m, "records", table="loose", mode="reference", record=self.parent, fk=loose)
        self.assertEqual((unplaceable["identity"]["status"], len(unplaceable["records"]), unplaceable["skipped"]),
                         ("no_declared_key", 0, 1))


if __name__ == "__main__":
    unittest.main()

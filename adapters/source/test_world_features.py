"""Sorting and the records window (owner decisions O8.5, O8.6, O8.9).

Run: python3 -m unittest adapters.source.test_world_features -v
"""
from __future__ import annotations

import unittest

from adapters.source.model import SourceError
from adapters.source.test_source import Fixture

TABLES = """
CREATE TABLE item(id INTEGER PRIMARY KEY, kind TEXT, size INTEGER);
INSERT INTO item VALUES (1,'b',3),(2,'a',3),(3,NULL,1),(4,'b',2),(5,'a',NULL),(6,'c',2),(7,'b',1);
CREATE TABLE keyless(kind TEXT, size INTEGER);
INSERT INTO keyless VALUES ('x',2),('y',1),('x',1);
CREATE VIEW item_view AS SELECT kind, size FROM item;
CREATE TABLE parent(id INTEGER PRIMARY KEY, name TEXT);
INSERT INTO parent VALUES (1,'one'),(2,'two');
CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id), label TEXT);
INSERT INTO child VALUES (1,1,'z'),(2,2,'y'),(3,1,'x'),(4,1,'w');
"""


def cells(rows, column):
    return [next(c for c in r["cells"] if c["column"] == column) for r in rows]


def exact(cell):
    return None if cell["storage_class"] == "null" else cell["exact"]


class TestSorting(Fixture):
    def setUp(self):
        super().setUp()
        self.build(TABLES)
        self.m = self.manager()

    def test_column_order_breaks_ties_by_the_verified_key_and_pages_stably(self):
        page = self.query(self.m, "rows", table="item", order="kind", limit=50)
        self.assertEqual((page["ordering"], page["order"]),
                         ("column", {"column": "kind", "desc": False, "tiebreak": "verified_primary_key"}))
        # SQLite's own comparison: NULL first, then text; ties by id.
        self.assertEqual([exact(c) for c in cells(page["rows"], "id")], ["3", "2", "5", "1", "4", "7", "6"])
        first = self.query(self.m, "rows", table="item", order="kind", limit=3)
        second = self.query(self.m, "rows", table="item", order="kind", limit=3, offset=3)
        third = self.query(self.m, "rows", table="item", order="kind", limit=3, offset=6)
        self.assertEqual([r["record_id"] for r in first["rows"] + second["rows"] + third["rows"]],
                         [r["record_id"] for r in page["rows"]])
        down = self.query(self.m, "rows", table="item", order="size", desc=1)
        self.assertEqual([exact(c) for c in cells(down["rows"], "id")], ["1", "2", "4", "6", "3", "7", "5"])
        self.assertTrue(down["order"]["desc"])

    def test_unsorted_reads_are_unchanged(self):
        page = self.query(self.m, "rows", table="item")
        self.assertEqual((page["ordering"], page["order"]), ("verified_primary_key", None))
        self.assertEqual([exact(c) for c in cells(page["rows"], "id")], ["1", "2", "3", "4", "5", "6", "7"])

    def test_ties_without_a_key_follow_the_stored_row_and_a_view_says_they_are_unordered(self):
        keyless = self.query(self.m, "rows", table="keyless", order="kind")
        self.assertEqual(keyless["order"]["tiebreak"], "row_location")
        self.assertEqual([(exact(a), exact(b)) for a, b in zip(cells(keyless["rows"], "kind"), cells(keyless["rows"], "size"))],
                         [("x", "2"), ("x", "1"), ("y", "1")])
        view = self.query(self.m, "rows", table="item_view", order="size")
        self.assertEqual(view["order"]["tiebreak"], "unspecified")
        self.assertEqual([exact(c) for c in cells(view["rows"], "size")], [None, "1", "1", "2", "2", "3", "3"])

    def test_search_takes_the_same_order(self):
        page = self.query(self.m, "search", table="item", text="b", column="kind", order="size")
        self.assertEqual([exact(c) for c in cells(page["rows"], "id")], ["7", "4", "1"])
        self.assertEqual(page["order"]["column"], "size")

    def test_unknown_columns_and_stray_desc_are_refused(self):
        for query in ({"order": "missing"}, {"order": "id; DROP TABLE item"}, {"desc": "1"}, {"order": "kind", "desc": "yes"}):
            with self.subTest(query=query), self.assertRaises(SourceError) as failure:
                self.query(self.m, "rows", table="item", **query)
            self.assertEqual(failure.exception.code, "invalid_parameter")


class TestRecordsWindow(Fixture):
    def setUp(self):
        super().setUp()
        self.build(TABLES)
        self.m = self.manager()

    def test_a_table_window_comes_back_as_the_records_single_reads_return(self):
        page = self.query(self.m, "records", table="item", order="kind", limit=4)
        rows = self.query(self.m, "rows", table="item", order="kind", limit=4)
        self.assertEqual([e["record"]["record_id"] for e in page["records"]], [r["record_id"] for r in rows["rows"]])
        for entry in page["records"]:
            self.assertEqual(entry["record"], self.query(self.m, "record", id=entry["record"]["record_id"]))
            self.assertNotIn("observation", entry)
        self.assertEqual((page["skipped"], page["has_more"], page["next_offset"], page["order"]["column"]), (0, True, 4, "kind"))

    def test_rows_without_a_handle_are_counted_never_returned(self):
        page = self.query(self.m, "records", table="keyless")
        self.assertEqual((page["records"], page["skipped"], page["returned"]), ([], 3, 3))

    def test_a_reference_group_comes_back_with_each_exact_observation(self):
        parent = self.query(self.m, "rows", table="parent")["rows"][0]["record_id"]
        fk = self.query(self.m, "references", record=parent, direction="incoming")["groups"][0]["declaration"]["declaration_id"]
        page = self.query(self.m, "records", table="child", mode="reference", record=parent, fk=fk, order="label")
        self.assertEqual([exact(cells([e["record"]], "label")[0]) for e in page["records"]], ["w", "x", "z"])
        for entry in page["records"]:
            observation = entry["observation"]
            self.assertEqual(observation, self.query(self.m, "reference", record=entry["record"]["record_id"], fk=fk))
            self.assertEqual((observation["status"], observation["parent"]["record_id"]), ("resolved", parent))

    def test_records_take_the_search_parameters_and_nothing_stray(self):
        page = self.query(self.m, "records", table="item", mode="literal", text="a", column="kind")
        self.assertEqual(len(page["records"]), 2)
        with self.assertRaises(SourceError) as failure:
            self.query(self.m, "records", table="item", text="a")
        self.assertEqual(failure.exception.code, "invalid_search_parameters")


if __name__ == "__main__":
    unittest.main()


class TestGlobalFind(Fixture):
    def setUp(self):
        super().setUp()
        self.build(TABLES)
        self.m = self.manager()

    def all_hits(self, m, text, limit=50):
        hits, cursor, rounds = [], None, 0
        while True:
            page = self.query(m, "find", text=text, limit=limit, **({"cursor": cursor} if cursor else {}))
            hits += page["hits"]
            rounds += 1
            if page["completion"] == "complete":
                return hits, rounds
            cursor = page["next_cursor"]
            self.assertLess(rounds, 200)

    def test_find_is_the_per_table_literal_search_across_every_table_and_view(self):
        page = self.query(self.m, "find", text="b")
        self.assertEqual((page["completion"], page["next_cursor"], page["skipped"]), ("complete", None, []))
        expected = []
        for table in ("item", "keyless", "item_view", "parent", "child"):
            for row in self.query(self.m, "search", table=table, text="b")["rows"]:
                expected.append((table, row["record_id"], tuple(row["matched_columns"])))
        self.assertEqual([(h["table"], h["record_id"], tuple(h["matched_columns"])) for h in page["hits"]], sorted(expected, key=lambda e: ["item", "keyless", "item_view", "parent", "child"].index(e[0])))
        self.assertTrue(all(c["column"] in h["matched_columns"] for h in page["hits"] for c in h["cells"]))

    def test_cursor_paging_returns_every_hit_once(self):
        whole = self.query(self.m, "find", text="1")["hits"]
        paged, rounds = self.all_hits(self.m, "1", limit=2)
        self.assertGreater(rounds, 2)
        self.assertEqual(paged, whole)

    def test_a_spent_cap_says_where_it_stopped_and_names_a_table_too_large_to_search(self):
        big = [("INSERT INTO big(v) VALUES (?)", [("x",)] * 40000 + [("needle",)])]
        self.build("CREATE TABLE big(id INTEGER PRIMARY KEY, v TEXT); CREATE TABLE after(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO after VALUES (1, 'needle');", big)
        m = self.manager(reader_options={"incoming_page_steps": 100_000})
        # The small tables before it spend part of the cap: stop with a cursor, never "no matches".
        page = self.query(m, "find", text="needle")
        self.assertEqual(page["completion"], "budget_exceeded")
        self.assertRegex(page["next_cursor"], r"^\d+:\d+$")
        skipped, found, cursor = list(page["skipped"]), list(page["hits"]), page["next_cursor"]
        while True:
            page = self.query(m, "find", text="needle", cursor=cursor)
            skipped += page["skipped"]
            found += page["hits"]
            if page["completion"] == "complete":
                break
            cursor = page["next_cursor"]
        # With the whole cap to itself, big still cannot be searched: it is named, and find moves on.
        self.assertEqual(skipped, [{"table": "big", "reason": "find_budget_exceeded"}])
        self.assertEqual([h["table"] for h in found], ["after"])

    def test_bad_text_and_cursors_are_refused(self):
        for query in ({"text": ""}, {"text": "x" * 1025}, {"text": "b", "cursor": "9:0"}, {"text": "b", "cursor": "a:b"}, {"text": "b", "limit": "51"},
                      {"text": "b", "offset": "1"}):
            with self.subTest(query=query), self.assertRaises(SourceError):
                self.query(self.m, "find", **query)


class TestFindTablesAndCase(Fixture):
    """O10 and O11: find lists tables by name, and ignores case like the filter."""

    def setUp(self):
        super().setUp()
        self.build(TABLES)
        self.m = self.manager()

    def test_the_first_answer_lists_tables_and_views_by_name_ignoring_case(self):
        page = self.query(self.m, "find", text="ITEM")
        self.assertEqual(page["relations"], [{"name": "item", "kind": "table"}, {"name": "item_view", "kind": "view"}])
        self.assertEqual((page["case"], page["text_comparison"]["policy"]), ("ignore", "casefold_v1"))
        exact = self.query(self.m, "find", text="ITEM", case="match")
        self.assertEqual((exact["relations"], exact["text_comparison"]["policy"]), ([], "exact_v1"))
        # Continuations do not repeat them.
        first = self.query(self.m, "find", text="1", limit=2)
        self.assertEqual(self.query(self.m, "find", text="1", limit=2, cursor=first["next_cursor"])["relations"], [])

    def test_record_hits_ignore_case_as_the_table_filter_does(self):
        hits = self.query(self.m, "find", text="ONE")["hits"]
        self.assertEqual([(h["table"], h["matched_columns"]) for h in hits], [("parent", ["name"])])
        self.assertEqual(self.query(self.m, "find", text="ONE", case="match")["hits"], [])
        with self.assertRaises(SourceError):
            self.query(self.m, "find", text="ONE", case="upper")

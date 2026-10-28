"""Incoming FK discovery: the inverse of outgoing resolution, never a cell filter.

Run from repository root: python -m unittest discover -s adapters/source -v
Expectations come from each child row's existing outgoing observation or, for
children without a handle, from a replay of that observation's comparison.
No test mutates a producer or capture.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import unittest
from collections import Counter, defaultdict
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from adapters.source.model import MAX_CELL_BYTES, SourceError, quote
from adapters.source.server import SessionManager, SourceHTTPServer, dispatch
from adapters.source.test_source import ROOT, Fixture

PHONE_1 = Path(os.environ.get("KI_SPIDER_PHONE_1", Path.home() /
               ".cache/ki-demo-databases/spider/spider_data/database/phone_1/phone_1.sqlite"))
PHONE_1_SHA256 = "d4c874e411976e7b8a971cdb3f0685dc5d2f40f4ab225260aa8cd143b4ab76f7"

# Each block is a counterexample to some shortcut (child equality, child index,
# affinity guessing, Python comparison). The outgoing read defines the answer.
EDGE = """
CREATE TABLE p_nocase(code TEXT COLLATE NOCASE PRIMARY KEY, label TEXT);
INSERT INTO p_nocase VALUES ('ABC','upper'),('def','lower');
CREATE TABLE c_nocase(id INTEGER PRIMARY KEY, code TEXT REFERENCES p_nocase(code));
CREATE INDEX c_nocase_code ON c_nocase(code);
INSERT INTO c_nocase(code) VALUES ('abc'),('ABC'),('Abc'),('DEF'),('xyz'),(NULL);

CREATE TABLE p_int(id INTEGER PRIMARY KEY, name TEXT);
INSERT INTO p_int VALUES (1,'one'),(2,'two'),(3,'three');
CREATE TABLE c_text(id INTEGER PRIMARY KEY, pid TEXT REFERENCES p_int(id));
CREATE INDEX c_text_pid ON c_text(pid);
INSERT INTO c_text(pid) VALUES ('1'),('01'),('1.0'),(1),('+1'),('2'),('x'),(NULL);
CREATE TABLE c_none(id INTEGER PRIMARY KEY, pid REFERENCES p_int(id));
INSERT INTO c_none(pid) VALUES ('1'),(1),(1.0),('2'),(X'01');
CREATE TABLE c_nokey(pid INTEGER REFERENCES p_int(id), note TEXT);
INSERT INTO c_nokey VALUES (1,'a'),(1,'b'),(2,'c'),(9,'d');

CREATE TABLE p_text(code TEXT PRIMARY KEY);
INSERT INTO p_text VALUES ('1'),('1.0'),('0.3'),('0.30000000000000004');
CREATE TABLE c_real(id INTEGER PRIMARY KEY, code REAL REFERENCES p_text(code));
CREATE INDEX c_real_code ON c_real(code);
INSERT INTO c_real(code) VALUES ('1'),(1.0),(0.1+0.2),('0.3'),('abc');

CREATE TABLE screen_mode(Graphics_mode real, Char_cells text, PRIMARY KEY(Graphics_mode));
INSERT INTO screen_mode VALUES (1.0,'80x25'),(3.0,'40x25');
CREATE TABLE phone(Hardware_Model_name text, screen_mode text, PRIMARY KEY(Hardware_Model_name),
  FOREIGN KEY(screen_mode) REFERENCES screen_mode(Graphics_mode));
INSERT INTO phone VALUES ('a','1'),('b','3'),('c','1');

CREATE TABLE p_comp(a INTEGER, b TEXT COLLATE NOCASE, note TEXT, PRIMARY KEY(a,b));
INSERT INTO p_comp VALUES (1,'X','one-x'),(1,'y','one-y'),(2,'X','two-x'),(5,'q','none');
CREATE TABLE c_comp(id INTEGER PRIMARY KEY, a INTEGER, b TEXT, FOREIGN KEY(a,b) REFERENCES p_comp(a,b));
CREATE INDEX c_comp_ba ON c_comp(b,a);
INSERT INTO c_comp(a,b) VALUES (1,'X'),(1,'x'),('1','X'),(1,NULL),(NULL,'X'),(2,'x'),(3,'X'),(1,'Y');

CREATE TABLE airport(code TEXT PRIMARY KEY, name TEXT);
INSERT INTO airport VALUES ('AMS','Schiphol'),('IST','Istanbul'),('LHR','Heathrow');
CREATE TABLE flight(id INTEGER PRIMARY KEY, origin TEXT REFERENCES airport(code),
  dest TEXT REFERENCES airport(code));
INSERT INTO flight(origin,dest) VALUES ('AMS','IST'),('IST','AMS'),('AMS','AMS'),('LHR',NULL),('AMS','JFK');
CREATE TABLE person(id INTEGER PRIMARY KEY, boss INTEGER REFERENCES person(id));
INSERT INTO person VALUES (1,NULL),(2,1),(3,1),(4,2),(5,99);

CREATE TABLE p_nonunique(id INTEGER PRIMARY KEY, grp TEXT);
INSERT INTO p_nonunique VALUES (1,'a'),(2,'a'),(3,'b');
CREATE TABLE c_nonunique(id INTEGER PRIMARY KEY, grp TEXT REFERENCES p_nonunique(grp),
  owner INTEGER REFERENCES p_nonunique(id));
INSERT INTO c_nonunique VALUES (1,'a',1),(2,'b',1);

CREATE TABLE p_strict(id INTEGER PRIMARY KEY) STRICT;
INSERT INTO p_strict VALUES (1),(2);
CREATE TABLE c_strict_any(id INTEGER PRIMARY KEY, pid ANY REFERENCES p_strict(id)) STRICT;
CREATE INDEX c_strict_any_pid ON c_strict_any(pid);
INSERT INTO c_strict_any(pid) VALUES ('1'),(1),(2),('2'),(1.0),('1.0');

CREATE TABLE p_wr(code TEXT PRIMARY KEY, n INTEGER) WITHOUT ROWID;
INSERT INTO p_wr VALUES ('a',1),('b',2);
CREATE TABLE c_wr(k TEXT, seq INTEGER, code TEXT REFERENCES p_wr(code), PRIMARY KEY(k,seq)) WITHOUT ROWID;
INSERT INTO c_wr VALUES ('x',1,'a'),('x',2,'a'),('y',1,'b');
CREATE TABLE c_gen(id INTEGER PRIMARY KEY, raw TEXT,
  code TEXT GENERATED ALWAYS AS (lower(raw)) VIRTUAL REFERENCES p_wr(code),
  scode TEXT GENERATED ALWAYS AS (lower(raw)) STORED REFERENCES p_wr(code));
INSERT INTO c_gen(raw) VALUES ('A'),('B'),('Z'),(NULL);
CREATE TABLE p_gen(id INTEGER PRIMARY KEY, raw TEXT, code TEXT GENERATED ALWAYS AS (upper(raw)) STORED UNIQUE);
INSERT INTO p_gen(raw) VALUES ('x'),('y');
CREATE TABLE c_pgen(id INTEGER PRIMARY KEY, code TEXT REFERENCES p_gen(code));
INSERT INTO c_pgen(code) VALUES ('X'),('x'),('q');
"""


def drift(path):
    """Stored values that no longer conform to their column's declared affinity.

    c_drift.code is created INTEGER, filled, then its recorded type is changed
    to TEXT. An index lookup on the child column would now miss rows that the
    outgoing comparison still resolves (PRAGMA quick_check reports them).
    """
    with closing(sqlite3.connect(path)) as db:
        db.executescript("""
          CREATE TABLE p_code(code TEXT PRIMARY KEY); INSERT INTO p_code VALUES ('7'),('8'),('9');
          CREATE TABLE c_drift(id INTEGER PRIMARY KEY, code INTEGER REFERENCES p_code(code));
          CREATE INDEX c_drift_code ON c_drift(code);
          INSERT INTO c_drift(code) VALUES (7),('8'),('x');""")
        db.execute("PRAGMA writable_schema=ON")
        db.execute("UPDATE sqlite_schema SET sql=replace(sql,'code INTEGER REFERENCES','code TEXT REFERENCES') WHERE name='c_drift'")
        db.commit()
    with closing(sqlite3.connect(path)) as db:
        assert db.execute("SELECT group_concat(typeof(code)) FROM c_drift").fetchone()[0] == "integer,integer,text"


def key_text(value):
    return struct.pack(">d", value).hex() if type(value) is float else str(value)


class IncomingFixture(Fixture):
    def edge(self):
        self.build(EDGE)
        drift(self.path)
        return self.manager()

    def all_rows(self, m, table):
        rows, offset = [], 0
        while True:
            page = self.query(m, "rows", table=table, limit=100, offset=offset)
            rows += page["rows"]
            if not page["has_more"]:
                return page, rows
            offset = page["next_offset"]

    def incoming(self, m, handle, **options):
        groups, offset = [], 0
        while True:
            page = self.query(m, "references", record=handle, direction="incoming", limit=100, offset=offset, **options)
            self.assertEqual((page["record_id"], page["direction"]), (handle, "incoming"))
            groups += page["groups"]
            if not page["has_more"]:
                self.assertEqual(len(groups), page["total"])
                return groups
            offset = page["next_offset"]

    def referencing(self, m, handle, fk, limit=100):
        rows, offset = [], 0
        while True:
            page = self.query(m, "search", table=fk["child_table"], mode="reference", record=handle,
                              fk=fk["declaration_id"], limit=limit, offset=offset)
            rows += page["rows"]
            if page["completion"] == "complete":
                return page, rows
            offset = page["next_offset"]

    def handle(self, m, table, *key):
        _, rows = self.all_rows(m, table)
        return next(r["record_id"] for r in rows
                    if tuple(c.get("exact", c.get("ieee754_hex")) for c in r["key"]) == tuple(map(key_text, key)))

    def counts(self, m, table, *key):
        return {(g["declaration"]["child_table"],) + tuple(p["child_column"] for p in g["declaration"]["pairs"]): g["count"]
                for g in self.incoming(m, self.handle(m, table, *key))}

    def replay(self, m, path, fk):
        """The outgoing comparison, replayed for children that have no handle."""
        found = Counter()
        cols = [p["child_column"] for p in fk["pairs"]]
        parent = fk["parent_table"]
        with closing(sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro&immutable=1", uri=True)) as db:
            pk = [r[1] for r in sorted(db.execute(f"PRAGMA table_info({quote(parent)})"), key=lambda r: r[5]) if r[5]]
            where = " AND ".join(f"{quote(p['parent_column'])} = ?" for p in fk["pairs"])
            for values in db.execute(f"SELECT {','.join(map(quote, cols))} FROM {quote(fk['child_table'])}"):
                if any(v is None or (type(v) is bytes and len(v) > MAX_CELL_BYTES) for v in values):
                    continue
                matches = db.execute(f"SELECT {','.join(map(quote, pk))} FROM {quote(parent)} WHERE {where} LIMIT 2", values).fetchall()
                if len(matches) == 1:
                    found[self.handle(m, parent, *matches[0])] += 1
        return found

    def assert_inverse(self, m, path):
        """Incoming from every parent record == outgoing resolution from every child."""
        tables = [r["name"] for r in self.query(m, "schema", limit=100)["relations"] if r["kind"] == "table"]
        identity, handles = {}, {}
        for table in tables:
            try:
                page, rows = self.all_rows(m, table)
            except SourceError:
                continue  # an unreadable table has its own test
            identity[table] = page["identity"]["status"]
            handles[table] = [r["record_id"] for r in rows if r["record_id"]]
        expected = defaultdict(set)
        for hs in handles.values():
            for h in hs:
                for obs in self.query(m, "references", record=h, limit=100)["observations"]:
                    if obs["status"] == "resolved":
                        expected[(obs["parent"]["record_id"], obs["declaration"]["declaration_id"])].add(obs["observation_id"])
        replays, checked = {}, Counter()
        for table, hs in handles.items():
            for h in hs:
                for group in self.incoming(m, h):
                    fk, count = group["declaration"], group["count"]
                    self.assertEqual(fk["parent_table"], table)
                    if fk["validation"]["status"] != "verified_declaration" or count["status"] != "exact":
                        self.assertIsNone(count["value"])
                        continue
                    page, rows = self.referencing(m, h, fk)
                    self.assertEqual(count["value"], len(rows))
                    self.assertTrue(all(r["matched_columns"] == [p["child_column"] for p in fk["pairs"]] for r in rows))
                    if identity.get(fk["child_table"]) == "verified":
                        self.assertEqual({r["observation_id"] for r in rows}, expected.pop((h, fk["declaration_id"]), set()))
                        checked["observation"] += len(rows)
                    else:
                        self.assertTrue(all(r["record_id"] is None and r["observation_id"] is None for r in rows))
                        if fk["declaration_id"] not in replays:
                            replays[fk["declaration_id"]] = self.replay(m, path, fk)
                        self.assertEqual(count["value"], replays[fk["declaration_id"]][h])
                        checked["replayed"] += len(rows)
        # Nothing resolved outgoing is missing from the incoming side.
        self.assertEqual(dict(expected), {})
        return checked


class TestIncomingMatching(IncomingFixture):
    def test_every_incoming_hit_is_the_outgoing_observation_and_none_is_missing(self):
        m = self.edge()
        checked = self.assert_inverse(m, self.path)
        self.assertGreater(checked["observation"], 40)
        self.assertGreater(checked["replayed"], 0)

    def test_parent_affinity_and_collation_not_child_equality(self):
        m = self.edge()
        exact = lambda counts: {k: v["value"] for k, v in counts.items()}
        # NOCASE parent, BINARY child with its own index: 'abc','ABC','Abc'.
        self.assertEqual(exact(self.counts(m, "p_nocase", "ABC")), {("c_nocase", "code"): 3})
        self.assertEqual(exact(self.counts(m, "p_nocase", "def")), {("c_nocase", "code"): 1})
        # INTEGER parent: TEXT '01', '1.0', '+1' and no-affinity '1' all resolve to 1.
        self.assertEqual(exact(self.counts(m, "p_int", 1)), {("c_text", "pid"): 5, ("c_none", "pid"): 3, ("c_nokey", "pid"): 2})
        # SQLite's REAL-to-TEXT conversion changed across versions. Use its
        # own FK checker as an independent oracle for each parent value.
        with closing(sqlite3.connect(self.path)) as source:
            values = source.execute("SELECT code FROM c_real").fetchall()
        for parent in ("0.3", "0.30000000000000004", "1.0", "1"):
            with closing(sqlite3.connect(":memory:")) as oracle:
                oracle.executescript("CREATE TABLE p(code TEXT PRIMARY KEY); CREATE TABLE c(code REAL REFERENCES p(code));")
                oracle.execute("INSERT INTO p VALUES (?)", (parent,))
                oracle.executemany("INSERT INTO c VALUES (?)", values)
                violations = list(oracle.execute("PRAGMA foreign_key_check(c)"))
                expected = len(values) - len(violations)
            self.assertEqual(exact(self.counts(m, "p_text", parent)), {("c_real", "code"): expected})
        # phone_1 shape: REAL parent key, TEXT child values '1' and '3'.
        self.assertEqual(exact(self.counts(m, "screen_mode", 1.0)), {("phone", "screen_mode"): 2})
        with closing(sqlite3.connect(self.path)) as db:
            # The shortcut this replaces: child-column equality finds none of them.
            self.assertEqual(db.execute("SELECT count(*) FROM phone WHERE screen_mode = 1.0").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM c_nocase WHERE code = 'ABC'").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT count(*) FROM c_real WHERE code = '0.30000000000000004'").fetchone()[0], 1)

    def test_strict_any_and_nonconformant_storage(self):
        m = self.edge()
        self.assertEqual(self.counts(m, "p_strict", 1)[("c_strict_any", "pid")]["value"], 4)
        self.assertEqual(self.counts(m, "p_strict", 2)[("c_strict_any", "pid")]["value"], 2)
        # Drifted INTEGER storage under a TEXT declaration: an index seek for
        # '7' finds nothing, the parent-side comparison still resolves it.
        self.assertEqual(self.counts(m, "p_code", "7")[("c_drift", "code")]["value"], 1)
        self.assertEqual(self.counts(m, "p_code", "8")[("c_drift", "code")]["value"], 1)
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM c_drift INDEXED BY c_drift_code WHERE code = '7'").fetchone()[0], 0)
            self.assertIn("NUMERIC value in c_drift.code", " ".join(r[0] for r in db.execute("PRAGMA quick_check")))
            # The independent FK checker agrees that both stored integers resolve.
            self.assertEqual([r[1] for r in db.execute("PRAGMA foreign_key_check(c_drift)")], [3])

    def test_composite_null_and_dangling(self):
        m = self.edge()
        self.assertEqual(self.counts(m, "p_comp", 1, "X")[("c_comp", "a", "b")]["value"], 3)
        self.assertEqual(self.counts(m, "p_comp", 1, "y")[("c_comp", "a", "b")]["value"], 1)
        self.assertEqual(self.counts(m, "p_comp", 2, "X")[("c_comp", "a", "b")]["value"], 1)
        # Exact zero is a count, not a missing group.
        self.assertEqual(self.counts(m, "p_comp", 5, "q")[("c_comp", "a", "b")], {"status": "exact", "value": 0, "reason": None})
        page, rows = self.referencing(m, self.handle(m, "p_comp", 1, "X"),
                                      self.incoming(m, self.handle(m, "p_comp", 1, "X"))[0]["declaration"])
        self.assertEqual([(r["cells"][1]["exact"], r["cells"][2]["exact"]) for r in rows], [("1", "X"), ("1", "x"), ("1", "X")])
        self.assertEqual(page["searched_columns"], ["a", "b"])
        # NULL components and the dangling (3,'X') never reach any parent.
        reached = set()
        for key in [(1, "X"), (1, "y"), (2, "X"), (5, "q")]:
            h = self.handle(m, "p_comp", *key)
            reached |= {r["record_id"] for r in self.referencing(m, h, self.incoming(m, h)[0]["declaration"])[1]}
        _, children = self.all_rows(m, "c_comp")
        statuses = {c["record_id"]: self.query(m, "references", record=c["record_id"])["observations"][0]["status"] for c in children}
        self.assertEqual({h for h, s in statuses.items() if s != "resolved"}, {h for h in statuses if h not in reached})
        self.assertEqual(Counter(statuses.values()), {"resolved": 5, "null_reference": 2, "dangling": 1})

    def test_parallel_declarations_and_self_reference_keep_separate_observations(self):
        m = self.edge()
        ams = self.handle(m, "airport", "AMS")
        groups = {g["declaration"]["pairs"][0]["child_column"]: g for g in self.incoming(m, ams)}
        self.assertEqual({column: g["count"]["value"] for column, g in groups.items()}, {"origin": 3, "dest": 2})
        self.assertNotEqual(groups["origin"]["declaration"]["declaration_id"], groups["dest"]["declaration"]["declaration_id"])
        origin = {r["record_id"]: r["observation_id"] for r in self.referencing(m, ams, groups["origin"]["declaration"])[1]}
        dest = {r["record_id"]: r["observation_id"] for r in self.referencing(m, ams, groups["dest"]["declaration"])[1]}
        shared = set(origin) & set(dest)
        self.assertEqual(len(shared), 1)  # AMS→AMS: one row, two observations
        row = shared.pop()
        self.assertNotEqual(origin[row], dest[row])
        self.assertEqual(self.counts(m, "airport", "LHR")[("flight", "dest")], {"status": "exact", "value": 0, "reason": None})
        boss = self.handle(m, "person", 1)
        group = self.incoming(m, boss)[0]
        self.assertEqual((group["declaration"]["child_table"], group["count"]["value"]), ("person", 2))
        reports = self.referencing(m, boss, group["declaration"])[1]
        self.assertEqual([r["key"][0]["exact"] for r in reports], ["2", "3"])
        self.assertNotIn(boss, {r["record_id"] for r in reports})

    def test_invalid_declarations_have_no_count_and_no_page(self):
        m = self.edge()
        h = self.handle(m, "p_nonunique", 1)
        groups = {g["declaration"]["pairs"][0]["child_column"]: g for g in self.incoming(m, h)}
        self.assertEqual(groups["grp"]["count"], {"status": "invalid_declaration", "value": None,
                                                 "reason": "parent_key_not_eligible_unique_constraint"})
        self.assertEqual(groups["owner"]["count"]["value"], 2)  # a valid sibling is unaffected
        with self.assertRaises(SourceError) as failure:
            self.referencing(m, h, groups["grp"]["declaration"])
        self.assertEqual((failure.exception.code, failure.exception.status), ("incoming_declaration_not_verified", 422))
        # A declaration that names no existing table is not incoming to anything.
        self.build("CREATE TABLE lonely(id INTEGER PRIMARY KEY, x REFERENCES nowhere(id)); INSERT INTO lonely VALUES(1,1);")
        fresh = self.manager()
        self.assertEqual(self.incoming(fresh, self.handle(fresh, "lonely", 1)), [])

    def test_without_rowid_and_generated_columns(self):
        m = self.edge()
        counts = self.counts(m, "p_wr", "a")
        self.assertEqual({k: v["value"] for k, v in counts.items()},
                         {("c_wr", "code"): 2, ("c_gen", "scode"): 1, ("c_gen", "code"): 1})
        group = next(g for g in self.incoming(m, self.handle(m, "p_wr", "a")) if g["declaration"]["child_table"] == "c_wr")
        rows = self.referencing(m, self.handle(m, "p_wr", "a"), group["declaration"])[1]
        self.assertEqual([[c["exact"] for c in r["key"]] for r in rows], [["x", "1"], ["x", "2"]])
        # A generated STORED UNIQUE parent key.
        self.assertEqual(self.counts(m, "p_gen", 1)[("c_pgen", "code")]["value"], 1)

    def test_identity_unavailable_children_are_counted_without_handles(self):
        m = self.edge()
        h = self.handle(m, "p_int", 1)
        group = next(g for g in self.incoming(m, h) if g["declaration"]["child_table"] == "c_nokey")
        page, rows = self.referencing(m, h, group["declaration"])
        self.assertEqual(page["identity"]["status"], "no_declared_key")
        self.assertEqual(page["ordering"], "unspecified_window_only")
        self.assertEqual([(r["record_id"], r["observation_id"], r["cells"][1]["exact"]) for r in rows],
                         [(None, None, "a"), (None, None, "b")])
        # A key table over the identity registry budget: readable, not addressable.
        self.build("""CREATE TABLE parent(id INTEGER PRIMARY KEY); INSERT INTO parent VALUES (1),(2);
          CREATE TABLE child(id INTEGER PRIMARY KEY, p REFERENCES parent(id));
          INSERT INTO child(p) VALUES (1),(1),(2),(1),(2);""")
        small = self.manager(reader_options={"key_rows": 4})
        h = self.handle(small, "parent", 1)
        group = self.incoming(small, h)[0]
        self.assertEqual(group["count"]["value"], 3)
        page, rows = self.referencing(small, h, group["declaration"])
        self.assertEqual(page["identity"]["status"], "budget_exceeded")
        self.assertEqual([(r["record_id"], r["observation_id"]) for r in rows], [(None, None)] * 3)

    def test_oversized_blob_is_unchecked_not_counted(self):
        self.build("""CREATE TABLE p_int(id INTEGER PRIMARY KEY); INSERT INTO p_int VALUES (1);
          CREATE TABLE p_blob(id INTEGER PRIMARY KEY, tag BLOB UNIQUE);
          INSERT INTO p_blob VALUES (1, zeroblob(2000000)), (2, X'0102'), (3, X'03');
          CREATE TABLE c_blob(id INTEGER PRIMARY KEY, tag REFERENCES p_blob(tag));
          INSERT INTO c_blob(tag) VALUES (zeroblob(2000000)), (X'0102'), (X'0102'), (zeroblob(1500000));
          CREATE TABLE c_blob_int(id INTEGER PRIMARY KEY, pid REFERENCES p_int(id));
          INSERT INTO c_blob_int(pid) VALUES (zeroblob(2000000)), (1);""")
        m = self.manager()
        _, children = self.all_rows(m, "c_blob")
        outgoing = [self.query(m, "references", record=c["record_id"])["observations"][0] for c in children]
        self.assertEqual([o["status"] for o in outgoing], ["budget_exceeded", "resolved", "resolved", "budget_exceeded"])
        self.assertEqual(outgoing[0]["reason"], "child_blob_matching_budget_exceeded")
        # The 2,000,000-byte parent can equal only the same-length child: unchecked, never zero.
        big = self.handle(m, "p_blob", 1)
        group = self.incoming(m, big)[0]
        self.assertEqual(group["count"], {"status": "unavailable", "value": None, "reason": "child_blob_matching_budget_exceeded"})
        page, rows = self.referencing(m, big, group["declaration"])
        self.assertEqual((rows, page["reference"]["unchecked_rows"]), ([], 1))
        self.assertEqual(page["reference"]["unchecked_reason"], "child_blob_matching_budget_exceeded")
        # A short BLOB can never equal an oversized one, so its count is exact.
        small = self.handle(m, "p_blob", 2)
        group = self.incoming(m, small)[0]
        self.assertEqual(group["count"]["value"], 2)
        page, rows = self.referencing(m, small, group["declaration"])
        self.assertEqual((len(rows), page["reference"]["unchecked_rows"]), (2, 0))
        self.assertEqual({r["observation_id"] for r in rows}, {o["observation_id"] for o in outgoing if o["status"] == "resolved"})
        # A BLOB never equals an INTEGER key.
        self.assertEqual(self.counts(m, "p_int", 1)[("c_blob_int", "pid")]["value"], 1)

    def test_alias_cannot_capture_a_child_table_named_like_it(self):
        self.build("""CREATE TABLE parent(id INTEGER PRIMARY KEY, other INTEGER UNIQUE); INSERT INTO parent VALUES (1,2),(2,1);
          CREATE TABLE ki_parent(id INTEGER PRIMARY KEY, p REFERENCES parent(other)); INSERT INTO ki_parent VALUES (1,2),(2,2);""")
        m = self.manager()
        self.assertEqual(self.counts(m, "parent", 1)[("ki_parent", "p")]["value"], 2)
        self.assertEqual(self.counts(m, "parent", 2)[("ki_parent", "p")]["value"], 0)
        self.assert_inverse(m, self.path)


class TestIncomingBudgets(IncomingFixture):
    def wide(self):
        # parent 1 is referenced by every row of a large unindexed table and by
        # two rows of a small one.
        self.build("""CREATE TABLE parent(id INTEGER PRIMARY KEY); INSERT INTO parent VALUES (1),(2);
          CREATE TABLE big(id INTEGER PRIMARY KEY, p INTEGER REFERENCES parent(id), pad TEXT);
          CREATE TABLE small(id INTEGER PRIMARY KEY, p INTEGER REFERENCES parent(id));
          INSERT INTO small(p) VALUES (1),(1),(2);""",
                   [("INSERT INTO big(p, pad) VALUES (?, ?)", [(1, "x" * 20)] * 30000)])

    def test_exhausted_count_is_unavailable_and_leaves_other_groups(self):
        self.wide()
        m = self.manager(reader_options={"vm_steps": 100_000})
        h = self.handle(m, "parent", 1)
        groups = {g["declaration"]["child_table"]: g for g in self.incoming(m, h)}
        # "big" is counted first and exhausts its budget; "small" still has its own.
        self.assertEqual(list(groups), ["big", "small"])
        self.assertEqual(groups["big"]["count"], {"status": "unavailable", "value": None, "reason": "source_query_budget_exceeded"})
        self.assertEqual(groups["small"]["count"], {"status": "exact", "value": 2, "reason": None})
        # Unavailable is not zero: the first page of the same group is readable.
        page = self.query(m, "search", table="big", mode="reference", record=h,
                          fk=groups["big"]["declaration"]["declaration_id"], limit=10)
        self.assertEqual((page["returned"], page["completion"]), (10, "window"))
        # A deep page that needs the whole scan is refused, never an empty page.
        with self.assertRaises(SourceError) as failure:
            self.query(m, "search", table="big", mode="reference", record=h,
                       fk=groups["big"]["declaration"]["declaration_id"], limit=10, offset=29_995)
        self.assertEqual(failure.exception.code, "source_query_budget_exceeded")
        # Default budgets count it exactly.
        default = self.manager()
        self.assertEqual(self.counts(default, "parent", 1)[("big", "p")]["value"], 30000)

    def test_a_sparse_page_costs_about_one_count(self):
        # Two references at the end of 30,000 rows: a page must scan them all.
        self.build("""CREATE TABLE parent(id INTEGER PRIMARY KEY); INSERT INTO parent VALUES (1),(2);
          CREATE TABLE big(id INTEGER PRIMARY KEY, p INTEGER REFERENCES parent(id), pad TEXT);""",
                   [("INSERT INTO big(p, pad) VALUES (?, ?)", [(2, "x" * 20)] * 29998 + [(1, "x" * 20)] * 2)])
        # SQLite query plans differ; the larger bounded budget covers both
        # supported builds while a separate low-budget check remains below.
        m = self.manager(reader_options={"vm_steps": 800_000})
        h = self.handle(m, "parent", 1)
        group = self.incoming(m, h)[0]
        self.assertEqual(group["count"]["value"], 2)
        page, rows = self.referencing(m, h, group["declaration"])
        self.assertEqual((page["returned"], page["completion"]), (2, "complete"))
        self.assertEqual([r["cells"][0]["exact"] for r in rows], ["29999", "30000"])
        # The general search path scans again for size preflight and lookahead,
        # and the same budget refuses it.
        limited = self.manager(reader_options={"vm_steps": 100_000})
        limited_handle = self.handle(limited, "parent", 1)
        limited_group = self.incoming(limited, limited_handle)[0]
        with self.assertRaises(SourceError) as failure:
            self.referencing(limited, limited_handle, limited_group["declaration"])
        self.assertEqual(failure.exception.code, "source_query_budget_exceeded")
        general = self.manager(reader_options={"vm_steps": 400_000})
        general_handle = self.handle(general, "parent", 1)
        general_group = self.incoming(general, general_handle)[0]
        reader = general.sessions[general.initial_session]["reader"]
        with patch.object(reader, "_row_locator", return_value=None), self.assertRaises(SourceError) as failure:
            self.referencing(general, general_handle, general_group["declaration"])
        self.assertEqual(failure.exception.code, "source_query_budget_exceeded")

    def test_rowid_shadowed_by_columns_uses_the_general_path(self):
        self.build("""CREATE TABLE parent(id INTEGER PRIMARY KEY); INSERT INTO parent VALUES (1);
          CREATE TABLE odd(rowid TEXT, _rowid_ TEXT, oid TEXT, p REFERENCES parent(id));
          INSERT INTO odd VALUES ('a','b','c',1),('d','e','f',1),('g','h','i',2);""")
        m = self.manager()
        h = self.handle(m, "parent", 1)
        page, rows = self.referencing(m, h, self.incoming(m, h)[0]["declaration"], limit=1)
        self.assertEqual([r["cells"][0]["exact"] for r in rows], ["a", "d"])
        self.assert_inverse(m, self.path)

    def parallel(self, declarations, rows, extra=""):
        # One parent row referenced by every child row through `declarations`
        # parallel declarations on one column: every count scans every row.
        fks = ", ".join("FOREIGN KEY(c) REFERENCES parent(id)" for _ in range(declarations))
        self.build(f"""CREATE TABLE parent(id INTEGER PRIMARY KEY); INSERT INTO parent VALUES (1);
          CREATE TABLE child(id INTEGER PRIMARY KEY, c INTEGER, {fks});
          WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < {rows})
          INSERT INTO child SELECT i, 1 FROM n;{extra}""")

    def test_an_incoming_page_shares_one_aggregate_budget(self):
        # Twelve declarations that each exhaust an ordinary budget share the
        # page's two, whatever the page size; the rest are named, never zero.
        self.parallel(12, 30000)
        m = self.manager(reader_options={"vm_steps": 100_000})
        h = self.handle(m, "parent", 1)
        reader = m.sessions[m.initial_session]["reader"]
        self.assertEqual(reader.incoming_page_steps, 200_000)
        original, windows = reader.reset_budget, []
        def budget(db, *limits):
            windows.append(original(db, *limits))
            return windows[-1]
        own = ("unavailable", "source_query_budget_exceeded")
        page = ("unavailable", "incoming_page_budget_exceeded")
        skipped = ("not_checked", "incoming_page_budget_exceeded")
        for limit, expected in ((1, [own]), (10, [own, page] + [skipped] * 8), (100, [own, page] + [skipped] * 10)):
            windows.clear()
            with patch.object(reader, "reset_budget", side_effect=budget):
                groups = self.query(m, "references", record=h, direction="incoming", limit=limit)["groups"]
            self.assertEqual([(g["count"]["status"], g["count"]["reason"]) for g in groups], expected)
            self.assertTrue(all(g["count"]["value"] is None for g in groups))
            # The operation's window, then counting windows within the page's work.
            self.assertEqual(len(windows), 1 + min(len(expected), 2))
            self.assertLessEqual(sum(w["steps"] for w in windows[1:]), reader.incoming_page_steps + 2000)
        # Not checked is not zero: the group's rows are still browsable.
        rows = self.query(m, "search", table="child", mode="reference", record=h,
                          fk=groups[-1]["declaration"]["declaration_id"], limit=10)
        self.assertEqual((rows["returned"], rows["completion"]), (10, "window"))

    def test_the_page_time_limit_keeps_exact_counts_exact_and_names_the_rest(self):
        self.parallel(50, 1_000_000, """
          CREATE TABLE z_small(id INTEGER PRIMARY KEY, p INTEGER REFERENCES parent(id)); INSERT INTO z_small(p) VALUES (1),(1);
          CREATE TABLE zz_invalid(id INTEGER PRIMARY KEY, p INTEGER REFERENCES parent(missing));""")
        # Steps never run out here: only the page's 0.1 s can stop a count.
        m = self.manager(reader_options={"vm_steps": 10**12, "incoming_page_seconds": 0.1})
        h = self.handle(m, "parent", 1)
        self.incoming(m, h)  # first use discovers every declaration
        started = time.monotonic()
        groups = self.incoming(m, h)
        elapsed = time.monotonic() - started
        counts = [(g["declaration"]["child_table"], g["count"]["status"], g["count"]["value"], g["count"]["reason"]) for g in groups]
        exact = [c for c in counts if c[1] == "exact"]
        if not exact:  # a slow host cannot finish even one million-row count in 0.1 s
            self.skipTest("no million-row count completed within the page's 0.1 s limit on this machine")
        self.assertTrue(all(c == ("child", "exact", 1_000_000, None) for c in exact))
        rest = counts[len(exact):]
        if rest[0][1] == "unavailable":  # the count the deadline interrupted
            self.assertEqual(rest.pop(0), ("child", "unavailable", None, "incoming_page_budget_exceeded"))
        # Cheap or not, nothing is started after the deadline; invalid is still invalid.
        self.assertEqual(rest[-2:], [("z_small", "not_checked", None, "incoming_page_budget_exceeded"),
                                     ("zz_invalid", "invalid_declaration", None, groups[-1]["declaration"]["validation"]["reason"])])
        self.assertTrue(all(c[1:] == ("not_checked", None, "incoming_page_budget_exceeded") for c in rest[:-1]))
        # 50 full scans of a million rows, cut to about the page's limit.
        self.assertLess(elapsed, 0.5)

    def test_a_concurrent_read_is_served_while_a_page_counts(self):
        # Uncapped, these counts would hold the reader lock past its 1 s wait.
        self.parallel(50, 1_000_000)
        m = self.manager(reader_options={"vm_steps": 10**12, "query_seconds": 1.0, "incoming_page_seconds": 0.2})
        h = self.handle(m, "parent", 1)
        self.incoming(m, h)
        reader = m.sessions[m.initial_session]["reader"]
        counting, original, held = threading.Event(), reader._incoming_count, {}
        def count(*arguments):
            counting.set()
            return original(*arguments)
        def page():
            started = time.monotonic()
            held["groups"] = self.query(m, "references", record=h, direction="incoming", limit=100)["groups"]
            held["seconds"] = time.monotonic() - started
        with patch.object(reader, "_incoming_count", side_effect=count):
            worker = threading.Thread(target=page)
            worker.start()
            self.assertTrue(counting.wait(5))
            started = time.monotonic()
            overview = self.query(m, "overview", limit=1)  # would raise source_reader_busy
            waited = time.monotonic() - started
            worker.join()
        self.assertEqual(overview["counts"]["tables"], 2)
        self.assertLess(waited, 1.0)
        self.assertLess(held["seconds"], 0.7)
        self.assertEqual(held["groups"][-1]["count"]["status"], "not_checked")

    def test_unsupported_child_read_fails_only_its_group(self):
        # A VIRTUAL generated FK value that fails when read (integer overflow).
        self.build("""CREATE TABLE parent(id INTEGER PRIMARY KEY); INSERT INTO parent VALUES (1);
          CREATE TABLE derived(id INTEGER PRIMARY KEY, raw INTEGER, p INTEGER GENERATED ALWAYS AS (raw) VIRTUAL REFERENCES parent(id));
          INSERT INTO derived(raw) VALUES (-1), (-9223372036854775808);
          CREATE TABLE plain(id INTEGER PRIMARY KEY, p INTEGER REFERENCES parent(id)); INSERT INTO plain VALUES (1,1);
          PRAGMA writable_schema=ON;
          UPDATE sqlite_schema SET sql=replace(sql,'AS (raw)','AS (abs(raw))') WHERE name='derived';""")
        m = self.manager()
        groups = {g["declaration"]["child_table"]: g["count"] for g in self.incoming(m, self.handle(m, "parent", 1))}
        self.assertEqual(groups, {"derived": {"status": "unavailable", "value": None, "reason": "unsupported_source_operation"},
                                  "plain": {"status": "exact", "value": 1, "reason": None}})


class TestIncomingBoundaries(IncomingFixture):
    def test_parameters_generation_and_wrong_declaration(self):
        m = self.edge()
        h = self.handle(m, "p_int", 1)
        fk = next(g["declaration"] for g in self.incoming(m, h) if g["declaration"]["child_table"] == "c_text")
        other = next(g["declaration"] for g in self.incoming(m, self.handle(m, "p_nocase", "ABC")))
        cases = [({"table": "c_text", "record": h, "fk": other["declaration_id"]}, "source_fk_not_found", 404),
                 ({"table": "c_nocase", "record": h, "fk": other["declaration_id"]}, "source_fk_parent_mismatch", 400),
                 ({"table": "c_text", "record": "sr1:" + "0" * 64, "fk": fk["declaration_id"]}, "source_record_not_found_in_generation", 404),
                 ({"table": "c_text", "record": h}, "invalid_search_parameters", 400),
                 ({"table": "c_text", "record": h, "fk": fk["declaration_id"], "text": "1"}, "invalid_search_parameters", 400)]
        for parameters, code, status in cases:
            with self.subTest(code=code), self.assertRaises(SourceError) as failure:
                self.query(m, "search", mode="reference", **parameters)
            self.assertEqual((failure.exception.code, failure.exception.status), (code, status))
        with self.assertRaises(SourceError) as failure:
            self.query(m, "search", table="c_text", text="1", record=h)
        self.assertEqual(failure.exception.code, "invalid_search_parameters")
        with self.assertRaises(SourceError) as failure:
            self.query(m, "references", record=h, direction="sideways")
        self.assertEqual((failure.exception.code, failure.exception.status), ("invalid_parameter", 400))
        # Literal Find is unchanged and is not an FK filter: '01' is not '1'.
        literal = self.query(m, "search", table="c_text", text="1", column="pid")
        self.assertEqual(sorted(r["cells"][1]["exact"] for r in literal["rows"]), ["+1", "01", "1", "1", "1.0"])
        self.assertNotIn("reference", literal)

    def test_session_and_generation_boundaries_and_read_only(self):
        self.build(EDGE)
        before = (hashlib.sha256(self.path.read_bytes()).hexdigest(), self.path.stat().st_mtime_ns,
                  sorted(p.name for p in self.path.parent.iterdir()))
        m = self.manager()
        capture = m.sessions[m.initial_session]["capture"]
        digest = hashlib.sha256(capture.snapshot_path.read_bytes()).hexdigest()
        h = self.handle(m, "p_int", 1)
        groups = self.incoming(m, h)
        for g in groups:
            if g["count"]["status"] == "exact":
                self.referencing(m, h, g["declaration"])
        second = m.new_generation()
        # The same bytes in another session: a handle must be verified there first.
        with self.assertRaises(SourceError) as failure:
            self.query(m, "references", session=second, record=h, direction="incoming")
        self.assertEqual(failure.exception.code, "source_record_not_found_in_generation")
        other = self.handle_in(m, second, "p_int", 1)
        self.assertEqual(other, h)  # same namespace and digest: same identity
        self.assertEqual([g["count"] for g in self.query(m, "references", session=second, record=other, direction="incoming")["groups"]],
                         [g["count"] for g in groups])
        with self.assertRaises(SourceError) as failure:
            dispatch(m, "/source/v1/references", {"session": [m.initial_session], "generation": [m.sessions[second]["capture"].generation],
                                                  "record": [h], "direction": ["incoming"]})
        self.assertEqual(failure.exception.code, "source_generation_mismatch")
        self.assertEqual(hashlib.sha256(capture.snapshot_path.read_bytes()).hexdigest(), digest)
        self.assertEqual(digest, capture.digest)
        m.close()
        self.assertEqual(before, (hashlib.sha256(self.path.read_bytes()).hexdigest(), self.path.stat().st_mtime_ns,
                                  sorted(p.name for p in self.path.parent.iterdir())))

    def handle_in(self, m, session, table, *key):
        rows = self.query(m, "rows", session=session, table=table, limit=100)["rows"]
        return next(r["record_id"] for r in rows if tuple(c["exact"] for c in r["key"]) == tuple(map(key_text, key)))

    def test_capability_and_record_action_are_advertised(self):
        m = self.edge()
        self.assertTrue(m.descriptor(m.initial_session)["capabilities"]["incoming_fk_observations"])
        record = self.query(m, "record", id=self.handle(m, "p_int", 1))
        self.assertEqual(record["actions"], {"outgoing_references": True, "incoming_references": True})


class TestIncomingHTTP(IncomingFixture):
    def test_incoming_routes_over_http(self):
        self.build(EDGE)
        m = self.manager()
        server = SourceHTTPServer(("127.0.0.1", 0), m)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            context = m.descriptor(m.initial_session)
            base = f"http://127.0.0.1:{server.server_port}/source/v1/"
            suffix = urllib.parse.urlencode({"session": context["session"], "generation": context["generation"]})
            def get(route, **parameters):
                try:
                    with urllib.request.urlopen(base + route + "?" + suffix + "&" + urllib.parse.urlencode(parameters)) as response:
                        return response.status, json.load(response)
                except urllib.error.HTTPError as failure:
                    return failure.code, json.load(failure)
            h = self.handle(m, "airport", "AMS")
            status, body = get("references", record=h, direction="incoming")
            self.assertEqual((status, body["data"]["total"]), (200, 2))
            fk = next(g["declaration"]["declaration_id"] for g in body["data"]["groups"]
                      if g["declaration"]["pairs"][0]["child_column"] == "origin")
            status, body = get("search", table="flight", mode="reference", record=h, fk=fk)
            self.assertEqual((status, body["data"]["returned"], body["data"]["search"]["fk"]), (200, 3, fk))
            self.assertEqual(get("search", table="flight", mode="reference", record=h, fk=fk, column="origin")[0], 400)
            self.assertEqual(get("search", table="flight", text="AMS", fk=fk)[0], 400)
            self.assertEqual(get("references", record=h, direction="sideways")[0], 400)
        finally:
            server.shutdown(); server.server_close(); thread.join()


@unittest.skipUnless(PHONE_1.exists(), "public Spider phone_1 not downloaded (see SOURCE_REFERENCES_ARCHITECTURE_BRIEF.md §7)")
class TestPublicPhone1(IncomingFixture):
    def test_text_child_of_real_parent_key(self):
        def state():
            return (hashlib.sha256(PHONE_1.read_bytes()).hexdigest(), PHONE_1.stat().st_mtime_ns,
                    sorted(p.name for p in PHONE_1.parent.glob(PHONE_1.name + "-*")))
        before = state()
        self.assertEqual(before[0], PHONE_1_SHA256)
        m = SessionManager(PHONE_1)
        self.managers.append(m)
        mode = self.handle(m, "screen_mode", 1.0)
        group = next(g for g in self.incoming(m, mode) if g["declaration"]["child_table"] == "phone")
        self.assertEqual(group["count"]["value"], 2)
        rows = self.referencing(m, mode, group["declaration"])[1]
        self.assertEqual(sorted(r["key"][0]["exact"] for r in rows), ["GT-I9100", "XPERIA T, XPERIA J"])
        self.assertTrue(all(r["cells"][6] == {"column": "screen_mode", "storage_class": "text", "exact": "1"} for r in rows))
        checked = self.assert_inverse(m, PHONE_1)
        self.assertEqual(checked["observation"], 16)  # all 8 phones, through both declarations
        with closing(sqlite3.connect(PHONE_1.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)) as db:
            self.assertEqual(db.execute("PRAGMA foreign_key_check(phone)").fetchall(), [])
            # Child-column equality with each parent value misses all 8 references.
            self.assertEqual(sum(db.execute("SELECT count(*) FROM phone WHERE screen_mode = ?", (v,)).fetchone()[0]
                                 for (v,) in db.execute("SELECT Graphics_mode FROM screen_mode").fetchall()), 0)
        m.close()
        self.assertEqual(state(), before)


@unittest.skipUnless((ROOT / "examples/chinook/data/Chinook_Sqlite.sqlite").exists(),
                     "prepare pinned Chinook before real-source acceptance")
class TestPinnedChinookIncoming(IncomingFixture):
    def test_album_genre_media_type_and_reports(self):
        path = ROOT / "examples/chinook/data/Chinook_Sqlite.sqlite"
        m = SessionManager(path)
        self.managers.append(m)
        def groups(table, key):
            return {(g["declaration"]["child_table"], g["declaration"]["pairs"][0]["child_column"]): g
                    for g in self.incoming(m, self.handle(m, table, key))}
        self.assertEqual({k: g["count"]["value"] for k, g in groups("Album", 1).items()}, {("Track", "AlbumId"): 10})
        self.assertEqual(groups("Genre", 1)[("Track", "GenreId")]["count"]["value"], 1297)
        self.assertEqual(groups("MediaType", 1)[("Track", "MediaTypeId")]["count"]["value"], 3034)
        self.assertEqual({k: g["count"]["value"] for k, g in groups("Employee", 1).items()},
                         {("Customer", "SupportRepId"): 0, ("Employee", "ReportsTo"): 2})
        self.assertEqual({k: g["count"]["value"] for k, g in groups("Track", 1).items()},
                         {("InvoiceLine", "TrackId"): 1, ("PlaylistTrack", "TrackId"): 3})
        album = self.handle(m, "Album", 1)
        fk = groups("Album", 1)[("Track", "AlbumId")]["declaration"]
        _, rows = self.referencing(m, album, fk, limit=3)
        self.assertEqual(len(rows), 10)
        for row in rows:
            observation = self.query(m, "reference", record=row["record_id"], fk=fk["declaration_id"])
            self.assertEqual((observation["observation_id"], observation["status"], observation["parent"]["record_id"]),
                             (row["observation_id"], "resolved", album))


if __name__ == "__main__":
    unittest.main()

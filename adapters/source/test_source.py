"""Disposable source API acceptance and SQLite FK differential tests.

Run from repository root: python -m unittest discover -s adapters/source -v
No test mutates frozen producer/Chinook artifacts.
"""
from __future__ import annotations

import concurrent.futures
import hashlib
import http.client
import json
import os
import signal
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from contextlib import closing
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from adapters.capture import Capture, CaptureError, SnapshotUnavailable
from adapters.source.model import SourceError, SourceReader, framed, declared_collations
from adapters.source.server import SessionManager, SourceHTTPServer, dispatch
from adapters.world import server as world


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)/"producer.sqlite"
        self.managers = []
        self.addCleanup(self.close_managers)

    def close_managers(self):
        for m in self.managers:
            m.close()

    def build(self, sql, parameters=()):
        db = sqlite3.connect(self.path)
        db.executescript(sql)
        for statement, values in parameters:
            db.executemany(statement, values)
        db.commit()
        db.close()

    def manager(self, **options):
        manager = SessionManager(self.path, **options)
        self.managers.append(manager)
        return manager

    def query(self, manager, route, *, session=None, **query):
        token = session or manager.initial_session
        context = manager.descriptor(token)
        q = {"session": [token], "generation": [context["generation"]]}
        q.update({k:[str(v)] for k,v in query.items()})
        return dispatch(manager, "/source/v1/"+route, q)["data"]

    def observations(self, manager, table="child"):
        rows = self.query(manager, "rows", table=table)["rows"]
        return [self.query(manager, "references", record=r["record_id"])["observations"] for r in rows]


class TestIdentityAndScalars(Fixture):
    def test_no_declaration_catalogue_records_and_no_world_semantics(self):
        self.build("CREATE TABLE Alone(id INTEGER PRIMARY KEY, v); INSERT INTO Alone VALUES(1,'a');")
        m = self.manager()
        overview = self.query(m, "overview")
        self.assertEqual(overview["counts"]["tables"], 1)
        self.assertEqual(overview["relations"][0]["identity"]["status"], "not_started")
        data = self.query(m,"rows",table="Alone")
        self.assertEqual(data["identity"]["verified_rows"],1)
        r = self.query(m,"record",id=data["rows"][0]["record_id"])
        self.assertEqual(r["cells"][1]["exact"], "a")
        text = json.dumps(r)
        for absent in ("assertion_id", "referent", "warrant", "authority", "governance", str(self.path)):
            self.assertNotIn(absent,text)

    def test_exact_scalar_transport_and_signed_integer_extremes(self):
        self.build("CREATE TABLE cells(id INTEGER PRIMARY KEY, v);", [
            ("INSERT INTO cells VALUES(?,?)", list(enumerate([
                None,""," \t\n",-(2**63),2**63-1,9007199254740993,1,"1",1.25,
                b"\x00\xff",float('inf')],1)))])
        rows = self.query(self.manager(),"rows",table="cells")["rows"]
        values = [r["cells"][1] for r in rows]
        self.assertEqual(values[0],{"column":"v","storage_class":"null","exact":None})
        self.assertEqual([values[i]["exact"] for i in (1,2,3,4,5,6,7)],
                         [""," \t\n",str(-(2**63)),str(2**63-1),"9007199254740993","1","1"])
        self.assertNotEqual(values[6]["storage_class"],values[7]["storage_class"])
        self.assertEqual(values[8]["ieee754_hex"],struct.pack('>d',1.25).hex())
        self.assertEqual(values[9]["sha256"],hashlib.sha256(b'\x00\xff').hexdigest())
        self.assertTrue(values[9]["preview_only"])
        self.assertFalse(values[10]["finite"])
        json.dumps(rows,allow_nan=False)

    def test_mixed_storage_keys_have_distinct_exact_handles(self):
        self.build("CREATE TABLE mixed(k PRIMARY KEY);",[("INSERT INTO mixed VALUES(?)",[(1,),("1",),("01",),(1.5,)])])
        m = self.manager()
        rows = self.query(m,"rows",table="mixed")["rows"]
        self.assertEqual(len({r['record_id'] for r in rows}),4)
        for row in rows:
            self.assertEqual(self.query(m,"record",id=row["record_id"])["key"],row["key"])
        self.assertEqual(self.query(m,"rows",table="mixed")["identity"]["verified_rows"],4)

    def test_framing_composite_keys_unicode_nul_empty_and_delimiters(self):
        self.build('CREATE TABLE "odd:name"(a TEXT,b TEXT,PRIMARY KEY(b,a));',[
            ('INSERT INTO "odd:name" VALUES(?,?)',[("x/y","z"),("x","y/z"),("Ω,/%","\0"),(""," ")])])
        m=self.manager();data=self.query(m,"rows",table="odd:name")
        self.assertEqual(data["identity"]["key_columns"],["b","a"])
        self.assertEqual(len({r["record_id"] for r in data["rows"]}),4)
        for row in data["rows"]:
            self.assertEqual(self.query(m,"record",id=row["record_id"])["key"],row["key"])
        self.assertNotEqual(framed(["x/y","z"]),framed(["x","y/z"]))
        self.assertNotEqual(framed([1]),framed(["1"]))
        self.assertNotEqual(framed([1]),framed([1.0]))

    def test_sqlite_like_user_name_and_empty_identifier_are_not_lost(self):
        self.build('CREATE TABLE sqliteX("" INTEGER PRIMARY KEY, "p" INTEGER REFERENCES sqliteX(""));INSERT INTO sqliteX VALUES(1,1);')
        m=self.manager()
        self.assertEqual(self.query(m,'overview')['total'],1)
        obs=self.observations(m,'sqliteX')[0][0]
        self.assertEqual(obs['status'],'resolved')
        self.assertEqual(obs['child_values'][0]['column'],'p')
        self.assertEqual(obs['parent']['key'][0]['column'],'')

    def test_keyless_duplicates_nullable_pk_blob_and_infinity_keys_table_only(self):
        self.build('''CREATE TABLE no_key(v); INSERT INTO no_key VALUES(1),(1);
            CREATE TABLE weak(a,b,PRIMARY KEY(a,b)); INSERT INTO weak VALUES(NULL,1),(NULL,1);
            CREATE TABLE blobs(k BLOB PRIMARY KEY); INSERT INTO blobs VALUES(x'31');
            CREATE TABLE inf(k REAL PRIMARY KEY);''',[("INSERT INTO inf VALUES(?)",[(float('inf'),)])])
        m=self.manager()
        for table,status in [("no_key","no_declared_key"),("weak","invalid"),("blobs","unsupported"),("inf","unsupported")]:
            with self.subTest(table=table):
                data=self.query(m,"rows",table=table)
                self.assertEqual(data["identity"]["status"],status)
                self.assertTrue(all(r['record_id'] is None for r in data['rows']))
        self.assertEqual(len(self.query(m,'rows',table='no_key')['rows']),2)

    def test_whole_table_verification_not_first_page(self):
        self.build("CREATE TABLE late(a,b,PRIMARY KEY(a,b));",[
            ("INSERT INTO late VALUES(?,?)",[(str(i),i) for i in range(150)]+[(None,151)])])
        m=self.manager();data=self.query(m,'rows',table='late',limit=1)
        self.assertEqual(data['identity']['status'],'invalid')
        self.assertIsNone(data['rows'][0]['record_id'])

    def test_empty_and_without_rowid(self):
        self.build('CREATE TABLE empty(id INTEGER PRIMARY KEY); CREATE TABLE wr(a,b,PRIMARY KEY(a,b)) WITHOUT ROWID; INSERT INTO wr VALUES(1,2);')
        m=self.manager()
        self.assertEqual(self.query(m,'rows',table='empty')['identity']['verified_rows'],0)
        data=self.query(m,'rows',table='wr')
        self.assertEqual(self.query(m,'record',id=data['rows'][0]['record_id'])['key'],data['rows'][0]['key'])

    def test_identity_registry_budget_never_publishes_partial_handles(self):
        self.build('CREATE TABLE t(id INTEGER PRIMARY KEY); INSERT INTO t VALUES(1),(2),(3);')
        m=self.manager(reader_options={'key_rows':2})
        data=self.query(m,'rows',table='t')
        self.assertEqual(data['identity']['status'],'budget_exceeded')
        self.assertTrue(all(r['record_id'] is None for r in data['rows']))
        self.assertEqual(m.sessions[m.initial_session]['reader'].records,{})

    def test_hash_collision_refused_instead_of_merge(self):
        self.build('CREATE TABLE t(id INTEGER PRIMARY KEY); INSERT INTO t VALUES(1),(2);')
        m=self.manager()
        with patch('adapters.source.model.hashlib.sha256') as digest:
            digest.return_value.hexdigest.return_value='0'*64
            data=self.query(m,'rows',table='t')
        self.assertEqual(data['identity']['status'],'unsupported')
        self.assertEqual(data['identity']['reason'],'identity_hash_collision')
        self.assertTrue(all(r['record_id'] is None for r in data['rows']))

    def test_suggestive_column_and_repeated_junction_rows_keep_evidence(self):
        self.build('''CREATE TABLE target(id INTEGER PRIMARY KEY);INSERT INTO target VALUES(1);
          CREATE TABLE loose(id INTEGER PRIMARY KEY,TargetId);INSERT INTO loose VALUES(1,1);
          CREATE TABLE j(event INTEGER PRIMARY KEY,p REFERENCES target(id),q REFERENCES target(id));
          INSERT INTO j VALUES(1,1,1),(2,1,1);''')
        m=self.manager()
        self.assertEqual(self.observations(m,'loose'),[[]])
        rows=self.query(m,'rows',table='j')['rows']
        self.assertNotEqual(rows[0]['record_id'],rows[1]['record_id'])
        obs=self.observations(m,'j')
        self.assertEqual(len({o['observation_id'] for group in obs for o in group}),4)


class TestForeignKeys(Fixture):
    def test_nullable_dangling_and_referential_grounding(self):
        self.build('''CREATE TABLE parent(id INTEGER PRIMARY KEY);INSERT INTO parent VALUES(1);
          CREATE TABLE child(id INTEGER PRIMARY KEY,p TEXT REFERENCES parent(id));
          INSERT INTO child VALUES(1,'01'),(2,NULL),(3,'999');''')
        obs=[o[0] for o in self.observations(self.manager())]
        self.assertEqual([o['status'] for o in obs],['resolved','null_reference','dangling'])
        self.assertEqual(obs[0]['child_values'][0]['exact'],'01')
        self.assertEqual(obs[0]['parent']['key'][0]['exact'],'1')
        self.assertEqual(obs[0]['historical_enforcement'],'not_established')
        self.assertIsNone(obs[2]['parent'])

    def test_column_join_counterexample_is_dangling(self):
        self.build('''CREATE TABLE parent(k TEXT PRIMARY KEY);INSERT INTO parent VALUES('01');
          CREATE TABLE child(id INTEGER PRIMARY KEY,p INTEGER REFERENCES parent(k));INSERT INTO child VALUES(1,1);''')
        with closing(sqlite3.connect(self.path)) as oracle:
            self.assertEqual(oracle.execute('SELECT count(*) FROM parent JOIN child ON parent.k=child.p').fetchone()[0],1)
            self.assertEqual(len(oracle.execute('PRAGMA foreign_key_check').fetchall()),1)
        self.assertEqual(self.observations(self.manager())[0][0]['status'],'dangling')

    def test_differential_affinity_collation_oracle(self):
        # Each case uses an independently disposable database. Foreign-key
        # checker, not ordinary column joins, supplies the expected answer.
        cases=[]
        for parent_type,child_type,parent_values,child_values in [
            ('TEXT','INTEGER',['01','2'],[1,2,3,None]),
            ('INTEGER','TEXT',[1,2],['01','2','3',None]),
            ('NUMERIC','BLOB',[1,2],[1,'01',1.0,b'1',None]),
            ('BLOB','NUMERIC',[1,'01'],[1,2,None]),
            ('REAL','TEXT',[1.5,2.0],['1.5','02','2.5',None])]:
            cases.append((parent_type,child_type,'BINARY',parent_values,child_values))
        for coll in ['BINARY','NOCASE','RTRIM']:
            cases.append(('TEXT','TEXT',coll,['ABC','one  '],['abc','ABC','one','one ','one  ','absent',None]))
        for i,(pt,ct,coll,pvals,cvals) in enumerate(cases):
            with self.subTest(parent=pt,child=ct,collation=coll):
                p=Path(self.tmp.name)/f'oracle{i}.sqlite'
                db=sqlite3.connect(p)
                db.executescript(f'CREATE TABLE parent(k {pt} COLLATE {coll} PRIMARY KEY); CREATE TABLE child(id INTEGER PRIMARY KEY,p {ct} REFERENCES parent(k));')
                db.executemany('INSERT INTO parent VALUES(?)',[(v,) for v in pvals])
                db.executemany('INSERT INTO child VALUES(?,?)',enumerate(cvals,1));db.commit()
                violated={r[1] for r in db.execute('PRAGMA foreign_key_check(child)')}
                raw=[tuple(r) for r in db.execute('SELECT id,p FROM child ORDER BY id')];db.close()
                m=SessionManager(p);self.managers.append(m)
                obs=[o[0] for o in self.observations(m)]
                self.assertEqual([o['status'] for o in obs],
                                 ['null_reference' if val is None else 'dangling' if ident in violated else 'resolved' for ident,val in raw])

    def test_cross_affinity_matrix_agrees_with_actual_fk_checker(self):
        types=['TEXT','INTEGER','REAL','NUMERIC','BLOB','']
        parent_values=[1,'01','ABC','one  ',b'1',1.5,'a\0x']
        children=[1,'1','01',1.0,1.5,'1.5','abc','one','one  ',b'1','a\0y',None]
        for i,pt in enumerate(types):
            for j,ct in enumerate(types):
                for coll in ['BINARY','NOCASE','RTRIM']:
                    with self.subTest(parent=pt,child=ct,collation=coll):
                        path=Path(self.tmp.name)/f'matrix-{i}-{j}-{coll}.db'
                        db=sqlite3.connect(path)
                        db.executescript(f'CREATE TABLE parent(k {pt} COLLATE {coll} PRIMARY KEY); CREATE TABLE child(id INTEGER PRIMARY KEY,p {ct} REFERENCES parent(k));')
                        for value in parent_values:
                            try:db.execute('INSERT OR IGNORE INTO parent VALUES(?)',(value,))
                            except sqlite3.IntegrityError:pass  # INTEGER rowid alias rejects nonintegers
                        db.executemany('INSERT INTO child VALUES(?,?)',enumerate(children,1));db.commit()
                        violations={r[1] for r in db.execute('PRAGMA foreign_key_check(child)')}
                        raw=list(db.execute('SELECT id,p FROM child ORDER BY id'));db.close()
                        m=SessionManager(path)
                        try:
                            observed=[o[0]['status'] for o in self.observations(m)]
                            for (ident,value),status in zip(raw,observed):
                                expected='null_reference' if value is None else 'dangling' if ident in violations else 'resolved'
                                self.assertEqual('resolved' if status=='resolved_unaddressable' else status,expected)
                        finally:m.close()

    def test_composite_implicit_keys_and_partial_null(self):
        self.build('''CREATE TABLE parent(a TEXT COLLATE NOCASE,b INTEGER,PRIMARY KEY(a,b)) WITHOUT ROWID;
          INSERT INTO parent VALUES('ABC',1);
          CREATE TABLE child(id INTEGER PRIMARY KEY,x TEXT,y TEXT,FOREIGN KEY(x,y) REFERENCES parent);
          INSERT INTO child VALUES(1,'abc','01'),(2,'ABC',NULL),(3,'absent','1');''')
        m=self.manager();obs=[o[0] for o in self.observations(m)]
        self.assertEqual([o['status'] for o in obs],['resolved','null_reference','dangling'])
        self.assertEqual([p['parent_column'] for p in obs[0]['declaration']['pairs']],['a','b'])
        self.assertTrue(all(p['to'] is None for p in obs[0]['declaration']['recorded_pairs']))
        self.assertEqual(len(obs[0]['parent']['key']),2)
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual([r[1] for r in db.execute('PRAGMA foreign_key_check(child)')],[3])

    def test_unique_non_pk_target_and_resolved_unaddressable(self):
        self.build('''CREATE TABLE parent(id INTEGER PRIMARY KEY,code TEXT COLLATE NOCASE UNIQUE);
          INSERT INTO parent VALUES(7,'ABC');
          CREATE TABLE unkeyed(code TEXT UNIQUE);INSERT INTO unkeyed VALUES('x');
          CREATE TABLE child(id INTEGER PRIMARY KEY,p REFERENCES parent(code),q REFERENCES unkeyed(code));
          INSERT INTO child VALUES(1,'abc','x');''')
        obs=self.observations(self.manager())[0];byparent={o['declaration']['parent_table']:o for o in obs}
        self.assertEqual(byparent['parent']['status'],'resolved')
        self.assertEqual(byparent['parent']['parent']['key'][0]['exact'],'7')
        self.assertEqual(byparent['unkeyed']['status'],'resolved_unaddressable')
        self.assertIsNone(byparent['unkeyed']['parent']['record_id'])

    def test_invalid_parent_declarations_remain_inspectable(self):
        self.build('''CREATE TABLE parent(a,b,PRIMARY KEY(a,b));CREATE TABLE nonunique(x);
          CREATE TABLE wrongcoll(x TEXT);CREATE UNIQUE INDEX wc ON wrongcoll(x COLLATE NOCASE);
          CREATE TABLE child(id INTEGER PRIMARY KEY,
            a REFERENCES missing(id), b REFERENCES parent, c REFERENCES nonunique(x),d REFERENCES wrongcoll(x));
          INSERT INTO child VALUES(1,1,1,1,'x');''')
        obs=self.observations(self.manager())[0]
        self.assertTrue(all(o['status']=='invalid_declaration' for o in obs))
        self.assertEqual({o['reason'] for o in obs}, {'missing_parent_table','implicit_parent_key_arity_mismatch','parent_key_not_eligible_unique_constraint'})
        self.assertTrue(all(o['parent'] is None for o in obs))

    def test_case_variant_identifiers_parallel_constraints_and_cycle(self):
        self.build('''CREATE TABLE Parent(Key INTEGER PRIMARY KEY);INSERT INTO Parent VALUES(1);
          CREATE TABLE child(id INTEGER PRIMARY KEY,p REFERENCES pArEnT(kEy),q REFERENCES PARENT(KEY));
          INSERT INTO child VALUES(1,1,1);
          CREATE TABLE cyc(id INTEGER PRIMARY KEY,p REFERENCES cyc(id));INSERT INTO cyc VALUES(1,1),(2,3),(3,2);''')
        m=self.manager();obs=self.observations(m)[0]
        self.assertEqual(len({o['declaration']['declaration_id'] for o in obs}),2)
        self.assertTrue(all(o['status']=='resolved' and o['parent']['name']=='Parent' for o in obs))
        self.assertEqual(obs[1]['declaration']['recorded_pairs'][0]['table'],'pArEnT')
        self.assertEqual(obs[1]['declaration']['pairs'][0]['parent_column'],'Key')
        cyc=self.observations(m,'cyc')
        self.assertTrue(all(group[0]['status']=='resolved' for group in cyc))
        self.assertEqual(cyc[0][0]['child_record_id'],cyc[0][0]['parent']['record_id'])

    def test_implicit_pk_collation_override_is_refused_not_falsely_invalid(self):
        self.build("CREATE TABLE parent(x TEXT,PRIMARY KEY(x COLLATE NOCASE));INSERT INTO parent VALUES('ABC');CREATE TABLE child(id INTEGER PRIMARY KEY,p REFERENCES parent);INSERT INTO child VALUES(1,'abc');")
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute('PRAGMA foreign_key_check(child)').fetchall(),[])
        obs=self.observations(self.manager())[0][0]
        self.assertEqual(obs['status'],'unsupported')
        self.assertEqual(obs['reason'],'implicit_pk_collation_differs_from_column')
        self.assertIsNone(obs['parent'])

    def test_reordered_parent_unique_and_partial_expression_indexes(self):
        self.build('''CREATE TABLE parent(id INTEGER PRIMARY KEY,a,b,UNIQUE(a,b));INSERT INTO parent VALUES(1,'x',2);
          CREATE TABLE child(id INTEGER PRIMARY KEY,b,a,FOREIGN KEY(b,a) REFERENCES parent(b,a));INSERT INTO child VALUES(1,2,'x');
          CREATE TABLE part(k);CREATE UNIQUE INDEX pi ON part(k) WHERE k IS NOT NULL;
          CREATE TABLE expr(k);CREATE UNIQUE INDEX ei ON expr(lower(k));
          CREATE TABLE bad(id INTEGER PRIMARY KEY,p REFERENCES part(k),q REFERENCES expr(k));INSERT INTO bad VALUES(1,1,1);''')
        m=self.manager();self.assertEqual(self.observations(m)[0][0]['status'],'resolved')
        self.assertTrue(all(o['status']=='invalid_declaration' for o in self.observations(m,'bad')[0]))
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute('PRAGMA foreign_key_check(child)').fetchall(),[])

    def test_unavailable_custom_collation_is_unsupported(self):
        db=sqlite3.connect(self.path);db.create_collation('CUSTOM',lambda a,b:(a>b)-(a<b))
        db.executescript('CREATE TABLE parent(k TEXT COLLATE CUSTOM PRIMARY KEY);INSERT INTO parent VALUES("x");CREATE TABLE child(id INTEGER PRIMARY KEY,p REFERENCES parent(k));INSERT INTO child VALUES(1,"x");');db.close()
        obs=self.observations(self.manager())[0][0]
        self.assertEqual(obs['status'],'unsupported')
        self.assertEqual(obs['reason'],'parent_collation_unavailable')

    def test_missing_parent_column_and_malformed_ddl(self):
        self.build('CREATE TABLE parent(id INTEGER PRIMARY KEY);CREATE TABLE child(id INTEGER PRIMARY KEY,p REFERENCES parent(missing));INSERT INTO child VALUES(1,1);')
        obs=self.observations(self.manager())[0][0]
        self.assertEqual(obs['status'],'invalid_declaration')
        self.assertEqual(obs['reason'],'missing_constraint_column')
        with closing(sqlite3.connect(':memory:')) as db:
            with self.assertRaises(sqlite3.OperationalError):
                db.execute('CREATE TABLE bad(id,FOREIGN KEY(no_such_column) REFERENCES parent(id))')

    def test_ambiguous_match_never_chooses_first_and_plan_refusal_has_evidence(self):
        self.build('CREATE TABLE parent(id INTEGER PRIMARY KEY);INSERT INTO parent VALUES(1);CREATE TABLE child(id INTEGER PRIMARY KEY,p REFERENCES parent(id));INSERT INTO child VALUES(1,1);')
        m=self.manager();self.observations(m)
        reader=m.sessions[m.initial_session]['reader']
        original=reader._select
        def ambiguous(db,name,**options):
            rows=original(db,name,**options)
            return rows*2 if name=='parent' else rows
        with patch.object(reader,'_select',side_effect=ambiguous):
            obs=self.observations(m)[0][0]
        self.assertEqual(obs['status'],'ambiguous');self.assertIsNone(obs['parent'])
        def budget(db,name,**options):
            if name=='parent':raise SourceError('injected_parent_query_budget_exceeded',422)
            return original(db,name,**options)
        with patch.object(reader,'_select',side_effect=budget):
            obs=self.observations(m)[0][0]
        self.assertEqual(obs['status'],'budget_exceeded')
        self.assertEqual(obs['child_values'][0]['exact'],'1');self.assertIsNone(obs['parent'])

    def test_collation_lexer_does_not_read_comments_defaults_or_checks_as_declarations(self):
        sql='''CREATE TABLE t("a" TEXT DEFAULT 'COLLATE NOCASE', b TEXT /* COLLATE RTRIM */,
          c TEXT COLLATE "NOCASE" CHECK(c != 'COLLATE BINARY'),
          d TEXT GENERATED ALWAYS AS (b COLLATE RTRIM), PRIMARY KEY(a));'''
        self.assertEqual(declared_collations(sql,['a','b','c','d']),{'a':'BINARY','b':'BINARY','c':'NOCASE','d':'BINARY'})


class TestViewsAndBounds(Fixture):
    def test_views_are_table_only_with_recorded_sql_and_nonunique_outputs(self):
        self.build('''CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT);INSERT INTO t VALUES(1,'same'),(2,'same');
          CREATE VIEW duplicate AS SELECT v FROM t;
          CREATE VIEW joined AS SELECT a.id,a.v,b.v AS other FROM t a JOIN t b ON a.id=b.id;
          CREATE TABLE generated(id INTEGER PRIMARY KEY,v INTEGER,g INTEGER GENERATED ALWAYS AS (v*2) STORED);
          INSERT INTO generated(id,v) VALUES(1,3);''')
        m=self.manager();schema=self.query(m,'schema')
        for name in ['duplicate','joined']:
            row=next(r for r in schema['relations'] if r['name']==name)
            self.assertIn('CREATE VIEW',row['view_sql'])
            self.assertEqual(row['lineage'],'not_recorded')
            data=self.query(m,'rows',table=name)
            self.assertEqual(data['identity']['status'],'view_table_only')
            self.assertTrue(all(r['record_id'] is None for r in data['rows']))
        data=self.query(m,'rows',table='generated')
        self.assertEqual(data['columns'][2]['generated'],'STORED')
        self.assertEqual(data['rows'][0]['cells'][2]['exact'],'6')

    def test_volatile_date_unknown_function_and_virtual_sources_refuse(self):
        self.build('''CREATE TABLE t(id INTEGER PRIMARY KEY);INSERT INTO t VALUES(1);
          CREATE VIEW volatile AS SELECT id,random() AS v FROM t;
          CREATE VIEW clock AS SELECT id,datetime('now') AS v FROM t;
          CREATE VIEW extension AS SELECT id,missing_function(id) AS v FROM t;''')
        m=self.manager()
        for name in ['volatile','clock','extension']:
            with self.subTest(name=name), self.assertRaises(SourceError) as failure:
                self.query(m,'rows',table=name)
            self.assertEqual(failure.exception.code,'unsupported_source_operation')
        # Unsupported objects do not prevent ordinary table inspection.
        self.assertEqual(self.query(m,'rows',table='t')['identity']['verified_rows'],1)
        schema=self.query(m,'schema')
        self.assertIn('CREATE VIEW',next(r for r in schema['relations'] if r['name']=='extension')['view_sql'])
        for name in ['volatile','clock','extension']:
            self.assertEqual(next(r for r in schema['relations'] if r['name']==name)['read_status'],'unsupported')

    def test_hidden_virtual_columns_are_not_exposed_and_no_module_reads(self):
        self.build('CREATE VIRTUAL TABLE f USING fts5(text);INSERT INTO f VALUES("hello");')
        m=self.manager();schema=self.query(m,'schema')
        self.assertTrue(all(r['read_status']=='unsupported' for r in schema['relations']))
        with self.assertRaises(SourceError) as failure:
            self.query(m,'rows',table='f')
        self.assertEqual(failure.exception.code,'unsupported_virtual_source')

    def test_large_blob_preview_text_and_page_limits(self):
        self.build('CREATE TABLE t(id INTEGER PRIMARY KEY,v);',[(
            'INSERT INTO t VALUES(?,?)',[(1,b'x'*(1024*1024+1)),(2,'y'*(1024*1024+1))])])
        m=self.manager();data=self.query(m,'rows',table='t',limit=1)
        cell=data['rows'][0]['cells'][1]
        self.assertTrue(cell['preview_only']);self.assertIsNone(cell['sha256'])
        with self.assertRaises(SourceError) as failure:
            self.query(m,'rows',table='t',offset=1)
        self.assertEqual(failure.exception.code,'source_cell_budget_exceeded')
        for options in [{'limit':0},{'limit':101},{'offset':-1},{'offset':1000001}]:
            with self.subTest(options=options),self.assertRaises(SourceError):
                self.query(m,'rows',table='t',**options)

    def test_query_budget_is_a_refusal_not_false_empty_result(self):
        self.build('CREATE TABLE t(id INTEGER PRIMARY KEY);',[(
            'INSERT INTO t VALUES(?)',[(i,) for i in range(1000)])])
        m=self.manager(reader_options={'vm_steps':1000})
        data=self.query(m,'rows',table='t')
        self.assertEqual(data['identity']['status'],'budget_exceeded')
        self.assertEqual(len(data['rows']),50)
        # A separate costly view exceeds the bounded window operation itself.
        db=sqlite3.connect(self.path)
        db.execute('CREATE VIEW expensive AS WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000) SELECT sum(x) AS total FROM n');db.commit();db.close()
        fresh=self.manager(reader_options={'vm_steps':1000})
        with self.assertRaises(SourceError) as failure:
            self.query(fresh,'rows',table='expensive')
        self.assertEqual(failure.exception.code,'source_query_budget_exceeded')

    def test_paging_is_bounded_and_does_not_repeat_or_merge_rows(self):
        self.build('CREATE TABLE t(id INTEGER PRIMARY KEY,v);',[(
            'INSERT INTO t VALUES(?,?)',[(i,'same') for i in range(250)])])
        m=self.manager();ids=[]
        for offset in [0,100,200]:
            data=self.query(m,'rows',table='t',limit=100,offset=offset)
            ids += [r['record_id'] for r in data['rows']]
            self.assertEqual(data['has_more'],offset<200)
        self.assertEqual(len(set(ids)),250)
        self.assertEqual(self.query(m,'rows',table='t',offset=300)['rows'],[])


class TestGenerationLifecycle(Fixture):
    def simple(self,journal='DELETE'):
        self.build(f'''PRAGMA journal_mode={journal};CREATE TABLE entity(id INTEGER PRIMARY KEY,label);
          INSERT INTO entity VALUES(1,'old');CREATE TABLE event(id INTEGER PRIMARY KEY,p REFERENCES entity(id));
          INSERT INTO event VALUES(1,1);''')

    def test_structural_reader_and_world_share_exact_capture_no_second_backup(self):
        self.simple();m=self.manager();s=m.sessions[m.initial_session];c=s['capture']
        writer=sqlite3.connect(self.path);writer.execute("UPDATE entity SET label='new'");writer.commit();writer.close()
        declaration=world.validate_declaration({'version':1,'world':{'id_prefix':'shared'},
          'entities':[{'kind':'entity','source':'entity','key_columns':['id'],'label_column':'label'}],
          'relations':[{'name':'event','source':'event','key_columns':['id'],
                        'roles':[{'role':'p','column_name':'p','target_kind':'entity'}]}]})
        with patch('adapters.capture.acquire_snapshot',side_effect=AssertionError('second capture forbidden')):
            reading=world.prepare_world_from_capture(c,declaration)
        try:
            self.assertEqual(reading.snapshot_path,c.snapshot_path)
            self.assertEqual(reading.fingerprint,c.digest)
            row=self.query(m,'rows',table='entity')['rows'][0]
            self.assertEqual(row['cells'][1]['exact'],'old')
            with c.lease() as db:
                self.assertEqual(world.referent(db,reading.model,'entity:1')['label'],'old')
            m.retire(m.initial_session)
            self.assertTrue(c.snapshot_path.exists())
        finally:reading.cleanup()
        self.assertFalse(c.snapshot_path.exists())

    def test_source_modification_replacement_and_explicit_capture(self):
        self.simple();m=self.manager();first=m.initial_session
        before=self.query(m,'rows',table='entity');c1=m.sessions[first]['capture']
        replacement=Path(self.tmp.name)/'replacement'
        db=sqlite3.connect(replacement);db.executescript('CREATE TABLE entity(id INTEGER PRIMARY KEY,label);INSERT INTO entity VALUES(1,"changed");');db.close()
        os.replace(replacement,self.path)
        self.assertEqual(self.query(m,'rows',table='entity'),before)
        second=m.new_generation();after=self.query(m,'rows',session=second,table='entity')
        self.assertEqual(after['rows'][0]['cells'][1]['exact'],'changed')
        self.assertNotEqual(c1.digest,m.sessions[second]['capture'].digest)
        self.assertEqual(c1.source_namespace,m.sessions[second]['capture'].source_namespace)
        self.assertNotEqual(before['rows'][0]['record_id'],after['rows'][0]['record_id'])
        with self.assertRaises(SourceError) as failure:
            self.query(m,'record',session=second,id=before['rows'][0]['record_id'])
        self.assertEqual(failure.exception.status,404)
        with self.assertRaises(SourceError) as failure:
            dispatch(m,'/source/v1/overview',{'session':[first],'generation':[m.sessions[second]['capture'].generation]})
        self.assertEqual(failure.exception.code,'source_generation_mismatch')
        self.path.unlink();self.assertEqual(self.query(m,'rows',table='entity'),before)

    def test_identical_capture_tokens_differ_namespace_and_ids_have_explicit_scope(self):
        self.simple();m=self.manager();first=m.initial_session;second=m.new_generation()
        a,b=m.sessions[first]['capture'],m.sessions[second]['capture']
        self.assertEqual(a.digest,b.digest);self.assertNotEqual(a.generation,b.generation)
        r1=self.query(m,'rows',session=first,table='entity')['rows'][0]['record_id']
        r2=self.query(m,'rows',session=second,table='entity')['rows'][0]['record_id']
        self.assertEqual(r1,r2)  # identity uses full digest, lifetime uses token
        unrelated=self.manager()
        r3=self.query(unrelated,'rows',table='entity')['rows'][0]['record_id']
        self.assertNotEqual(r1,r3)
        self.assertNotEqual(a.source_namespace,unrelated.namespace)

    def test_wal_visible_commits_and_post_capture_changes(self):
        self.simple('WAL');writer=sqlite3.connect(self.path)
        try:
            before=hashlib.sha256(self.path.read_bytes()).hexdigest()
            writer.execute("INSERT INTO entity VALUES(2,'wal')");writer.commit()
            self.assertEqual(hashlib.sha256(self.path.read_bytes()).hexdigest(),before)
            m=self.manager();self.assertEqual(len(self.query(m,'rows',table='entity')['rows']),2)
            writer.execute('DELETE FROM entity');writer.commit()
            self.assertEqual(len(self.query(m,'rows',table='entity')['rows']),2)
        finally:writer.close()

    def test_missing_damaged_capture_and_unknown_session(self):
        self.simple();m=self.manager();c=m.sessions[m.initial_session]['capture']
        self.query(m,'overview')  # cache must not conceal loss
        c.snapshot_path.write_bytes(b'damaged snapshot')
        with self.assertRaises(CaptureError) as failure:self.query(m,'overview')
        self.assertEqual(failure.exception.code,'source_capture_damaged')
        c.snapshot_path.unlink()
        with self.assertRaises(CaptureError) as failure:self.query(m,'overview')
        self.assertEqual(failure.exception.code,'source_capture_missing')
        with self.assertRaises(CaptureError) as failure:m.descriptor('unknown')
        self.assertEqual(failure.exception.status,410)

    def test_capture_changed_during_consumer_fails_before_response(self):
        self.simple();m=self.manager();token=m.initial_session;c=m.sessions[token]['capture']
        with self.assertRaises(CaptureError) as failure:
            with m.lease(token,c.generation) as (_,reader,db):
                db.execute('SELECT * FROM entity').fetchall()
                c.snapshot_path.write_bytes(b'changed during read')
        self.assertEqual(failure.exception.code,'source_capture_damaged')

    def test_expiry_retirement_and_active_consumer_cleanup(self):
        self.simple();m=self.manager(ttl_s=1);token=m.initial_session;c=m.sessions[token]['capture']
        with m.lease(token,c.generation) as (context,reader,db):
            m.sessions[token]['last_used']-=2
            m.expire()
            self.assertTrue(c.snapshot_path.exists())
            self.assertEqual(db.execute('SELECT count(*) FROM entity').fetchone()[0],1)
            with self.assertRaises(CaptureError):m.descriptor(token)
        self.assertFalse(c.snapshot_path.exists());self.assertFalse(c.directory.exists())

    def test_limits_include_retiring_captures_with_active_consumers(self):
        self.simple();m=self.manager(max_sessions=1);token=m.initial_session;c=m.sessions[token]['capture']
        with m.lease(token,c.generation):
            m.retire(token)
            with self.assertRaises(SourceError) as failure:m.new_generation()
            self.assertEqual(failure.exception.code,'source_session_limit')
        fresh=m.new_generation();self.assertNotEqual(fresh,token)

    def test_failed_capture_deadline_permissions_and_no_producer_mutation(self):
        self.simple();before=(hashlib.sha256(self.path.read_bytes()).hexdigest(),self.path.stat().st_mtime_ns,sorted(p.name for p in self.path.parent.iterdir()))
        prefix='ki-source-test-'+str(os.getpid())+'-'
        initial=set(Path(tempfile.gettempdir()).glob(prefix+'*'))
        with self.assertRaises(SnapshotUnavailable):Capture.acquire(self.path,deadline_s=0,prefix=prefix)
        with self.assertRaises(SnapshotUnavailable):Capture.acquire(self.path,max_bytes=1,prefix=prefix)
        with self.assertRaises(SnapshotUnavailable):Capture.acquire(self.path.parent/'missing',prefix=prefix)
        self.assertEqual(initial,set(Path(tempfile.gettempdir()).glob(prefix+'*')))
        m=self.manager();c=m.sessions[m.initial_session]['capture']
        self.assertEqual(c.directory.stat().st_mode & 0o777,0o700)
        self.assertEqual(c.snapshot_path.stat().st_mode & 0o777,0o600)
        self.assertNotEqual(c.directory,self.path.parent)
        self.query(m,'rows',table='entity')
        self.assertEqual(before,(hashlib.sha256(self.path.read_bytes()).hexdigest(),self.path.stat().st_mtime_ns,sorted(p.name for p in self.path.parent.iterdir())))

    def test_readonly_consumers_and_wal_acquisition_preserve_original_bytes(self):
        self.simple('WAL');writer=sqlite3.connect(self.path)
        try:
            writer.execute("INSERT INTO entity VALUES(2,'in wal')");writer.commit()
            main_before=hashlib.sha256(self.path.read_bytes()).hexdigest()
            wal=Path(str(self.path)+'-wal');wal_before=hashlib.sha256(wal.read_bytes()).hexdigest()
            m=self.manager();c=m.sessions[m.initial_session]['capture']
            self.assertEqual(hashlib.sha256(self.path.read_bytes()).hexdigest(),main_before)
            self.assertEqual(hashlib.sha256(wal.read_bytes()).hexdigest(),wal_before)
            self.assertLessEqual({p.name for p in self.path.parent.glob(self.path.name+'-*')},
                                 {self.path.name+'-wal',self.path.name+'-shm'})
            with c.lease() as db:
                with self.assertRaises(sqlite3.OperationalError):db.execute('DELETE FROM entity')
            self.assertEqual(len(self.query(m,'rows',table='entity')['rows']),2)
        finally:writer.close()

    def test_exclusive_producer_lock_respects_capture_deadline(self):
        self.simple();writer=sqlite3.connect(self.path);writer.execute('BEGIN EXCLUSIVE')
        started=time.monotonic()
        try:
            with self.assertRaises(SnapshotUnavailable):Capture.acquire(self.path,deadline_s=0.05)
        finally:writer.rollback();writer.close()
        self.assertLess(time.monotonic()-started,1.0)

    def test_concurrent_readers_do_not_mix_generations(self):
        self.simple();m=self.manager();self.query(m,'rows',table='entity')
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results=list(pool.map(lambda _:self.query(m,'rows',table='entity'),range(30)))
        self.assertTrue(all(r==results[0] for r in results))


class TestHTTP(Fixture):
    def setUp(self):
        super().setUp()
        self.build('CREATE TABLE t(id INTEGER PRIMARY KEY);INSERT INTO t VALUES(1);')
        self.m=self.manager()
        self.server=SourceHTTPServer(('127.0.0.1',0),self.m)
        self.thread=threading.Thread(target=self.server.serve_forever);self.thread.start()
        self.addCleanup(self.stop_http)

    def stop_http(self):
        self.server.shutdown();self.server.server_close();self.thread.join()

    def get(self,path,method='GET',headers=None):
        conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=10)
        conn.request(method,path,headers=headers or {})
        r=conn.getresponse();body=r.read();status=r.status;headers=dict(r.getheaders());conn.close()
        return status,json.loads(body),headers

    def suffix(self):
        c=self.m.descriptor(self.m.initial_session)
        return '?session='+c['session']+'&generation='+c['generation']

    def test_standalone_default_still_expires_after_one_hour_idle(self):
        status, context, _ = self.get('/source/v1/session')
        self.assertEqual(status, 200)
        self.assertEqual(context['idle_ttl_seconds'], 3600)
        capture = self.m.sessions[context['session']]['capture']
        self.m.sessions[context['session']]['last_used'] -= 3601
        status, failure, _ = self.get('/source/v1/session')
        self.assertEqual((status, failure['error']), (410, 'source_session_missing_or_expired'))
        self.assertFalse(capture.directory.exists())

    def test_bootstrap_context_required_records_and_write_refusal(self):
        status,context,headers=self.get('/source/v1/session');self.assertEqual(status,200)
        self.assertNotIn(str(self.path),json.dumps(context));self.assertEqual(headers['Cache-Control'],'no-store')
        status,data,_=self.get('/source/v1/rows'+self.suffix()+'&table=t')
        self.assertEqual(status,200);handle=data['data']['rows'][0]['record_id']
        self.assertEqual(self.get('/source/v1/record'+self.suffix()+'&id='+handle)[0],200)
        self.assertEqual(self.get('/source/v1/record'+self.suffix()+'&id=unknown')[0],404)
        self.assertEqual(self.get('/source/v1/overview')[0],400)
        self.assertEqual(self.get('/source/v1/overview?session=unknown&generation=x')[0],410)
        for method in ['POST','PUT','PATCH','DELETE']:
            self.assertEqual(self.get('/source/v1/session',method)[0],405)

    def test_origin_query_limits_no_arbitrary_path_or_sql_and_no_cors(self):
        for headers in [{'Host':'attacker.invalid'},{'Origin':'https://attacker.invalid'}]:
            self.assertEqual(self.get('/source/v1/session',headers=headers)[0],403)
        for extra in ['&sql=DELETE%20FROM%20t','&db=/tmp/other','&table=t&table=t','&limit=101']:
            self.assertEqual(self.get('/source/v1/rows'+self.suffix()+'&table=t'+extra)[0],400)
        status,_,headers=self.get('/source/v1/overview'+self.suffix())
        self.assertEqual(status,200);self.assertNotIn('Access-Control-Allow-Origin',headers)
        self.assertEqual(self.get('/source/v1/session?'+('a'*8200))[0],414)
        self.assertEqual(self.get('/source/v1/session',headers={'Content-Length':'1'})[0],400)

    def test_admission_overload_is_a_structured_recoverable_busy_response(self):
        suffix=self.suffix()
        for _ in range(8):self.assertTrue(self.server.slots.acquire(blocking=False))
        try:
            status,data,headers=self.get('/source/v1/overview'+suffix)
            self.assertEqual((status,data),(429,{'error':'source_server_busy'}))
            self.assertEqual((headers['Retry-After'],headers['Content-Type'],headers['Cache-Control']),('1','application/json','no-store'))
        finally:
            for _ in range(8):self.server.slots.release()
        # Nothing about the capture or session changed: the same read succeeds.
        self.assertEqual(self.get('/source/v1/overview'+suffix)[0],200)

    def test_lost_capture_http_503_and_expiry_410(self):
        suffix=self.suffix();self.m.sessions[self.m.initial_session]['capture'].snapshot_path.unlink()
        self.assertEqual(self.get('/source/v1/overview'+suffix)[0],503)
        self.m.retire(self.m.initial_session)
        self.assertEqual(self.get('/source/v1/overview'+suffix)[0],410)

    def test_incoming_direction_is_served_and_unknown_direction_refused(self):
        status,data,_=self.get('/source/v1/rows'+self.suffix()+'&table=t');handle=data['data']['rows'][0]['record_id']
        status,data,_=self.get('/source/v1/references'+self.suffix()+'&record='+handle+'&direction=incoming')
        self.assertEqual(status,200);self.assertEqual((data['data']['direction'],data['data']['total'],data['data']['groups']),('incoming',0,[]))
        status,data,_=self.get('/source/v1/references'+self.suffix()+'&record='+handle+'&direction=both')
        self.assertEqual(status,400);self.assertEqual(data['error'],'invalid_parameter')


class TestCLILifecycle(Fixture):
    def test_sigterm_during_acquisition_cleans_partial_directory(self):
        self.build('CREATE TABLE t(id INTEGER PRIMARY KEY);')
        root=Path(self.tmp.name)/'startup-captures';root.mkdir()
        writer=sqlite3.connect(self.path);writer.execute('BEGIN EXCLUSIVE')
        proc=subprocess.Popen([sys.executable,str(ROOT/'adapters/source/server.py'),'--db',str(self.path),
                               '--port','0','--capture-deadline','1'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                              text=True,env={**os.environ,'TMPDIR':str(root)})
        try:
            deadline=time.monotonic()+5
            while not list(root.iterdir()) and proc.poll() is None and time.monotonic()<deadline:
                time.sleep(0.01)
            self.assertTrue(list(root.iterdir()))
            proc.send_signal(signal.SIGTERM);proc.wait(timeout=10)
            self.assertEqual(proc.returncode,0,proc.stderr.read())
            self.assertEqual(list(root.iterdir()),[])
        finally:
            writer.rollback();writer.close()
            if proc.poll() is None:proc.kill();proc.wait()
            proc.stdout.close();proc.stderr.close()

    def test_no_declaration_cli_shutdown_removes_owned_capture(self):
        self.build('CREATE TABLE t(id INTEGER PRIMARY KEY);INSERT INTO t VALUES(1);')
        capture_root=Path(self.tmp.name)/'captures';capture_root.mkdir()
        proc=subprocess.Popen([sys.executable,str(ROOT/'adapters/source/server.py'),'--db',str(self.path),'--port','0'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env={**os.environ,'TMPDIR':str(capture_root)})
        try:
            line=proc.stdout.readline().strip();self.assertIn('/source/v1/session',line)
            from urllib.request import urlopen
            with urlopen(line.split('sqlite source: ')[1]) as response:context=json.load(response)
            self.assertIn('capture_digest',context)
            self.assertEqual(len(list(capture_root.glob('knowledge-inspector-source-*'))),1)
            proc.send_signal(signal.SIGTERM);proc.wait(timeout=10)
            self.assertEqual(proc.returncode,0,proc.stderr.read())
            self.assertEqual(list(capture_root.iterdir()),[])
        finally:
            if proc.poll() is None:proc.kill();proc.wait()
            proc.stdout.close();proc.stderr.close()


@unittest.skipUnless((ROOT/'examples/chinook/data/Chinook_Sqlite.sqlite').exists(),
                     'prepare pinned Chinook before real-source acceptance')
class TestPinnedChinook(Fixture):
    def test_complete_catalogue_track_album_composite_junction_view_and_immutability(self):
        base=ROOT/'examples/chinook/data';upstream=base/'Chinook_Sqlite.sqlite';view=base/'Chinook_Sqlite.with-view.sqlite'
        self.assertEqual(hashlib.sha256(upstream.read_bytes()).hexdigest(),
                         'bdf635be69850bd3be09c9a2dbeef7ddfb80036bd3ef3381383cd03b61e4a61a')
        def state(p):
            return (hashlib.sha256(p.read_bytes()).hexdigest(),p.stat().st_mtime_ns,
                    sorted(x.name for x in p.parent.glob(p.name+'-*')))
        before={p:state(p) for p in [upstream,view] if p.exists()}
        m=SessionManager(upstream);self.managers.append(m)
        catalogue=self.query(m,'schema')
        self.assertEqual(catalogue['total'],11);self.assertEqual(catalogue['counts']['views'],0)
        track=next(r for r in self.query(m,'rows',table='Track')['rows'] if r['key'][0]['exact']=='10')
        record=self.query(m,'record',id=track['record_id'])
        with closing(sqlite3.connect(upstream.as_uri()+'?mode=ro&immutable=1',uri=True)) as db:
            db.row_factory=sqlite3.Row
            native=db.execute('SELECT * FROM Track WHERE TrackId=10').fetchone()
            self.assertEqual([c['exact'] if 'exact' in c else struct.unpack('>d',bytes.fromhex(c['ieee754_hex']))[0]
                              for c in record['cells']],
                             [str(v) if type(v) is int else v for v in native])
            self.assertEqual({r[0] for r in db.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")},
                             {r['name'] for r in catalogue['relations']})
        obs=self.query(m,'references',record=track['record_id'])['observations']
        album=next(o for o in obs if o['declaration']['parent_table']=='Album')
        self.assertEqual(album['status'],'resolved');self.assertEqual(album['child_values'][0]['exact'],'1')
        parent=self.query(m,'record',id=album['parent']['record_id'])
        self.assertEqual(parent['key'][0]['exact'],'1')
        self.assertEqual(next(c['exact'] for c in parent['cells'] if c['column']=='Title'),
                         'For Those About To Rock We Salute You')
        junction=self.query(m,'rows',table='PlaylistTrack')
        self.assertEqual(junction['identity']['verified_rows'],8715)
        self.assertEqual(junction['identity']['key_columns'],['PlaylistId','TrackId'])
        row=junction['rows'][0]
        self.assertEqual(self.query(m,'record',id=row['record_id'])['key'],row['key'])
        cap=m.sessions[m.initial_session]['capture']
        self.assertEqual(hashlib.sha256(cap.snapshot_path.read_bytes()).hexdigest(),record['grounding']['capture_digest'])
        if view.exists():
            vm=SessionManager(view);self.managers.append(vm)
            vs=self.query(vm,'schema')
            self.assertEqual(vs['counts']['views'],1)
            vr=self.query(vm,'rows',table='InvoiceLineCustomer')
            self.assertEqual(vr['identity']['status'],'view_table_only')
            self.assertEqual(vr['lineage'],'not_recorded')
            self.assertTrue(all(r['record_id'] is None for r in vr['rows']))
        for p,s in before.items():self.assertEqual(state(p),s)

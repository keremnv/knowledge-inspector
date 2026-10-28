"""KI-019/020: disposable SQLite, validated models and actual HTTP framing.

build_fixture is also used by the browser regression's real adapter process.
"""
import hashlib
import json
import sqlite3
import tempfile
import threading
import unittest
from contextlib import closing
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import urlopen

import server as world

RESERVED_KEY = 'key,?/#+&% Ω'


def build_fixture(path):
    with closing(sqlite3.connect(path)) as db:
        db.executescript('''
CREATE TABLE flows(id TEXT PRIMARY KEY,label TEXT);
INSERT INTO flows VALUES('F2','Second flow'),('many','Many occurrences');
CREATE TABLE ordinary(id TEXT PRIMARY KEY,label TEXT);
INSERT INTO ordinary VALUES('F2','Ordinary flow');
CREATE TABLE capital(id TEXT PRIMARY KEY,label TEXT);
INSERT INTO capital VALUES('F2','Capital flow');
CREATE TABLE numbers(id INTEGER PRIMARY KEY,label TEXT);
INSERT INTO numbers VALUES(1,'Number one');
CREATE TABLE determination(id INTEGER PRIMARY KEY,subject TEXT,date TEXT,basis TEXT);
INSERT INTO determination VALUES(1,'F2','2026-01-01','recorded basis');
CREATE TABLE inspection(id INTEGER PRIMARY KEY,subject TEXT,amount NUMERIC,note TEXT);
CREATE TABLE network(id INTEGER PRIMARY KEY,subject TEXT,other TEXT,ordinary TEXT,capital TEXT);
CREATE TABLE numeric_event(id INTEGER PRIMARY KEY,subject TEXT);
INSERT INTO numeric_event VALUES(1,'01');
''')
        db.execute('INSERT INTO flows VALUES(?,?)', (RESERVED_KEY, 'Reserved neighbour'))
        db.execute('INSERT INTO ordinary VALUES(?,?)', (RESERVED_KEY, 'Ordinary reserved'))
        db.executemany('INSERT INTO inspection VALUES(?,?,?,?)',
                       [(n, 'many', 0 if n == 1 else None if n == 2 else n / 2,
                         '' if n == 1 else None if n == 2 else f'note {n}')
                        for n in range(1, 106)])
        db.execute('INSERT INTO network VALUES(1,?,?,?,?)', ('F2', RESERVED_KEY, 'F2', 'F2'))
        db.commit()
    def role(name, kind=None):
        return {'role': name, 'column_name': name, 'target_kind': kind}
    def relation(name, roles, state=None):
        item = {'name': name, 'source': name, 'key_columns': ['id'], 'roles': roles}
        if state:
            item['occurrence_state'] = state
        return item
    return world.validate_declaration({'version': 1, 'world': {'id_prefix': 'directorytest'},
        'entities': [
            {'kind': kind, 'source': source, 'key_columns': ['id'], 'label_column': 'label'}
            for kind, source in [('flow,kind', 'flows'), ('flow', 'ordinary'),
                                 ('Flow,kind', 'capital'), ('number', 'numbers')]],
        'relations': [
            relation('determination', [role('subject', 'flow,kind'), role('date'), role('basis')], 'RECORDED'),
            relation('inspection', [role('subject', 'flow,kind'), role('amount'), role('note')]),
            relation('network', [role('subject', 'flow,kind'), role('other', 'flow,kind'),
                                 role('ordinary', 'flow'), role('capital', 'Flow,kind')]),
            relation('numeric_event', [role('subject', 'number')])]})


class TestReferentDirectory(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'producer.sqlite'
        self.declaration = build_fixture(self.path)
        self.before = self.signature()
        self.prepared = world.prepare_world(self.path, self.declaration)
        prepared = self.prepared
        class Handler(world.Handler):
            db_path = prepared.snapshot_path
            model = prepared.model
            world_id = prepared.world_id
            fingerprint = prepared.fingerprint
            snapshot_mode = True
            db_connect = staticmethod(world.connect_snapshot)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f'http://127.0.0.1:{self.server.server_port}'

    def signature(self):
        return hashlib.sha256(self.path.read_bytes()).hexdigest(), self.path.stat().st_mtime_ns

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.prepared.cleanup()
        self.assertEqual(self.signature(), self.before)
        self.assertEqual(list(self.path.parent.glob('producer.sqlite-*')), [])
        self.tmp.cleanup()

    def get(self, path, params=()):
        with urlopen(self.origin + path + '?' + urlencode(params)) as response:
            return json.load(response)

    def test_named_roles_values_states_and_bounded_occurrence_preview(self):
        single = self.get('/world/referent', [('id', 'flow,kind:F2')])
        self.assertEqual([(f['relation'], f['role'], f['value'], f['assertion_id']) for f in single['fields']],
                         [('determination', 'basis', 'recorded basis', 'determination:1'),
                          ('determination', 'date', '2026-01-01', 'determination:1')])
        self.assertTrue(all(f['occurrence_state'] == 'RECORDED' for f in single['fields']))
        many = self.get('/world/referent', [('id', 'flow,kind:many')])
        self.assertEqual(next(r['count'] for r in many['relations'] if r['name'] == 'inspection'), 105)
        self.assertEqual(len(many['fields']), 200)
        self.assertEqual(len({f['assertion_id'] for f in many['fields']}), 100)
        self.assertEqual([(f['role'], f['value']) for f in many['fields'][:4]],
                         [('amount', 0), ('note', ''), ('amount', None), ('note', None)])
        self.assertEqual(many['fields'][4]['value'], 1.5)
        self.assertEqual(many['fields'][5]['value'], 'note 3')
        self.assertTrue(all('occurrence_state' not in f for f in many['fields']))
        rows = self.get('/world/rows', [('relation', 'inspection'), ('subject', many['id']), ('limit', 200)])
        self.assertEqual(rows['total'], 105)
        self.assertEqual(len(rows['rows']), 105)

    def test_search_category_preserves_ids_labels_and_namespace_spellings(self):
        for query, expected in [('Second flow', [('flow,kind:F2', 'Second flow')]),
                                ('flow,kind:F2', [('flow,kind:F2', 'Second flow'), ('Flow,kind:F2', 'Capital flow')]),
                                (world.encode_id('flow,kind', [RESERVED_KEY]), [(world.encode_id('flow,kind', [RESERVED_KEY]), 'Reserved neighbour')]),
                                ('Reserved neighbour', [(world.encode_id('flow,kind', [RESERVED_KEY]), 'Reserved neighbour')]),
                                ('F2', [('flow,kind:F2', 'Second flow'), ('flow:F2', 'Ordinary flow'),
                                        ('Flow,kind:F2', 'Capital flow')])]:
            with self.subTest(query=query):
                results = self.get('/world/search', [('q', query)])['results']
                self.assertCountEqual([(r['id'], r['label']) for r in results], expected)
                self.assertTrue(all(r['kind'] == 'referent' for r in results))
                self.assertEqual([r['entity_kind'] for r in results], [r['id'].split(':', 1)[0] for r in results])

    def test_repeated_ids_preserve_opaque_comma_namespace_keys_and_order(self):
        reserved = world.encode_id('flow,kind', [RESERVED_KEY])
        ids = ['flow,kind:F2', reserved, 'flow:F2', 'Flow,kind:F2', 'flow,kind:missing', 'number:1']
        labels = self.get('/world/labels', [('id', i) for i in ids])['labels']
        self.assertEqual(labels, dict(zip(ids, ['Second flow', 'Reserved neighbour', 'Ordinary flow',
                                               'Capital flow', None, 'Number one'])))
        self.assertEqual(list(labels), ids)
        directory = self.get('/world/referents')
        self.assertFalse(directory['truncated'])
        self.assertIn(reserved, [r['id'] for r in directory['referents']])
        self.assertEqual(self.get('/world/referent', [('id', reserved)])['id'], reserved)
        row = self.get('/world/assertion', [('id', 'network:1')])
        self.assertEqual(row['values']['other'], reserved)
        self.assertEqual(row['values']['ordinary'], 'flow:F2')
        self.assertEqual(row['values']['capital'], 'Flow,kind:F2')
        alias = reserved.replace('%2C', '%2c')
        self.assertEqual(self.get('/world/labels', [('id', alias)])['labels'], {alias: None})
        with self.assertRaises(HTTPError) as error:
            self.get('/world/referent', [('id', alias)])
        self.assertEqual(error.exception.code, 404)

    def test_legacy_comma_lists_encoded_key_commas_and_alias_refusal(self):
        self.assertEqual(self.get('/world/labels', [('ids', 'flow:F2,number:1,number:01')])['labels'],
                         {'flow:F2': 'Ordinary flow', 'number:1': 'Number one', 'number:01': None})
        # Key commas are escaped by the unchanged codec; only a namespace comma is raw.
        identifier = world.encode_id('flow', [RESERVED_KEY])
        self.assertEqual(self.get('/world/labels', [('ids', identifier + ',flow:F2')])['labels'],
                         {identifier: 'Ordinary reserved', 'flow:F2': 'Ordinary flow'})
        self.assertEqual(self.get('/world/labels', [('id', 'number:01')])['labels'], {'number:01': None})
        for endpoint, params in [('/world/referent', [('id', 'number:01')]),
                                 ('/world/rows', [('relation', 'numeric_event'), ('subject', 'number:01')])]:
            with self.assertRaises(HTTPError) as error:
                self.get(endpoint, params)
            self.assertEqual(error.exception.code, 404)
        self.assertEqual(self.get('/world/assertion', [('id', 'numeric_event:1')])['values']['subject'], 'number:1')

    def test_label_transport_rejects_mixed_forms_and_preserves_missing_keys(self):
        with self.assertRaises(HTTPError) as error:
            self.get('/world/labels', [('id', 'flow,kind:F2'), ('ids', 'flow:F2')])
        self.assertEqual(error.exception.code, 400)
        missing = ['flow,kind:missing', ' flow,kind:F2 ', 'flow,kind:key%2cmissing']
        self.assertEqual(self.get('/world/labels', [('id', i) for i in missing])['labels'],
                         dict.fromkeys(missing))
        self.assertEqual(self.get('/world/labels')['labels'], {})

    def test_world_identity_and_fingerprint_remain_source_based(self):
        self.assertEqual(self.prepared.world_id,
                         world.build_world_id('directorytest', self.prepared.fingerprint, self.declaration))
        self.assertEqual(self.get('/world/overview')['world_id'], self.prepared.world_id)
        with closing(world.connect_snapshot(self.prepared.snapshot_path)) as db:
            self.assertEqual(db.execute('PRAGMA query_only').fetchone()[0], 1)
        restarted = world.prepare_world(self.path, self.declaration)
        try:
            self.assertEqual(restarted.world_id, self.prepared.world_id)
            self.assertEqual(restarted.fingerprint, self.prepared.fingerprint)
        finally:
            restarted.cleanup()
        self.assertEqual(self.signature(), self.before)


if __name__ == '__main__':
    unittest.main()

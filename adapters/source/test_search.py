"""Discovery semantics, bounded failures and actual HTTP integration."""
import json
import sqlite3
import threading
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import patch

from adapters.source.test_source import Fixture
from adapters.source.model import SourceError
from adapters.source.server import SourceHTTPServer


class TestSearch(Fixture):
    def seed(self):
        self.build('''CREATE TABLE tracks(id INTEGER PRIMARY KEY, name, mixed);
        CREATE TABLE keyless(v);
        INSERT INTO keyless VALUES('same'),('same'),(NULL),('');
        CREATE TABLE composite(a TEXT COLLATE NOCASE, b INTEGER, v, PRIMARY KEY(a,b));
        INSERT INTO composite VALUES('AbC',9223372036854775807,'same');
        CREATE TABLE invalid(id TEXT PRIMARY KEY, v);
        INSERT INTO invalid VALUES(NULL,'same');
        CREATE TABLE blobkey(id BLOB PRIMARY KEY, v);
        INSERT INTO blobkey VALUES(x'01','same');
        CREATE VIEW computed AS SELECT upper(name) AS label FROM tracks;
        CREATE VIEW volatile AS SELECT random() AS v;
        ''', [('INSERT INTO tracks VALUES(?,?,?)', [
            (10, 'Evil Walks', 10), (11, 'Evil Walks', '10'),
            (12, "quote' %_\\", 10.0), (13, 'éΩ', None),
            (14, 'Éω', b'10'), (15, '', 9223372036854775807),
            (16, ' \t', -9223372036854775808), (17, 'nul\0tail', 1.25)])])
        return self.manager()

    def search(self, manager, table='tracks', **parameters):
        return self.query(manager, 'search', table=table, **parameters)

    def test_broad_duplicates_registered_reader_and_windows(self):
        m = self.seed()
        result = self.search(m, text='Evil Walks', limit=1)
        self.assertEqual(result['completion'], 'window')
        self.assertEqual(result['next_offset'], 1)
        self.assertEqual(result['rows'][0]['matched_columns'], ['name'])
        row = result['rows'][0]
        self.assertEqual(row['key'][0]['exact'], '10')
        record = self.query(m, 'record', id=row['record_id'])
        self.assertEqual(record['cells'], row['cells'])
        next_page = self.search(m, text='Evil Walks', limit=1, offset=1)
        self.assertEqual(next_page['completion'], 'complete')
        self.assertNotEqual(next_page['rows'][0]['record_id'], row['record_id'])
        self.assertEqual(self.search(m, text='absent')['rows'], [])
        self.assertEqual(self.search(m, text='absent')['completion'], 'complete')

    def test_literal_case_unicode_whitespace_empty_and_nul(self):
        m = self.seed()
        # case=match: the previous rule, code points as recorded (exact_v1).
        for text, ids in [("' %_\\", ['12']), ('%', ['12']), ('_', ['12']),
                          ('evil', []), ('é', ['13']), ('É', ['14']), ('Ω', ['13']),
                          (' \t', ['16']), ('\0tail', ['17']), ("' OR 1=1 --", [])]:
            with self.subTest(text=text, case='match'):
                data = self.search(m, text=text, column='name', case='match')
                self.assertEqual([r['key'][0]['exact'] for r in data['rows']], ids)
                self.assertEqual(data['text_comparison']['policy'], 'exact_v1')
        # The default ignores case (O11, casefold_v1); punctuation, whitespace and NUL stay literal.
        for text, ids in [("' %_\\", ['12']), ('%', ['12']), ('_', ['12']),
                          ('evil', ['10', '11']), ('EVIL WALKS', ['10', '11']), ('é', ['13', '14']), ('É', ['13', '14']),
                          ('Ω', ['13', '14']), ('ω', ['13', '14']), (' \t', ['16']), ('\0tail', ['17']), ('NUL\0TAIL', ['17']),
                          ("' OR 1=1 --", [])]:
            with self.subTest(text=text, case='ignore'):
                data = self.search(m, text=text, column='name')
                self.assertEqual([r['key'][0]['exact'] for r in data['rows']], ids)
                self.assertEqual((data['search']['case'], data['text_comparison']['policy']), ('ignore', 'casefold_v1'))
                for row in data['rows']:
                    self.assertEqual(row['matched_columns'], ['name'])
        for case in ('ignore', 'match'):
            self.assertEqual(self.search(m, text='', column='name', case=case)['returned'], 8)
            self.assertEqual(self.search(m, text='Evil', column='id', case=case)['returned'], 0)

    def test_casefold_v1_is_full_unicode_folding_without_normalization(self):
        self.build("CREATE TABLE w(id INTEGER PRIMARY KEY, v TEXT, n INTEGER);", [('INSERT INTO w VALUES(?,?,?)', [
            (1, 'Straße', 7), (2, 'ΣΊΣΥΦΟΣ', None), (3, 'sísyfos', None), (4, 'cafe\u0301', None), (5, 'café', None),
            (6, 'ﬁle', None), (7, 'İstanbul', None), (8, 'ABC', 70)])])
        m = self.manager()
        ids = lambda text, **q: [r['key'][0]['exact'] for r in self.search(m, 'w', text=text, column=q.pop('column', 'v'), **q)['rows']]
        self.assertEqual(ids('STRASSE'), ['1'])          # ß folds to ss
        self.assertEqual(ids('σίσυφος'), ['2'])          # final and medial sigma fold alike
        self.assertEqual(ids('FILE'), ['6'])             # the ligature folds to fi
        self.assertEqual(ids('istanbul'), [])            # İ folds to i + U+0307, not to i
        self.assertEqual(ids('i\u0307stanbul'), ['7'])
        self.assertEqual(ids('café'), ['5'])             # no normalization: composed and decomposed differ
        self.assertEqual(ids('cafe\u0301'.upper()), ['4'])
        self.assertEqual(ids('7', column='n'), ['1'])    # numbers are compared as before
        self.assertEqual(ids('abc'), ['8'])
        self.assertEqual(ids('abc', case='match'), [])

    def test_case_is_a_literal_option_only(self):
        m = self.seed()
        for query in ({'text': 'x', 'case': 'upper'}, {'text': 'x', 'case': ''}):
            with self.subTest(query=query), self.assertRaises(SourceError) as failure:
                self.search(m, **query)
            self.assertEqual(failure.exception.code, 'invalid_search_parameters')
        key = json.dumps([{'column': 'id', 'storage_class': 'integer', 'exact': '10'}])
        with self.assertRaises(SourceError):
            self.search(m, mode='primary_key', key=key, case='ignore')

    def test_mixed_scalars_and_integer_limits(self):
        m = self.seed()
        data = self.search(m, text='10', column='mixed')
        self.assertEqual([r['cells'][2]['storage_class'] for r in data['rows']], ['integer', 'text', 'real'])
        for value, rowid in [('9223372036854775807','15'), ('-9223372036854775808','16')]:
            rows = self.search(m, text=value, column='mixed')['rows']
            self.assertEqual(rows[0]['key'][0]['exact'], rowid)
            self.assertEqual(rows[0]['cells'][2]['exact'], value)
        self.assertEqual(self.search(m, text='1.25', column='mixed')['returned'], 1)
        self.assertEqual(self.search(m, text='9223372036854775808', column='mixed')['returned'], 0)
        self.assertEqual(self.search(m, text='010', column='mixed')['returned'], 1)  # REAL only

    def test_explicit_composite_exact_key_binary_collation(self):
        m = self.seed()
        key = [{'column':'a','storage_class':'text','exact':'AbC'},
               {'column':'b','storage_class':'integer','exact':'9223372036854775807'}]
        data = self.search(m, 'composite', mode='primary_key', key=json.dumps(key))
        self.assertEqual(data['returned'], 1)
        self.assertEqual(data['rows'][0]['matched_columns'], ['a','b'])
        key[0]['exact'] = 'abc'
        self.assertEqual(self.search(m, 'composite', mode='primary_key', key=json.dumps(key))['returned'], 0)
        key[0]['storage_class'] = 'real'
        with self.assertRaisesRegex(SourceError, 'unsupported_search_key_type'):
            self.search(m, 'composite', mode='primary_key', key=json.dumps(key))

    def test_imperfect_identities_and_views_remain_readable(self):
        m = self.seed()
        for table, text, count, status in [('keyless','same',2,'no_declared_key'),
                ('invalid','same',1,'invalid'), ('blobkey','same',1,'unsupported'),
                ('computed','EVIL',2,'view_table_only')]:
            data = self.search(m, table, text=text)
            self.assertEqual(data['returned'], count)
            self.assertEqual(data['identity']['status'], status)
            self.assertTrue(all(r['record_id'] is None for r in data['rows']))
        with self.assertRaisesRegex(SourceError, 'unsupported_source_operation'):
            self.search(m, 'volatile', text='1')
        with self.assertRaisesRegex(SourceError, 'unsupported_search_key'):
            self.search(m, 'keyless', mode='primary_key', key='[]')

    def test_validation(self):
        m = self.seed()
        for parameters in [{}, {'text':'x','column':'not a column'}, {'text':'x'*1025},
                {'text':'x','mode':'sql'}, {'text':'x','key':'[]'}, {'mode':'primary_key','key':'{'},
                {'mode':'primary_key','key':'null'}, {'text':'x','limit':101},
                {'text':'x','offset':-1}, {'text':'x','operator':'LIKE'}]:
            with self.subTest(parameters=parameters), self.assertRaises(SourceError):
                self.search(m, **parameters)
        with self.assertRaises(SourceError):
            self.query(m, 'search', table='tracks; DROP TABLE tracks', text='x')

    def test_hostile_identifier_and_virtual_exclusion(self):
        self.build('CREATE TABLE "odd""table"("x""y"); INSERT INTO "odd""table" VALUES(\'needle\'); CREATE VIRTUAL TABLE f USING fts5(v);')
        m = self.manager()
        result = self.search(m, 'odd"table', text='needle', column='x"y')
        self.assertEqual(result['rows'][0]['matched_columns'], ['x"y'])
        with self.assertRaisesRegex(SourceError, 'unsupported_virtual_source'):
            self.search(m, 'f', text='needle')

    def test_vm_time_and_response_failures_are_not_empty_results(self):
        self.build('CREATE TABLE large(v TEXT);', [('INSERT INTO large VALUES(?)', [('haystack',)]*10000)])
        m = self.manager(reader_options={'vm_steps': 1000})
        with self.assertRaisesRegex(SourceError, 'source_query_budget_exceeded'):
            self.search(m, 'large', text='absent')
        m = self.manager(reader_options={'query_seconds': 0.000001})
        with self.assertRaisesRegex(SourceError, 'source_query_budget_exceeded'):
            self.search(m, 'large', text='absent')
        m = self.manager()
        with patch('adapters.source.model.MAX_RESPONSE_BYTES', 100):
            with self.assertRaisesRegex(SourceError, 'budget_exceeded'):
                self.search(m, 'large', text='haystack')

    def test_actual_http_context_encoding_and_failures(self):
        m = self.seed()
        server = SourceHTTPServer(('127.0.0.1', 0), m)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            context = m.descriptor(m.initial_session)
            params = {'session':context['session'], 'generation':context['generation'],
                      'table':'tracks','text':"' %_\\"}
            def get(parameters):
                return urllib.request.urlopen(f'http://127.0.0.1:{server.server_port}/source/v1/search?' + urllib.parse.urlencode(parameters))
            with get(params) as response:
                body = json.load(response)
                self.assertEqual(body['context'], context)
                self.assertEqual(body['data']['returned'], 1)
            for changes, code in [({'generation':'stale'},409), ({'mode':'sql'},422), ({'column':'unknown'},400)]:
                with self.assertRaises(urllib.error.HTTPError) as error:
                    get({**params, **changes})
                self.assertEqual(error.exception.code, code)
                self.assertIn('error', json.load(error.exception))
        finally:
            server.shutdown(); thread.join(); server.server_close()

    def test_exact_storage_class_and_oversized_next_match(self):
        self.build('CREATE TABLE t(id INTEGER PRIMARY KEY, v);', [
            ('INSERT INTO t VALUES(?,?)', [(10,'needle'),(11,'needle'+'x'*(1024*1024))])])
        m = self.manager()
        first = self.search(m, 't', text='needle', limit=1)
        self.assertEqual(first['completion'], 'window')
        with self.assertRaisesRegex(SourceError, 'source_cell_budget_exceeded'):
            self.search(m, 't', text='needle', limit=1, offset=1)
        for kind, count in [('integer',1), ('text',0)]:
            result = self.search(m, 't', mode='primary_key', key=json.dumps([
                {'column':'id','storage_class':kind,'exact':'10'}]))
            self.assertEqual(result['returned'], count)
        with self.assertRaisesRegex(SourceError, 'invalid_search_key'):
            self.search(m, 't', mode='primary_key', key=json.dumps([
                {'column':'id','storage_class':'integer','exact':'9223372036854775808'}]))

    def test_real_limits_and_explicit_binary64_rounding_policy(self):
        self.build('CREATE TABLE r(v);', [('INSERT INTO r VALUES(?)', [
            (float('1.7976931348623157e308'),), (float('5e-324'),),
            (float('9007199254740992'),), (float('inf'),), (float('-inf'),)])])
        m = self.manager()
        for text in ['1.7976931348623157e308', '5e-324', '9007199254740993']:
            result = self.search(m, 'r', text=text)
            self.assertEqual(result['returned'], 1)
            self.assertEqual(result['rows'][0]['cells'][0]['storage_class'], 'real')
            self.assertEqual(result['rows'][0]['matched_columns'], ['v'])
        # Nonfinite input does not pretend it searched nonfinite numeric cells.
        for text in ['inf', '-inf', '1e999']:
            self.assertEqual(self.search(m, 'r', text=text)['returned'], 0)

"""Real SQLite canonical references; oracle is the ORIGINAL column join."""
import hashlib
from collections import Counter
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
import server as world


def declaration(target='target', source='events', keys=None):
    return {'version': 1, 'entities': [
        {'kind': 'entity', 'source': target, 'key_columns': ['k'], 'label_column': 'label'}],
        'relations': [{'name': 'event', 'source': source, 'key_columns': keys or ['id'],
                       'roles': [{'role': 'participant', 'column_name': 'v', 'target_kind': 'entity'}]}]}


class TestCanonicalReferences(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / 'source.sqlite'

    def tearDown(self):
        self.directory.cleanup()

    def seed(self, target_type, participant_type, targets, participants, view=False):
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('CREATE TABLE target(k ' + target_type + ',label TEXT)')
            db.execute('CREATE TABLE events(id INTEGER PRIMARY KEY,v ' + participant_type + ')')
            db.executemany('INSERT INTO target VALUES(?,?)', [(v, 'label ' + str(v)) for v in targets])
            db.executemany('INSERT INTO events VALUES(?,?)', enumerate(participants, 1))
            if view:
                db.executescript('CREATE VIEW tv AS SELECT k,label FROM target; CREATE VIEW ev AS SELECT id,v FROM events;')
            db.commit()
        return declaration('tv' if view else 'target', 'ev' if view else 'events')

    def check_endpoints(self, declared, expected, raw, storage):
        before = hashlib.sha256(self.path.read_bytes()).hexdigest(), self.path.stat().st_mtime_ns
        with closing(world.connect(self.path)) as db:
            model = world.Model(db, declared)
            self.assertIn(expected, [v['id'] for v in world.referents(db, model)['referents']])
            detail = world.referent(db, model, expected)
            self.assertEqual(detail['relations'][0]['count'], len(raw))
            self.assertIsInstance(detail['label'], str)
            self.assertEqual(len(world.expand(db, model, expected, 'event', 100)['tuples']), len(raw))
            window = world.rows(db, model, {'relation': ['event'], 'subject': [expected]})
            self.assertEqual(window['total'], len(raw))
            for n, (value, kind) in enumerate(zip(raw, storage), 1):
                item = world.assertion(db, model, 'event:' + str(n))
                self.assertEqual(item['values']['participant'], expected)
                self.assertEqual(item['grounding'][0]['detail']['reference_participants']['participant'],
                                 {'column': 'v', 'value': value, 'storage_class': kind})
                self.assertEqual(world.support(db, model, 'event:' + str(n))['referents'], [expected])
            self.assertEqual(db.execute('PRAGMA query_only').fetchone()[0], 1)
            self.assertEqual(list(db.execute("SELECT name FROM sqlite_master WHERE type='index'")), [])
            with self.assertRaises(sqlite3.OperationalError):
                db.execute('CREATE INDEX forbidden ON target(k)')
        self.assertEqual((hashlib.sha256(self.path.read_bytes()).hexdigest(), self.path.stat().st_mtime_ns), before)
        self.assertEqual(list(self.path.parent.glob('source.sqlite-*')), [])

    def test_nocase_repeated_and_exact_references_everywhere(self):
        d = self.seed('TEXT COLLATE NOCASE', 'TEXT COLLATE RTRIM', ['ABC'], ['abc', 'AbC', 'ABC', 'abc'])
        self.check_endpoints(d, 'entity:ABC', ['abc', 'AbC', 'ABC', 'abc'], ['text'] * 4)

    def test_quoted_identifiers_and_nul_values_are_not_sql_fragments(self):
        target_name = 'target"; --'; source_name = 'events"; --'; column = 'participant"; --'
        key = 'ABC\0one'; raw = 'abc\0two'
        with closing(sqlite3.connect(self.path)) as db:
            db.execute(f'CREATE TABLE {world.quote_ident(target_name)}(k TEXT COLLATE NOCASE,label TEXT)')
            db.execute(f'CREATE TABLE {world.quote_ident(source_name)}(id INTEGER PRIMARY KEY,{world.quote_ident(column)} TEXT)')
            db.execute(f'INSERT INTO {world.quote_ident(target_name)} VALUES(?,?)', (key, 'label'))
            db.executemany(f'INSERT INTO {world.quote_ident(source_name)} VALUES(?,?)', [(n, raw) for n in range(1, 71)])
            db.commit()
        d = declaration(target_name, source_name)
        d['relations'][0]['roles'][0]['column_name'] = column
        with closing(world.connect(self.path)) as db:
            model = world.Model(db, d)
            item = world.assertion(db, model, 'event:1')
            self.assertEqual(item['values']['participant'], world.encode_id('entity', [key]))
            self.assertEqual(item['grounding'][0]['detail']['reference_participants']['participant']['value'], raw)
            self.assertEqual(world.referent(db, model, world.encode_id('entity', [key]))['relations'][0]['count'], 70)

    def test_rtrim_uses_actual_key_spaces(self):
        d = self.seed('TEXT COLLATE RTRIM', 'TEXT', ['one  '], ['one', 'one ', 'one  '])
        self.check_endpoints(d, 'entity:one%20%20', ['one', 'one ', 'one  '], ['text'] * 3)

    def test_integer_target_and_text_participant_affinity(self):
        d = self.seed('INTEGER', 'TEXT', [1], ['01', '1', '001'])
        self.check_endpoints(d, 'entity:1', ['01', '1', '001'], ['text'] * 3)

    def test_numeric_target_and_mixed_storage_participants(self):
        d = self.seed('NUMERIC', '', [1], [1, 1.0, '01', '1'])
        self.check_endpoints(d, 'entity:1', [1, 1.0, '01', '1'], ['integer', 'real', 'text', 'text'])
        with closing(world.connect(self.path)) as db:
            model = world.Model(db, d)
            self.assertEqual(len(model.relations['event']['references']['participant']), 4)

    def test_column_affinity_can_resolve_when_parameter_probe_cannot(self):
        d = self.seed('TEXT', 'INTEGER', ['01'], [1])
        with closing(world.connect(self.path)) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM target WHERE k=?', ('1',)).fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM target t JOIN events s ON t.k=s.v').fetchone()[0], 1)
        self.check_endpoints(d, 'entity:01', [1], ['integer'])

    def test_participant_collation_does_not_override_left_target_column(self):
        d = self.seed('TEXT', 'TEXT COLLATE NOCASE', ['ABC'], ['abc'])
        with closing(world.connect(self.path)) as db, self.assertRaisesRegex(ValueError, 'dangling participant'):
            world.Model(db, d)

    def test_noncompound_target_and_occurrence_views(self):
        d = self.seed('TEXT COLLATE NOCASE', 'TEXT', ['ABC'], ['abc'], True)
        self.check_endpoints(d, 'entity:ABC', ['abc'], ['text'])
        with closing(world.connect(self.path)) as db:
            detail = world.assertion(db, world.Model(db, d), 'event:1')['grounding'][0]['detail']
            self.assertIn('derivation_definition', detail)
            self.assertEqual(detail['lineage'], 'not recorded')

    def test_alias_ids_explicitly_refused_by_http_contract(self):
        d = self.seed('INTEGER', 'TEXT', [1], ['01'])
        with closing(world.connect(self.path)) as db:
            model = world.Model(db, d)
            for path, query in [('/world/referent', {'id': ['entity:01']}),
                                ('/world/expand', {'id': ['entity:01'], 'relation': ['event']}),
                                ('/world/rows', {'subject': ['entity:01'], 'relation': ['event']})]:
                with self.subTest(path=path), self.assertRaisesRegex(world.NotFound, 'canonical referent'):
                    world.route(path, query, db, model, 'test')
            self.assertEqual(world.labels(db, model, 'entity:01,entity:1')['labels'], {'entity:01': None, 'entity:1': 'label 1'})

    def test_ambiguous_column_join_despite_unambiguous_parameter_keys(self):
        d = self.seed('TEXT', 'INTEGER', ['1', '01'], [1])
        with closing(world.connect(self.path)) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM target t JOIN events s ON t.k=s.v').fetchone()[0], 2)
            # Each target ID independently has exactly one parameter match.
            with self.assertRaisesRegex(ValueError, 'ambiguous participant.*exactly one'):
                world.Model(db, d)

    def test_dangling_and_null_remain_refusals(self):
        for value, message in [('missing', 'dangling participant'), (None, 'null participants')]:
            with self.subTest(value=value):
                self.path.unlink(missing_ok=True)
                d = self.seed('TEXT', 'TEXT', ['exists'], [value])
                with closing(world.connect(self.path)) as db, self.assertRaisesRegex(ValueError, message):
                    world.Model(db, d)

    def test_multiple_roles_kinds_composite_occurrences_reserved_and_scalars(self):
        special = 'a/b?% Ω'
        d = self.seed('TEXT COLLATE NOCASE', 'TEXT', [special], [special.upper()])
        with closing(sqlite3.connect(self.path)) as db:
            db.executescript('CREATE TABLE number(k INTEGER PRIMARY KEY,label TEXT); INSERT INTO number VALUES(1,"one"); CREATE TABLE many(a TEXT,b INTEGER,x TEXT,y TEXT,z TEXT,note TEXT,PRIMARY KEY(a,b));')
            db.executemany('INSERT INTO many VALUES(?,?,?,?,?,?)', [(special, n, special.upper(), special, '01', 'raw scalar') for n in (1, 2)])
            db.commit()
        d['entities'].append({'kind': 'number', 'source': 'number', 'key_columns': ['k'], 'label_column': 'label'})
        d['relations'] = [{'name': 'many', 'source': 'many', 'key_columns': ['a', 'b'], 'roles': [
            {'role': role, 'column_name': col, 'target_kind': target} for role, col, target in
            [('first', 'x', 'entity'), ('second', 'y', 'entity'), ('third', 'z', 'number'), ('scalar', 'note', None)]]}]
        with closing(world.connect(self.path)) as db:
            model = world.Model(db, d)
            cid = world.encode_id('entity', [special])
            occurrence = world.encode_id('many', [special, 1])
            self.assertEqual(world.assertion(db, model, occurrence)['values'], {'first': cid, 'second': cid, 'third': 'number:1', 'scalar': 'raw scalar'})
            self.assertEqual(world.referent(db, model, cid)['relations'][0]['count'], 2)
            self.assertEqual(len(world.expand(db, model, cid, 'many', 10)['tuples']), 2)

    def test_reference_join_differential_affinity_collation_and_views(self):
        # Test the resolver against actual original joins, not decoder probes.
        cases = [('TEXT COLLATE NOCASE', ['ABC', 'one ', '1', '01']),
                 ('TEXT COLLATE RTRIM', ['ABC', 'one ', '1', '01']),
                 ('TEXT', ['ABC', 'one ', '1', '01']),
                 ('BLOB', ['ABC', 'one ', '1', '01']),
                 ('INTEGER', [1, 2]), ('NUMERIC', [1, 1.5]), ('REAL', [1.0, 1.5])]
        checked = 0
        for target_type, targets in cases:
            for source_type in ('TEXT', 'INTEGER', 'NUMERIC', 'REAL', 'BLOB', 'TEXT COLLATE NOCASE', 'TEXT COLLATE RTRIM'):
                for view in (False, True):
                    self.path.unlink(missing_ok=True)
                    d = self.seed(target_type, source_type, targets, ['abc', 'one', '01', 1, 1.0, 1.5, 'absent'], view)
                    target_source = 'tv' if view else 'target'; source = 'ev' if view else 'events'
                    # Prepare filtered simple views before the read-only run;
                    # their bare participant column keeps the same metadata.
                    with closing(sqlite3.connect(self.path)) as write:
                        for ordinal in range(1, 8):
                            write.execute(f'CREATE VIEW probe_{ordinal} AS SELECT id,v FROM {source} WHERE id={ordinal}')
                        write.commit()
                    with closing(world.connect(self.path)) as db:
                        target = world.Model.__new__(world.Model)._entity(db, {target_source}, d['entities'][0])
                        for ordinal in range(1, 8):
                            probe = f'probe_{ordinal}'
                            matches = db.execute(f'SELECT t.k FROM {target_source} t JOIN {probe} s ON t.k=s.v').fetchall()
                            raw = db.execute(f'SELECT v FROM {probe}').fetchone()[0]
                            with self.subTest(target=target_type, source=source_type, view=view, raw=raw):
                                if len(matches) != 1:
                                    with self.assertRaises(ValueError):
                                        world._resolve_references(db, probe, 'v', target, 'test')
                                else:
                                    result = world._resolve_references(db, probe, 'v', target, 'test')
                                    self.assertEqual(result, {world._key_signature([raw]): world.encode_id('entity', [matches[0][0]])})
                            checked += 1
        self.assertEqual(checked, 686)

    def test_both_materialized_join_directions_match_original_typed_results(self):
        for target_type, source_type, transform in [
            ('TEXT', 'INTEGER', lambda n: (str(n).zfill(6), n)),
            ('TEXT COLLATE RTRIM', 'INTEGER', lambda n: (str(n) + ' ', n)),
            ('TEXT COLLATE NOCASE', 'NUMERIC', lambda n: ('KEY' + str(n), 'key' + str(n))),
            ('NUMERIC', 'TEXT', lambda n: (n, str(n).zfill(6))),
            ('REAL', 'TEXT', lambda n: (n + 0.5, str(n + 0.5))),
            ('BLOB', 'TEXT COLLATE NOCASE', lambda n: ('KEY' + str(n), 'key' + str(n))),
        ]:
            for view in (False, True):
                self.path.unlink(missing_ok=True)
                pairs = [transform(n) for n in range(129)]
                d = self.seed(target_type, source_type, [p[0] for p in pairs], [p[1] for p in pairs], view)
                with closing(world.connect(self.path)) as db:
                    source = d['relations'][0]['source']; target_source = d['entities'][0]['source']
                    target = {'source': target_source, 'keys': ['k']}
                    original = list(db.execute(f'SELECT s.id,s.v,t.k FROM {source} s LEFT JOIN {target_source} t ON t.k=s.v'))
                    def signatures(rows):
                        return Counter((r[0], world._key_signature([r[1]]), world._key_signature([r[2]])) for r in rows)
                    for reverse in (False, True):
                        with self.subTest(target=target_type, source=source_type, view=view, reverse=reverse):
                            sql, _ = world._reference_query(source, 'v', target, reverse=reverse)
                            expected = [r for r in original if not reverse or r[2] is not None]
                            self.assertEqual(signatures(db.execute(sql)), signatures(expected))

    def test_reference_instruction_budget_and_late_mismatch(self):
        ticks = []
        for count in (1500, 3000):
            self.path.unlink(missing_ok=True)
            d = self.seed('INTEGER', 'TEXT', list(range(count)), [str(n).zfill(6) for n in range(count)])
            with closing(world.connect(self.path)) as db:
                target = world.Model.__new__(world.Model)._entity(db, {'target'}, d['entities'][0])
                work = [0]
                def progress():
                    work[0] += 1
                    return work[0] > 1000
                db.set_progress_handler(progress, 1000)
                mapping = world._resolve_references(db, 'events', 'v', target, 'test')
                db.set_progress_handler(None, 0)
                self.assertEqual(len(mapping), count)
                ticks.append(work[0])
        self.assertLess(ticks[1], 3 * ticks[0], ticks)
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("UPDATE events SET v='missing' WHERE id=3000"); db.commit()
        with closing(world.connect(self.path)) as db, self.assertRaisesRegex(ValueError, 'dangling participant'):
            world.Model(db, d)

    def test_reverse_indexed_plan_preserves_column_affinity_and_cardinality(self):
        count = 1500
        d = self.seed('TEXT', 'INTEGER', [str(n).zfill(8) for n in range(count)], list(range(count)))
        with closing(world.connect(self.path)) as db:
            model = world.Model(db, d)
            self.assertEqual(world.assertion(db, model, 'event:1')['values']['participant'], 'entity:00000000')
            sql, alias = world._reference_query('events', 'v', model.entities['entity'], reverse=True)
            self.assertTrue(world._require_lookup_plan(db, sql, (), model.entities['entity'], 'test', alias, 'events'))
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("INSERT INTO target VALUES('0','ambiguous')"); db.commit()
        with closing(world.connect(self.path)) as db, self.assertRaisesRegex(ValueError, 'ambiguous participant'):
            world.Model(db, d)
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("DELETE FROM target WHERE k='0'")
            db.execute('UPDATE events SET v=999999 WHERE id=1500'); db.commit()
        with closing(world.connect(self.path)) as db, self.assertRaisesRegex(ValueError, 'dangling participant'):
            world.Model(db, d)

    def test_bounded_fallback_automatic_indexes_and_compounds(self):
        d = self.seed('INTEGER', 'TEXT', list(range(65)), [str(n).zfill(3) for n in range(65)])
        with closing(world.connect(self.path)) as db:
            target = world.Model.__new__(world.Model)._entity(db, {'target'}, d['entities'][0])
            db.execute('PRAGMA automatic_index=OFF')
            with self.assertRaisesRegex(ValueError, 'cannot plan indexed'):
                world._resolve_references(db, 'events', 'v', target, 'test')
        with closing(sqlite3.connect(self.path)) as db:
            db.executescript('DELETE FROM events WHERE id=65; DELETE FROM target WHERE k=64; CREATE VIEW compound AS SELECT k,label FROM target UNION ALL SELECT k,label FROM target WHERE 0;')
            db.commit()
        d['entities'][0]['source'] = 'compound'
        with closing(world.connect(self.path)) as db:
            db.execute('PRAGMA automatic_index=OFF')
            model = world.Model(db, d)
            self.assertEqual(world.assertion(db, model, 'event:64')['values']['participant'], 'entity:63')
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('INSERT INTO events VALUES(65,"063")'); db.commit()
        with closing(world.connect(self.path)) as db, self.assertRaisesRegex(ValueError, 'compound SELECT'):
            world.Model(db, d)


if __name__ == '__main__':
    unittest.main(verbosity=2)

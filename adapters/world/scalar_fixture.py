"""Disposable fixture for scalar-presentation regressions.

Used by the Python adapter tests and, through a small subprocess script, by
the browser regression. Everything here is synthetic: no producer database is
read or written.

`probe` holds one occurrence per distinct stored value, all mentioning the
same `item`. Its `value` column has no declared type (BLOB affinity), so
SQLite keeps each value's own storage class: NULL, the empty string, zero as
INTEGER and as REAL, negative and positive numbers, whitespace-only text,
the literal texts 'null' and 'NULL', a literal em dash, a text that looks
like the empty-string marker, and ordinary text. `memo` (TEXT) is NULL on
odd ids and the empty string on even ids, so one occurrence can carry two
different absent-looking scalars.

`probe_ref` is a referent-only relation (no scalars) over two items, so a
table of identity cells is also exercised.
"""
import sqlite3
from contextlib import closing

import server as world

# (id, stored value). The id order is the relation's key order.
PROBE_VALUES = [
    (1, None),
    (2, ''),
    (3, 0),
    (4, 0.0),
    (5, -3),
    (6, -2.5),
    (7, 7),
    (8, 3.25),
    (9, '   '),
    (10, '\t\n'),
    (11, 'null'),
    (12, 'NULL'),
    (13, '—'),
    (14, '""'),
    (15, ' padded '),
    (16, 'plain text'),
]


def build_fixture(path):
    with closing(sqlite3.connect(path)) as db:
        db.executescript('''
CREATE TABLE item(id INTEGER PRIMARY KEY, name TEXT);
INSERT INTO item VALUES (1,'Probe'),(2,'Other');
CREATE TABLE probe(id INTEGER PRIMARY KEY, item INTEGER, value, memo TEXT);
CREATE TABLE probe_ref(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER);
INSERT INTO probe_ref VALUES (1,1,2),(2,2,1);
''')
        db.executemany(
            'INSERT INTO probe VALUES(?,?,?,?)',
            [(n, 1, value, None if n % 2 else '') for n, value in PROBE_VALUES])
        db.commit()

    def scalar(name):
        return {'role': name, 'column_name': name, 'target_kind': None}

    def referent(role, kind='item'):
        return {'role': role, 'column_name': role, 'target_kind': kind}

    return world.validate_declaration({
        'version': 1,
        'world': {'id_prefix': 'scalartest'},
        'entities': [
            {'kind': 'item', 'source': 'item', 'key_columns': ['id'], 'label_column': 'name'},
        ],
        'relations': [
            {'name': 'probe', 'source': 'probe', 'key_columns': ['id'],
             'roles': [referent('item'), scalar('value'), scalar('memo')]},
            {'name': 'probe_ref', 'source': 'probe_ref', 'key_columns': ['id'],
             'roles': [referent('a'), referent('b')]},
        ],
    })

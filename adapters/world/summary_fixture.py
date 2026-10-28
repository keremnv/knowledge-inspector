"""Disposable fixture for the plain-text summary regressions.

Used through tests/disposable-world.ts. Everything here is synthetic.

`mark` (plates on one `item`) and `tie` (parallel bonds between the same two
items) each carry eight occurrences whose `value` column holds one of the
values that a one-line summary used to print identically: SQL NULL against the
text `NULL`, the empty string against the text `""`, and the literal `not
supplied`, `—` and `null`. `value` has no declared type, so SQLite keeps each
value's own storage class. Occurrence 8 stores the text `plain`; the browser
test deletes its `value` key from the API response to stand for a value the API
did not send. `memo` is the same ordinary text throughout.
"""
import sqlite3
from contextlib import closing

import server as world

VALUES = [
    (1, None),
    (2, 'NULL'),
    (3, ''),
    (4, '""'),
    (5, 'not supplied'),
    (6, '—'),
    (7, 'null'),
    (8, 'plain'),
]


def build_fixture(path):
    with closing(sqlite3.connect(path)) as db:
        db.executescript('''
CREATE TABLE item(id INTEGER PRIMARY KEY, name TEXT);
INSERT INTO item VALUES (1,'Probe'),(2,'Other');
CREATE TABLE mark(id INTEGER PRIMARY KEY, item INTEGER, value, memo TEXT);
CREATE TABLE tie(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, value, memo TEXT);
''')
        db.executemany('INSERT INTO mark VALUES(?,?,?,?)', [(n, 1, v, 'm') for n, v in VALUES])
        db.executemany('INSERT INTO tie VALUES(?,?,?,?,?)', [(n, 1, 2, v, 'm') for n, v in VALUES])
        db.commit()

    def scalar(name):
        return {'role': name, 'column_name': name, 'target_kind': None}

    def referent(role):
        return {'role': role, 'column_name': role, 'target_kind': 'item'}

    return world.validate_declaration({
        'version': 1,
        'world': {'id_prefix': 'summarytest'},
        'entities': [
            {'kind': 'item', 'source': 'item', 'key_columns': ['id'], 'label_column': 'name'},
        ],
        'relations': [
            {'name': 'mark', 'source': 'mark', 'key_columns': ['id'],
             'roles': [referent('item'), scalar('value'), scalar('memo')]},
            {'name': 'tie', 'source': 'tie', 'key_columns': ['id'],
             'roles': [referent('a'), referent('b'), scalar('value'), scalar('memo')]},
        ],
    })

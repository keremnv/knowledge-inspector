"""Disposable fixture for evidence-attribution regressions.

Used by the Python adapter tests and, through a small subprocess script, by
the browser regression. Everything here is synthetic and generic: no
producer database is read or written.

The shape is chosen to make ownership guesses fail loudly:

* `assignment` is many-to-many. Two referents (`person` as lead and helper,
  `project`) share occurrences; occurrences 1 and 2 repeat the same scalar
  values; occurrence 3 has one person in BOTH person roles.
* Scalar columns cover each declared-type family the adapter must describe
  without converting: INTEGER, REAL, NUMERIC, DECIMAL, DATETIME, TEXT, BLOB,
  an untyped column, SQL NULL, the empty string and zero. Note that SQLite
  applies NUMERIC affinity at INSERT: the text '1.50' in a DECIMAL column is
  stored (and so served) as the REAL 1.5, while 'n/a' stays TEXT.
* `review_adopted` / `review_rejected` carry occurrence states and origins at
  relation level: a state belongs to the occurrence, never to a person in it.
* `ledger` has 105 occurrences for one person with two scalars each, past the
  100-occurrence preview bound; the other person has none.
"""
import sqlite3
from contextlib import closing

import server as world

LEDGER_OCCURRENCES = 105


def build_fixture(path):
    with closing(sqlite3.connect(path)) as db:
        db.executescript('''
CREATE TABLE person(id INTEGER PRIMARY KEY, name TEXT);
INSERT INTO person VALUES (1,'Ada'),(2,'Ben'),(3,'Cy'),(8,'Yan'),(9,'Zed');
CREATE TABLE project(id INTEGER PRIMARY KEY, title TEXT);
INSERT INTO project VALUES (10,'Alpha'),(20,'Beta');
CREATE TABLE assignment(
  id INTEGER PRIMARY KEY, lead INTEGER, helper INTEGER, project INTEGER,
  hours INTEGER, rate NUMERIC(10,2), amount DECIMAL(10,2), started DATETIME,
  note TEXT, extra REAL, blobby BLOB, untyped);
INSERT INTO assignment VALUES
  (1,1,2,10, 8,0.99,'1.50','2024-01-01 00:00:00',NULL,1.0,x'0102','x'),
  (2,1,2,20, 8,0.99,'1.50','2024-01-01 00:00:00',NULL,1.0,x'0102','x'),
  (3,2,2,20, 0,1,'n/a','','',2,NULL,3);
CREATE TABLE review_adopted(id INTEGER PRIMARY KEY, person INTEGER, verdict TEXT);
INSERT INTO review_adopted VALUES (1,1,'kept');
CREATE TABLE review_rejected(id INTEGER PRIMARY KEY, person INTEGER, verdict TEXT);
INSERT INTO review_rejected VALUES (1,1,'kept');
CREATE TABLE ledger(id INTEGER PRIMARY KEY, person INTEGER, qty INTEGER, memo TEXT);
''')
        db.executemany(
            'INSERT INTO ledger VALUES(?,?,?,?)',
            [(n, 9, 0 if n == 1 else None if n == 2 else n,
              '' if n == 1 else None if n == 2 else f'memo {n}')
             for n in range(1, LEDGER_OCCURRENCES + 1)])
        db.commit()

    def scalar(name):
        return {'role': name, 'column_name': name, 'target_kind': None}

    def referent(role, kind, column=None):
        return {'role': role, 'column_name': column or role, 'target_kind': kind}

    def relation(name, roles, **extra):
        return {'name': name, 'source': name, 'key_columns': ['id'], 'roles': roles, **extra}

    return world.validate_declaration({
        'version': 1,
        'world': {'id_prefix': 'attributiontest'},
        'entities': [
            # Declared label column.
            {'kind': 'person', 'source': 'person', 'key_columns': ['id'], 'label_column': 'name'},
            # No label column declared: the adapter falls back to the key.
            {'kind': 'project', 'source': 'project', 'key_columns': ['id']},
        ],
        'relations': [
            relation('assignment', [
                referent('lead', 'person'), referent('helper', 'person'),
                referent('project', 'project'),
                *[scalar(name) for name in (
                    'hours', 'rate', 'amount', 'started', 'note', 'extra', 'blobby', 'untyped')],
            ]),
            relation('review_adopted', [referent('person', 'person'), scalar('verdict')],
                     origin='SEMANTIC', occurrence_state='ADOPTED'),
            relation('review_rejected', [referent('person', 'person'), scalar('verdict')],
                     origin='MECHANICAL', occurrence_state='REJECTED'),
            relation('ledger', [referent('person', 'person'), scalar('qty'), scalar('memo')]),
        ],
    })

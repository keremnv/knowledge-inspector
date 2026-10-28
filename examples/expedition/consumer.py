"""Answer expedition questions with plain SQLite. No Inspector imports.

This is the independence proof for the conceptual slice: everything the
graph explorer shows about determinations is queried here through ordinary
tables and SQL views. Open the database read-only, by reference.
"""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path


def connect(db_path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    return db


def adopted(db: sqlite3.Connection) -> tuple[str, list[dict]]:
    sql = """
    SELECT v.det_id, v.catalog_no, t.label AS taxon, p.name AS determiner, v.det_on
    FROM v_determination_adopted AS v
    JOIN taxon AS t ON t.taxon_id = v.taxon_id
    JOIN person AS p ON p.person_id = v.determiner_id
    ORDER BY v.det_id
    """
    return (sql, [dict(row) for row in db.execute(sql)])


def proposed(db: sqlite3.Connection) -> tuple[str, list[dict]]:
    sql = """
    SELECT v.det_id, v.catalog_no, t.label AS taxon, p.name AS determiner, v.basis
    FROM v_determination_proposed AS v
    JOIN taxon AS t ON t.taxon_id = v.taxon_id
    JOIN person AS p ON p.person_id = v.determiner_id
    ORDER BY v.det_id
    """
    return (sql, [dict(row) for row in db.execute(sql)])


def rejected(db: sqlite3.Connection) -> tuple[str, list[dict]]:
    sql = """
    SELECT v.det_id, v.catalog_no, t.label AS taxon, p.name AS determiner, v.basis
    FROM v_determination_rejected AS v
    JOIN taxon AS t ON t.taxon_id = v.taxon_id
    JOIN person AS p ON p.person_id = v.determiner_id
    ORDER BY v.det_id
    """
    return (sql, [dict(row) for row in db.execute(sql)])


def unresolvable(db: sqlite3.Connection) -> tuple[str, list[dict]]:
    sql = """
    SELECT det_id, catalog_no, asserted_name, stance
    FROM v_determination_unmatched
    ORDER BY det_id
    """
    return (sql, [dict(row) for row in db.execute(sql)])


def specimen_history(db: sqlite3.Connection, catalog_no: str) -> tuple[str, list[dict]]:
    sql = """
    SELECT d.det_id, d.asserted_name, d.stance, p.name AS determiner, d.det_on,
           t.label AS resolved_taxon
    FROM determination AS d
    JOIN person AS p ON p.person_id = d.determiner_id
    LEFT JOIN taxon_alias AS a ON a.alias = d.asserted_name
    LEFT JOIN taxon AS t ON t.taxon_id = a.taxon_id
    WHERE d.catalog_no = ?
    ORDER BY d.det_on
    """
    return (sql, [dict(row) for row in db.execute(sql, (catalog_no,))])


def collections(db: sqlite3.Connection) -> tuple[str, list[dict]]:
    sql = """
    SELECT s.catalog_no, t.name AS site, p.name AS collector, s.collected_on
    FROM specimen AS s
    JOIN site AS t ON t.site_id = s.site_id
    JOIN person AS p ON p.person_id = s.collector_id
    ORDER BY s.catalog_no
    """
    return (sql, [dict(row) for row in db.execute(sql)])


QUESTIONS = [
    ("Which adopted taxon claims hold?", adopted, ()),
    ("Which proposals are still open?", proposed, ()),
    ("Which determinations were considered and rejected?", rejected, ()),
    ("Which determination records resolve to no known taxon?", unresolvable, ()),
    ("What is the determination history of specimen K-118?", specimen_history, ("K-118",)),
    ("Who collected what, where?", collections, ()),
]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True, help="expedition database file")
    args = parser.parse_args()
    db = connect(args.db)
    try:
        for question, ask, argv in QUESTIONS:
            sql, rows = ask(db, *argv)
            print(f"Q: {question}")
            print("SQL:", " ".join(sql.split()))
            for row in rows:
                print("  " + ", ".join(f"{key}={row[key]}" for key in row))
            if not rows:
                print("  (no rows)")
            print()
    finally:
        db.close()


if __name__ == "__main__":
    main()

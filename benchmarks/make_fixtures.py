#!/usr/bin/env python3
"""Deterministic, disposable SQLite fixtures for the performance benchmarks.

    python3 benchmarks/make_fixtures.py OUTPUT_DIR

Two families separate the workload dimensions the benchmarks report:

* ``hub-N.sqlite``  small database, one ``parent`` row referenced by N ``child``
  rows (controlled relationship fan-out), plus N unrelated ``item`` rows.
* ``size-M.sqlite`` the same small relational core plus an ``event`` table of M
  rows no benchmarked interaction touches (database size alone).

Every value is a pure function of its row number: no randomness, so the files
are reproducible bit for bit on one SQLite version. Existing files are kept.
"""
from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path

HUB_SIZES = (50, 200, 500)
DB_ROWS = (10_000, 100_000, 1_000_000)
BATCH = 50_000


def core(db: sqlite3.Connection, fanout: int) -> None:
    db.executescript("""
      CREATE TABLE parent(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id), label TEXT NOT NULL);
      CREATE TABLE item(id INTEGER PRIMARY KEY, label TEXT NOT NULL);
    """)
    db.executemany("INSERT INTO parent VALUES (?,?)", [(i, f"Parent {i}") for i in range(1, 11)])
    db.executemany("INSERT INTO child VALUES (?,?,?)", [(i, 1, f"Child {i}") for i in range(1, fanout + 1)])
    db.executemany("INSERT INTO item VALUES (?,?)", [(i, f"Item {i}") for i in range(1, fanout + 1)])


def event_rows(start: int, stop: int):
    for i in range(start, stop):
        yield (i, f"event-{i:08d}", (i * 7919) % 100_003, f"payload {i:08d} " + "x" * 48)


def build(path: Path, fanout: int, events: int = 0) -> None:
    path.unlink(missing_ok=True)
    db = sqlite3.connect(path)
    try:
        core(db, fanout)
        if events:
            db.execute("CREATE TABLE event(id INTEGER PRIMARY KEY, name TEXT NOT NULL, bucket INTEGER NOT NULL, payload TEXT NOT NULL)")
            for start in range(1, events + 1, BATCH):
                db.executemany("INSERT INTO event VALUES (?,?,?,?)", event_rows(start, min(start + BATCH, events + 1)))
        db.commit()
        db.execute("VACUUM")
    finally:
        db.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output")
    out = Path(parser.parse_args().output)
    out.mkdir(parents=True, exist_ok=True)
    for n in HUB_SIZES:
        if not (out / f"hub-{n}.sqlite").exists():
            build(out / f"hub-{n}.sqlite", n)
    for m in DB_ROWS:
        if not (out / f"size-{m}.sqlite").exists():
            build(out / f"size-{m}.sqlite", 50, m)
    for path in sorted(out.glob("*.sqlite")):
        print(f"{path.name}\t{path.stat().st_size}")


if __name__ == "__main__":
    main()

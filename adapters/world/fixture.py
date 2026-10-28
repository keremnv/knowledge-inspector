"""Synthetic fixture for the generic World adapter: flows plus ordered hops.

Two flows, three hops — the same shape as the Run 000 acceptance case
(data_flow / flow_hop) at a size the backend tests can rebuild and mutate
freely. No ki_* tables: the generic adapter takes its declaration from the
reader, never from the file.
"""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path


def build(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    db = sqlite3.connect(path)
    db.executescript(
        """
        PRAGMA foreign_keys=ON;
        CREATE TABLE flow (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL
        );
        CREATE TABLE hop (
          flow_id TEXT NOT NULL REFERENCES flow (id),
          seq INTEGER NOT NULL,
          who TEXT NOT NULL,
          what TEXT NOT NULL,
          PRIMARY KEY (flow_id, seq)
        );
        CREATE TABLE pair (
          scope TEXT NOT NULL,
          code TEXT NOT NULL,
          label TEXT,
          PRIMARY KEY (scope, code)
        );
        INSERT INTO flow VALUES ('F1', 'first'), ('F2', 'second');
        INSERT INTO hop VALUES
          ('F1', 1, 'browser', 'loads'),
          ('F1', 2, 'proxy', 'forwards'),
          ('F2', 1, 'adapter', 'windows');
        INSERT INTO pair VALUES ('A', '1', 'a-one'), ('B', '1', 'b-one');
        """
    )
    db.commit()
    db.close()
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    print(build(args.output), flush=True)


if __name__ == "__main__":
    main()

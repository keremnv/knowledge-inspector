"""Adversarial structural fixture: keys, keyless duplicates, composite FKs, a view."""

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
        CREATE TABLE targets (
          scope TEXT NOT NULL, code TEXT NOT NULL, label TEXT,
          PRIMARY KEY (scope, code)
        ) WITHOUT ROWID;
        CREATE TABLE links (
          id TEXT PRIMARY KEY,
          target_scope TEXT NOT NULL, target_code TEXT NOT NULL,
          FOREIGN KEY (target_scope, target_code) REFERENCES targets (scope, code)
        );
        CREATE TABLE events (payload TEXT);
        CREATE TABLE loose (scope TEXT, code TEXT, payload TEXT, PRIMARY KEY (scope, code));
        CREATE VIEW v_link_detail AS
          SELECT links.id AS link_id, targets.scope, targets.code, targets.label
          FROM links JOIN targets
            ON targets.scope = links.target_scope AND targets.code = links.target_code;
        INSERT INTO targets VALUES ('A', '1', 'first'), ('B', '1', 'second');
        INSERT INTO links VALUES ('l1', 'A', '1');
        INSERT INTO events VALUES ('repeat'), ('repeat');
        INSERT INTO loose VALUES (NULL, NULL, 'x'), (NULL, NULL, 'y');
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

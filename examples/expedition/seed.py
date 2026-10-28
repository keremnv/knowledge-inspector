"""Build the expedition fixture: field records plus a SQL-backed interpretation.

A small herbarium expedition. Collectors gather specimens at sites; later,
botanists determine them — asserting, in their own words, which taxon each
specimen belongs to, and whether that claim is proposed or adopted.

Raw foreign keys carry the collection bookkeeping. They cannot carry the
interpretation: a determination's ``asserted_name`` is free text (``S.
globulifera``, a misspelled ``Maesopsis emini``), and only the ``taxon_alias``
mapping plus the ``v_determination*`` views resolve those spellings to taxa.
That resolution — which taxon a determination concerns — is the conceptual
model, and it is ordinary SQL: any agent can query it without this repo.

The ``ki_*`` tables are an experimental declaration candidate (see README):
the minimum a generic Inspector needs to discover identities, relation
instances, and participant roles over tables and views.
"""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path

SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE site (
  site_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  region TEXT NOT NULL
);
CREATE TABLE person (
  person_id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE taxon (
  taxon_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  rank TEXT NOT NULL
);
CREATE TABLE taxon_alias (
  alias TEXT PRIMARY KEY,
  taxon_id TEXT NOT NULL REFERENCES taxon (taxon_id)
);
CREATE TABLE specimen (
  catalog_no TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES site (site_id),
  collector_id TEXT NOT NULL REFERENCES person (person_id),
  collected_on TEXT NOT NULL,
  preparation TEXT NOT NULL
);
CREATE TABLE determination (
  det_id INTEGER PRIMARY KEY,
  catalog_no TEXT NOT NULL REFERENCES specimen (catalog_no),
  asserted_name TEXT NOT NULL,
  determiner_id TEXT NOT NULL REFERENCES person (person_id),
  det_on TEXT NOT NULL,
  stance TEXT NOT NULL CHECK (stance IN ('proposed', 'adopted', 'rejected')),
  basis TEXT
);

CREATE VIEW v_determination AS
SELECT d.det_id, d.catalog_no, t.taxon_id, d.determiner_id,
       d.det_on, d.stance, d.basis
FROM determination AS d
JOIN taxon_alias AS a ON a.alias = d.asserted_name
JOIN taxon AS t ON t.taxon_id = a.taxon_id;
CREATE VIEW v_determination_adopted AS
SELECT det_id, catalog_no, taxon_id, determiner_id, det_on, basis
FROM v_determination WHERE stance = 'adopted';
CREATE VIEW v_determination_proposed AS
SELECT det_id, catalog_no, taxon_id, determiner_id, det_on, basis
FROM v_determination WHERE stance = 'proposed';
CREATE VIEW v_determination_rejected AS
SELECT det_id, catalog_no, taxon_id, determiner_id, det_on, basis
FROM v_determination WHERE stance = 'rejected';
CREATE VIEW v_determination_unmatched AS
SELECT d.det_id, d.catalog_no, d.asserted_name, d.determiner_id,
       d.det_on, d.stance, d.basis
FROM determination AS d
LEFT JOIN taxon_alias AS a ON a.alias = d.asserted_name
WHERE a.alias IS NULL;

CREATE TABLE ki_entity (
  kind TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  key_columns TEXT NOT NULL,
  label_column TEXT
);
CREATE TABLE ki_relation (
  name TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  key_columns TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'SEMANTIC',
  occurrence_state TEXT,
  description TEXT
);
CREATE TABLE ki_role (
  relation TEXT NOT NULL REFERENCES ki_relation (name),
  role TEXT NOT NULL,
  column_name TEXT NOT NULL,
  target_kind TEXT REFERENCES ki_entity (kind),
  PRIMARY KEY (relation, role)
);
"""

DATA = """
INSERT INTO site VALUES
  ('S-1', 'Bwindi understory plot 4', 'Albertine Rift'),
  ('S-2', 'Kibale forest edge', 'Albertine Rift');
INSERT INTO person VALUES
  ('P-7', 'A. Okello'),
  ('P-9', 'M. Lindqvist');
INSERT INTO taxon VALUES
  ('T-042', 'Symphonia globulifera', 'species'),
  ('T-117', 'Maesopsis eminii', 'species');
INSERT INTO taxon_alias VALUES
  ('Symphonia globulifera', 'T-042'),
  ('S. globulifera', 'T-042'),
  ('Maesopsis eminii', 'T-117'),
  ('Maesopsis emini', 'T-117');
INSERT INTO specimen VALUES
  ('K-118', 'S-1', 'P-7', '2024-03-02', 'silica'),
  ('K-119', 'S-1', 'P-9', '2024-03-03', 'sheet'),
  ('K-201', 'S-2', 'P-7', '2024-03-09', 'spirit');
INSERT INTO determination
  (det_id, catalog_no, asserted_name, determiner_id, det_on, stance, basis)
VALUES
  (1, 'K-118', 'S. globulifera', 'P-9', '2024-04-01', 'adopted', 'floral morphology'),
  (2, 'K-118', 'Maesopsis emini', 'P-7', '2024-03-20', 'proposed', 'leaf flush'),
  (3, 'K-119', 'Symphonia globulifera', 'P-9', '2024-04-02', 'adopted', 'fruit'),
  (4, 'K-201', 'Chrysophyllum sp.', 'P-9', '2024-04-05', 'proposed', 'bark slash'),
  (5, 'K-201', 'Maesopsis eminii', 'P-7', '2024-05-01', 'rejected', 're-examined sheet');

INSERT INTO ki_entity (kind, source, key_columns, label_column) VALUES
  ('specimen', 'specimen', 'catalog_no', 'catalog_no'),
  ('taxon', 'taxon', 'taxon_id', 'label'),
  ('person', 'person', 'person_id', 'name'),
  ('site', 'site', 'site_id', 'name');
INSERT INTO ki_relation (name, source, key_columns, origin, occurrence_state, description) VALUES
  ('determination', 'v_determination_adopted', 'det_id', 'SEMANTIC', 'ADOPTED',
   'Adopted taxon claims: free-text names resolved to taxa through the alias map.'),
  ('determination_proposed', 'v_determination_proposed', 'det_id', 'SEMANTIC', 'PROPOSED',
   'Proposed taxon claims awaiting a decision. Not adopted.'),
  ('determination_rejected', 'v_determination_rejected', 'det_id', 'SEMANTIC', 'REJECTED',
   'Recorded rejections: taxon claims considered and decided against. A negative decision, neither adopted nor open.'),
  ('collection', 'specimen', 'catalog_no', 'SEMANTIC', 'RECORDED',
   'Recorded collection events: which specimen came from which site, gathered by whom.');
INSERT INTO ki_role (relation, role, column_name, target_kind) VALUES
  ('determination', 'specimen', 'catalog_no', 'specimen'),
  ('determination', 'taxon', 'taxon_id', 'taxon'),
  ('determination', 'determiner', 'determiner_id', 'person'),
  ('determination', 'det_on', 'det_on', NULL),
  ('determination', 'basis', 'basis', NULL),
  ('determination_proposed', 'specimen', 'catalog_no', 'specimen'),
  ('determination_proposed', 'taxon', 'taxon_id', 'taxon'),
  ('determination_proposed', 'determiner', 'determiner_id', 'person'),
  ('determination_proposed', 'det_on', 'det_on', NULL),
  ('determination_proposed', 'basis', 'basis', NULL),
  ('determination_rejected', 'specimen', 'catalog_no', 'specimen'),
  ('determination_rejected', 'taxon', 'taxon_id', 'taxon'),
  ('determination_rejected', 'determiner', 'determiner_id', 'person'),
  ('determination_rejected', 'det_on', 'det_on', NULL),
  ('determination_rejected', 'basis', 'basis', NULL),
  ('collection', 'specimen', 'catalog_no', 'specimen'),
  ('collection', 'site', 'site_id', 'site'),
  ('collection', 'collector', 'collector_id', 'person'),
  ('collection', 'collected_on', 'collected_on', NULL);
"""


def build(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    db = sqlite3.connect(path)
    try:
        db.executescript(SCHEMA)
        db.executescript(DATA)
        db.commit()
    finally:
        db.close()
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "output",
        nargs="?",
        type=Path,
        default=Path(__file__).resolve().parent / "expedition.sqlite",
        help="where to write the fixture database",
    )
    args = parser.parse_args()
    print(build(args.output), flush=True)


if __name__ == "__main__":
    main()

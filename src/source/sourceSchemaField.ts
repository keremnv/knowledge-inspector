/**
 * The schema view (O8.12): the capture's tables and declared foreign keys,
 * drawn with the same canonical marks as the record canvas.
 *
 * A table is a disc and each declaration whose parent table resolves is a
 * connection from the child table to the parent, named by its columns, as a
 * record's reference is named. Nothing is inferred: declarations are what the
 * file records, read from the schema, and an unresolved parent draws nothing.
 * The tables stand on World's schema ring (O12): alphabetical, the first at
 * twelve o'clock, so a schema never rearranges itself between visits and each
 * table is always where it was. Display state, never a record or an observation.
 */
import type { SourceCatalogue, SourceFKObservation } from "../api/source";
import { ringPositions } from "../world/schemaRing";
import { emptySourceField, type PlacedReference, type SourceField } from "./sourceField";

type Relation = SourceCatalogue["relations"][number];

export const schemaElement = (table: string) => `table:${table}`;

export function sourceSchemaField(context: string, relations: Relation[]): SourceField {
  const field = emptySourceField(context);
  const tables = relations.map((relation) => relation.name);
  const present = new Set(tables);
  const ring = ringPositions([...tables].sort());
  const positions = new Map(tables.map((table) => [schemaElement(table), ring.get(table)!]));
  const references: PlacedReference[] = [];
  for (const relation of relations) {
    for (const fk of relation.foreign_keys ?? []) {
      if (!fk.parent_table || !present.has(fk.parent_table)) continue;
      // Only what the canonical frame reads to draw and name a connection:
      // its identity and the declaration. Not an observation of any row.
      const declared = { observation_id: fk.declaration_id, declaration: fk } as unknown as SourceFKObservation;
      references.push({ elementId: `declaration:${fk.declaration_id}`, observation: declared,
        child: schemaElement(relation.name), parent: schemaElement(fk.parent_table) });
    }
  }
  return { ...field, positions, references, sequence: 1,
    records: tables.map((table) => ({ elementId: schemaElement(table), recordId: schemaElement(table), table, key: [] })) };
}

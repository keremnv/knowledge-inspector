import { test, expect } from "@playwright/test";
import { schemaElement, sourceSchemaField } from "../src/source/sourceSchemaField";
import { sourceContextKey } from "../src/api/sourceClient";
import { context, identity, observation, record } from "./source-reference-fixtures";

const key = sourceContextKey(context);
const declared = (child: string, parent: string, number = 0) =>
  ({ ...observation(record(child, "1"), record(parent, "1"), number).declaration });
const relation = (name: string, foreign_keys: ReturnType<typeof declared>[] = []) => ({ name, kind: "table" as const, identity,
  read_status: "available" as const, reason: null, row_count: null, row_count_status: "not_computed" as const, foreign_keys });

test("the schema field is every table and each declaration whose parent table is in the capture", () => {
  const missing = { ...declared("Child", "Gone", 2), parent_table: "Gone" };
  const unresolved = { ...declared("Child", "Parent", 3), parent_table: null };
  const field = sourceSchemaField(key, [
    relation("Parent"), relation("Child", [declared("Child", "Parent"), declared("Child", "Child", 1), missing, unresolved]), relation("Lone"),
  ]);
  expect(field.records.map((r) => [r.elementId, r.table])).toEqual([["table:Parent", "Parent"], ["table:Child", "Child"], ["table:Lone", "Lone"]]);
  // Declared, not inferred: nothing for a parent outside the capture or unresolved; a table may name itself.
  expect(field.references.map((r) => [r.child, r.parent])).toEqual([["table:Child", "table:Parent"], ["table:Child", "table:Child"]]);
  expect(field.references[0].observation.declaration).toEqual(declared("Child", "Parent"));
  // World's schema ring (O12): one radius, alphabetical clockwise from twelve o'clock.
  const radii = field.records.map((r) => Math.hypot(field.positions.get(r.elementId)!.x, field.positions.get(r.elementId)!.y));
  expect(new Set(radii.map(Math.round)).size).toBe(1);
  expect(field.positions.get("table:Child")).toEqual({ x: 0, y: -Math.round(radii[0]) });
  // Every table stands somewhere finite, none on another.
  const at = field.records.map((r) => field.positions.get(r.elementId)!);
  expect(at.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  for (const [i, a] of at.entries()) for (const b of at.slice(i + 1)) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(90);
  expect(schemaElement("Parent")).toBe("table:Parent");
  // The same schema lays out the same way.
  expect([...sourceSchemaField(key, [relation("Parent"), relation("Child", [declared("Child", "Parent")]), relation("Lone")]).positions])
    .toEqual([...sourceSchemaField(key, [relation("Parent"), relation("Child", [declared("Child", "Parent")]), relation("Lone")]).positions]);
});

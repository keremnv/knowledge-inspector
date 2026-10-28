import { test, expect } from "@playwright/test";
import { adoptSourceRecords, emptySourceField, expandSourceGroup, expansionKey, expansionShown, hideSourceReference, moveSourceRecords,
  placeSourceRecord, placeSourceRecords, retractSourceExpansion, showSourceReference } from "../src/source/sourceField";
import { sourceContextKey, sourceGrounded } from "../src/api/sourceClient";
import { child, secondChild, parent, context, observation, record } from "./source-reference-fixtures";

const key = sourceContextKey(context), grounded = (r: typeof child) => sourceGrounded(context, r.grounding);
const third = record("Child", "3");
const members = [child, secondChild, third].map((r) => ({ record: r, observation: observation(r, parent, 0) }));
const group = expansionKey(parent.record_id, members[0].observation.declaration.declaration_id);
const ids = (field: ReturnType<typeof emptySourceField>) => field.records.map((r) => r.recordId);

test("placing many keeps standing marks where they are and places each new record once", () => {
  const standing = placeSourceRecord(emptySourceField(key), key, child, grounded);
  const moved = moveSourceRecords(standing.field, new Map([[standing.elementId, { x: 400, y: -300 }]]), standing.elementId);
  const many = placeSourceRecords(moved, key, [child, secondChild, third, secondChild], grounded);
  expect(ids(many.field)).toEqual([child.record_id, secondChild.record_id, third.record_id]);
  expect(many.elementIds).toEqual([standing.elementId, "record-2", "record-3", "record-2"]);
  expect(many.placed).toEqual(["record-2", "record-3"]);
  expect(many.field.positions.get(standing.elementId)).toEqual({ x: 400, y: -300 });
  expect(placeSourceRecords(many.field, key, [child, third], grounded).field).toBe(many.field);
  // One record from another capture places none.
  const foreign = { ...third, grounding: { ...third.grounding, generation: "other" } };
  expect(() => placeSourceRecords(moved, key, [secondChild, foreign], grounded)).toThrow();
});

test("an expansion places its parent and members, draws each connection, and notes only what it introduced", () => {
  const before = showSourceReference(placeSourceRecord(emptySourceField(key), key, child, grounded).field, key,
    observation(child, parent, 0), child, parent, grounded);
  const expanded = expandSourceGroup(before.field, key, group, parent, members, grounded);
  expect(ids(expanded)).toEqual([child.record_id, parent.record_id, secondChild.record_id, third.record_id]);
  expect(expanded.references).toHaveLength(3);
  const note = expanded.expansions.get(group)!;
  // The connection shown individually before is not the expansion's to take back.
  expect(note.references).not.toContain(before.elementId);
  expect(note.references).toHaveLength(2);
  expect(note.introduced.map((id) => expanded.records.find((r) => r.elementId === id)!.recordId)).toEqual([secondChild.record_id, third.record_id]);
  expect(expansionShown(expanded, group)).toBe(true);
  // A second page for the same group adds to the same note.
  const fourth = record("Child", "4");
  const more = expandSourceGroup(expanded, key, group, parent, [{ record: fourth, observation: observation(fourth, parent, 0) }], grounded);
  expect(more.expansions.get(group)!.introduced).toHaveLength(3);
  // Bad evidence places nothing.
  expect(() => expandSourceGroup(before.field, key, group, parent, [{ record: secondChild, observation: { ...observation(secondChild, parent, 0), status: "dangling" } }], grounded)).toThrow();
});

test("taking an expansion back removes only what it introduced and nobody opened or still joins", () => {
  const standing = placeSourceRecord(emptySourceField(key), key, child, grounded).field;
  const expanded = expandSourceGroup(standing, key, group, parent, members, grounded);
  const markOf = (field: typeof expanded, r: typeof child) => field.records.find((x) => x.recordId === r.record_id)!.elementId;
  // secondChild opened individually afterwards; third also joined to child by another shown connection.
  const adopted = adoptSourceRecords(expanded, [markOf(expanded, secondChild)]);
  const joined = showSourceReference(adopted, key, observation(third, child, 1), third, child, grounded).field;
  const back = retractSourceExpansion(joined, group);
  expect(ids(back)).toEqual([child.record_id, parent.record_id, secondChild.record_id, third.record_id]);
  expect(back.references.map((r) => r.observation.observation_id)).toEqual([observation(third, child, 1).observation_id]);
  expect(back.expansions.has(group)).toBe(false);
  // Without either, the introduced members leave; the parent and the record placed before stay.
  const plain = retractSourceExpansion(expanded, group);
  expect(ids(plain)).toEqual([child.record_id, parent.record_id]);
  expect(plain.references).toEqual([]);
  // Hiding all its connections leaves the note, but nothing shown.
  const hidden = expanded.expansions.get(group)!.references.reduce((f, id) => hideSourceReference(f, id), expanded);
  expect(expansionShown(hidden, group)).toBe(false);
  expect(retractSourceExpansion(plain, group)).toBe(plain);
});

import { test, expect } from "@playwright/test";
import { emptySourceField, placeSourceRecord, showSourceReference, hideSourceReference, removeSourceRecord, moveSourceRecords } from "../src/source/sourceField";
import { sourceContextKey, sourceGrounded } from "../src/api/sourceClient";
import { child, secondChild, parent, context, observation } from "./source-reference-fixtures";
const key = sourceContextKey(context), grounded = (r: typeof child) => sourceGrounded(context, r.grounding);
const empty = () => emptySourceField(key);
const show = (field = empty(), c = child, p = parent, number = 0) => showSourceReference(field, key, observation(c, p, number), c, p, grounded);

const ids = (field: { records: { recordId: string }[] }) => field.records.map((r) => r.recordId);
const mark = (field: ReturnType<typeof empty>, record = parent) => field.records.find((r) => r.recordId === record.record_id)!.elementId;

test("hiding a connection hides only it: shared and parallel endpoints stay where they stand", () => {
  const a = show(), b = show(a.field, secondChild), parallel = show(b.field, secondChild, parent, 1);
  expect(ids(parallel.field)).toEqual([child.record_id, parent.record_id, secondChild.record_id]);
  expect(parallel.field.references).toHaveLength(3);
  expect(show(parallel.field, secondChild, parent, 1).field).toBe(parallel.field);
  const withoutA = hideSourceReference(parallel.field, a.elementId);
  expect(ids(withoutA)).toEqual(ids(parallel.field));
  expect(withoutA.references.map((r) => r.elementId)).toEqual([b.elementId, parallel.elementId]);
  expect(withoutA.positions).toEqual(parallel.field.positions); expect(withoutA.depth).toEqual(parallel.field.depth);
  const none = hideSourceReference(hideSourceReference(withoutA, b.elementId), parallel.elementId);
  expect(none.references).toEqual([]);
  expect(none.records).toEqual(parallel.field.records); expect(none.positions).toEqual(parallel.field.positions);
  // Hiding is display only: the same observation shows again between the same marks.
  const again = show(none);
  expect(again.field.records).toBe(none.records); expect(again.field.positions).toEqual(none.positions);
  expect(again.field.references[0].observation).toEqual(observation());
  expect([again.field.references[0].child, again.field.references[0].parent]).toEqual([mark(none, child), mark(none)]);
  expect(again.elementId).not.toBe(a.elementId);
  expect(hideSourceReference(none, a.elementId)).toBe(none);
});

test("removing a record takes it and its incident connections, and no other record", () => {
  const a = show(), b = show(a.field, secondChild), parallel = show(b.field, secondChild, parent, 1);
  const withoutParent = removeSourceRecord(parallel.field, mark(parallel.field));
  expect(ids(withoutParent)).toEqual([child.record_id, secondChild.record_id]);
  expect(withoutParent.references).toEqual([]);
  expect([...withoutParent.positions.keys()]).toEqual([mark(parallel.field, child), mark(parallel.field, secondChild)]);
  for (const id of withoutParent.positions.keys()) expect(withoutParent.positions.get(id)).toEqual(parallel.field.positions.get(id));
  const withoutChild = removeSourceRecord(parallel.field, mark(parallel.field, child));
  expect(ids(withoutChild)).toEqual([parent.record_id, secondChild.record_id]);
  expect(withoutChild.references.map((r) => r.elementId)).toEqual([b.elementId, parallel.elementId]);
  const empty_ = removeSourceRecord(removeSourceRecord(withoutChild, mark(withoutChild)), mark(withoutChild, secondChild));
  expect(empty_.records).toEqual([]); expect(empty_.references).toEqual([]);
  expect(empty_.positions.size).toBe(0); expect(empty_.depth.size).toBe(0);
  expect(removeSourceRecord(empty_, a.elementId)).toBe(empty_);
});

test("previously visited endpoints keep their mark, position and depth through show, hide and removal", () => {
  const visited = placeSourceRecord(empty(), key, parent, grounded);
  const moved = moveSourceRecords(visited.field, new Map([[visited.elementId, { x: -640, y: 320 }]]), visited.elementId);
  const shown = show(moved);
  expect(mark(shown.field)).toBe(visited.elementId);
  expect(shown.field.positions.get(visited.elementId)).toEqual({ x: -640, y: 320 });
  expect(shown.field.depth).toEqual(moved.depth);
  const hidden = hideSourceReference(shown.field, shown.elementId);
  expect(ids(hidden)).toEqual([parent.record_id, child.record_id]);
  expect(hidden.positions.get(visited.elementId)).toEqual({ x: -640, y: 320 }); expect(hidden.depth).toEqual(moved.depth);
  // A record reached only through the connection stands just the same.
  const childMark = mark(hidden, child);
  expect(removeSourceRecord(hidden, childMark).records.map((r) => r.elementId)).toEqual([visited.elementId]);
  expect(ids(removeSourceRecord(shown.field, visited.elementId))).toEqual([child.record_id]);
});

test("showing or reopening a standing record never duplicates or moves it, and removed ids are never reused", () => {
  const placed = placeSourceRecord(empty(), key, child, grounded);
  const repeat = placeSourceRecord(placed.field, key, child, grounded);
  expect(repeat.field).toBe(placed.field); expect(repeat.elementId).toBe(placed.elementId);
  const both = placeSourceRecord(placed.field, key, parent, grounded).field;
  const connected = show(both);
  expect(connected.field.records).toBe(both.records); expect(connected.field.positions).toBe(both.positions);
  expect(placeSourceRecord(connected.field, key, parent, grounded).field).toBe(connected.field);
  const removed = removeSourceRecord(connected.field, mark(connected.field));
  const returned = placeSourceRecord(removed, key, parent, grounded);
  expect(returned.elementId).not.toBe(mark(connected.field));
  expect(returned.field.positions.get(placed.elementId)).toEqual(connected.field.positions.get(placed.elementId));
  expect(returned.field.references).toEqual([]);
});

test("new endpoints anchor at the actual dragged record and all standing positions/depth remain fixed", () => {
  const explicit = placeSourceRecord(empty(), key, child, grounded);
  const moved = moveSourceRecords(explicit.field, new Map([[explicit.elementId, { x: 1800, y: -1200 }]]), explicit.elementId);
  const expanded = show(moved).field;
  expect(expanded.positions.get(explicit.elementId)).toEqual({ x: 1800, y: -1200 });
  expect(expanded.depth).toEqual(moved.depth);
  const at = expanded.positions.get(expanded.records.find((r) => r.recordId === parent.record_id)!.elementId)!;
  expect(Math.hypot(at.x - 1800, at.y + 1200)).toBeLessThan(250);
  expect(show(moved).field).toEqual(expanded);
});

test("self references and cycles never recurse or duplicate records", () => {
  const self = show(empty(), child, child, 2);
  expect(self.field.records).toHaveLength(1);
  expect(self.field.references[0].child).toBe(self.field.references[0].parent);
  const forward = show(self.field), cycle = show(forward.field, parent, child);
  expect(cycle.field.records).toHaveLength(2); expect(cycle.field.references).toHaveLength(3);
  expect(hideSourceReference(self.field, self.elementId).records).toEqual(self.field.records);
  const removed = removeSourceRecord(cycle.field, self.field.records[0].elementId);
  expect(ids(removed)).toEqual([parent.record_id]); expect(removed.references).toEqual([]);
});

for (const status of ["resolved_unaddressable", "null_reference", "dangling", "ambiguous", "invalid_declaration", "unsupported", "budget_exceeded"] as const) {
  test(`${status} can never contribute endpoints or a filament`, () => {
    const field = empty();
    expect(() => showSourceReference(field, key, { ...observation(), status }, child, parent, grounded)).toThrow();
    expect(field.records).toEqual([]); expect(field.references).toEqual([]);
  });
}
for (const corruption of ["context", "child", "parent", "grounding", "declaration", "identity"] as const) {
  test(`placement refuses mismatched ${corruption}`, () => {
    const o = observation();
    if (corruption === "child") o.child_record_id = "wrong";
    if (corruption === "parent") o.parent!.record_id = "wrong";
    if (corruption === "grounding") o.grounding = { ...o.grounding, generation: "wrong" };
    if (corruption === "declaration") o.declaration.parent_table = "wrong";
    if (corruption === "identity") o.parent!.identity = { ...o.parent!.identity, status: "unsupported" };
    expect(() => showSourceReference(empty(), corruption === "context" ? "wrong" : key, o, child, parent, grounded)).toThrow();
  });
}

test("a missing child anchors at an existing parent and a reused observation ID cannot change its target", () => {
  const standingParent = placeSourceRecord(empty(), key, parent, grounded);
  const moved = moveSourceRecords(standingParent.field, new Map([[standingParent.elementId, { x: -2000, y: 900 }]]), standingParent.elementId);
  const connected = show(moved);
  expect(connected.field.positions.get(standingParent.elementId)).toEqual({ x: -2000, y: 900 });
  const childMark = connected.field.records.find((r) => r.recordId === child.record_id)!;
  const at = connected.field.positions.get(childMark.elementId)!;
  expect(Math.hypot(at.x + 2000, at.y - 900)).toBeLessThan(250);
  expect(() => show(connected.field, child, child)).toThrow(/cannot change/);
});

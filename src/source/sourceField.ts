import type { SourceCell, SourceRecord, SourceFKObservation } from "../api/source";
import { restackDepths } from "../world/fieldDepth";
import { DISC_BODY, ringSlot } from "../world/fieldPlacement";
import { relax } from "../world/relax";
import type { Point } from "../world/workingSet";
import { sourceValueText } from "./sourceValueText";

/** One verified source record on the field. It stands on its own: no displayed
 * connection holds it there, and hiding one never takes it away. */
export type PlacedRecord = {
  /** Renderer element id: local to this field, never a source identity, and
   * never reused within a field. */
  elementId: string;
  /** The server-minted handle the record was read and verified under. */
  recordId: string;
  table: string;
  key: SourceCell[];
};

/**
 * The captured-source field: which verified records are placed, where they
 * stand, and which is in front.
 *
 * Source-owned display state, scoped to one complete source context. It is not
 * a World working set: there are no referents or assertions here,
 * only explicit record placements and per-observation structural connections.
 * Nothing in it is written to the producer or the service. Tab-scoped memory
 * restores the arrangement on refresh only after re-reading its evidence (O8.8).
 *
 * Records and connections are independent memberships. A connection is drawn
 * between two records on the field; it never owns them. Only a group
 * expansion keeps a note, beside the records, of the element ids it
 * introduced, so that taking it back can take those back. Ids are never
 * reused, so that note cannot match a record removed and placed again.
 */
export type PlacedReference = {
  elementId: string;
  observation: SourceFKObservation;
  child: string;
  parent: string;
};
export type SourceField = {
  context: string;
  records: PlacedRecord[];
  references: PlacedReference[];
  positions: Map<string, Point>;
  depth: Map<string, number>;
  /** Next renderer element number; never reused within a field. */
  sequence: number;
  /** Group expansions standing on the field, by `expansionKey` (O8.9). */
  expansions: ReadonlyMap<string, SourceExpansion>;
};
/**
 * What one group expansion put on the field: the connections it drew, and
 * the records it introduced that nobody has opened individually since.
 */
export type SourceExpansion = { references: string[]; introduced: string[] };

export function emptySourceField(context: string): SourceField {
  return { context, records: [], references: [], positions: new Map(), depth: new Map(), sequence: 1, expansions: new Map() };
}

/** One group: the records referencing `parent` through `declaration`. */
export function expansionKey(parent: string, declaration: string): string {
  return JSON.stringify([parent, declaration]);
}

export function placedRecord(field: SourceField, recordId: string | null | undefined): PlacedRecord | null {
  return recordId ? field.records.find((record) => record.recordId === recordId) ?? null : null;
}

/**
 * Place one verified record, or answer the mark it already has.
 *
 * Idempotent by handle: showing a placed record again adds nothing and moves
 * nothing. Identical labels or key text never merge two handles. A record whose
 * grounding does not belong to this field's context is refused outright —
 * different captured generations cannot share a field.
 *
 * Placement is World's law, through the same calls: a free ring slot around the
 * field's origin, then one settling pass with every standing mark pinned, so
 * nothing already placed — including anything a person dragged — moves.
 */
export function placeSourceRecord(
  field: SourceField,
  context: string,
  record: SourceRecord,
  groundedIn: (record: SourceRecord) => boolean,
  anchor?: Point,
): { field: SourceField; elementId: string } {
  checkPlaceable(field, context, record, groundedIn);
  const existing = placedRecord(field, record.record_id);
  if (existing) return { field, elementId: existing.elementId };
  const elementId = `record-${field.sequence}`;
  const positions = new Map(field.positions);
  const at = positions.size
    ? ringSlot(positions, () => DISC_BODY, anchor ?? { x: 0, y: 0 }, field.records.length, 0)
    : { x: 0, y: 0 };
  positions.set(elementId, at);
  const settled = relax(
    [...positions].map(([id, point]) => ({ id, ...point, pinned: id !== elementId, radius: DISC_BODY })),
    [],
  );
  for (const [id, point] of settled) positions.set(id, point);
  return {
    elementId,
    field: {
      ...field,
      records: [...field.records, {
        elementId,
        recordId: record.record_id,
        table: record.grounding.table,
        key: record.grounding.key.map((cell) => ({ ...cell })),
      }],
      positions,
      sequence: field.sequence + 1,
    },
  };
}

function checkPlaceable(field: SourceField, context: string, record: SourceRecord, groundedIn: (record: SourceRecord) => boolean) {
  if (field.context !== context || !record.record_id || record.kind !== "source_record" ||
      record.identity.status !== "verified" || record.name !== record.grounding.table || !groundedIn(record)) {
    throw new Error("A source record can only be placed in the field of its own captured context.");
  }
}

/**
 * Place many verified records in one update: World's add-all, and the members
 * of an expansion. Each new record takes the next free ring slot round the
 * anchor, then one settling pass runs with every standing mark pinned, so
 * nothing already on the field moves. Records already placed keep their mark.
 * Every record passes the same check as `placeSourceRecord`, before anything
 * is placed: one bad record places none.
 */
export function placeSourceRecords(
  field: SourceField,
  context: string,
  records: SourceRecord[],
  groundedIn: (record: SourceRecord) => boolean,
  anchor?: Point,
): { field: SourceField; elementIds: string[]; placed: string[] } {
  for (const record of records) checkPlaceable(field, context, record, groundedIn);
  const marks = new Map(field.records.map((placed) => [placed.recordId, placed.elementId]));
  const positions = new Map(field.positions), placedRecords = [...field.records], fresh: string[] = [], elementIds: string[] = [];
  let sequence = field.sequence;
  for (const record of records) {
    const standing = marks.get(record.record_id);
    if (standing) { elementIds.push(standing); continue; }
    const elementId = `record-${sequence++}`;
    positions.set(elementId, positions.size
      ? ringSlot(positions, () => DISC_BODY, anchor ?? { x: 0, y: 0 }, placedRecords.length, 0)
      : { x: 0, y: 0 });
    placedRecords.push({ elementId, recordId: record.record_id, table: record.grounding.table,
      key: record.grounding.key.map((cell) => ({ ...cell })) });
    marks.set(record.record_id, elementId);
    fresh.push(elementId); elementIds.push(elementId);
  }
  if (!fresh.length) return { field, elementIds, placed: [] };
  const free = new Set(fresh);
  for (const [id, point] of relax([...positions].map(([id, point]) => ({ id, ...point, pinned: !free.has(id), radius: DISC_BODY })), [])) {
    positions.set(id, point);
  }
  return { field: { ...field, records: placedRecords, positions, sequence }, elementIds, placed: fresh };
}

/**
 * Show one resolved observation: its two verified records, placed if absent
 * (standing records keep their marks and positions), and the connection
 * between them. One atomic update. No traversal, inference or partial records.
 */
export function showSourceReference(field: SourceField, context: string, observation: SourceFKObservation,
  child: SourceRecord, parent: SourceRecord, groundedIn: (record: SourceRecord) => boolean):
  { field: SourceField; elementId: string } {
  checkShowable(field, context, observation, child, parent, groundedIn);
  const existing = field.references.find((item) => item.observation.observation_id === observation.observation_id);
  if (existing) {
    if (existing.observation.child_record_id !== observation.child_record_id ||
        existing.observation.declaration.declaration_id !== observation.declaration.declaration_id ||
        existing.observation.parent?.record_id !== observation.parent?.record_id) {
      throw new Error("A visible observation cannot change its recorded endpoints or declaration.");
    }
    return { field, elementId: existing.elementId };
  }
  const parentMark = placedRecord(field, parent.record_id);
  const childPlacement = placeSourceRecord(field, context, child, groundedIn,
    parentMark ? field.positions.get(parentMark.elementId) : undefined);
  const parentPlacement = placeSourceRecord(childPlacement.field, context, parent, groundedIn,
    childPlacement.field.positions.get(childPlacement.elementId));
  const elementId = `reference-${parentPlacement.field.sequence}`;
  return { elementId, field: { ...parentPlacement.field, sequence: parentPlacement.field.sequence + 1,
    references: [...parentPlacement.field.references, { elementId, observation,
      child: childPlacement.elementId, parent: parentPlacement.elementId }] } };
}

function checkShowable(field: SourceField, context: string, observation: SourceFKObservation,
  child: SourceRecord, parent: SourceRecord, groundedIn: (record: SourceRecord) => boolean) {
  if (field.context !== context || !observation.observation_id || !observation.declaration.declaration_id || observation.status !== "resolved" ||
      observation.declaration.validation.status !== "verified_declaration" ||
      child.identity.status !== "verified" || parent.identity.status !== "verified" ||
      observation.child_record_id !== child.record_id || observation.parent?.record_id !== parent.record_id ||
      observation.parent.identity.status !== "verified" || observation.parent.name !== parent.name ||
      observation.declaration.child_table !== child.name || observation.declaration.parent_table !== parent.name ||
      !groundedIn(child) || !groundedIn(parent) ||
      !Object.entries(child.grounding).every(([key, value]) =>
        JSON.stringify(observation.grounding[key as keyof typeof observation.grounding]) === JSON.stringify(value))) {
    throw new Error("Only a resolved observation between verified records in this capture can be shown.");
  }
}

/**
 * Expand one group onto the field (O8.9): the records referencing `parent`
 * through one declaration, each with its connection to it, in one update.
 *
 * Every member passes the same checks as `showSourceReference`, before
 * anything changes. The parent is placed if absent and counts as opened: the
 * person expanded from it. Members are placed round it with standing marks
 * pinned. The expansion notes the connections it drew and the members it
 * introduced, so `retractSourceExpansion` can take back exactly those; a page
 * arriving later for the same group adds to the same note.
 */
export function expandSourceGroup(field: SourceField, context: string, key: string, parent: SourceRecord,
  members: { record: SourceRecord; observation: SourceFKObservation }[], groundedIn: (record: SourceRecord) => boolean): SourceField {
  for (const { record, observation } of members) checkShowable(field, context, observation, record, parent, groundedIn);
  const anchored = placeSourceRecord(field, context, parent, groundedIn);
  const placed = placeSourceRecords(anchored.field, context, members.map((member) => member.record), groundedIn,
    anchored.field.positions.get(anchored.elementId));
  let next = placed.field;
  const drawn: string[] = [];
  members.forEach(({ observation }, index) => {
    if (next.references.some((item) => item.observation.observation_id === observation.observation_id)) return;
    const elementId = `reference-${next.sequence}`;
    next = { ...next, sequence: next.sequence + 1, references: [...next.references,
      { elementId, observation, child: placed.elementIds[index], parent: anchored.elementId }] };
    drawn.push(elementId);
  });
  // Expanding from the parent is opening it: no other expansion takes it back.
  next = adoptSourceRecords(next, [anchored.elementId]);
  const before = field.expansions.get(key) ?? { references: [], introduced: [] };
  const expansions = new Map(next.expansions);
  expansions.set(key, { references: [...before.references, ...drawn], introduced: [...before.introduced, ...placed.placed] });
  return { ...next, expansions };
}

/**
 * Take one expansion back: the connections it drew, then the records it
 * introduced that nobody opened individually since and that no other shown
 * connection still joins (D11). Physical proximity never counts.
 */
export function retractSourceExpansion(field: SourceField, key: string): SourceField {
  const expansion = field.expansions.get(key);
  if (!expansion) return field;
  const drawn = new Set(expansion.references);
  let next: SourceField = { ...field, references: field.references.filter((reference) => !drawn.has(reference.elementId)) };
  const joined = new Set(next.references.flatMap((reference) => [reference.child, reference.parent]));
  for (const elementId of expansion.introduced) {
    if (!joined.has(elementId)) next = removeSourceRecord(next, elementId);
  }
  const expansions = new Map(next.expansions);
  expansions.delete(key);
  return { ...next, expansions };
}

/**
 * A record opened individually stands on its own: no expansion may take it
 * back any more. Returns the same field when none had introduced it.
 */
export function adoptSourceRecords(field: SourceField, elementIds: string[]): SourceField {
  const adopted = new Set(elementIds);
  if (![...field.expansions.values()].some((expansion) => expansion.introduced.some((id) => adopted.has(id)))) return field;
  return { ...field, expansions: new Map([...field.expansions].map(([key, expansion]) =>
    [key, { ...expansion, introduced: expansion.introduced.filter((id) => !adopted.has(id)) }])) };
}

/** What a field remembered between visits looks like: everything but the evidence. */
export type RememberedField = {
  sequence: number;
  records: { elementId: string }[];
  references: { elementId: string; child: string; parent: string }[];
  positions: [string, Point][];
  depth: [string, number][];
  expansions: [string, SourceExpansion][];
};

/**
 * Stand a remembered field again (O8.8), from records and observations read
 * and verified anew in this context. Marks keep their element ids, positions
 * and depth; expansion notes keep what still stands. A record that did not
 * verify is left out with the connections drawn to it, and every record and
 * observation passes the same checks as placing or showing it.
 */
export function restoreSourceField(context: string, remembered: RememberedField,
  records: ReadonlyMap<string, SourceRecord>, observations: ReadonlyMap<string, SourceFKObservation>,
  groundedIn: (record: SourceRecord) => boolean): SourceField {
  const empty = emptySourceField(context);
  const placed: PlacedRecord[] = [];
  for (const { elementId } of remembered.records) {
    const record = records.get(elementId);
    if (!record || placed.some((item) => item.recordId === record.record_id)) continue;
    checkPlaceable(empty, context, record, groundedIn);
    placed.push({ elementId, recordId: record.record_id, table: record.grounding.table, key: record.grounding.key.map((cell) => ({ ...cell })) });
  }
  const standing = new Set(placed.map((item) => item.elementId));
  const references: PlacedReference[] = [];
  for (const { elementId, child, parent } of remembered.references) {
    const observation = observations.get(elementId), childRecord = records.get(child), parentRecord = records.get(parent);
    if (!observation || !childRecord || !parentRecord || !standing.has(child) || !standing.has(parent)) continue;
    checkShowable(empty, context, observation, childRecord, parentRecord, groundedIn);
    references.push({ elementId, observation, child, parent });
  }
  const drawn = new Set(references.map((item) => item.elementId));
  const positions = new Map(remembered.positions.filter(([id]) => standing.has(id)));
  for (const item of placed) if (!positions.has(item.elementId)) positions.set(item.elementId, { x: 0, y: 0 });
  const ids = [...standing, ...drawn].map((id) => Number(id.split("-").at(-1))).filter(Number.isFinite);
  return { ...empty, records: placed, references, positions,
    depth: new Map(remembered.depth.filter(([id]) => standing.has(id))),
    sequence: Math.max(remembered.sequence, ...ids.map((n) => n + 1), 1),
    expansions: new Map(remembered.expansions.map(([key, expansion]) => [key, {
      references: expansion.references.filter((id) => drawn.has(id)),
      introduced: expansion.introduced.filter((id) => standing.has(id)),
    }] as [string, SourceExpansion]).filter(([, expansion]) => expansion.references.length || expansion.introduced.length)) };
}

/** Whether an expansion still has anything drawn on the field. */
export function expansionShown(field: SourceField, key: string): boolean {
  const expansion = field.expansions.get(key);
  return !!expansion && field.references.some((reference) => expansion.references.includes(reference.elementId));
}

/**
 * Hide one displayed connection. Both of its records stay where they stand.
 * Display only: the recorded reference and its observation are unchanged, and
 * showing it again draws the same observation.
 */
export function hideSourceReference(field: SourceField, elementId: string): SourceField {
  if (!field.references.some((reference) => reference.elementId === elementId)) return field;
  return { ...field, references: field.references.filter((reference) => reference.elementId !== elementId) };
}

/** Remove one record and the connections drawn to it. Every other record stays. */
export function removeSourceRecord(field: SourceField, elementId: string): SourceField {
  if (!field.records.some((record) => record.elementId === elementId)) return field;
  const positions = new Map(field.positions), depth = new Map(field.depth);
  positions.delete(elementId); depth.delete(elementId);
  return { ...field, records: field.records.filter((record) => record.elementId !== elementId),
    references: field.references.filter((reference) => reference.child !== elementId && reference.parent !== elementId),
    positions, depth };
}

/**
 * Push apart only the marks that sit on one another: World's `separate`.
 *
 * The placement solver with every link taken away, run from where everything
 * already stands, so a mark that overlaps nothing feels nothing and does not
 * move. A deliberate, named action: it is the one way besides a drag that a
 * standing mark moves, and the caller keeps what it displaced for undo.
 * Returns the same field when nothing overlapped.
 */
export function separateSourceRecords(field: SourceField): SourceField {
  const moved = relax(
    [...field.positions].map(([id, point]) => ({ id, ...point, pinned: false, radius: DISC_BODY })),
    [],
  );
  const positions = new Map(field.positions);
  let disturbed = false;
  for (const [id, point] of moved) {
    const was = positions.get(id);
    if (!was || (was.x === point.x && was.y === point.y)) continue;
    positions.set(id, point);
    disturbed = true;
  }
  return disturbed ? { ...field, positions } : field;
}

/** Take every record and connection off. Element ids keep counting: none is reused. */
export function clearSourceField(field: SourceField): SourceField {
  return { ...emptySourceField(field.context), sequence: field.sequence };
}

/** Take every record of one table off, with the connections drawn to them. */
export function removeSourceTable(field: SourceField, table: string): SourceField {
  return field.records.filter((record) => record.table === table)
    .reduce((current, record) => removeSourceRecord(current, record.elementId), field);
}

/**
 * Where the renderer says the person left the marks, and which one they let go.
 *
 * Only placed marks are written, and a drop that moved its mark restacks it to
 * the front — the same record the World field keeps.
 */
export function moveSourceRecords(field: SourceField, moved: Map<string, Point>, droppedId?: string): SourceField {
  const positions = new Map(field.positions);
  let changed = false;
  for (const [id, point] of moved) {
    const before = positions.get(id);
    if (!before) continue;
    if (before.x !== point.x || before.y !== point.y) changed = true;
    positions.set(id, point);
  }
  if (!changed) return field;
  const depth = droppedId && positions.has(droppedId) ? restackDepths(field.depth, droppedId) : field.depth;
  return { ...field, positions, depth };
}

/**
 * The recorded key as text, exact: INTEGER stays decimal, TEXT stays quoted and
 * REAL names its binary64 bits. The Reader's subject caption reads the same.
 */
export function sourceKeyText(key: SourceCell[]): string {
  return key.map((cell) =>
    `${cell.column}=${cell.storage_class === "real" ? `REAL binary64 0x${cell.ieee754_hex}` : sourceValueText(cell)}`).join("; ");
}

/** The persistent identity a placed mark carries: its table and verified key. */
export function placedRecordName(record: PlacedRecord): string {
  return `${record.table} · ${sourceKeyText(record.key)}`;
}

/** Display text only; the registered handle remains the record identity. */
export function sourceRecordLabel(table: string, key: string): string { return `${table}\n${key}`; }

/**
 * A record called by its key (O17): "Track 8" for one INTEGER key column,
 * `Genre "Rock"` for one TEXT key, and the column names otherwise, where a
 * bare value would not say which component is which.
 */
export function sourceKeyLabel(table: string, key: SourceCell[]): string {
  const only = key.length === 1 ? key[0] : null;
  return only && (only.storage_class === "integer" || only.storage_class === "text")
    ? `${table} ${sourceValueText(only)}` : `${table} ${sourceKeyText(key)}`;
}

/**
 * A record's name (O17): the recorded value of the column a person chose for
 * its table, or its key label when there is no choice or the value is empty,
 * NULL or binary. Display only; the verified key stays the identity.
 */
export function sourceRecordName(table: string, key: SourceCell[], cells: readonly SourceCell[] | undefined, column: string | undefined): string {
  const cell = column ? cells?.find((candidate) => candidate.column === column) : undefined;
  const value = !cell ? null
    : cell.storage_class === "text" ? (cell.exact.trim() ? cell.exact : null)
    : cell.storage_class === "integer" || cell.storage_class === "real" ? sourceValueText(cell)
    : null;
  return value ?? sourceKeyLabel(table, key);
}
/**
 * A drawn connection by its two ends, the record holding the reference first,
 * and the recorded columns between: "posts 876 · OwnerUserId → emakalic".
 * The arrow is the declaration's own direction, child to parent; no meaning
 * beyond that is read into it.
 */
export function sourceConnectionName(reference: PlacedReference, nameOf: (elementId: string) => string): string {
  const fk = reference.observation.declaration;
  const columns = (fk.pairs.length ? fk.pairs.map((pair) => pair.child_column ?? "?") : fk.recorded_pairs.map((pair) => pair.from)).join(" + ");
  return `${nameOf(reference.child)} · ${columns} → ${nameOf(reference.parent)}`;
}

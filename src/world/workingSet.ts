/**
 * The working set — what is currently on the field.
 *
 * The canvas is not a view of the World. It is a subgraph a person built by
 * asking for things, one expansion at a time, and this module is that
 * construction: which referents and assertions are on the field, where they
 * sit, and what it would cost to add more. Rule 9 lives here — the World is
 * never rendered, only what someone asked for.
 *
 * Two rules the rest of the surface depends on.
 *
 * **Existing marks never move.** Expanding places only what is new, ringed
 * around the mark it came from. A canvas that re-lays-out on every expansion
 * destroys the thing expansion is for: you looked away for a second and the
 * part you were reading is somewhere else. This is the same argument, and the
 * same shape, as `proposalPositions` in the product graph — a proposed node is
 * ringed around what it would attach to, because that placement is a statement
 * about what it connects to.
 *
 * `settle` takes the slack out of each fold afterwards — see `relax` — but it
 * is given the old marks as pins rather than asked to leave them alone, so the
 * rule holds by construction and not by care.
 *
 * **The field is not bounded by count.** Expansions place what the world
 * returns, and the reader counts what is standing. The cost is still known in
 * advance: `/world/referent` returns a count per
 * relation, so the question "what would this cost" is answered before anything
 * is drawn.
 */

import type { WorldRole, WorldTuple } from "../api/world";
import { projectionOf } from "./marks";
import { restackDepths } from "./fieldDepth";
import { fieldGraph } from "./hops";
import { relax, type RelaxBody, type RelaxLink } from "./relax";
import {
  DISC_BODY,
  PLATE_BODY,
  PROBES,
  RING_RADIUS,
  ringSlot,
  slotClear,
} from "./fieldPlacement";

// Depth is display state shared with the source field; World callers keep
// importing it from here.
export { paintDepths, rankedDepths, restackTop } from "./fieldDepth";

const CHIP_INSET = 0.55;
/** How far a plate wants to sit from each mark it joins. */
const SPOKE_LENGTH = 110;

export type Point = { x: number; y: number };

export type FieldReferent = {
  id: string;
  label: string;
  /** The referent this one arrived beside, if it was not the seed. */
  via?: string;
};

export type FieldAssertion = {
  assertion_id: string;
  relation: string;
  /** Scalar compatibility summary; `origins` preserves every support path. */
  origin: string;
  origins?: string[];
  /** The recorded occurrence state, where the source supplied one. */
  occurrence_state?: string;
  mode: string;
  stale: boolean;
  completeness: "COMPLETE" | "INCOMPLETE" | "UNKNOWN" | null;
  /** Referent role values, in role order. */
  spokes: { role: string; id: string }[];
  /** Scalar role values, which stay off the field and in the inspector. */
  scalars: { role: string; value: unknown }[];
};

/**
 * An obligation on the field: a tuple a purpose asked for and the world does
 * not assert (§8.7).
 *
 * It has no assertion id because there is no assertion — that is the whole
 * content of the mark — so it is keyed by the relation and its values, which is
 * the only identity an unresolved thing has.
 */
export type FieldDemand = {
  key: string;
  relation: string;
  spokes: { role: string; id: string }[];
  scalars: { role: string; value: unknown }[];
};

/**
 * A binary tuple drawn as the line it makes.
 *
 * It carries its roles and scalars even though a filament draws neither. A
 * bond is not a different kind of thing from a plate — it is the same tuple
 * folded onto the line between its two referents — and `open` unfolds it in
 * place. Keeping the folded form complete is what makes that a change of
 * drawing rather than a refetch.
 */
export type FieldBond = {
  assertion_id: string;
  relation: string;
  origin: string;
  origins?: string[];
  /** The recorded occurrence state, where the source supplied one. */
  occurrence_state?: string;
  mode: string;
  stale: boolean;
  completeness: "COMPLETE" | "INCOMPLETE" | "UNKNOWN" | null;
  source: string;
  target: string;
  /** Referent role values in role order — the spokes the open form would have. */
  spokes: { role: string; id: string }[];
  /** Scalar role values, which the filament has nowhere to put. */
  scalars: { role: string; value: unknown }[];
};

export type WorkingSet = {
  referents: Map<string, FieldReferent>;
  assertions: Map<string, FieldAssertion>;
  demands: Map<string, FieldDemand>;
  bonds: FieldBond[];
  positions: Map<string, Point>;
  /**
   * Paint depth, for the depth stack. A mark id maps to the `zIndex` its
   * last drop stamped; higher is fronter.
   *
   * Scene sibling order is creation-frozen — G6 does not move survivors when
   * the model reorders — so depth can only be restated as `zIndex`, and only
   * the lane can state it, since every redraw restates `zIndex` from the
   * data it draws. A drop therefore records its paint here, and the lane
   * stamps it verbatim. Marks with no entry keep the layer's own `zIndex`
   * and paint in creation order behind every restacked mark. Display state
   * like `positions`, kept and pruned alongside it.
   *
   * Values from before paint lived here are bare drop counts, and read back
   * as the order they always were: `paintDepths` re-homes them to dense
   * ranks on first paint, so a stored field comes back standing as it stood.
   */
  depth: Map<string, number>;
  /** Expansions that completed, including empty expansions. This is completion
   *  provenance, not the source of truth for whether their tuples are still on
   *  the field; `expansionOnField` derives that from the material itself. */
  expanded: Set<string>;
};

export function emptySet(): WorkingSet {
  return {
    referents: new Map(),
    assertions: new Map(),
    demands: new Map(),
    bonds: [],
    positions: new Map(),
    depth: new Map(),
    expanded: new Set(),
  };
}

export function fieldSize(set: WorkingSet): number {
  return set.referents.size + set.assertions.size + set.demands.size;
}

export function expansionKey(referentId: string, relation: string): string {
  return `${referentId}\u0000${relation}`;
}

/** How many positive tuples of this relation involving this referent stand here. */
export function expansionTupleCount(
  set: WorkingSet,
  referentId: string,
  relation: string,
): number {
  const ids = new Set<string>();
  for (const assertion of set.assertions.values()) {
    if (
      assertion.relation === relation &&
      assertion.spokes.some((spoke) => spoke.id === referentId)
    ) {
      ids.add(assertion.assertion_id);
    }
  }
  for (const bond of set.bonds) {
    if (
      bond.relation === relation &&
      bond.spokes.some((spoke) => spoke.id === referentId)
    ) {
      ids.add(bond.assertion_id);
    }
  }
  return ids.size;
}

/**
 * Whether expanding this relation would add any tuple matter.
 *
 * Presence is derived from the field rather than from the route by which a
 * tuple arrived. A row focus or an expansion from the tuple's other referent
 * can put exactly the same assertion here, and the panel must still say "on
 * field". The completion record matters only for a legitimately empty
 * expansion, where there is no material from which to derive the answer.
 */
export function expansionOnField(
  set: WorkingSet,
  referentId: string,
  relation: string,
  expectedCount: number,
): boolean {
  if (expectedCount === 0) {
    return set.expanded.has(expansionKey(referentId, relation));
  }
  return expansionTupleCount(set, referentId, relation) >= expectedCount;
}

/**
 * The tuples a retraction of this route takes off: every claim of the
 * relation standing on the referent, as a plate or as a bond.
 */
export function expansionMaterial(
  set: WorkingSet,
  referentId: string,
  relation: string,
): Set<string> {
  const assertionIds = new Set<string>();
  for (const assertion of set.assertions.values()) {
    if (
      assertion.relation === relation &&
      assertion.spokes.some((spoke) => spoke.id === referentId)
    ) {
      assertionIds.add(assertion.assertion_id);
    }
  }
  for (const bond of set.bonds) {
    if (
      bond.relation === relation &&
      bond.spokes.some((spoke) => spoke.id === referentId)
    ) {
      assertionIds.add(bond.assertion_id);
    }
  }
  return assertionIds;
}

/**
 * Take one completed expansion back off the field.
 *
 * The route is identified by the same anchor/relation pair that added it. Its
 * tuples leave; referents that arrived through that anchor leave only when no
 * remaining tuple or obligation still uses them. This makes the control a
 * genuine toggle without deleting shared matter another expansion owns.
 */
export function retractExpansion(
  set: WorkingSet,
  referentId: string,
  relation: string,
): WorkingSet {
  const assertionIds = expansionMaterial(set, referentId, relation);
  const key = expansionKey(referentId, relation);
  if (!assertionIds.size && !set.expanded.has(key)) return set;

  const next = clone(set);
  for (const id of assertionIds) {
    next.assertions.delete(id);
    next.positions.delete(id);
    next.depth.delete(id);
  }
  next.bonds = next.bonds.filter(
    (bond) => !assertionIds.has(bond.assertion_id),
  );
  next.expanded.delete(key);

  const used = new Set<string>();
  for (const assertion of next.assertions.values()) {
    assertion.spokes.forEach((spoke) => used.add(spoke.id));
  }
  for (const bond of next.bonds) {
    bond.spokes.forEach((spoke) => used.add(spoke.id));
  }
  for (const demand of next.demands.values()) {
    demand.spokes.forEach((spoke) => used.add(spoke.id));
  }
  for (const [id, referent] of next.referents) {
    if (id === referentId || referent.via !== referentId || used.has(id)) continue;
    next.referents.delete(id);
    next.positions.delete(id);
    next.depth.delete(id);
    for (const expanded of [...next.expanded]) {
      if (expanded.startsWith(`${id}\u0000`)) next.expanded.delete(expanded);
    }
  }
  return next;
}

/** Put the first referent on an empty field, at the middle. */
export function seed(set: WorkingSet, id: string, label: string): WorkingSet {
  const next = clone(set);
  next.referents.set(id, { id, label });
  next.positions.set(id, { x: 0, y: 0 });
  return next;
}

function clone(set: WorkingSet): WorkingSet {
  return {
    referents: new Map(set.referents),
    assertions: new Map(set.assertions),
    demands: new Map(set.demands),
    bonds: [...set.bonds],
    positions: new Map(set.positions),
    depth: new Map(set.depth),
    expanded: new Set(set.expanded),
  };
}

/**
 * A drop brings its mark to the front of the depth stack.
 *
 * The value is paint — one step above the current top — not a sequence, so
 * the lane stamps it verbatim and every other standing number survives the
 * drop untouched. Called only for drops that moved; a press that went
 * nowhere restacks nothing, the way it repositions nothing.
 */
export function restack(set: WorkingSet, id: string): WorkingSet {
  const next = clone(set);
  next.depth = restackDepths(next.depth, id);
  return next;
}

/**
 * How much room a mark of each kind needs around its centre.
 *
 * Read off `DISC_BODY` and `PLATE_BODY`, which is what makes placement and
 * settling agree about what "clear" means: a slot placement accepts is a slot
 * the settle has no reason to push anything out of.
 */
function bodyRadius(next: WorkingSet, id: string): number {
  return next.referents.has(id) ? DISC_BODY : PLATE_BODY;
}

/** Whether a mark of this size could sit here without landing on anything. */
function isClear(next: WorkingSet, at: Point, radius: number, ignore?: string): boolean {
  return slotClear(next.positions, (id) => bodyRadius(next, id), at, radius, ignore);
}

/**
 * Whether a plate could open here without landing on a standing mark.
 *
 * The fold's seat is authored — the drawn label's station — so unlike a fresh
 * placement it is never walked out to freedom: it either stands where the name
 * stood or keeps the pushed seat `open` already gave it. Same bodies as
 * `isClear`, so the canvas and the store agree about what "clear" means.
 */
export function plateSeatClear(set: WorkingSet, at: Point, ignore: string): boolean {
  return isClear(set, at, PLATE_BODY, ignore);
}

/** Free space around an anchor — see `ringSlot`, which the source field shares. */
function placeAround(
  next: WorkingSet,
  anchor: Point,
  taken: number,
  index: number,
): Point {
  return ringSlot(next.positions, (id) => bodyRadius(next, id), anchor, taken, index);
}

export type ExpansionInput = {
  anchor: string;
  relation: string;
  mode: string;
  stale: boolean;
  completeness: "COMPLETE" | "INCOMPLETE" | "UNKNOWN" | null;
  roles: WorldRole[];
  tuples: WorldTuple[];
  /** Labels for referents that may not be on the field yet. */
  labels: Map<string, string | null>;
};

/**
 * How far the pre-settle spiral steps out per coincident mark.
 *
 * Only has to break exact coincidence — the solver does the separating — so
 * it stays small enough that a fanned plate still reads as standing with its
 * spokes.
 */
const STACK_SPIRAL_STEP = 14;

/** Golden angle: successive offsets never line up behind each other. */
const STACK_SPIRAL_TURN = 2.399963;

/**
 * Fan out arrived marks that landed on exactly the same point, before settle.
 *
 * Tuples sharing one spoke set compute one plate position; a bulk fold of
 * fifty-odd stacks them all on it, the solver's quadtree degenerates, and
 * the pass crawls (measured 1.2s for 53 where a healthy pass is
 * milliseconds). A deterministic spiral by sorted id breaks the coincidence;
 * the settle still decides where everything rests. Only arrived marks move —
 * what was already standing is never touched.
 */
function spreadStacks(before: WorkingSet, next: WorkingSet): void {
  const arrived = new Set<string>();
  for (const id of next.referents.keys()) {
    if (!before.referents.has(id)) arrived.add(id);
  }
  for (const id of next.assertions.keys()) {
    if (!before.assertions.has(id)) arrived.add(id);
  }
  if (!arrived.size) return;
  const used = new Set<string>();
  for (const [id, at] of next.positions) {
    if (!arrived.has(id)) used.add(`${at.x},${at.y}`);
  }
  for (const id of [...arrived].sort()) {
    const at = next.positions.get(id);
    if (!at) continue;
    const key = `${at.x},${at.y}`;
    if (!used.has(key)) {
      used.add(key);
      continue;
    }
    let k = 0;
    let moved = at;
    let movedKey = key;
    do {
      k += 1;
      const radius = STACK_SPIRAL_STEP * Math.sqrt(k);
      const angle = k * STACK_SPIRAL_TURN;
      moved = {
        x: at.x + radius * Math.cos(angle),
        y: at.y + radius * Math.sin(angle),
      };
      movedKey = `${moved.x},${moved.y}`;
    } while (used.has(movedKey) && k < 64);
    next.positions.set(id, moved);
    used.add(movedKey);
  }
}

/** Fold every tuple of one relation, as read from one referent, into the field. */
export function expand(set: WorkingSet, input: ExpansionInput): WorkingSet {
  const next = clone(set);
  const key = expansionKey(input.anchor, input.relation);
  // `expanded` records that a request once completed; it cannot prove its
  // material is still present after a related referent was dropped. Only skip
  // when every tuple returned by this request still has one of its two field
  // drawings.
  const materialComplete = input.tuples.every(
    (tuple) =>
      next.assertions.has(tuple.assertion_id) ||
      next.bonds.some((bond) => bond.assertion_id === tuple.assertion_id),
  );
  if (next.expanded.has(key) && materialComplete) return set;
  next.expanded.add(key);

  const taken = countAround(set, input.anchor);
  let placed = 0;
  for (const tuple of input.tuples) {
    placed = fold(next, {
      anchor: input.anchor,
      relation: input.relation,
      mode: input.mode,
      stale: input.stale,
      completeness: input.completeness,
      roles: input.roles,
      tuple,
      labels: input.labels,
    }, taken, placed);
  }
  spreadStacks(set, next);
  settle(set, next);
  return next;
}

export type PlacementInput = {
  relation: string;
  mode: string;
  stale: boolean;
  completeness: "COMPLETE" | "INCOMPLETE" | "UNKNOWN" | null;
  roles: WorldRole[];
  tuple: WorldTuple;
  labels: Map<string, string | null>;
};

/**
 * Put one tuple on the field — a table row focusing its graph projection.
 *
 * §11: the table and the canvas are two projections of one relation state, so
 * selecting a row has to be able to say *show me this one*. The anchor is a
 * referent from the tuple that is already on the field when there is one, which
 * is what makes picking a row out of a table land the tuple beside the
 * neighborhood you were already reading rather than somewhere else on the
 * canvas. With an empty field the first referent takes the middle and the rest
 * fan around it, exactly as a seed would.
 */
/**
 * Fold one tuple into an accumulating field, without settling.
 *
 * Shared by the single and bulk placements so they anchor identically: the
 * anchor is read off the accumulating field, and the slots taken around it
 * are counted there too — for one tuple that field is a clone of the field,
 * so the count is the same count the single placement always took.
 */
function foldOne(next: WorkingSet, input: PlacementInput): boolean {
  const spokes = input.roles
    .filter((role) => role.referent)
    .map((role) => String(input.tuple.values[role.name]));
  const anchor = anchorFor(next, spokes, input.labels);
  if (!anchor) return false;
  fold(next, { ...input, anchor }, countAround(next, anchor), 0);
  return true;
}

export function place(set: WorkingSet, input: PlacementInput): WorkingSet {
  const next = clone(set);
  if (!foldOne(next, input)) return set;
  settle(set, next);
  return next;
}

export type BulkPlacementInput = {
  relation: string;
  mode: string;
  stale: boolean;
  completeness: "COMPLETE" | "INCOMPLETE" | "UNKNOWN" | null;
  roles: WorldRole[];
  tuples: WorldTuple[];
  labels: Map<string, string | null>;
};

/**
 * Fold a page of tuples, settling once.
 *
 * What add-all places through: every tuple anchors the way a single placement
 * would — beside the neighborhood it names — but the settle runs a single
 * time over the whole fold rather than once per tuple, which is what made a
 * 53-row run pay for 53 simulations. `spreadStacks` breaks the coincident
 * stacks first, so the one pass stays millisecond-scale.
 */
export function placeAll(set: WorkingSet, input: BulkPlacementInput): WorkingSet {
  const next = clone(set);
  let placed = false;
  for (const tuple of input.tuples) {
    if (foldOne(next, { ...input, tuple })) placed = true;
  }
  if (!placed) return set;
  spreadStacks(set, next);
  settle(set, next);
  return next;
}

export type DemandPlacement = {
  /** The obligation's identity, since an unresolved tuple has no assertion id. */
  key: string;
  relation: string;
  roles: WorldRole[];
  values: Record<string, unknown>;
  labels: Map<string, string | null>;
};

/**
 * Put one unresolved obligation on the field (§8.7, §9).
 *
 * An obligation is drawn as a standing hollow chip with a dotted spoke per
 * role, at every arity — it never collapses onto a bond the way a binary
 * assertion does, and that is deliberate rather than a shortcut. A bond is a
 * line between two referents saying they are joined; there is no such line to
 * draw here, because nothing has been asserted. Drawing one and marking it
 * somehow would be the front end implying a connection the world has not made,
 * which is the same error as implying falsehood from absence.
 */
export function placeDemand(set: WorkingSet, input: DemandPlacement): WorkingSet {
  if (set.demands.has(input.key)) return set;
  const next = clone(set);
  /**
   * Only the roles this obligation actually names.
   *
   * An obligation is the one tuple shape whose referent roles can be unbound —
   * that is most of what makes it an obligation. `String(undefined)` put a
   * referent called `undefined` on the field, gave it a spoke, and let it be
   * dragged, selected and remembered across reloads: a mark standing for a
   * thing the world has never mentioned. An unfilled role is not a referent
   * with a strange name; it is nothing, and nothing is what gets drawn.
   */
  const referentRoles = input.roles.filter(
    (role) => role.referent && input.values[role.name] != null,
  );
  const spokes = referentRoles.map((role) => ({
    role: role.name,
    id: String(input.values[role.name]),
  }));
  const anchor = anchorFor(next, spokes.map((spoke) => spoke.id), input.labels);
  if (!anchor) return set;
  const anchorAt = next.positions.get(anchor) ?? { x: 0, y: 0 };

  attach(next, spokes, anchor, anchorAt, countAround(set, anchor), 0, input.labels);
  next.demands.set(input.key, {
    key: input.key,
    relation: input.relation,
    spokes,
    scalars: input.roles
      .filter((role) => !role.referent)
      .map((role) => ({ role: role.name, value: input.values[role.name] })),
  });
  next.positions.set(input.key, plateAt(next, anchorAt, spokes));
  settle(set, next);
  return next;
}

/**
 * Take the slack out of what just arrived, and nothing else.
 *
 * Placement stays where it was — new marks are fanned onto a ring around what
 * they came from, which is a statement about where they belong. What the fan
 * cannot do is know whether the slot it chose was already occupied by material
 * from some earlier expansion, and the one-nudge answer in `placeAround` was
 * only ever meant to stop a stack, not to resolve a crowd.
 *
 * So: one headless settling pass, every mark already on the field held exactly
 * where it is, and only the referents that arrived in this fold free to move.
 * Because the solver is given the pins rather than trusted to respect them,
 * `existing marks never move` holds by construction — including for a disc a
 * person dragged, which by the next expansion is simply something already on
 * the field.
 *
 * A plate is a body like any other, tied to each mark it gathers by a short
 * link. That is how it comes to sit between them and how the same collision
 * that separates two discs clears a plate off one, rather than a rule applied
 * to plates afterwards. See `relax`.
 */
function fieldBodies(set: WorkingSet, free: (id: string) => boolean): RelaxBody[] {
  const bodies: RelaxBody[] = [];
  const body = (id: string, radius: number) => {
    const at = set.positions.get(id);
    if (at) bodies.push({ id, x: at.x, y: at.y, pinned: !free(id), radius });
  };
  for (const id of set.referents.keys()) body(id, DISC_BODY);
  for (const id of set.assertions.keys()) body(id, PLATE_BODY);
  for (const id of set.demands.keys()) body(id, PLATE_BODY);
  return bodies;
}

/**
 * What the field says is joined.
 *
 * A bond is already a line between two referents. A plate is joined to each
 * mark it gathers, which is both what holds it between them and what carries
 * its referents toward each other — so there is no separate pull between
 * co-participants to add.
 */
function fieldLinks(set: WorkingSet): RelaxLink[] {
  const links: RelaxLink[] = [];
  for (const bond of set.bonds) {
    links.push({ source: bond.source, target: bond.target, distance: RING_RADIUS });
  }
  const spokesOf = (id: string, spokes: { id: string }[]) => {
    for (const spoke of spokes) {
      links.push({ source: id, target: spoke.id, distance: SPOKE_LENGTH });
    }
  };
  for (const [id, assertion] of set.assertions) spokesOf(id, assertion.spokes);
  for (const [id, demand] of set.demands) spokesOf(id, demand.spokes);
  return links;
}

function settle(before: WorkingSet, next: WorkingSet): void {
  const arrived = new Set<string>();
  for (const id of next.referents.keys()) {
    if (!before.referents.has(id)) arrived.add(id);
  }
  for (const id of next.assertions.keys()) {
    if (!before.assertions.has(id)) arrived.add(id);
  }
  for (const id of next.demands.keys()) {
    if (!before.demands.has(id)) arrived.add(id);
  }
  if (!arrived.size) return;

  const moved = relax(
    fieldBodies(next, (id) => arrived.has(id)),
    fieldLinks(next),
  );
  for (const [id, at] of moved) next.positions.set(id, at);
}

/**
 * Two ways a person may ask the field to re-place matter it already holds.
 *
 * Both break the rule the canvas is otherwise built on — `existing marks never
 * move` — which is exactly why neither may happen on its own. They are actions
 * with names, taken deliberately, and the caller keeps what they displaced so
 * it can be put back.
 */
export type Arrangement =
  | { kind: "separate" }
  | { kind: "gather"; subject: string };

/**
 * Re-place matter already on the field, because someone asked.
 *
 * Neither of these is a second layout model. `gather` is arrival, run again:
 * the same bodies, the same links, the same solver, with the pins moved so that
 * one subject's neighbours are free instead of the marks that just arrived. A
 * field arranged this way settles exactly as it would have if those neighbours
 * had been expanded from the subject in the first place, which is the property
 * that keeps there from being two answers to where a mark belongs.
 *
 * `separate` is the same solver with the links taken away. Collision alone,
 * from where everything already is: a body that overlaps nothing feels nothing
 * and does not move, so the total displacement is bounded by the depth of the
 * overlaps and nothing is rearranged that was not already on top of something.
 * Keeping the links would have made it a relayout of the whole field, which is
 * a different and much larger thing to ask for.
 *
 * The subject of a gather is pinned. It is the mark the person named, and the
 * arrangement is *around* it; moving it would answer a question nobody asked.
 */
export function arrange(set: WorkingSet, request: Arrangement): WorkingSet {
  if (request.kind === "gather") {
    const near = fieldGraph(set).get(request.subject);
    if (!near?.size) return set;
    const moved = relax(
      fieldBodies(set, (id) => id !== request.subject && near.has(id)),
      fieldLinks(set),
    );
    if (!moved.size) return set;
    const next = clone(set);
    for (const [id, at] of moved) next.positions.set(id, at);
    return next;
  }

  const moved = relax(fieldBodies(set, () => true), []);
  let disturbed = false;
  for (const [id, at] of moved) {
    const was = set.positions.get(id);
    if (was && (was.x !== at.x || was.y !== at.y)) disturbed = true;
  }
  if (!disturbed) return set;
  const next = clone(set);
  for (const [id, at] of moved) next.positions.set(id, at);
  return next;
}

/**
 * Which mark this tuple hangs off.
 *
 * A referent already on the field when there is one, so a tuple picked out of a
 * list lands beside the neighborhood being read rather than somewhere else on
 * the canvas. With nothing to hang off, the first referent takes the middle of
 * an empty field or a free slot on a busy one, exactly as a seed would.
 */
function anchorFor(
  next: WorkingSet,
  spokes: string[],
  labels: Map<string, string | null>,
): string | null {
  const present = spokes.find((id) => next.referents.has(id));
  if (present) return present;
  const first = spokes[0];
  if (!first) return null;
  next.referents.set(first, { id: first, label: labels.get(first) ?? first });
  next.positions.set(
    first,
    next.positions.size
      ? placeAround(next, { x: 0, y: 0 }, next.referents.size, 0)
      : { x: 0, y: 0 },
  );
  return first;
}

/**
 * Fold one tuple into the field, returning how many marks it placed.
 *
 * The projection decision is the same one the schema canvas makes, from the
 * same function: a tuple with two referents becomes a bond, one with three or
 * more becomes a plate with a spoke per role, and a tuple carrying one referent
 * plus scalars becomes a plate too. The plate is the occurrence, not the
 * referent: its scalars are what that occurrence states, and its id, origin and
 * state are the occurrence's own — an assertion behind it worth opening.
 */
function fold(
  next: WorkingSet,
  input: PlacementInput & { anchor: string },
  taken: number,
  placed: number,
): number {
  const anchorAt = next.positions.get(input.anchor) ?? { x: 0, y: 0 };
  const referentRoles = input.roles.filter((role) => role.referent);
  const scalarRoles = input.roles.filter((role) => !role.referent);
  const projection = projectionOf(input.roles.length, referentRoles.length);
  const tuple = input.tuple;

  const spokes = referentRoles.map((role) => ({
    role: role.name,
    id: String(tuple.values[role.name]),
  }));
  const scalars = scalarRoles.map((role) => ({
    role: role.name,
    value: tuple.values[role.name],
  }));

  placed = attach(next, spokes, input.anchor, anchorAt, taken, placed, input.labels);

  // Already standing, in either form. A second fold would overwrite the record
  // and recompute its position, which is `existing marks never move` broken by
  // the one path that is allowed to add marks. This is also what lets a bond
  // stay open across later expansions: its plate is not a bond any more, so the
  // `bonds` check alone would not have found it.
  if (
    next.assertions.has(tuple.assertion_id) ||
    next.bonds.some((bond) => bond.assertion_id === tuple.assertion_id)
  ) {
    return placed;
  }

  if (projection === "bond" && spokes.length === 2) {
    next.bonds.push({
      assertion_id: tuple.assertion_id,
      relation: input.relation,
      origin: tuple.origin,
      origins: tuple.origins,
      occurrence_state: tuple.occurrence_state,
      mode: input.mode,
      stale: input.stale,
      completeness: input.completeness,
      source: spokes[0].id,
      target: spokes[1].id,
      spokes,
      scalars,
    });
    return placed;
  }

  next.assertions.set(tuple.assertion_id, {
    assertion_id: tuple.assertion_id,
    relation: input.relation,
    origin: tuple.origin,
    origins: tuple.origins,
    occurrence_state: tuple.occurrence_state,
    mode: input.mode,
    stale: input.stale,
    completeness: input.completeness,
    spokes,
    scalars,
  });
  next.positions.set(tuple.assertion_id, plateAt(next, anchorAt, spokes));
  return placed;
}

/**
 * Bring a tuple's referents onto the field, returning how many were new.
 *
 * Every referent in the tuple joins, including the ones that were already there
 * — a tuple whose partners are all present adds its plate and no discs, which
 * is how a neighborhood closes up on itself instead of growing a second copy of
 * what you can already see.
 */
function attach(
  next: WorkingSet,
  spokes: { role: string; id: string }[],
  anchor: string,
  anchorAt: Point,
  taken: number,
  placed: number,
  labels?: Map<string, string | null>,
): number {
  for (const spoke of spokes) {
    if (next.referents.has(spoke.id)) continue;
    next.referents.set(spoke.id, {
      id: spoke.id,
      label: labels?.get(spoke.id) ?? spoke.id,
      via: anchor,
    });
    next.positions.set(spoke.id, placeAround(next, anchorAt, taken, placed));
    placed += 1;
  }
  return placed;
}

/**
 * Where a plate sits: between the marks it joins, pulled in from their centroid
 * so its spokes read as short and its name does not land on a disc.
 */
function plateAt(
  next: WorkingSet,
  anchorAt: Point,
  spokes: { id: string }[],
): Point {
  const points = spokes
    .map((spoke) => next.positions.get(spoke.id))
    .filter((point): point is Point => Boolean(point));
  const centre = points.length
    ? {
        x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
        y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
      }
    : anchorAt;
  const at = {
    x: Math.round(anchorAt.x + (centre.x - anchorAt.x) * CHIP_INSET),
    y: Math.round(anchorAt.y + (centre.y - anchorAt.y) * CHIP_INSET),
  };
  // Two tuples over nearly the same referents land in nearly the same place —
  // an obligation and the assertion that would answer it, say, which is exactly
  // the pair someone opens the frontier to compare. Stepped off each other by
  // the same rule the discs are placed by: walk out from where the plate wants
  // to be until the spot is actually free. The path is a phyllotaxis spiral, so
  // it covers the ring evenly instead of running off in one diagonal, and it is
  // the same path every time.
  if (isClear(next, at, PLATE_BODY)) return at;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let probe = 1; probe <= PROBES; probe += 1) {
    const radius = 26 * Math.sqrt(probe);
    const angle = probe * golden;
    const stepped = {
      x: Math.round(at.x + Math.cos(angle) * radius),
      y: Math.round(at.y + Math.sin(angle) * radius),
    };
    if (isClear(next, stepped, PLATE_BODY)) return stepped;
  }
  return at;
}

/** How many marks already sit around this one, so the next fan starts clear. */
function countAround(set: WorkingSet, anchor: string): number {
  let count = 0;
  for (const referent of set.referents.values()) {
    if (referent.via === anchor) count += 1;
  }
  return count;
}

/**
 * Whether a mark on the field has a second form, and which way it would go.
 *
 * A binary assertion is drawn two ways: as the filament between its referents,
 * or as a plate standing between them with a named spoke to each. Both are the
 * same tuple. The line is the reading where the relation is the connection; the
 * plate is the reading where the relation is a thing that has roles — and roles
 * are precisely what a named typed n-ary relation adds and what a labelled line
 * cannot show. So this is semantic zoom and not decluttering: opening a bond
 * reveals `part` and `bom_item`, and any scalar the line had nowhere to put.
 *
 * Two things deliberately have no second form.
 *
 * An assertion with three or more referents has no line to fold onto, so it is
 * only ever a plate. And an **obligation never collapses onto a bond at any
 * arity** — a line between two discs asserts that they are joined, and the
 * entire content of an unresolved mark is that no such claim has been made.
 * That is why this reads the field's own collections rather than arity: a
 * demand is not in either of them.
 */
export function foldingOf(
  set: WorkingSet,
  id: string,
): "open" | "collapse" | null {
  if (set.bonds.some((bond) => bond.assertion_id === id)) return "open";
  const assertion = set.assertions.get(id);
  if (assertion && assertion.spokes.length === 2) return "collapse";
  return null;
}

/**
 * Unfold a bond into the plate it is.
 *
 * The plate lands on the midpoint of the line it replaces, so the line appears
 * to open rather than to be swapped for something elsewhere, and neither disc
 * moves — this changes how a tuple is drawn and nothing about where the field
 * stands. `plateAt` still probes outward if the midpoint is already occupied,
 * by the same phyllotaxis walk every other plate is placed with.
 */
export function open(set: WorkingSet, assertionId: string): WorkingSet {
  const bond = set.bonds.find((edge) => edge.assertion_id === assertionId);
  if (!bond) return set;
  const next = clone(set);
  next.bonds = next.bonds.filter((edge) => edge.assertion_id !== assertionId);
  next.assertions.set(assertionId, {
    assertion_id: bond.assertion_id,
    relation: bond.relation,
    origin: bond.origin,
    origins: bond.origins,
    occurrence_state: bond.occurrence_state,
    mode: bond.mode,
    stale: bond.stale,
    completeness: bond.completeness,
    spokes: bond.spokes,
    scalars: bond.scalars,
  });
  const ends = [bond.source, bond.target]
    .map((id) => next.positions.get(id))
    .filter((point): point is Point => Boolean(point));
  const middle = ends.length
    ? {
        x: ends.reduce((sum, p) => sum + p.x, 0) / ends.length,
        y: ends.reduce((sum, p) => sum + p.y, 0) / ends.length,
      }
    : { x: 0, y: 0 };
  next.positions.set(assertionId, plateAt(next, middle, bond.spokes));
  return next;
}

/** Fold a two-referent plate back onto the line between its referents. */
export function collapse(set: WorkingSet, assertionId: string): WorkingSet {
  const assertion = set.assertions.get(assertionId);
  if (!assertion || assertion.spokes.length !== 2) return set;
  const next = clone(set);
  next.assertions.delete(assertionId);
  next.positions.delete(assertionId);
  next.depth.delete(assertionId);
  next.bonds.push({
    assertion_id: assertion.assertion_id,
    relation: assertion.relation,
    origin: assertion.origin,
    origins: assertion.origins,
    occurrence_state: assertion.occurrence_state,
    mode: assertion.mode,
    stale: assertion.stale,
    completeness: assertion.completeness,
    source: assertion.spokes[0].id,
    target: assertion.spokes[1].id,
    spokes: assertion.spokes,
    scalars: assertion.scalars,
  });
  return next;
}

/** Take a mark and everything that only existed because of it. */
export function drop(set: WorkingSet, id: string): WorkingSet {
  const next = clone(set);
  next.referents.delete(id);
  next.positions.delete(id);
  next.depth.delete(id);
  next.bonds = next.bonds.filter(
    (bond) => bond.source !== id && bond.target !== id,
  );
  for (const [assertionId, assertion] of next.assertions) {
    if (assertion.spokes.some((spoke) => spoke.id === id)) {
      next.assertions.delete(assertionId);
      next.positions.delete(assertionId);
      next.depth.delete(assertionId);
    }
  }
  for (const [key, demand] of next.demands) {
    if (demand.spokes.some((spoke) => spoke.id === id)) {
      next.demands.delete(key);
      next.positions.delete(key);
      next.depth.delete(key);
    }
  }
  for (const key of [...next.expanded]) {
    if (key.startsWith(`${id}\u0000`)) next.expanded.delete(key);
  }
  return next;
}

/**
 * Take a mark off the field.
 *
 * A referent still takes everything that only existed because of it. An
 * assertion, bond, or obligation leaves on its own — the discs it joined stay,
 * which is what makes Delete a small verb rather than a neighbourhood wipe.
 */
export function dropMark(set: WorkingSet, id: string): WorkingSet {
  if (set.referents.has(id)) return drop(set, id);
  const next = clone(set);
  next.assertions.delete(id);
  next.demands.delete(id);
  next.positions.delete(id);
  next.depth.delete(id);
  next.bonds = next.bonds.filter((bond) => bond.assertion_id !== id);
  return next;
}

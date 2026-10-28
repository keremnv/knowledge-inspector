/**
 * Frames: referents a relation's claims hold *in*, rather than *between*.
 *
 * A referent that takes part in every tuple of a relation's extension carries
 * no distinguishing information for that relation — every claim of it is
 * about the same one. A snapshot threaded through every code fact, a tenant
 * through every record, a revision through every row: drawn as a participant,
 * each becomes a hub that every claim spokes to, and the claims' own shape —
 * which two things a claim actually joins — is lost behind it.
 *
 * So framing drops those roles before the projection is decided, and nothing
 * else. It is the same rule `projectionOf` applies, counted over the referent
 * roles that vary: a tuple left with two becomes a bond, with three or more a
 * plate, with one a property plate on its referent, and with none it belongs
 * to the frame itself. The frame referent leaves the field when no claim still
 * needs it as a participant.
 *
 * Nothing here knows a domain. "Ambient" is read off the world: a referent's
 * per-relation count against the relation's own count. A referent is never
 * ambient because of how the field was built — the centre of an expansion is
 * in every tuple on the field, but not in every tuple of the relation.
 *
 * The view is a drawing. The working set is untouched; readers, tables and
 * removal keep speaking about the tuples as the world states them.
 */

import type { WorldReferent, WorldRelation } from "../api/world";
import type {
  FieldAssertion,
  FieldBond,
  Point,
  WorkingSet,
} from "./workingSet";

/** Referent id → the relations it is ambient in. */
export type Ambient = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * The relations this referent takes part in exhaustively — or none.
 *
 * A relation of one tuple is excluded: every referent in it is "in every
 * tuple", and saying so would frame every singleton claim away. And one
 * relation is not enough: two claims about the same proposition make it
 * exhaustive in a small relation while it is plainly what they are about. A
 * frame is exhaustive across relations — context threads through a world.
 */
export function ambientRelations(
  detail: Pick<WorldReferent, "relations">,
  relations: readonly Pick<WorldRelation, "name" | "count">[],
): Set<string> {
  const totals = new Map(relations.map((relation) => [relation.name, relation.count]));
  const out = new Set<string>();
  for (const item of detail.relations) {
    const total = totals.get(item.name);
    if (total !== undefined && total >= 2 && item.count === total) out.add(item.name);
  }
  return out.size >= 2 ? out : new Set();
}

/**
 * Referents worth asking the world about: on the field, and in every tuple of
 * some relation *that the field holds at least two of*. The world has the last
 * word; this only keeps the question to the few marks it could be true of.
 */
export function frameCandidates(set: WorkingSet): string[] {
  const byRelation = new Map<string, { spokes: { id: string }[] }[]>();
  const tuples = [...set.assertions.values(), ...set.bonds];
  for (const tuple of tuples) {
    const list = byRelation.get(tuple.relation) ?? [];
    list.push(tuple);
    byRelation.set(tuple.relation, list);
  }
  const out = new Set<string>();
  for (const list of byRelation.values()) {
    if (list.length < 2) continue;
    const [first, ...rest] = list;
    for (const spoke of first.spokes) {
      if (!set.referents.has(spoke.id)) continue;
      if (rest.every((tuple) => tuple.spokes.some((other) => other.id === spoke.id))) {
        out.add(spoke.id);
      }
    }
  }
  return [...out];
}

export type Frame = {
  id: string;
  label: string;
  /** Claims left with no varying referent: they are about the frame alone. */
  held: number;
};

export type FramedView = {
  view: WorkingSet;
  frames: Frame[];
  /** Claims drawn with fewer spokes than they have: their form is the view's. */
  reprojected: ReadonlySet<string>;
};

/** How far a property plate stands from the disc it describes. */
const PROPERTY_RADIUS = 78;

/**
 * Draw the working set with ambient roles taken out of the projection.
 *
 * Marks that change form get positions derived from what stands: a property
 * plate rings its referent, a plate reuses a position it already had. Nothing
 * that was already standing moves.
 *
 * `opened` holds claims that framing made binary and a person has opened back
 * into a plate — the same two forms a stored bond has, kept by the view
 * because the binary reading only exists in it.
 */
export function frameView(
  set: WorkingSet,
  ambient: Ambient,
  opened: ReadonlySet<string> = new Set(),
): FramedView {
  const none: ReadonlySet<string> = new Set();
  if (!ambient.size) return { view: set, frames: [], reprojected: none };
  const isAmbient = (relation: string, id: string) =>
    ambient.get(id)?.has(relation) ?? false;

  const assertions = new Map<string, FieldAssertion>();
  const bonds: FieldBond[] = [];
  const positions = new Map(set.positions);
  const framedOut = new Set<string>();
  const needed = new Set<string>();
  const held = new Map<string, number>();
  const ringed = new Map<string, number>();
  const reprojected = new Set<string>();

  const ring = (id: string, owner: string): Point => {
    const stored = set.positions.get(id);
    if (stored) return stored;
    const centre = set.positions.get(owner) ?? { x: 0, y: 0 };
    const index = ringed.get(owner) ?? 0;
    ringed.set(owner, index + 1);
    // Golden-angle steps: any count of plates spreads without a known total.
    const angle = -Math.PI / 2 + index * 2.39996;
    return {
      x: Math.round(centre.x + Math.cos(angle) * PROPERTY_RADIUS),
      y: Math.round(centre.y + Math.sin(angle) * PROPERTY_RADIUS),
    };
  };

  const place = (
    tuple: FieldAssertion | FieldBond,
    wasPlate: boolean,
  ) => {
    const kept = tuple.spokes.filter((spoke) => !isAmbient(tuple.relation, spoke.id));
    tuple.spokes
      .filter((spoke) => isAmbient(tuple.relation, spoke.id))
      .forEach((spoke) => framedOut.add(spoke.id));
    if (kept.length === tuple.spokes.length) {
      kept.forEach((spoke) => needed.add(spoke.id));
      if (wasPlate) assertions.set(tuple.assertion_id, tuple as FieldAssertion);
      else bonds.push(tuple as FieldBond);
      return;
    }
    kept.forEach((spoke) => needed.add(spoke.id));
    reprojected.add(tuple.assertion_id);
    const { source: _source, target: _target, ...rest } = tuple as FieldBond;
    const plate: FieldAssertion = { ...(rest as FieldAssertion), spokes: kept };
    if (kept.length === 0) {
      for (const spoke of tuple.spokes) {
        held.set(spoke.id, (held.get(spoke.id) ?? 0) + 1);
      }
      positions.delete(tuple.assertion_id);
      return;
    }
    const binary = kept.length === 2 && kept[0].id !== kept[1].id;
    if (binary && !opened.has(tuple.assertion_id)) {
      bonds.push({ ...plate, source: kept[0].id, target: kept[1].id });
      positions.delete(tuple.assertion_id);
      return;
    }
    assertions.set(tuple.assertion_id, plate);
    if (binary) {
      // Opened where the line was, as a stored bond opens.
      const ends = kept
        .map((spoke) => set.positions.get(spoke.id))
        .filter((point): point is Point => Boolean(point));
      positions.set(
        tuple.assertion_id,
        set.positions.get(tuple.assertion_id) ??
          (ends.length === 2
            ? {
                x: Math.round((ends[0].x + ends[1].x) / 2),
                y: Math.round((ends[0].y + ends[1].y) / 2),
              }
            : ring(tuple.assertion_id, kept[0].id)),
      );
      return;
    }
    if (kept.length === 1 || kept.length === 2) {
      positions.set(tuple.assertion_id, ring(tuple.assertion_id, kept[0].id));
    } else if (!wasPlate || !set.positions.has(tuple.assertion_id)) {
      const points = kept
        .map((spoke) => set.positions.get(spoke.id))
        .filter((point): point is Point => Boolean(point));
      // No end standing anywhere yet: a centroid over nothing is NaN, and a
      // NaN mark is invisible, unhittable, and poisons the harvest. Ring it
      // like a property plate instead — it re-seats once its ends land.
      positions.set(
        tuple.assertion_id,
        points.length
          ? {
              x: Math.round(points.reduce((sum, p) => sum + p.x, 0) / points.length),
              y: Math.round(points.reduce((sum, p) => sum + p.y, 0) / points.length),
            }
          : ring(tuple.assertion_id, kept[0].id),
      );
    }
  };

  for (const assertion of set.assertions.values()) place(assertion, true);
  for (const bond of set.bonds) place(bond, false);
  for (const demand of set.demands.values()) {
    demand.spokes.forEach((spoke) => needed.add(spoke.id));
  }

  const referents = new Map(set.referents);
  const frames: Frame[] = [];
  for (const id of framedOut) {
    if (needed.has(id) || !set.referents.has(id)) continue;
    referents.delete(id);
    positions.delete(id);
    frames.push({
      id,
      label: set.referents.get(id)?.label ?? id,
      held: held.get(id) ?? 0,
    });
  }
  if (!frames.length && framedOut.size === 0) {
    return { view: set, frames: [], reprojected: none };
  }

  return {
    view: { ...set, referents, assertions, bonds, positions },
    frames,
    reprojected,
  };
}

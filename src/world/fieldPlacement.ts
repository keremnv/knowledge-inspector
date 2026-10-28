/**
 * Where an explicitly placed mark lands, before the settle takes its slack.
 *
 * Geometry only: a free slot on a deterministic ring, and the bodies the
 * settle separates. World places referents through it from its working set,
 * and the captured-source field places verified records through it from its
 * own record field. What a mark *is* never reaches here — positions and the
 * room each one keeps are the whole of the input. Moved out of `workingSet`
 * unchanged when the source field became the second consumer.
 */

import type { Point } from "./workingSet";

/** Where new matter lands relative to what it came from. */
export const RING_RADIUS = 190;
export const RING_TIER = 120;
/**
 * What each kind of mark keeps around itself while the field settles.
 *
 * d3 separates two bodies by the sum of their radii, so these three numbers
 * are really the three clearances the field needs, expressed once each: two
 * discs end up 104 apart — inside the ring's own chord, which is 145 at eight
 * slots to a tier, so settling never collapses the fan that placed them — a
 * plate stays 70 from a disc centre, which is 25 clear of its edge, and two
 * plates stay 36 apart, which is the gap two chips need to read as two.
 */
export const DISC_BODY = 52;
export const PLATE_BODY = 18;

/**
 * How far the search will go before it gives up and takes the last slot.
 *
 * Eight tiers, which at `RING_TIER` apart reaches well past any field yet
 * placed.
 */
export const PROBES = 64;

/** Whether a mark of this size could sit here without landing on anything. */
export function slotClear(
  positions: ReadonlyMap<string, Point>,
  radiusOf: (id: string) => number,
  at: Point,
  radius: number,
  ignore?: string,
): boolean {
  for (const [id, existing] of positions) {
    if (id === ignore) continue;
    const apart = Math.hypot(existing.x - at.x, existing.y - at.y);
    if (apart < radius + radiusOf(id)) return false;
  }
  return true;
}

/**
 * Free space around an anchor.
 *
 * Angles are taken in a fixed order and skipped when something already sits
 * near them, so a second expansion of the same referent fans into the gaps the
 * first left rather than landing on top of it. Deterministic: the same
 * expansions in the same order always produce the same picture, which is what
 * makes a canvas something you can return to.
 *
 * The skipping has to happen here rather than be left to the settle, because
 * pushing marks apart cannot get one *out* of somewhere it should not have
 * been put. A disc dropped into a pocket of marks that surround it is pushed
 * equally from every side and stays exactly where it landed — a stable place
 * to be, and the wrong one. Collision opens a gap; it does not find a door.
 * So the slot has to be free before anything is placed in it.
 */
export function ringSlot(
  positions: ReadonlyMap<string, Point>,
  radiusOf: (id: string) => number,
  anchor: Point,
  taken: number,
  index: number,
): Point {
  let at = { x: anchor.x, y: anchor.y };
  for (let probe = 0; probe < PROBES; probe += 1) {
    const slot = taken + index + probe;
    const tier = Math.floor(slot / 8);
    const angle = -Math.PI / 2 + ((slot % 8) * Math.PI * 2) / 8 + tier * 0.4;
    const radius = RING_RADIUS + tier * RING_TIER;
    at = {
      x: Math.round(anchor.x + Math.cos(angle) * radius),
      y: Math.round(anchor.y + Math.sin(angle) * radius),
    };
    if (slotClear(positions, radiusOf, at, DISC_BODY)) return at;
  }
  return at;
}

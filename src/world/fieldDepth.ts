/**
 * The depth stack: which placed mark paints in front of which.
 *
 * Display state, like positions, and indifferent to what a mark stands for.
 * World keeps it on its working set and the captured-source field keeps it on
 * its own record field; both canvases stamp, predict and record drops through
 * these same calls, so a dropped mark comes to the front the same way on
 * either. Moved out of `workingSet` unchanged when the source field became the
 * second consumer.
 */

import {
  MARK_DEPTH_CEILING,
  MARK_DEPTH_STEP,
  markDepthZ,
  PAINT_LAYER_MARK,
  PAINT_LAYER_NAME,
} from "./fieldLayers";

/**
 * Drop order as paint, for the lane, the gesture, and the drop itself.
 *
 * Three readers, one sort: the draw lane stamps these numbers verbatim, a
 * drag predicts its drop's top from them before that drop exists, and the
 * drop records through them. Values already paint come back untouched — a
 * drop must not move a single standing number — and anything else is a
 * legacy sequence from before paint lived here, re-homed to dense ranks in
 * the order it already stood in. Paint lives strictly inside the mark
 * layer, so anything on the layer or past the names is a sequence by
 * elimination.
 */
export function paintDepths(
  depth: ReadonlyMap<string, number>,
): Map<string, number> {
  for (const z of depth.values()) {
    if (!(z > PAINT_LAYER_MARK && z < PAINT_LAYER_NAME)) {
      const order = rankedDepths(depth, [...depth.keys()].sort()).map(
        (entry) => entry.id,
      );
      return denseDepths(order);
    }
  }
  return new Map(depth);
}

/** Dense ranks, lowest first, laid out with the compression. */
function denseDepths(orderedIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  orderedIds.forEach((id, rank) =>
    out.set(id, markDepthZ(rank, orderedIds.length)),
  );
  return out;
}

/**
 * The stack after this drop, as paint — the one append all three readers
 * share, so the gesture's prediction, the drop's record, and the lane's
 * stamp cannot disagree about a single number.
 */
export function restackDepths(
  depth: ReadonlyMap<string, number>,
  id: string,
): Map<string, number> {
  const paint = paintDepths(depth);
  let top = PAINT_LAYER_MARK;
  for (const z of paint.values()) top = Math.max(top, z);
  // Already the top: a drop that fronts nothing restacks nothing.
  if (paint.has(id) && paint.get(id) === top) return paint;
  // Room to append: the mark takes one step above the top and every
  // standing number stays exactly where it was.
  if (top + MARK_DEPTH_STEP <= MARK_DEPTH_CEILING) {
    paint.set(id, top + MARK_DEPTH_STEP);
    return paint;
  }
  // The ceiling: ninety drops of headroom spent, so the stack is laid dense
  // again with this mark on top. Past eighty-nine stacked marks this binds
  // every drop, which is the old behavior kept as the floor for fields that
  // large — order-preserving throughout, so even there nothing swaps.
  const order = [...paint.keys()]
    .filter((key) => key !== id)
    .sort((a, b) => (paint.get(a) ?? 0) - (paint.get(b) ?? 0));
  order.push(id);
  return denseDepths(order);
}

/**
 * The paint a drop of this mark will stamp — what `restackDepths` records.
 *
 * The gesture reads this, not the formula: the grab rides the number the
 * release restates because both are the same call.
 */
export function restackTop(
  depth: ReadonlyMap<string, number>,
  id: string,
): number {
  return restackDepths(depth, id).get(id) ?? PAINT_LAYER_MARK;
}

/**
 * Drop order as ranks, for membership and order.
 *
 * One sort: the draw lane iterates it for the stacked marks in the frame,
 * stamping the paint `paintDepths` holds for each, and the dense paths size
 * from its count. `idsInFrameOrder` is the frame's node order — ties break
 * on it, the way creation order breaks unstacked marks. A mark with no
 * entry is unstacked and keeps the layer, which is the caller's to say, not
 * this sort's.
 */
export function rankedDepths(
  depth: ReadonlyMap<string, number>,
  idsInFrameOrder: string[],
): { id: string; rank: number; count: number }[] {
  return idsInFrameOrder
    .map((id, index) => ({ id, index }))
    .filter(({ id }) => depth.has(id))
    .sort(
      (a, b) =>
        (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0) || a.index - b.index,
    )
    .map(({ id }, rank, all) => ({ id, rank, count: all.length }));
}

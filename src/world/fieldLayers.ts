/** Renderer-independent layer numbers, shared by field models and paint. */
/**
 * Paint layers: strokes under marks under names.
 *
 * G6 inserts each born batch after everything standing, so data order only
 * ever layered one batch at a time — a stroke placed later painted over a
 * name placed earlier, whatever the lanes prepended. Stated `zIndex` is what
 * survives batching: G6 keeps an explicitly numbered element's layer on
 * every path that recomputes the others, and the renderer paints the sorted
 * list. Nodes are stated too, because a drag fronts its mark and the number
 * would otherwise ratchet past the names; the drop's redraw restates depth
 * from the set instead, so a dropped mark keeps the front its gesture gave
 * it — see `restack`.
 */
export const PAINT_LAYER_STROKE = 0;
export const PAINT_LAYER_MARK = 1;
export const PAINT_LAYER_NAME = 2;
/**
 * How far into the gap above the mark layer restacks may rise.
 *
 * Strictly less than the full gap to the name layer, so ranked depth —
 * marks, then the half-step their labels lift above them — can never reach
 * the names no matter how many drops land.
 */
export const MARK_DEPTH_SPAN = 0.9;

/**
 * How much paint one drop spends.
 *
 * A drop appends its mark one step above the current top and touches nothing
 * else — which is what keeps a release from renumbering the whole stack the
 * way rank-over-count compression did. A hundredth of a layer: ninety drops
 * to the ceiling, and the lift a label needs between two bands is half of
 * one step, still four orders above float dust.
 */
export const MARK_DEPTH_STEP = 0.01;

/**
 * The highest paint a drop may append.
 *
 * One step of label air below the span's top, so the topmost mark's own
 * labels still have a band to stand in. A drop that would land past it lays
 * the stack dense first — the compression below, kept as the rare path — so
 * the ceiling costs one reshuffle per ninety drops instead of one per drop.
 */
export const MARK_DEPTH_CEILING =
  PAINT_LAYER_MARK + MARK_DEPTH_SPAN - MARK_DEPTH_STEP;

/**
 * A stacked mark's paint depth from its rank in a dense stack.
 *
 * The dense assignment: first paint, ceiling renormalization, and legacy
 * migration all lay the stack out with this. Drops between ceilings do not
 * call it — they append one step above the top and leave every stamped
 * number standing, which is what makes a release silent past its own mark.
 * Rank is 0-based and count is the stack's size.
 */
export function markDepthZ(rank: number, count: number): number {
  return PAINT_LAYER_MARK + ((rank + 1) / (count + 1)) * MARK_DEPTH_SPAN;
}

/** The original World paint-order law, shared without domain ownership.
 * Drops keep their depth; names ride their endpoints and the same attention
 * rank that resolves visibility. Neither context supplies its own layer tuning. */
import type { CanvasDatum } from './canvasMotion';
import { paintDepths, rankedDepths } from './fieldDepth';
import { MARK_DEPTH_STEP, NAME_RANK_SPAN, PAINT_LAYER_MARK, PAINT_LAYER_NAME } from './marks';
import { compareRanks, type VisibilityRank } from './visibility';

export function stampFieldPaint(nodes: CanvasDatum[], edges: CanvasDatum[], depth: ReadonlyMap<string, number>,
  rank: (id: string, font: unknown) => VisibilityRank) {
  /**
   * Depth, stated: drops restack within the mark layer — see `restack`.
   *
   * G6 fronts the held mark for the gesture and the drop's redraw would
   * otherwise sink it back to its creation slot, behind whatever it now
   * overlaps. Ranked, not sequenced: the fractions always land strictly
   * between the mark layer and the name layer however many drops land, so
   * no normalization pass ever owes anyone a visit. Marks with no entry
   * keep the layer's own `zIndex` and paint in creation order behind every
   * restacked mark — an empty stack is exactly today's drawing.
   */
  const nodeById = new Map(
    (nodes as { id: string; style?: Record<string, unknown> }[]).map(
      (datum) => [datum.id, datum] as const,
    ),
  );
  const stackedDepths = rankedDepths(
    depth,
    (nodes as { id: string }[]).map((datum) => datum.id),
  );
  // Stamped verbatim: these numbers are the drops' own record, and
  // restating anything else's is the reshuffle step two killed.
  const depthPaint = paintDepths(depth);
  for (const { id } of stackedDepths) {
    const style = nodeById.get(id)?.style;
    const z = depthPaint.get(id);
    if (!style || z === undefined) continue;
    style.zIndex = z;
  }
  const stackedCount = stackedDepths.length;
  /**
   * Labels sink with occluded owners, and rise with rank.
   *
   * A label at the name layer paints over every mark, including one
   * stacked above the mark it names — a hidden plate impersonating the
   * disc hiding it. So a labeled edge lifts half a drop step above its
   * fronter endpoint: over its own marks, under any mark stacked above
   * them, because the next band up is always at least a step away. A
   * fixed lift, not half the band it stands in — a new top landing
   * overhead must not move it, and half the band would halve with every
   * ceiling the stack climbs toward. Past eighty-nine stacked marks the
   * dense bands narrow below a step, and the lift takes half the band
   * instead: the same floor the marks stand on. Strictly between the
   * bands by construction, and the span cap keeps the topmost label below
   * the names. Unlabeled strokes keep the stroke layer — they never
   * needed to beat a mark.
   *
   * Within the lift, rank decides: the labels sort strongest-first by the
   * same `rankOfLabel` the strength pass settles, so the brighter of two
   * overlapping names is also the one on top. Endpoint depth still
   * dominates — rank only orders labels that share a base — because a
   * bright plate over the disc hiding its endpoint would be the same
   * impersonation. With no restack every label shares the name layer as
   * its base, and rank orders the whole field instead of creation order.
   */
  const rankShare = new Map(
    (
      edges as {
        id: string;
        style?: Record<string, unknown>;
      }[]
    )
      .filter(
        (edge) =>
          typeof edge.style?.labelText === "string" && edge.style.labelText,
      )
      .map((edge) => ({
        id: edge.id,
        rank: rank(edge.id, edge.style?.labelFontFamily),
      }))
      .sort(
        (a, b) =>
          compareRanks(a.rank, b.rank) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .map(
        (entry, index, all) =>
          [entry.id, (all.length - index) / all.length] as const,
      ),
  );
  const markZ = new Map<string, number>();
  for (const datum of nodes as {
    id: string;
    style?: Record<string, unknown>;
  }[]) {
    const z = datum.style?.zIndex;
    markZ.set(datum.id, typeof z === "number" ? z : PAINT_LAYER_MARK);
  }
  // Half the room above the base, capped at half a drop step — the cap
  // is what keeps a new top from moving every label standing under it.
  const liftOver = (over: number): number => {
    let next = PAINT_LAYER_NAME;
    for (const z of markZ.values()) {
      if (z > over && z < next) next = z;
    }
    return Math.min(MARK_DEPTH_STEP / 2, (next - over) / 2);
  };
  for (const edge of edges as {
    id: string;
    source?: unknown;
    target?: unknown;
    style?: Record<string, unknown>;
  }[]) {
    const style = edge.style;
    if (!style) continue;
    if (typeof style.labelText !== "string" || !style.labelText) continue;
    const over = stackedCount
      ? Math.max(
          typeof edge.source === "string"
            ? (markZ.get(edge.source) ?? PAINT_LAYER_MARK)
            : PAINT_LAYER_MARK,
          typeof edge.target === "string"
            ? (markZ.get(edge.target) ?? PAINT_LAYER_MARK)
            : PAINT_LAYER_MARK,
        )
      : PAINT_LAYER_NAME;
    const lift = stackedCount ? liftOver(over) : NAME_RANK_SPAN;
    style.zIndex = over + lift * (rankShare.get(edge.id) ?? 1);
  }
}

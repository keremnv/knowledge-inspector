/**
 * One visibility rule for every name on the field.
 *
 * Labels used to hide themselves from local geometry, each site with its own
 * boolean — a bond too wide for its span, a role pair too close on one
 * filament — and a crowded junction went quiet exactly where a person was
 * looking. This turns hiding into losing: every intended label stays laid
 * out, and where boxes overlap the lower rank yields in proportion to the
 * crowding. Nothing moves off its line; strength is the only thing contested.
 *
 * Pure geometry and rank in, strengths out. The lanes feed it rendered boxes
 * (so fans and fonts are already accounted for) and apply the strengths to
 * the text channel only — the knockout ground stays opaque, because a dimmed
 * name with its gap intact still reads, while a ghosted ground lets strokes
 * through the whisper.
 *
 * Rank is shared, not duplicated: the field lane computes the tuple once in
 * `rankOfLabel`, and the strength pass settles ink from it while the frame
 * author stamps paint order from it — the brighter of two overlapping names
 * is also the one on top. Occlusion flows the other way: marks report their
 * bodies and depth, and a name fully under a mark standing above it leaves
 * the fight. Ink follows rank; paint follows rank; pressure respects paint.
 */

import { FONT_MONO_FAMILY } from "../styles/typography";

/** The floor under sustained crowding: a whisper, not an absence. */
export const VISIBILITY_WHISPER = 0.25;

/**
 * Whether crowding settles label strengths.
 *
 * Off for now: every name stays at its full authored strength and the
 * passes skip their box reads. Rank still computes — paint order keeps
 * following it — and flipping this back to `true` restores the dimming,
 * with settled strengths returning through the normal restore fade.
 *
 * Off as in the original (`f761911`), by the owner's decision O16: names
 * are layered in depth order without opacity. KI-016 had turned it on.
 */
export const VISIBILITY_STRENGTHS_ON = false;

/**
 * Fractions of the yielding name's area. A fresh contact must cover more
 * than a continuing one, so grazing a boundary does not repeatedly relight
 * it. At full pressure the text reaches its whisper; the curve eases into
 * both ends. Relative area gives a short name and a long one the same rule,
 * independent of the camera's scale.
 */
export const VISIBILITY_ENTER_COVERAGE = 0.08;
export const VISIBILITY_RELEASE_COVERAGE = 0.04;
export const VISIBILITY_FULL_COVERAGE = 0.6;
/** Ignore sub-level ink changes while yielded, so tiny geometry noise settles. */
const STRENGTH_TOLERANCE = 1 / 255;

export type VisibilityBox = {
  id: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type VisibilityRank = {
  /** Selection outranks pointer attention and incidental names. */
  selection: boolean;
  /** The pointer's mark reads while it is looked at. */
  hover: boolean;
  /** Named by light, within naming reach of the attention. */
  named: boolean;
  /** Structural names outrank qualifying ones. Lower wins. */
  kind: number;
};

/** Plates, bonds and counts (sans) outrank spoke roles (mono). */
export function visibilityKindOf(labelFontFamily: unknown): number {
  return labelFontFamily === FONT_MONO_FAMILY ? 1 : 0;
}

/**
 * An opaque mark standing over the names.
 *
 * Only node bodies occlude: strokes are what grounds knock out, not what
 * knocks names out. `z` is the authored paint depth — only a mark strictly
 * above a label can bury it, so a name never occludes itself off its own
 * mark, and an edge label never off its own endpoints, which it is lifted
 * above.
 */
export type VisibilityOccluder = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  z: number;
};

export type VisibilityOcclusion = {
  occluders: readonly VisibilityOccluder[];
  /** Authored paint depth per label; a label with no entry always fights. */
  depths: ReadonlyMap<string, number>;
};

function rankOf(rank: VisibilityRank): readonly [number, number, number, number] {
  return [
    rank.selection ? 0 : 1,
    rank.hover ? 0 : 1,
    rank.named ? 0 : 1,
    rank.kind,
  ];
}

/**
 * Rank order, shared: the strength pass settles ink in this order and the
 * frame author stamps paint in it, so the brighter of two overlapping names
 * is also the one on top.
 */
export function compareRanks(a: VisibilityRank, b: VisibilityRank): number {
  const ra = rankOf(a);
  const rb = rankOf(b);
  for (let i = 0; i < ra.length; i += 1) {
    if (ra[i] !== rb[i]) return ra[i] - rb[i];
  }
  return 0;
}

function overlapArea(a: VisibilityBox, b: VisibilityBox): number {
  const x = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  if (x <= 0) return 0;
  const y = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  if (y <= 0) return 0;
  return x * y;
}

/**
 * Strength per label: 1 reads, increasing crowding yields toward a whisper.
 *
 * Resolve from strongest to weakest. Equal ranks keep the incumbent, with
 * id order breaking opening ties; selection and hover override that memory
 * immediately. A name already yielding exerts less pressure on the next one,
 * so a crowded junction does not turn every pair into another full contest.
 * Multiple contacts use their strongest pressure, not repeated opacity
 * multiplication. Only the text yields; its knockout and mark keep standing.
 *
 * A name fully buried under a mark standing above it is out of the fight:
 * it presses nothing, because dimming by an invisible rival reads as the
 * field inventing crowding. It still resolves its own strength, so an
 * un-burying finds settled ink rather than a pop.
 */
export function resolveVisibility(
  boxes: readonly VisibilityBox[],
  ranks: ReadonlyMap<string, VisibilityRank>,
  prev: ReadonlyMap<string, number>,
  occlusion?: VisibilityOcclusion,
): Map<string, number> {
  const strengths = new Map<string, number>();
  for (const box of boxes) strengths.set(box.id, 1);
  const buried = new Set<string>();
  if (occlusion) {
    for (const box of boxes) {
      const z = occlusion.depths.get(box.id);
      if (z === undefined) continue;
      for (const mark of occlusion.occluders) {
        if (
          mark.z > z &&
          mark.minX <= box.minX &&
          mark.minY <= box.minY &&
          mark.maxX >= box.maxX &&
          mark.maxY >= box.maxY
        ) {
          buried.add(box.id);
          break;
        }
      }
    }
  }
  const ordered = boxes.filter((box) => ranks.has(box.id)).sort((a, b) =>
    compareRanks(ranks.get(a.id)!, ranks.get(b.id)!) ||
    (prev.get(b.id) ?? 1) - (prev.get(a.id) ?? 1) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (let i = 0; i < ordered.length; i += 1) {
    const box = ordered[i];
    const area = (box.maxX - box.minX) * (box.maxY - box.minY);
    if (!(area > 0)) continue;
    let coverage = 0;
    for (let j = 0; j < i; j += 1) {
      const stronger = ordered[j];
      if (buried.has(stronger.id)) continue;
      coverage = Math.max(coverage,
        overlapArea(box, stronger) / area * strengths.get(stronger.id)!,
      );
    }
    const continuing = (prev.get(box.id) ?? 1) < 1;
    if (coverage <= (continuing ? VISIBILITY_RELEASE_COVERAGE : VISIBILITY_ENTER_COVERAGE)) continue;
    const pressure = Math.min(1, (coverage - VISIBILITY_RELEASE_COVERAGE) /
      (VISIBILITY_FULL_COVERAGE - VISIBILITY_RELEASE_COVERAGE));
    const eased = pressure * pressure * (3 - 2 * pressure);
    const strength = 1 - (1 - VISIBILITY_WHISPER) * eased;
    const previous = prev.get(box.id) ?? 1;
    strengths.set(box.id, continuing && strength > VISIBILITY_WHISPER &&
      Math.abs(strength - previous) < STRENGTH_TOLERANCE ? previous : strength);
  }
  return strengths;
}

type RendererBox = { min: [number, number]; max: [number, number] };
type Shaped = {
  getShape?: (name: string) => Shaped | undefined;
  getBounds?: () => RendererBox | undefined;
};

/**
 * One shape's bounds, read off the renderer.
 *
 * Takes the graph as unknown so this module stays free of G6: only the shape
 * of the renderer is assumed, and a graph that does not have it simply has
 * no readable boxes. A shape G6 has not built yet has no box, and the caller
 * keeps its last answer rather than inventing one.
 */
function paintedShapeBox(
  graph: unknown,
  id: string,
  pick: (element: Shaped) => RendererBox | undefined,
): Omit<VisibilityBox, "id"> | null {
  const context = (
    graph as {
      context?: { element?: { getElement?: (id: string) => unknown } };
    } | null
  )?.context;
  let element: unknown;
  try {
    // A method call, not a detached function: the lookup reaches other
    // element methods through its receiver — see `liveElement`.
    element = context?.element?.getElement?.(id);
  } catch {
    return null;
  }
  if (!element || typeof element !== "object") return null;
  let bounds: RendererBox | undefined;
  try {
    bounds = pick(element as Shaped);
  } catch {
    return null;
  }
  if (!bounds) return null;
  const [minX, minY] = bounds.min;
  const [maxX, maxY] = bounds.max;
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
  if (!(maxX > minX && maxY > minY)) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * The box a name actually occupies on the canvas, or null when it cannot be
 * read.
 *
 * Asked of the renderer rather than re-derived, because only the stroke knows
 * where its fan took the name, and only the laid-out text knows how wide the
 * word is in this face — SelectionAnts learnt both the hard way. The plate
 * (background) is the box when there is one, because the plate is what
 * occludes; a bare name reads its own bounds.
 */
export function paintedLabelBox(
  graph: unknown,
  id: string,
): Omit<VisibilityBox, "id"> | null {
  return paintedShapeBox(graph, id, (element) => {
    const label = element.getShape?.("label");
    return (
      label?.getShape?.("background")?.getBounds?.() ?? label?.getBounds?.()
    );
  });
}

/**
 * The box a mark's body actually occupies, or null when it cannot be read.
 *
 * The key shape only — never the element's own bounds, which include the
 * name the mark carries. A body's own name sits on it, not under it, so
 * reading the element would bury every name off its own mark.
 */
export function paintedMarkBox(
  graph: unknown,
  id: string,
): Omit<VisibilityBox, "id"> | null {
  return paintedShapeBox(
    graph,
    id,
    (element) => element.getShape?.("key")?.getBounds?.(),
  );
}

/**
 * State a label's settled strength onto built data.
 *
 * Without this a transition repaints every label at full strength and the
 * pass yields the losers after — a flash on every arrival. The base comes
 * from the record once seen: a style may already carry a stamped strength
 * (a lane re-mapping memo-stable data, or the pass stamping the baseline),
 * so re-reading the style as a base would compound the whisper every frame.
 * First sight records the builder's fresh value, which is the only sight
 * that can still be unstamped.
 */
export function stampLabelStrength(
  datum: { id: string; style?: Record<string, unknown> },
  remembered: Map<string, { strength: number; base: number }>,
): void {
  const style = datum.style;
  if (!style) return;
  if (typeof style.labelText !== "string" || !style.labelText) return;
  const record = remembered.get(datum.id);
  const base =
    record?.base ??
    (typeof style.labelFillOpacity === "number" ? style.labelFillOpacity : 1);
  const strength = record?.strength ?? 1;
  if (!record) remembered.set(datum.id, { strength, base });
  const stated = base * strength;
  if (!Object.is(style.labelFillOpacity, stated)) {
    style.labelFillOpacity = stated;
  }
}

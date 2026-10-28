/**
 * Where a connection runs beneath a record it does not join, say so.
 *
 * Strokes lie beneath discs, as in World, so a line that crosses an unrelated
 * disc vanishes at its rim and reappears on the far side: read at a glance it
 * ends there. In PR #60's Stack Exchange investigation (I2) the line from
 * emakalic to answer 876 crossed answer 874 and was read as "emakalic → 874".
 *
 * This draws the hidden part of such a line across the disc it passes under,
 * in the disc's own label colour, faint at rest and plain while that
 * connection is selected, broken around the disc's name so the name stays
 * readable. Nothing moves and nothing is joined: positions, endpoints, layout,
 * the strokes themselves and World's canvas are untouched. Like the selection
 * ants, it is a screen-space overlay re-read from the canvas as it is drawn,
 * panned, zoomed, dragged or fanned, so it follows every mark the renderer
 * moves. It speaks only of what is drawn: a hidden connection or a hidden
 * table's records draw nothing to cross or be crossed.
 */
import { useEffect, useRef, useState } from "react";
import type { Graph } from "@antv/g6";
import { SPREAD_FRAME_EVENT } from "../world/spread";
import type { PlacedReference } from "./sourceField";

const CARRIER = "source-carrier:";

type Vec = [number, number];
type Box = { min: Vec; max: Vec };
/** One visible piece of a line, where it passes beneath a disc it does not join. */
export type PassThrough = { carrier: string; reference: string; under: string; from: Vec; to: Vec };

/** The part of segment a→b inside the circle, as a parameter range, or null. */
function insideCircle(a: Vec, b: Vec, centre: Vec, radius: number): [number, number] | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const fx = a[0] - centre[0], fy = a[1] - centre[1];
  const qa = dx * dx + dy * dy;
  if (!(qa > 0)) return null;
  const qb = 2 * (fx * dx + fy * dy), qc = fx * fx + fy * fy - radius * radius;
  const disc = qb * qb - 4 * qa * qc;
  if (disc <= 0) return null;
  const root = Math.sqrt(disc);
  const t0 = Math.max(0, (-qb - root) / (2 * qa)), t1 = Math.min(1, (-qb + root) / (2 * qa));
  return t1 > t0 ? [t0, t1] : null;
}

/** The parameter range of segment a→b inside an axis-aligned box (Liang–Barsky), or null. */
function insideBox(a: Vec, b: Vec, box: Box): [number, number] | null {
  let t0 = 0, t1 = 1;
  const d = [b[0] - a[0], b[1] - a[1]];
  for (const axis of [0, 1] as const) {
    if (Math.abs(d[axis]) < 1e-9) {
      if (a[axis] < box.min[axis] || a[axis] > box.max[axis]) return null;
      continue;
    }
    let u0 = (box.min[axis] - a[axis]) / d[axis], u1 = (box.max[axis] - a[axis]) / d[axis];
    if (u0 > u1) [u0, u1] = [u1, u0];
    t0 = Math.max(t0, u0); t1 = Math.min(t1, u1);
    if (t0 >= t1) return null;
  }
  return [t0, t1];
}

const lerp = (a: Vec, b: Vec, t: number): Vec => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/**
 * The pieces of each drawn line that lie beneath a disc other than its own two,
 * minus the box of that disc's name. Canvas coordinates in, canvas coordinates out.
 * A graze shorter than `least` is left alone: it touches no more than a rim.
 */
export function passThroughs(
  lines: ReadonlyArray<{ carrier: string; reference: string; ends: [string, string]; legs: ReadonlyArray<[Vec, Vec]> }>,
  discs: ReadonlyArray<{ id: string; centre: Vec; radius: number; name: Box | null }>,
  least = 2,
): PassThrough[] {
  const found: PassThrough[] = [];
  // Discs by grid cell, so a line meets only the discs near it: an uncapped
  // expansion (O8.9) can put thousands of records and lines on one canvas.
  // A cell is the widest disc across, so a disc the segment touches has its
  // centre within one cell of a point sampled every half cell along it.
  type Disc = (typeof discs)[number];
  const cell = Math.max(1, ...discs.map((disc) => disc.radius * 2));
  const keyOf = (x: number, y: number) => x * 1_000_003 + y;
  const grid = new Map<number, Disc[]>();
  for (const disc of discs) {
    const key = keyOf(Math.floor(disc.centre[0] / cell), Math.floor(disc.centre[1] / cell));
    const bucket = grid.get(key);
    if (bucket) bucket.push(disc); else grid.set(key, [disc]);
  }
  const near = (a: Vec, b: Vec) => {
    const cells = new Set<number>(), found = new Set<Disc>();
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (cell / 2)));
    for (let i = 0; i <= steps; i++) {
      const x = Math.floor((a[0] + (b[0] - a[0]) * i / steps) / cell), y = Math.floor((a[1] + (b[1] - a[1]) * i / steps) / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) cells.add(keyOf(x + dx, y + dy));
    }
    for (const key of cells) for (const disc of grid.get(key) ?? []) found.add(disc);
    return found;
  };
  for (const line of lines) {
    for (const [a, b] of line.legs) {
      for (const disc of near(a, b)) {
        if (line.ends.includes(disc.id)) continue;
        const span = insideCircle(a, b, disc.centre, disc.radius);
        if (!span) continue;
        const from = lerp(a, b, span[0]), to = lerp(a, b, span[1]);
        if (Math.hypot(to[0] - from[0], to[1] - from[1]) < least) continue;
        const named = disc.name ? insideBox(from, to, disc.name) : null;
        const pieces: [Vec, Vec][] = named ? [[from, lerp(from, to, named[0])], [lerp(from, to, named[1]), to]] : [[from, to]];
        for (const [p, q] of pieces) {
          if (Math.hypot(q[0] - p[0], q[1] - p[1]) >= least) found.push({ carrier: line.carrier, reference: line.reference, under: disc.id, from: p, to: q });
        }
      }
    }
  }
  return found;
}

/** A stroke's drawn path, as straight legs: `M x y L x y …`, as a string or a path array. */
function legsOf(d: unknown): [Vec, Vec][] {
  const points: Vec[] = [];
  if (typeof d === "string") {
    for (const match of d.matchAll(/[ML]\s*(-?[\d.eE+-]+)[\s,]+(-?[\d.eE+-]+)/g)) points.push([Number(match[1]), Number(match[2])]);
  } else if (Array.isArray(d)) {
    for (const command of d) if (Array.isArray(command) && (command[0] === "M" || command[0] === "L")) points.push([Number(command[1]), Number(command[2])]);
  }
  const legs: [Vec, Vec][] = [];
  for (let i = 1; i < points.length; i++) if (points.slice(i - 1, i + 1).every((p) => p.every(Number.isFinite))) legs.push([points[i - 1], points[i]]);
  return legs;
}

type Element = { getShape: (name: string) => { attributes?: Record<string, unknown>; getRenderBounds?: () => Box } | undefined;
  attributes?: Record<string, unknown> } | undefined;

/** What the renderer is drawing now: Source's strokes and discs, in canvas coordinates. */
function measure(graph: Graph) {
  const element = (id: string): Element => (graph as unknown as { context?: { element?: { getElement: (id: string) => Element } } })
    .context?.element?.getElement(id);
  const bounds = (shape: ReturnType<NonNullable<Element>["getShape"]>): Box | null => {
    try { const box = shape?.getRenderBounds?.(); return box && [...box.min, ...box.max].every(Number.isFinite) ? box : null; } catch { return null; }
  };
  // One stroke per pair of records, owned by one of the pair's references.
  const lines = [];
  for (const edge of graph.getEdgeData()) {
    const carrier = String(edge.id);
    if (!carrier.startsWith(CARRIER)) continue;
    const legs = legsOf(element(carrier)?.getShape("key")?.attributes?.d);
    if (legs.length) lines.push({ carrier, reference: carrier.slice(CARRIER.length), ends: [String(edge.source), String(edge.target)] as [string, string], legs });
  }
  const discs = [];
  for (const node of graph.getNodeData()) {
    const id = String(node.id), drawn = element(id);
    const body = bounds(drawn?.getShape("key"));
    if (!body || Number(drawn?.attributes?.opacity ?? 1) < 0.5) continue;
    const name = bounds(drawn?.getShape("label"));
    const pad = 2;
    discs.push({ id, centre: [(body.min[0] + body.max[0]) / 2, (body.min[1] + body.max[1]) / 2] as Vec, radius: (body.max[0] - body.min[0]) / 2,
      name: name ? { min: [name.min[0] - pad, name.min[1] - pad] as Vec, max: [name.max[0] + pad, name.max[1] + pad] as Vec } : null });
  }
  return { lines, discs };
}

/**
 * The overlay. `references` are the drawn connections; only the first of each
 * pair carries a stroke (the field draws one line per pair), the rest share it.
 */
export function SourcePassThrough({ graph, references, selected, color, lineWidth, traceToken }: {
  graph: Graph | null;
  references: ReadonlyArray<PlacedReference>;
  selected: string | null;
  color: string;
  lineWidth: number;
  /** Changes with every frame the canvas authors, so the overlay re-reads. */
  traceToken: unknown;
}) {
  const [pieces, setPieces] = useState<{ reference: string; under: string; from: Vec; to: Vec; width: number }[]>([]);
  const retrace = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!graph || graph.destroyed) { setPieces([]); return; }
    let frame = 0, still = 0, last = "";
    const update = () => {
      frame = 0;
      if (graph.destroyed) return;
      let next: typeof pieces = [];
      try {
        const { lines, discs } = measure(graph);
        const zoom = Math.max(0.05, graph.getZoom() || 1);
        next = passThroughs(lines, discs).map((piece) => {
          const from = graph.getViewportByCanvas(piece.from), to = graph.getViewportByCanvas(piece.to);
          return { reference: piece.reference, under: piece.under, from: [from[0], from[1]] as Vec, to: [to[0], to[1]] as Vec, width: Math.max(1, lineWidth * zoom) };
        });
      } catch {
        next = [];
      }
      const signature = JSON.stringify(next.map((p) => [p.reference, p.under, ...p.from.map(Math.round), ...p.to.map(Math.round)]));
      if (signature !== last) { last = signature; still = 0; setPieces(next); } else still += 1;
      // Marks arrive, leave and settle over several frames: keep reading until still.
      if (still < 8) frame = requestAnimationFrame(update);
    };
    const schedule = () => {
      still = 0;
      if (!frame) frame = requestAnimationFrame(update);
    };
    retrace.current = schedule;
    const container = graph.getCanvas().getContainer();
    const observer = new ResizeObserver(schedule);
    if (container) { observer.observe(container); container.addEventListener(SPREAD_FRAME_EVENT, schedule); }
    graph.on("node:drag", schedule);
    graph.on("aftertransform", schedule);
    graph.on("afterdraw", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      if (container) container.removeEventListener(SPREAD_FRAME_EVENT, schedule);
      graph.off("node:drag", schedule);
      graph.off("aftertransform", schedule);
      graph.off("afterdraw", schedule);
      if (retrace.current === schedule) retrace.current = null;
    };
  }, [graph, lineWidth]);

  useEffect(() => { retrace.current?.(); }, [traceToken, references]);

  // A connection selected is one of the pair's references; its stroke is the pair's.
  const chosen = references.find((reference) => reference.elementId === selected);
  const pairOf = (id: string) => {
    const reference = references.find((item) => item.elementId === id);
    return reference ? [reference.child, reference.parent].sort().join("\u0000") : null;
  };
  const selectedPair = chosen ? [chosen.child, chosen.parent].sort().join("\u0000") : null;
  if (!pieces.length) return null;
  return <svg className="source-pass" style={{ color }} aria-hidden="true">
    {pieces.map((piece, index) => {
      const lit = selectedPair !== null && pairOf(piece.reference) === selectedPair;
      return <line key={`${piece.reference}:${piece.under}:${index}`} data-pass-through={piece.reference} data-pass-under={piece.under}
        data-selected={lit || undefined} className={`source-pass__line${lit ? " is-selected" : ""}`}
        x1={piece.from[0]} y1={piece.from[1]} x2={piece.to[0]} y2={piece.to[1]} strokeWidth={piece.width} />;
    })}
  </svg>;
}

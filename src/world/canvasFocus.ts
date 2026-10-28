/**
 * Bring a mark into the visible remainder of the field.
 *
 * The product canvas flies with zoom (`flyCameraTo`). World pans only: the
 * neighborhood is already at the scale someone grew it to, and a table row
 * naming a mark that is already on the field should not re-frame the rest.
 *
 * The destination is the centre of what the overlays leave, not the centre of
 * the G6 host. Tables and the reader sit *over* the canvas rather than shrinking
 * it, so a fit to the host would land the mark under a panel.
 *
 * The field frames what a person introduced, not a point: a claim with the
 * discs it joins, an expansion with the neighbours it brought — measured off
 * the drawn extents, labels included, and never by moving a mark. The first
 * framing of an empty field composes it in the middle; after that the camera
 * is the person's, and a reveal moves it only as far as the new material
 * needs. No flight changes zoom. See `revealDelta`.
 */

import { useEffect, useRef, type RefObject } from "react";
import type { Graph } from "@antv/g6";
import { DEFAULT_MOTION_PLANS, type MotionPlan } from "../styles/motion";

export type CameraInsets = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

const flights = new WeakMap<Graph, () => void>();

export function cancelPan(graph: Graph) {
  flights.get(graph)?.();
}

function hasNode(graph: Graph, id: string): boolean {
  try {
    return Boolean(graph.getNodeData(id));
  } catch {
    return false;
  }
}

function hasEdge(graph: Graph, id: string): boolean {
  try {
    return Boolean(graph.getEdgeData(id));
  } catch {
    return false;
  }
}

/**
 * The drawing's id for a mark the tables know by assertion, obligation, or
 * relation name. A binary assertion is `bond:<id>`; a schema plate is `rel:<name>`;
 * a filament keeps the relation name as its edge id.
 */
export function resolveFocusId(graph: Graph, id: string): string | null {
  if (hasNode(graph, id)) return id;
  if (!id.startsWith("rel:") && hasNode(graph, `rel:${id}`)) return `rel:${id}`;
  if (!id.startsWith("bond:") && hasEdge(graph, `bond:${id}`)) return `bond:${id}`;
  if (hasEdge(graph, id)) return id;
  return null;
}

function canvasPoint(graph: Graph, id: string): [number, number] | null {
  /**
   * An edge first. G6 answers `getElementPosition` for an edge with the
   * edge's own `[0, 0, 0]` — truthy — so asking it first sent every bond and
   * filament focus to the canvas origin, which is wherever the field's first
   * seed stands, and the midpoint below was never reached.
   */
  if (!hasEdge(graph, id)) {
    const position = graph.getElementPosition(id);
    return position ? [position[0], position[1]] : null;
  }
  const edge = graph.getEdgeData(id);
  if (!edge) return null;
  const from = graph.getElementPosition(String(edge.source));
  const to = graph.getElementPosition(String(edge.target));
  if (!from || !to) return null;
  return [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** A rectangle in viewport pixels of the G6 host. */
export type Box = { left: number; top: number; right: number; bottom: number };

/** Smaller than this, the remainder has nowhere to bring anything. */
const ROOM_MIN = 48;

/** What the overlays leave of the host: where a reveal may bring things. */
export function visibleRoom(
  width: number,
  height: number,
  insets: CameraInsets,
): Box | null {
  const room = {
    left: insets.left,
    top: insets.top,
    right: width - insets.right,
    bottom: height - insets.bottom,
  };
  return room.right - room.left < ROOM_MIN || room.bottom - room.top < ROOM_MIN
    ? null
    : room;
}

/** The smallest box holding all of these. */
export function unionBox(boxes: readonly Box[]): Box | null {
  if (!boxes.length) return null;
  return {
    left: Math.min(...boxes.map((box) => box.left)),
    top: Math.min(...boxes.map((box) => box.top)),
    right: Math.max(...boxes.map((box) => box.right)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
  };
}

/**
 * How far to translate the camera so `target` reads inside `room`.
 *
 * Pure: viewport boxes in, a viewport delta out. Per axis:
 *
 * - **Reveal** (the default). A target that fits moves by the shortest path to
 *   inside, and one already inside does not move at all — a person's camera
 *   is left alone unless the new material actually needs it.
 * - **Compose** (`centre`). The target is centred in the room. Only for an
 *   establishment, when no one has framed this field yet.
 * - **Too large** for the room, in either mode, the target is centred and
 *   then held so `keep` — the anchor or the claim asked for — stays inside.
 *   The camera does not zoom out to make it fit: a neighbourhood shrunk until
 *   every name is illegible has not been shown. What is left over is reached
 *   by panning, zooming, or naming it from the reader or a table.
 */
export function revealDelta(
  target: Box,
  room: Box,
  options: { keep?: Box; centre?: boolean } = {},
): [number, number] {
  const axis = (
    lo: number,
    hi: number,
    start: number,
    end: number,
    keepLo: number | undefined,
    keepHi: number | undefined,
  ): number => {
    if (!options.centre && hi - lo <= end - start) {
      if (lo < start) return start - lo;
      if (hi > end) return end - hi;
      return 0;
    }
    let delta = (start + end) / 2 - (lo + hi) / 2;
    if (keepLo !== undefined && keepHi !== undefined) {
      if (keepHi - keepLo > end - start) {
        delta = (start + end) / 2 - (keepLo + keepHi) / 2;
      } else {
        delta = Math.min(Math.max(delta, start - keepLo), end - keepHi);
      }
    }
    return delta;
  };
  return [
    axis(target.left, target.right, room.left, room.right, options.keep?.left, options.keep?.right),
    axis(target.top, target.bottom, room.top, room.bottom, options.keep?.top, options.keep?.bottom),
  ];
}

/**
 * Where an element is drawn, in viewport pixels: its painted extent — a
 * disc, a plate or a bond with its name — not its centre.
 */
export function elementBox(graph: Graph, id: string): Box | null {
  try {
    const bounds = graph.getElementRenderBounds(id);
    const a = graph.getViewportByCanvas(bounds.min as never);
    const b = graph.getViewportByCanvas(bounds.max as never);
    const box = {
      left: Math.min(a[0], b[0]),
      top: Math.min(a[1], b[1]),
      right: Math.max(a[0], b[0]),
      bottom: Math.max(a[1], b[1]),
    };
    return Object.values(box).every(Number.isFinite) ? box : null;
  } catch {
    return null;
  }
}

/**
 * `translateBy`, safe from G's zero.
 *
 * G's landmark setters read a zero in a typed vector as an omitted
 * coordinate, so a move whose camera lands exactly on 0 on one axis is
 * silently dropped on that axis. Composing a lone seed hits it every time —
 * the disc starts at the host's corner and is centred by exactly half the
 * host — and the seed stayed on the top edge. Same remedy as the
 * vocabulary's fit: a hundredth of a viewport pixel.
 */
function translateCamera(graph: Graph, delta: [number, number]) {
  const zoom = graph.getZoom() || 1;
  const camera = graph.getCanvas().getCamera();
  const position = camera.getPosition();
  const focalPoint = camera.getFocalPoint();
  const safe: [number, number] = [delta[0], delta[1]];
  for (const axis of [0, 1] as const) {
    if (
      Math.fround(position[axis] - safe[axis] / zoom) === 0 ||
      Math.fround(focalPoint[axis] - safe[axis] / zoom) === 0
    ) safe[axis] -= 0.01;
  }
  return graph.translateBy(safe, false);
}

/**
 * Carry the camera by `delta`, tracking `anchor` (a canvas point) so the
 * flight lands where it was aimed even if a draw nudges the camera under it.
 *
 * The one camera animation this module runs. A newer flight, a person's
 * wheel or press (`cancelPan`), or the graph going away ends it where it is.
 * Reduced motion cuts to the same destination.
 */
async function flyBy(
  graph: Graph,
  anchor: [number, number],
  delta: [number, number],
  plan: MotionPlan,
): Promise<void> {
  const start = graph.getViewportByCanvas(anchor);
  const destX = start[0] + delta[0];
  const destY = start[1] + delta[1];
  if (Math.hypot(delta[0], delta[1]) < 2) return;

  cancelPan(graph);

  const cut = reducedMotion() || plan.durationMs <= 1;
  if (cut) {
    const now = graph.getViewportByCanvas(anchor);
    await translateCamera(graph, [destX - now[0], destY - now[1]]);
    return;
  }

  await new Promise<void>((resolve) => {
    let frame = 0;
    let cancelled = false;
    const started = performance.now();
    const cancel = () => {
      cancelled = true;
      if (frame) cancelAnimationFrame(frame);
      if (flights.get(graph) === cancel) flights.delete(graph);
      resolve();
    };
    flights.set(graph, cancel);

    const step = () => {
      frame = 0;
      if (cancelled || graph.destroyed) {
        resolve();
        return;
      }
      const elapsed = performance.now() - started;
      const progress = Math.min(1, elapsed / plan.durationMs);
      const eased = plan.easing.sample(progress);
      const wantX = start[0] + (destX - start[0]) * eased;
      const wantY = start[1] + (destY - start[1]) * eased;
      const now = graph.getViewportByCanvas(anchor);
      const dx = wantX - now[0];
      const dy = wantY - now[1];
      if (dx || dy) {
        void translateCamera(graph, [dx, dy]);
      }
      if (progress >= 1) {
        if (flights.get(graph) === cancel) flights.delete(graph);
        resolve();
        return;
      }
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
  });
}

export async function panToElement(
  graph: Graph,
  id: string,
  insets: CameraInsets,
  plan: MotionPlan = DEFAULT_MOTION_PLANS.settle,
): Promise<void> {
  const resolved = resolveFocusId(graph, id);
  if (!resolved) return;
  const target = canvasPoint(graph, resolved);
  if (!target) return;
  const [width, height] = graph.getSize();
  if (!width || !height) return;

  const visibleLeft = insets.left;
  const visibleRight = width - insets.right;
  const visibleTop = insets.top;
  const visibleBottom = height - insets.bottom;
  if (visibleRight - visibleLeft < 48 || visibleBottom - visibleTop < 48) return;

  // Reveal, not recenter. The mark comes inside the margin by the shortest
  // path, and a mark already showing holds the camera still — centering here
  // slid the whole field on every table click, which read as the labels
  // moving rather than the camera. The margin shrinks with the view so a
  // small window still has somewhere to bring things.
  const margin = Math.min(
    80,
    (visibleRight - visibleLeft) / 4,
    (visibleBottom - visibleTop) / 4,
  );
  const start = graph.getViewportByCanvas(target);
  let dx = 0;
  let dy = 0;
  if (start[0] < visibleLeft + margin) dx = visibleLeft + margin - start[0];
  else if (start[0] > visibleRight - margin) dx = visibleRight - margin - start[0];
  if (start[1] < visibleTop + margin) dy = visibleTop + margin - start[1];
  else if (start[1] > visibleBottom - margin) dy = visibleBottom - margin - start[1];
  await flyBy(graph, target, [dx, dy], plan);
}

/**
 * Frame a focused element with what it is drawn with — see `revealDelta`.
 *
 * `extra` widens the target (an expansion's new neighbours); the focused
 * element itself is what must stay in view when the target cannot.
 */
export async function frameElements(
  graph: Graph,
  focus: string,
  extra: readonly string[],
  insets: CameraInsets,
  options: { centre: boolean; plan?: MotionPlan; measure?: (graph: Graph, id: string) => Box | null },
): Promise<boolean> {
  const [width, height] = graph.getSize();
  if (!width || !height) return false;
  const room = visibleRoom(width, height, insets);
  const measure = options.measure ?? elementBox;
  const keep = measure(graph, focus);
  if (!room || !keep) return false;
  const boxes = [keep];
  for (const id of extra) {
    const box = measure(graph, id);
    if (box) boxes.push(box);
  }
  const target = unionBox(boxes)!;
  const delta = revealDelta(target, room, { keep, centre: options.centre });
  const point = canvasPoint(graph, focus);
  if (!point) return false;
  await flyBy(graph, point, delta, options.plan ?? DEFAULT_MOTION_PLANS.settle);
  return true;
}

/**
 * How the field frames a focus, beyond the bare reveal the vocabulary keeps.
 *
 * Absent, `useFocusPan` reveals the mark's point as it always has.
 */
export type FieldFraming = {
  /** More marks the request brings with it — an expansion's neighbours. */
  with?: readonly string[];
  /** The marks a focused element is drawn with: a claim's referents. */
  participants: (graph: Graph, drawnId: string) => string[];
  /**
   * False until this field has a viewpoint — a restored camera, a centred
   * standing field, a person's wheel or press, or the first framing. While
   * false the framing composes; after, it only reveals.
   */
  established: RefObject<boolean>;
  /**
   * Bumped by every wheel and press on the field. A request that sees it
   * move while waiting for the drawing gives the camera up: whatever the
   * person did is newer than the request.
   */
  intent: RefObject<number>;
  /** A held pointer owns the field; a request arriving under it yields. */
  holding: () => boolean;
  /**
   * The extent an element is framed by, when its drawn bounds mid-arrival
   * would answer differently from its bounds at rest. Absent, the painted
   * extent — see `elementBox`.
   */
  extent?: (graph: Graph, id: string) => Box | null;
};

/** Frames the renderer is given to draw what a request names. */
const DRAW_WAIT_FRAMES = 120;

/**
 * Fly to a mark after the renderer has it. Table placement often selects in
 * the same tick the tuple is folded in, so the first look can miss.
 *
 * With `field`, the request waits for every element it names — the claim and
 * its referents, or the expansion's neighbours — so it measures the completed
 * frame, not an intermediate one. A newer request, a person's wheel or press,
 * or the graph going away ends a request at any point, including a flight
 * already under way.
 */
export function useFocusPan(
  graphRef: RefObject<Graph | null>,
  ready: boolean,
  focusId: string | null | undefined,
  focusToken: number,
  insetsRef: RefObject<CameraInsets>,
  /**
   * Hold the room's camera recorder across the flight, when the room keeps
   * one. A flight ends at a mark the next visit will not have selected, so
   * its endpoint must not spend the framing the person left — see
   * `cameraMemory`.
   */
  holdCamera?: () => () => void,
  field?: FieldFraming,
) {
  const tokenRef = useRef(focusToken);
  const fieldRef = useRef(field);
  fieldRef.current = field;
  useEffect(() => {
    if (!focusId || !focusToken) return;
    const graph = graphRef.current;
    if (!ready || !graph || graph.destroyed) return;
    tokenRef.current = focusToken;
    let cancelled = false;
    const framing = fieldRef.current;
    // Only the newest request flies. One already under way toward an older
    // mark stops where it is, even if this one turns out to need no move.
    if (framing) cancelPan(graph);
    const intent = framing?.intent.current ?? 0;
    const stale = () =>
      cancelled ||
      graph.destroyed ||
      tokenRef.current !== focusToken ||
      (framing ? framing.intent.current !== intent : false);

    const present = (): string | null =>
      graph.destroyed ? null : resolveFocusId(graph, focusId);

    /** The focused element and everything it is drawn with, once drawn. */
    const drawn = (): { id: string; extra: string[] } | null => {
      const id = present();
      if (!id) return null;
      if (!framing) return { id, extra: [] };
      const extra = [
        ...framing.participants(graph, id),
        ...(framing.with ?? []),
      ];
      const resolved = extra.map((item) => resolveFocusId(graph, item));
      return resolved.every(Boolean)
        ? { id, extra: resolved as string[] }
        : null;
    };

    const run = async () => {
      let found = drawn();
      if (!found) {
        found = await new Promise<{ id: string; extra: string[] } | null>((resolve) => {
          let frames = 0;
          const finish = (result: { id: string; extra: string[] } | null) => {
            graph.off("afterdraw", onDraw);
            resolve(result);
          };
          const onDraw = () => {
            const result = drawn();
            if (result) finish(result);
          };
          graph.on("afterdraw", onDraw);
          const tick = () => {
            if (stale()) {
              finish(null);
              return;
            }
            const result = drawn();
            if (result) {
              finish(result);
              return;
            }
            frames += 1;
            if (frames > (framing ? DRAW_WAIT_FRAMES : 45)) {
              // Something named never drew — a neighbour a filter keeps
              // off, say. Frame what did, as long as the mark itself did.
              const id = present();
              finish(
                framing && id
                  ? {
                      id,
                      extra: [
                        ...framing.participants(graph, id),
                        ...(framing.with ?? []),
                      ].flatMap((item) => {
                        const resolved = resolveFocusId(graph, item);
                        return resolved ? [resolved] : [];
                      }),
                    }
                  : null,
              );
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      }
      if (!found || stale()) return;
      if (framing?.holding()) return;
      const release = holdCamera?.();
      try {
        if (!framing) {
          await panToElement(graph, found.id, insetsRef.current);
          return;
        }
        const centre = !framing.established.current;
        if (
          await frameElements(graph, found.id, found.extra, insetsRef.current, {
            centre,
            measure: framing.extent,
          })
        ) {
          framing.established.current = true;
        }
      } finally {
        release?.();
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [focusId, focusToken, graphRef, insetsRef, ready, holdCamera]);
}

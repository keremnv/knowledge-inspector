/**
 * Marching ants — the selection mark, carried over from the product canvas.
 *
 * The ancestor is `explorations/SelectionAntRing`, which the frozen product
 * graph still uses. Everything load-bearing about it is kept: a screen-space
 * SVG driven by graph-space coordinates, so the beads stay crisp through pan,
 * zoom and drag; a bead count locked to the *graph-space* path length, so mid
 * zoom keeps the same dotted look; a count that drops rather than letting beads
 * fuse, so the mark is never a solid outline; and arrival and departure on the
 * kernel's own `emit` and `absorb`, because a selection that fades in is a
 * thing that *became* selected where one that blinks is indistinguishable from
 * a redraw.
 *
 * What is new is that World IR has three kinds of mark and the ring only knew
 * one. A referent is a disc, so it takes a circle. A binary assertion has no
 * mark of its own at all: it *is* the filament between two discs, so the beads
 * march along that line.
 *
 * A plate is the case the first version got wrong. It took a rectangle held
 * off the plate's edge, which drew **a rectangle around a rectangle** — two
 * outlines for one mark, and the eye reads the pair as a frame rather than as
 * a selected thing. A plate already *has* a border. So the ants become it: the
 * plate's own stroke is dropped, the path is traced on exactly the edge the
 * stroke occupied, and the handover is invisible because the beads start solid
 * in precisely its place. Then the dash morphs from solid to dotted, and only
 * then does it travel.
 *
 * A plate whose border is already dotted — `unresolved` — skips the morph. Its
 * border is already the thing the morph was reaching for, so transforming it
 * would be an animation from a value to itself.
 *
 * In each case the ants trace the geometry the mark already has rather than a
 * shape imposed on it, which is the whole reason this reads as selection and a
 * halo reads as a smudge. The plate is now the most literal instance of that:
 * the ants are not near its geometry, they *are* it.
 *
 * That generalisation is why this is a second component rather than a prop on
 * the first. The ring draws a `<circle>`, and the product's stylesheet animates
 * `.gdna__ant-ring circle` by that element name; a path can express all three
 * shapes, and swapping the element would silently stop the frozen product's
 * beads from marching. The two are kept apart deliberately — see
 * `world/carryover.md`.
 */

import { useEffect, useRef, useState } from "react";
import type { Graph } from "@antv/g6";
import { motionPoseKeyframes, type MotionPlans } from "./motion";
import { useMotion } from "./useMotion";
import { MARK_DEFAULTS } from "../world/marks";
import { SPREAD_FRAME_EVENT } from "../world/spread";
import "./selectionAnts.css";

/**
 * What to draw around, named by the mark's own geometry.
 *
 * The caller says which shape because only the caller knows what the mark
 * means: a disc is a circle because a referent is a mass, not because it
 * happens to measure square. Size comes from the renderer — a plate is as wide
 * as the word in it, and asking the graph is how the ants stay correct when
 * that word changes.
 */
/**
 * `clearance` is the air between the mark's edge and the beads.
 *
 * It applies to the marks the ants stand *off*: a disc, whose filled body has
 * no border to take over, and a filament, whose ends are inside the discs it
 * joins. A plate has no clearance and takes none — the ants land on its own
 * border, so any air at all would put the second rectangle back.
 *
 * `dotted` says the mark's border already is what the ants are about to
 * become, so the solid-to-dotted morph is skipped and the beads simply start
 * travelling.
 */
export type AntTarget =
  | { shape: "circle"; id: string; diameter: number; clearance?: number }
  | { shape: "rect"; id: string; dotted?: boolean }
  | {
      shape: "edge-label";
      id: string;
      text?: string;
      trim?: number;
      clearance?: number;
      dotted?: boolean;
    }
  /** An edge: `trim` is how much of each end is inside the mark it leaves. */
  | { shape: "line"; id: string; trim: number; clearance?: number };

type Traced = { d: string; screenLength: number; graphLength: number };

/**
 * Whether this target's ants *are* the mark's border rather than a ring around
 * it — which is what decides how they arrive.
 *
 * A disc and a filament have nothing to take over, so they emit: they scale up
 * from the pose the mark itself emits from, and a selection you can see become
 * one. A plate's border already exists and is already in the right place, so
 * scaling would move something a person did not move. It changes pattern
 * instead.
 */
function isBorder(
  target: AntTarget,
): target is Extract<AntTarget, { shape: "rect" | "edge-label" }> {
  return target.shape === "rect" || target.shape === "edge-label";
}

/** Solid, expressed in the same two-number form the dotted pattern uses. */
const SOLID_DASH = "100 0";

/**
 * Temporarily off: the selection ring's scale-in on arrival and scale-out on
 * absorb. The plays stay below so the effect comes back by flipping this to
 * `true`; while off, rings arrive and leave at full size. Borders never scaled
 * — they morph dashes — so they are untouched either way.
 */
const SCALE_ARRIVAL = false;

/**
 * Experiment: the march never pauses while a mark is in hand.
 *
 * The hold pause below stays so the old answer comes back by flipping this to
 * `false`: the grip listeners reattach, the `held` prop takes hold again, and
 * beads stop under the pointer. While on, both paths are cut and the ants
 * march through hold and drag. The still DNA (`speed <= 0`) and reduced-motion
 * users are untouched — this is only about the app's own pause, not a request
 * to be still.
 */
const MARCH_THROUGH_HOLD = true;

function trace(
  graph: Graph,
  target: AntTarget,
  clearance: number,
): Traced | null {
  const zoom = Math.max(0.05, graph.getZoom() || 1);
  // A plate carries no clearance field at all, because there is no number that
  // would be right: its ants are its border.
  const standoff = target.shape === "rect" ? 0 : (target.clearance ?? clearance);
  const gap = standoff * zoom;
  /**
   * A mark's position, or nothing — and nothing includes `[null, null, 0]`.
   *
   * That is what G6 answers for a body still nucleating, and it is an array,
   * so a plain truthiness check lets it through. Projected, it becomes `NaN`,
   * and the ring is painted as `d="M NaN NaN A 45 45 …"` — an SVG error per
   * frame for as long as the marching loop runs. Refusing to trace is right:
   * the loop already retries, and a body that has no position yet has no
   * boundary for ants to march along.
   */
  const placed = (point: ArrayLike<number> | null | undefined): boolean =>
    Boolean(point) && Number.isFinite(point![0]) && Number.isFinite(point![1]);
  const at = (id: string) => {
    const point = graph.getElementPosition(id);
    if (!placed(point)) return null;
    const view = graph.getViewportByCanvas(point);
    return { x: view[0], y: view[1] };
  };

  if (target.shape === "circle") {
    const centre = at(target.id);
    if (!centre) return null;
    const r = (target.diameter / 2) * zoom + gap;
    // Two half-arcs rather than a `<circle>`: one element has to be able to be
    // all three shapes, or the dash pattern and the march would each need a
    // per-shape branch in CSS as well as here.
    const d =
      `M ${centre.x - r} ${centre.y}` +
      ` A ${r} ${r} 0 1 0 ${centre.x + r} ${centre.y}` +
      ` A ${r} ${r} 0 1 0 ${centre.x - r} ${centre.y} Z`;
    const screenLength = 2 * Math.PI * r;
    return { d, screenLength, graphLength: screenLength / zoom };
  }

  if (target.shape === "rect") {
    /**
     * The plate's own rect, from its position and size.
     *
     * Not `getElementRenderBounds`, which is the union of everything the
     * element draws — and a plate's label ink is *taller than its plate*. A
     * 71x10 plate reported 71x16 render bounds, so the ring stood 3px proud
     * top and bottom while matching the width, which is why it read as very
     * nearly right and still wrong. Position and size are what the plate was
     * built from, so this cannot disagree with it.
     */
    const centre = graph.getElementPosition(target.id);
    const datum = graph.getNodeData(target.id) as
      | { style?: { size?: number | [number, number] } }
      | undefined;
    const size = datum?.style?.size;
    if (!placed(centre) || size === undefined) return null;
    const [w, h] = typeof size === "number" ? [size, size] : size;
    const a = graph.getViewportByCanvas([centre[0] - w / 2, centre[1] - h / 2]);
    const b = graph.getViewportByCanvas([centre[0] + w / 2, centre[1] + h / 2]);
    // No gap. The caller drops the plate's own stroke while it is the target,
    // so this rect is the one the stroke was on and the beads land where it
    // was standing. Anything added here is the second rectangle again.
    const x0 = Math.min(a[0], b[0]);
    const x1 = Math.max(a[0], b[0]);
    const y0 = Math.min(a[1], b[1]);
    const y1 = Math.max(a[1], b[1]);
    const d = `M ${x0} ${y0} H ${x1} V ${y1} H ${x0} Z`;
    const screenLength = 2 * (x1 - x0 + (y1 - y0));
    return { d, screenLength, graphLength: screenLength / zoom };
  }

  if (target.shape === "edge-label") {
    const edge = graph.getEdgeData(target.id);
    if (!edge) return null;
    if (!at(String(edge.source)) || !at(String(edge.target))) return null;
    const text =
      target.text ||
      (typeof edge.style?.labelText === "string" ? edge.style.labelText : "") ||
      "";
    if (text) {
      /**
       * Prefer the background the renderer actually painted, in *world*
       * space. `getRenderBounds` is already camera-projected; converting
       * that through `getViewportByCanvas` was the box that drifted under
       * pan and zoom. `getBounds` is the AABB the plate occupies in the
       * graph, which is the same space node positions live in.
       */
      type Box = { min: [number, number]; max: [number, number] };
      type Shaped = {
        getShape?: (name: string) => Shaped | undefined;
        getBounds?: () => Box | undefined;
      };
      const label = (
        graph as unknown as {
          context?: { element?: { getElement?: (id: string) => Shaped } };
        }
      ).context?.element?.getElement?.(target.id)?.getShape?.("label");
      const painted =
        label?.getShape?.("background")?.getBounds?.() ?? label?.getBounds?.();
      const a = painted ? graph.getViewportByCanvas(painted.min) : null;
      const b = painted ? graph.getViewportByCanvas(painted.max) : null;
      if (!a || !b) {
        /**
         * No painted plate yet: trace nothing and let the retry find it.
         * Re-deriving the placement here duplicated G6's minus the fan and
         * the stack, so it drew a confident box where the name was not.
         */
        return null;
      }
      const x0 = Math.min(a[0], b[0]);
      const x1 = Math.max(a[0], b[0]);
      const y0 = Math.min(a[1], b[1]);
      const y1 = Math.max(a[1], b[1]);
      const d = `M ${x0} ${y0} H ${x1} V ${y1} H ${x0} Z`;
      const screenLength = 2 * (x1 - x0 + (y1 - y0));
      return { d, screenLength, graphLength: screenLength / zoom };
    }
  }

  const edge = graph.getEdgeData(target.id);
  if (!edge) return null;
  const from = at(String(edge.source));
  const to = at(String(edge.target));
  if (!from || !to) return null;
  const span = Math.hypot(to.x - from.x, to.y - from.y);
  const trim =
    target.shape === "line"
      ? target.trim
      : (target.trim ?? MARK_DEFAULTS.discDiameter / 2);
  const inset = trim * zoom + gap;
  // A filament shorter than the two discs it joins has no free length to march
  // along, and beads drawn on it would sit inside the marks. Nothing is drawn
  // rather than something wrong; the lit palette still says what is selected.
  if (span <= inset * 2 + 8) return null;
  const ux = (to.x - from.x) / span;
  const uy = (to.y - from.y) / span;
  const x0 = from.x + ux * inset;
  const y0 = from.y + uy * inset;
  const x1 = to.x - ux * inset;
  const y1 = to.y - uy * inset;
  const screenLength = span - inset * 2;
  return {
    d: `M ${x0} ${y0} L ${x1} ${y1}`,
    screenLength,
    graphLength: screenLength / zoom,
  };
}

export function SelectionAnts({
  graph,
  target,
  clearance,
  dotGap,
  lineWidth,
  speed,
  color,
  motion,
  arrivalDelay = 0,
  animated = true,
  held: contactHeld = false,
  traceToken,
  gone,
}: {
  graph: Graph | null;
  target: AntTarget | null;
  /** Default air between the mark's edge and the beads, in graph units. */
  clearance: number;
  /** Bead spacing along the path, in graph units. */
  dotGap: number;
  lineWidth: number;
  /** Screen pixels per second the beads travel; 0 holds them still. */
  speed: number;
  color: string;
  motion: MotionPlans;
  /** Hold a new ring until the mass it names has finished arriving. */
  arrivalDelay?: number;
  animated?: boolean;
  /** Pointer contact pauses a selected field before drag threshold is crossed. */
  held?: boolean;
  /**
   * Retrace when this changes, without replaying the arrival.
   *
   * Restations write straight into the renderer (`element.update` in the
   * restyle path) and emit nothing this overlay hears — no draw, no
   * transform — so a selected bond's label could cross to the far end while
   * its box stayed behind. The field passes its station subjects: their
   * identity changes exactly when a label may have moved, and the retrace
   * only re-reads where the plate now stands.
   */
  traceToken?: unknown;
  /**
   * True when the named mark has left the field rather than merely lost the
   * selection. A dying mark takes its ants with it at once: the leave below
   * hands the border back to a stroke that is about to redraw, and a removed
   * mark redraws nothing. Omitted, every leave hands off as before.
   */
  gone?: (id: string) => boolean;
}) {
  const [drawn, setDrawn] = useState<AntTarget | null>(target);
  const [arrival, setArrival] = useState(0);
  const held = useRef<AntTarget | null>(target);
  const pathRef = useRef<SVGPathElement | null>(null);
  /** The dotted pattern as last written, so the morph has a real destination. */
  const dash = useRef(SOLID_DASH);
  /** How long the march holds off, so it starts when the morph has landed. */
  const march = useRef(0);
  const revealAt = useRef(0);
  /** Armed by an arrival, fired by the first `update` that has a pattern. */
  const morph = useRef(false);
  /** So the tracing effect can reach the spine without depending on it. */
  const motionRef = useRef(motion);
  motionRef.current = motion;
  /** So the leave can ask whether its mark died without refiring on the set. */
  const goneRef = useRef(gone);
  goneRef.current = gone;
  /** The live tracer's coalesced retrace, for `traceToken` to call. */
  const retrace = useRef<(() => void) | null>(null);
  const lifecycle = useMotion<SVGPathElement>();
  // The identity of what is selected, so the effects below fire when the
  // selection changes and not on every render of the canvas around them.
  const key = target ? JSON.stringify(target) : null;

  useEffect(() => {
    if (target) {
      revealAt.current = performance.now() + Math.max(0, arrivalDelay);
      held.current = target;
      setDrawn(target);
      setArrival((run) => run + 1);
      return;
    }
    if (!held.current) return;
    if (!animated || goneRef.current?.(held.current.id)) {
      held.current = null;
      setDrawn(null);
      return;
    }
    // A border leaves by going back to being one: the beads close up into the
    // solid rect the plate's own stroke is about to redraw, and the mark is
    // never seen without an edge. A ring has no such destination and absorbs —
    // while its scale is off, it simply goes.
    if (!SCALE_ARRIVAL && held.current && !isBorder(held.current)) {
      held.current = null;
      setDrawn(null);
      return;
    }
    const leaving = lifecycle.play(
      isBorder(held.current)
        ? [{ strokeDasharray: dash.current }, { strokeDasharray: SOLID_DASH, opacity: 0 }]
        : motionPoseKeyframes({ scale: 1, opacity: 1 }, { scale: 0.86, opacity: 0 }),
      motion.absorb,
      {
        fill: "forwards",
        onFinish: () => {
          held.current = null;
          setDrawn(null);
        },
      },
    );
    if (!leaving) {
      held.current = null;
      setDrawn(null);
    }
    // `key` stands for `target`: the object is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animated, arrivalDelay, key, lifecycle, motion.absorb]);

  useEffect(() => {
    if (!animated || !arrival || !key || !drawn) return;
    if (!isBorder(drawn)) {
      if (!SCALE_ARRIVAL) return;
      lifecycle.play(
        motionPoseKeyframes({ scale: 0.86, opacity: 0 }, { scale: 1, opacity: 1 }),
        motion.emit,
        { fill: "both", delay: arrivalDelay },
      );
      return;
    }
    /**
     * A plate whose border is already dotted has nothing to transform into.
     * The beads take over a pattern identical to the one they replace, so
     * what a person sees is the border they were already looking at starting
     * to travel — no morph, and no delay before the march.
     */
    if (isBorder(drawn) && drawn.dotted) {
      march.current = 0;
      return;
    }
    /**
     * Otherwise the morph runs, and the march waits for it.
     *
     * It is armed here and fired by `update` rather than started here, and the
     * difference is one visible frame. The bead pattern is written by the
     * effect below, which has not run on this pass; waiting a frame for it
     * meant the dots were painted once before the morph replaced them with
     * solid — a pop, at the exact moment the thing is supposed to look
     * continuous. Firing where the pattern is written costs nothing and means
     * the first painted frame is already the solid border the plate just gave
     * up.
     */
    march.current = motion.emit.durationMs;
    morph.current = true;
  }, [animated, arrival, arrivalDelay, drawn, key, lifecycle, motion.emit]);

  useEffect(() => {
    const path = pathRef.current;
    if (!graph || graph.destroyed || !drawn || !path) return;

    let frame = 0;
    let misses = 0;
    const update = () => {
      if (graph.destroyed) return;
      if (performance.now() < revealAt.current) {
        path.style.visibility = "hidden";
        frame = requestAnimationFrame(() => {
          frame = 0;
          update();
        });
        return;
      }
      let traced: Traced | null = null;
      try {
        traced = trace(graph, drawn, clearance);
      } catch {
        traced = null;
      }
      if (!traced) {
        path.style.visibility = "hidden";
        // Placement often selects before the mark has been drawn. afterdraw
        // will retry; a few frames cover the gap when that event has already
        // fired with the node still missing.
        if (misses < 12) {
          misses += 1;
          frame = requestAnimationFrame(() => {
            frame = 0;
            update();
          });
        }
        return;
      }
      misses = 0;
      // Beads are counted on the path as it exists in the world, not as it is
      // currently magnified, so zooming moves the ants closer together on
      // screen without ever re-spacing them. The screen length only decides
      // when they would fuse.
      const wanted = Math.max(
        1,
        Math.round(traced.graphLength / Math.max(0.01, dotGap)),
      );
      const fits = Math.max(3, Math.floor(traced.screenLength / (lineWidth + 1)));
      const beads = Math.min(wanted, fits);
      const cycle =
        speed <= 0 ? 0 : Math.max(0.25, traced.screenLength / speed);
      path.setAttribute("d", traced.d);
      dash.current = `0 ${100 / beads}`;
      path.setAttribute("stroke-dasharray", dash.current);
      path.style.setProperty("--ants-cycle", cycle > 0 ? `${cycle}s` : "0s");
      path.style.setProperty("--ants-march-delay", `${march.current}ms`);
      /**
       * Cleared, not set to `visible`.
       *
       * The field canvas stays mounted under vocabulary focus and is hidden by
       * `.world__layer.is-parked { visibility: hidden }`. Visibility inherits,
       * but an inline `visible` on a descendant *overrides* an inherited
       * hidden — so a `visible` here kept the parked canvas's selection ring
       * marching on top of the schema view, a ring around a mark that was not
       * on screen. Clearing the property lets the layer decide, which is who
       * knows.
       */
      path.style.visibility = "";
      if (morph.current) {
        morph.current = false;
        lifecycle.play(
          [{ strokeDasharray: SOLID_DASH }, { strokeDasharray: dash.current }],
          motionRef.current.emit,
          { fill: "none" },
        );
      }
    };

    const schedule = () => {
      if (document.documentElement.classList.contains("is-panel-resizing")) {
        return;
      }
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };

    // Marching pauses while a mark is in hand — held, not dragged — unless
    // the march-through experiment is on; see `MARCH_THROUGH_HOLD`.
    //
    // A drag cannot happen without a hold, so hanging this off `dragstart`
    // only meant the march survived the part of the gesture where the mark
    // was already under the pointer and already about to move. Held is the
    // thing a person did; the drag is what they may or may not go on to do
    // with it — the same move the fan made in WorldCanvas, off the same
    // `node:pointerdown`. The release is the window's, because a hold can
    // end anywhere: off the mark, off the canvas, or cancelled outright.
    const grip = (grabbed: boolean) => () => {
      path.classList.toggle("is-held", grabbed);
    };
    const grab = grip(true);
    const release = grip(false);

    const observer = new ResizeObserver(schedule);
    const container = graph.getCanvas().getContainer();
    if (container) observer.observe(container);
    // The spread field's own announcement. Fan frames write straight into
    // the renderer and emit nothing G6 hears — no draw, no transform — so
    // without this a label the fan moved kept the box from where it stood.
    // `schedule` coalesces the frames to one retrace each.
    if (container) container.addEventListener(SPREAD_FRAME_EVENT, schedule);
    if (!MARCH_THROUGH_HOLD) {
      graph.on("node:pointerdown", grab);
      window.addEventListener("pointerup", release);
      window.addEventListener("pointercancel", release);
      // Switching away mid-hold delivers no pointerup.
      window.addEventListener("blur", release);
    }
    retrace.current = schedule;
    graph.on("node:drag", schedule);
    graph.on("aftertransform", schedule);
    graph.on("afterdraw", schedule);
    const classes = new MutationObserver(() => {
      if (document.documentElement.classList.contains("is-panel-resizing")) {
        return;
      }
      schedule();
    });
    classes.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    update();
    /**
     * And once more after the paint, for what the canvas applies late.
     *
     * This overlay's effects run before its canvas's: a restyle the same
     * commit authored — a restationed label above all — lands after the trace
     * above read. The scheduled pass re-reads once the frame has settled, so
     * the box ends where the plate now stands rather than where it stood. The
     * first trace still lands pre-paint, so nothing flickers between them.
     */
    schedule();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      if (container) container.removeEventListener(SPREAD_FRAME_EVENT, schedule);
      classes.disconnect();
      graph.off("node:pointerdown", grab);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
      if (retrace.current === schedule) retrace.current = null;
      graph.off("node:drag", schedule);
      graph.off("aftertransform", schedule);
      graph.off("afterdraw", schedule);
    };
  }, [clearance, dotGap, drawn, graph, lifecycle, lineWidth, speed]);

  // Only a retrace, scheduled past the canvas's own commit — the token
  // changes on every hover, so it must not rebuild the tracer.
  useEffect(() => {
    retrace.current?.();
  }, [traceToken]);

  if (!drawn) return null;

  return (
    <svg className="ants" style={{ color }} aria-hidden="true">
      <path
        ref={(element) => {
          pathRef.current = element;
          lifecycle.ref.current = element;
        }}
        className={`ants__mark${speed <= 0 ? " is-still" : ""}${
          contactHeld && !MARCH_THROUGH_HOLD ? " is-held" : ""
        }`}
        d=""
        pathLength={100}
        fill="none"
        stroke="currentColor"
        strokeWidth={lineWidth}
        strokeLinecap="round"
        strokeDasharray="0 5"
        style={{ visibility: "hidden" }}
      />
    </svg>
  );
}

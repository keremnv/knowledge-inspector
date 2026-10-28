/**
 * Element lifecycle for World canvases.
 *
 * A mark enters from a 4% nucleation pin at its authored position and leaves
 * by being absorbed back into it. Edges have no centre to scale around, so
 * they release through opacity. Both consume the shared motion plans.
 *
 * Only identity arriving or leaving is animated. Marks that were already on
 * the field are written directly, because `STILL_RULES.marksNeverMove`: a
 * field that re-poses what is already standing has moved something nobody
 * asked it to move. Drag release is the same rule — the mark stays exactly
 * where the pointer left it, with no settle.
 */

import type { Graph } from "@antv/g6";
import {
  DEFAULT_MOTION_PLANS,
  NODE_BIRTH_PLAN,
  NODE_COLLAPSE_PLAN,
  staggerWaves,
  type MotionPlan,
} from "../styles/motion";
import { g6KeyframeMotion } from "../styles/motionG6";

export type CanvasDatum = {
  id: string;
  source?: string;
  target?: string;
  style?: Record<string, unknown>;
};

export type CanvasData = {
  nodes: CanvasDatum[];
  edges: CanvasDatum[];
};

export type CanvasTransition = {
  bornNodes: CanvasDatum[];
  bornEdges: CanvasDatum[];
  diedNodeIds: string[];
  diedEdgeIds: string[];
};

export type CanvasMotionOptions = {
  /** Present in the working set but hidden by an observer filter. */
  retainedNode?: (id: string) => boolean;
  /** Already belonged to the working field before becoming visible again. */
  returningNode?: (id: string) => boolean;
  /** A constraint hidden and restored by the observer rather than admitted. */
  returningEdge?: (id: string) => boolean;
  /** Observer reveal, distinct from massive-node nucleation. */
  revealPlan?: MotionPlan;
  appearancePlan?: MotionPlan;
  /** The small assertion plates carried as edge labels. */
  labelPlan?: MotionPlan;
  /** Retained for callers that want the canonical massive-node plans. */
  stellarNodes?: boolean;
  /** Lab-scaled forms of the same laws, when supplied. */
  birthPlan?: MotionPlan;
  collapsePlan?: MotionPlan;
  releasePlan?: MotionPlan;
  /** Shared-spine time before a newly nucleated body can bind constraints. */
  bindingDelayMs?: number;
  /** Lab-scaled window across an expansion's distance waves. */
  staggerWindowMs?: number;
  /**
   * Draw this frame the way reduced motion draws every frame: data in, no
   * lifecycle. A bulk arrival — dozens of births in one frame — is the case
   * this is for: fifty staggered nucleations are not fifty announcements, they
   * are one laggy one, and the loading state lives on the control that asked
   * for them rather than on each mark.
   */
  still?: boolean;
};

const LIFECYCLE_SCALE = 0.04;

function scaledSize(size: unknown, scale: number): unknown {
  if (typeof size === "number") return size * scale;
  if (
    Array.isArray(size) &&
    size.length === 2 &&
    size.every((part) => typeof part === "number")
  ) {
    return [size[0] * scale, size[1] * scale];
  }
  return size;
}

function nodePose(
  node: CanvasDatum,
  opacity: number,
  scale: number,
): CanvasDatum {
  const size = scaledSize(node.style?.size, scale);
  return {
    ...node,
    style: {
      ...node.style,
      opacity,
      ...(size === undefined ? {} : { size }),
    },
  };
}

function edgeOpacity(edge: CanvasDatum, opacity: number): CanvasDatum {
  return { ...edge, style: { ...edge.style, opacity } };
}

function planOptions(plan: MotionPlan) {
  return {
    duration: plan.durationMs,
    easing: plan.easing.g6,
  };
}

/**
 * The channels a stage is allowed to move, restated because G6 will not.
 *
 * The base theme animates position and colour on update and nothing else —
 * `[{ fields: ['x','y','fill','stroke'] }]` for a node, `sourceNode`,
 * `targetNode` and `stroke` for an edge. Every channel this surface actually
 * writes meaning into is opacity: occlusion is `opacity`, a name arriving is
 * `labelOpacity`, and light is `fillOpacity` and `strokeOpacity`. A stage that
 * does not name them applies them on the next frame instead — the observer's
 * shutter snaps shut rather than closing, and a mark two hops from the pointer
 * flashes rather than lifts.
 *
 * `size` is the other one, and it is mass rather than light: a body absorbed
 * into its 4% nucleation pin has to be seen contracting into it, or the pin is
 * just a smaller body that appeared where the old one was. Unstated, arrival
 * and withdrawal both read as a cut.
 *
 * `setOptions` replaces this block rather than merging into it, so the theme's
 * own fields are restated alongside. Dropping `x`/`y` or `sourceNode`/
 * `targetNode` would let a filament leave the body it is bound to mid-stage,
 * and dropping `stroke` would take the status cross-fade with it.
 */
function nodeUpdateAnimation(plan: MotionPlan) {
  return {
    animation: {
      update: [
        {
          fields: [
            "x",
            "y",
            "size",
            "fill",
            "stroke",
            "opacity",
            "fillOpacity",
            "strokeOpacity",
          ],
          ...planOptions(plan),
        },
      ],
    },
  };
}

function edgeUpdateAnimation(keyPlan: MotionPlan, labelPlan = keyPlan) {
  return {
    animation: {
      update: [
        { fields: ["sourceNode", "targetNode"], ...planOptions(keyPlan) },
        {
          fields: ["opacity", "stroke", "strokeOpacity"],
          shape: "key",
          ...planOptions(keyPlan),
        },
        // A name leaves with the constraint that carried it, on its own plan:
        // a label is read rather than lit, so it states its arrival at `emit`
        // while the filament under it releases at whatever the stage is.
        {
          fields: ["opacity", "fill"],
          shape: "label",
          ...planOptions(labelPlan),
        },
      ],
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function pointOf(datum: CanvasDatum): { x: number; y: number } | null {
  const x = datum.style?.x;
  const y = datum.style?.y;
  if (typeof x !== "number" || typeof y !== "number") return null;
  return { x, y };
}

function centroid(points: { x: number; y: number }[]): { x: number; y: number } | null {
  if (!points.length) return null;
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

/**
 * Where the new matter grew out of.
 *
 * Not passed in, derived: the marks an expansion attaches to are exactly the
 * *existing* endpoints of the arriving edges, and their centroid is the
 * anchor. That keeps the stagger a property of the change rather than of the
 * caller, so it is right for a table row focus and a fold as well as for an
 * expansion. A first load has no such endpoints; then the arrival radiates
 * from the middle of itself, which is the only centre it has.
 */
function anchorOf(
  bornNodes: CanvasDatum[],
  bornEdges: CanvasDatum[],
  standing: Map<string, CanvasDatum>,
): { x: number; y: number } | null {
  const roots: { x: number; y: number }[] = [];
  for (const edge of bornEdges) {
    for (const end of [edge.source, edge.target]) {
      const held = end ? standing.get(end) : undefined;
      const point = held ? pointOf(held) : null;
      if (point) roots.push(point);
    }
  }
  return (
    centroid(roots) ??
    centroid(bornNodes.map(pointOf).filter((point): point is { x: number; y: number } => Boolean(point)))
  );
}

/** The one motion policy question every canvas asks. Shared, not re-derived. */
export function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * The live element behind an id, for a frame that must repaint without a draw.
 *
 * `graph.draw()` is what makes a redraw expensive: with any update animation
 * declared it builds a Web Animation for *every* element on the field,
 * whether or not that element changed — measured at ~2.5ms per element on top
 * of a ~110ms floor, against ~0.2ms per element for the paint itself. A hover
 * changes what a handful of marks look like, so it goes to the elements
 * directly, the same renderer boundary a drag already reaches through to
 * restation a plate.
 */
type LiveShape = {
  nodeName?: string;
  style?: Record<string, unknown>;
  animate: (
    keyframes: Record<string, unknown>[],
    options: Record<string, unknown>,
  ) => { cancel: () => void } | null;
};

type LiveElement = {
  update: (attributes: Record<string, unknown>) => void;
  /**
   * Commit a label's text strength without re-rendering the element; false
   * when the label is not built, so the caller falls back to `update`.
   */
  commitLabelFill: (to: number) => boolean;
  /** The label's own drawn parts: its text, and the plate behind it. */
  labelParts: () => LiveShape[];
  /** The mark itself, for the one presence the restyle lane owns. */
  keyShape: () => LiveShape | null;
};

function liveElement(graph: Graph, id: string): LiveElement | null {
  const context = (
    graph as unknown as {
      context?: { element?: { getElement: (id: string) => unknown } };
    }
  ).context;
  const element = context?.element?.getElement(id);
  if (!element || typeof element !== "object") return null;
  const live = element as {
    update?: (attributes: Record<string, unknown>) => void;
    getShape?: (name: string) => unknown;
    destroyed?: boolean;
  };
  if (live.destroyed || typeof live.update !== "function") return null;
  // `update` reaches other element methods through `this`; handing back the
  // bare method detaches it and a filament throws while an isolated disc
  // appears to work. Preserve the receiver at this one boundary.
  const shapeOf = (name: string): unknown | null => {
    if (typeof live.getShape !== "function") return null;
    try {
      return live.getShape.call(element, name);
    } catch {
      return null;
    }
  };
  return {
    update: live.update.bind(element),
    /**
     * `update` re-runs the whole element's render — body, halo, badges and
     * label layout — to change one number. Measured, that was about 0.3 ms
     * per element, and under a dragged hub a crowded pile changes a hundred
     * strengths every frame. Strength is the text's fill alone and moves no
     * geometry, so this writes what `update` would have left behind: the
     * element's attribute (so its next render restates the strength rather
     * than reverting it), the label's own, and the text's fill. G6's
     * `setAttributes` writes element attributes the same way.
     */
    commitLabelFill: (to) => {
      const label = shapeOf("label") as {
        attributes?: Record<string, unknown>;
        children?: unknown[];
      } | null;
      const text = Array.isArray(label?.children)
        ? (label.children.find(
            (child) => (child as LiveShape | null)?.nodeName === "text",
          ) as LiveShape | undefined)
        : undefined;
      const attributes = (element as { attributes?: Record<string, unknown> })
        .attributes;
      if (!label?.attributes || !attributes || !text?.style) return false;
      attributes.labelFillOpacity = to;
      label.attributes.fillOpacity = to;
      text.style.fillOpacity = to;
      return true;
    },
    labelParts: () => {
      // A label G6 has not built yet — an element whose name has never been
      // shown — is not an error, it is a shape that does not exist to fade.
      const shape = shapeOf("label");
      const children = (shape as { children?: unknown[] } | null)?.children;
      if (!Array.isArray(children)) return [];
      return children.filter(
        (child): child is LiveShape =>
          Boolean(child) &&
          typeof (child as LiveShape).animate === "function",
      );
    },
    keyShape: () => {
      const shape = shapeOf("key") as LiveShape | null;
      return shape && typeof shape.animate === "function" ? shape : null;
    },
  };
}

/**
 * One drawn part, faded, interrupting whatever it was doing.
 *
 * The restyle lane exists because `graph.draw()` builds an update animation
 * for every element on the field in order to express a change on one, and a
 * hover changes one. The cost of taking that lane was that the channel this
 * surface changes most often — whether a filament is carrying its name —
 * started arriving as a cut, because G6's declared update animation is a
 * property of a draw and there is no draw here.
 *
 * *Part*, not the label. A G6 label is a composite of a text and the plate
 * behind it, and animating the composite's opacity looks right until a fade is
 * interrupted: the cascade re-drives the text and abandons the plate wherever
 * the cancelled animation last left it. What stayed on the field was a
 * background-coloured rectangle sitting across the filament — a gap in a
 * stroke that was still whole underneath, which only the next full draw
 * cleared. Driving each part explicitly is what makes an interruption total.
 *
 * A label's arrival is `emit` for the same reason it was `emit` on the draw
 * path: a name is a body leaving its home, and the reader's pointer is what
 * spent the impulse. A furniture key withdrawing with its selected plate is
 * the same question in the other direction, so it takes `absorb` — the
 * lifecycle's own release — and returns on `emit`. One interlock for both:
 * the shapes are distinct objects, so a name and a rule never cancel each
 * other.
 */
const fadingShapes = new WeakMap<object, { cancel: () => void }>();

function fadeShape(shape: LiveShape, from: number, to: number, plan: MotionPlan) {
  fadingShapes.get(shape)?.cancel();
  fadingShapes.delete(shape);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return;
  try {
    const running = shape.animate(
      [{ opacity: from }, { opacity: to }],
      g6KeyframeMotion(plan),
    );
    if (running) fadingShapes.set(shape, running);
  } catch {
    // The nucleation race the stations and contact both hit: a shape whose
    // layout has not happened cannot be animated. `update` has already written
    // the destination, so the honest failure is to be there without the
    // travel.
  }
}

/**
 * Where a label part is going, which only the frame can say.
 *
 * Not the shape: while an animation stands on a part, reading its opacity back
 * gives the animated value rather than the destination, so a fade that asked
 * the shape where it had just been sent was told "where you already are" and
 * declined to move. The frame's own delta is the only honest answer.
 */
function partDestination(
  part: LiveShape,
  delta: Record<string, unknown>,
): number {
  const key =
    part.nodeName === "text" ? "labelOpacity" : "labelBackgroundOpacity";
  return key in delta ? Number(delta[key]) : Number.NaN;
}

/**
 * Equal as style, not as object. The builders mint `size`, `labelPadding` and
 * `labelTransform` as fresh arrays every frame, and identity alone reported
 * every element on the field as changed on every hover.
 */
function sameStyleValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }
  return a.every((item, index) => sameStyleValue(item, b[index]));
}

/** Style keys that changed, or null when this frame is not a pure restyle. */
function styleDelta(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const previous = before ?? {};
  const next = after ?? {};
  // A key the last frame wrote and this one does not is a default coming back,
  // and `update` has no way to say "unset". No builder in `marks.ts` omits a
  // key it ever writes, so this is a guard against a future one rather than a
  // case in hand — and refusing the fast lane is the cheap way to be right.
  for (const key of Object.keys(previous)) {
    if (!(key in next)) return null;
  }
  const delta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    if (!sameStyleValue(previous[key], value)) delta[key] = value;
  }
  return delta;
}

/**
 * Take a frame that only changes how standing marks look.
 *
 * This is the hover and naming path, and it is the common one: light lifting
 * from the pointer, a name arriving on a bond, a plate restationing to the end
 * a person is reading from. Nothing is born, nothing dies, and
 * `marksNeverMove` means nothing is anywhere new — so there is no lifecycle to
 * author and no reason to hand the whole field to G6 again.
 *
 * `authored` is the frame this canvas last drew, not `graph.getNodeData()`.
 * The store is the renderer's copy and it carries the renderer's own
 * bookkeeping — `zIndex` is written into every stored datum during a draw —
 * so diffing against it reports keys vanishing that the canvas never wrote.
 * Comparing what was authored with what is being authored is also what makes
 * the missing-key guard mean something.
 *
 * The store is still updated alongside the paint. `updateNodeData` costs half
 * a millisecond across a field and does not repaint on its own, which is the
 * split wanted here: `graph.getNodeData()` keeps telling the truth for the
 * next real transition to diff against, and the pixels come from the elements.
 *
 * Returns false when the frame is anything more than a restyle, and the caller
 * falls through to the authored lifecycle.
 */
export function restyleCanvasData(
  graph: Graph,
  authored: CanvasData | null,
  next: CanvasData,
  options: {
    /** Absent means land on the new opacity outright — reduced motion. */
    labelPlan?: MotionPlan;
    /**
     * The one presence the restyle lane owns: a node's own `opacity`, which
     * today only furniture writes — a shelf or crown withdrawing with its
     * selected plate. `releasePlan` takes it out, `revealPlan` brings it
     * back, the lifecycle's own pair. Absent means land outright, same rule
     * as the label.
     */
    revealPlan?: MotionPlan;
    releasePlan?: MotionPlan;
  } = {},
): boolean {
  if (!authored) return false;
  if (
    authored.nodes.length !== next.nodes.length ||
    authored.edges.length !== next.edges.length
  ) {
    return false;
  }

  const standingNodes = new Map(authored.nodes.map((node) => [node.id, node]));
  const standingEdges = new Map(authored.edges.map((edge) => [edge.id, edge]));
  const nodePatches: CanvasDatum[] = [];
  const edgePatches: CanvasDatum[] = [];
  const paint: {
    id: string;
    kind: "node" | "edge";
    delta: Record<string, unknown>;
    labelWas: unknown;
    opacityWas: unknown;
  }[] = [];

  for (const node of next.nodes) {
    const standing = standingNodes.get(node.id);
    if (!standing) return false;
    // A mark that is somewhere new is an arrangement, and a body moving to a
    // new rest is `settle` rather than a repaint. Let it through here and the
    // field would teleport.
    if (
      !Object.is(standing.style?.x, node.style?.x) ||
      !Object.is(standing.style?.y, node.style?.y)
    ) {
      return false;
    }
    const delta = styleDelta(standing.style, node.style);
    if (!delta) return false;
    if (Object.keys(delta).length === 0) continue;
    nodePatches.push(node);
    paint.push({
      id: node.id,
      kind: "node",
      delta,
      labelWas: standing.style?.labelOpacity,
      opacityWas: standing.style?.opacity,
    });
  }

  for (const edge of next.edges) {
    const standing = standingEdges.get(edge.id);
    if (!standing) return false;
    if (
      !Object.is(standing.source, edge.source) ||
      !Object.is(standing.target, edge.target)
    ) {
      return false;
    }
    const delta = styleDelta(standing.style, edge.style);
    if (!delta) return false;
    if (Object.keys(delta).length === 0) continue;
    edgePatches.push(edge);
    paint.push({
      id: edge.id,
      kind: "edge",
      delta,
      labelWas: standing.style?.labelOpacity,
      opacityWas: standing.style?.opacity,
    });
  }

  // Nothing to say. The frame is still handled — a draw would have been a
  // whole field of animations set up to express no change at all.
  if (!paint.length) return true;

  if (nodePatches.length) graph.updateNodeData(nodePatches as never);
  if (edgePatches.length) graph.updateEdgeData(edgePatches as never);
  for (const { id, kind, delta, labelWas, opacityWas } of paint) {
    const element = liveElement(graph, id);
    // The store is already correct; an element G6 has not built yet will be
    // built from it. Nothing to repaint, nothing to fall back for.
    if (!element) continue;
    const plan = options.labelPlan;
    const fading =
      plan !== undefined && naming(delta) ? element.labelParts() : [];
    // Read before the update, not after: `update` writes the destination, and
    // an interrupted fade has to resume from where the eye last saw it rather
    // than from where the last settled frame claimed it was.
    const travel = fading.map((part) => ({
      part,
      from: liveOpacity(part, labelWas),
      to: partDestination(part, delta),
    }));
    // A node coming or going on its own channel — furniture withdrawing with
    // its plate. Edges never write `opacity` here; light writes the stroke's.
    const keyTo =
      kind === "node" && "opacity" in delta ? Number(delta.opacity) : NaN;
    const key = Number.isFinite(keyTo) ? element.keyShape() : null;
    const keyTravel = key
      ? { part: key, from: liveOpacity(key, opacityWas), to: keyTo }
      : null;
    // The direction the eye is travelling, not the frame's: an interrupted
    // withdrawal returning home is an arrival, whatever the last settled
    // frame claimed it was.
    const keyPlan =
      keyTravel === null
        ? undefined
        : keyTravel.to > keyTravel.from
          ? options.revealPlan
          : options.releasePlan;
    element.update(delta);
    if (plan !== undefined) {
      for (const { part, from, to } of travel) fadeShape(part, from, to, plan);
    }
    if (keyTravel && keyPlan !== undefined) {
      fadeShape(keyTravel.part, keyTravel.from, keyTravel.to, keyPlan);
    }
  }
  return true;
}

/**
 * Converge stranded transient poses to the settled frame.
 *
 * A lifecycle run cancelled mid-arrival leaves births frozen in the model —
 * measured, a disc at opacity 0 and size 3.6 against a laid 90 — while the
 * authored frames all say the end state, so restyle never patches them: it
 * diffs authored against authored, and both agree. Nothing afterwards
 * rebirths them either, so they stay invisible for the life of the page.
 * Nodes converge opacity and size, edges opacity; positions are never
 * touched — converging those would snap a live gesture. Returns whether
 * anything was patched, so the caller can redraw before reading bounds.
 *
 * Both lanes share the one guard: the schema lane grew it first, the field
 * lane heals naturally most of the time but shares the hazard.
 */
export function convergeStrandedToFrame(graph: Graph, frame: CanvasData): boolean {
  const nodes = new Map(
    graph
      .getNodeData()
      .map((node) => [String(node.id), node.style as Record<string, unknown> | undefined]),
  );
  const nodePatches: CanvasDatum[] = [];
  for (const node of frame.nodes) {
    const at = nodes.get(node.id);
    if (!at) continue;
    if (
      !Object.is(at.opacity, node.style?.opacity) ||
      JSON.stringify(at.size) !== JSON.stringify(node.style?.size)
    ) {
      nodePatches.push(node);
    }
  }
  const edges = new Map(
    graph
      .getEdgeData()
      .map((edge) => [String(edge.id), edge.style as Record<string, unknown> | undefined]),
  );
  const edgePatches: CanvasDatum[] = [];
  for (const edge of frame.edges) {
    const at = edges.get(edge.id);
    if (!at) continue;
    if (!Object.is(at.opacity, edge.style?.opacity)) {
      edgePatches.push(edge);
    }
  }
  if (nodePatches.length) graph.updateNodeData(nodePatches as never);
  if (edgePatches.length) graph.updateEdgeData(edgePatches as never);
  return nodePatches.length > 0 || edgePatches.length > 0;
}

/** What the eye is seeing now, falling back to the last settled frame. */
function liveOpacity(shape: LiveShape, standing: unknown): number {
  const live = Number(shape.style?.opacity);
  if (Number.isFinite(live)) return live;
  const last = Number(standing ?? 0);
  return Number.isFinite(last) ? last : 0;
}

/**
 * Strength travels on its own interlock, because it travels on its own
 * attribute.
 *
 * Naming fades `opacity`; strength fades `fillOpacity`. Sharing
 * `fadingShapes` would make a name yielding to a neighbour cancel the fade
 * that was bringing it in — or the reverse — snapping whichever lost. The
 * two attributes compose on the text, so the two animations compose on the
 * timeline.
 */
const fadingFills = new WeakMap<object, { cancel: () => void }>();

function fadeFill(shape: LiveShape, from: number, to: number, plan: MotionPlan) {
  fadingFills.get(shape)?.cancel();
  fadingFills.delete(shape);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return;
  try {
    const running = shape.animate(
      [{ fillOpacity: from }, { fillOpacity: to }],
      g6KeyframeMotion(plan),
    );
    if (running) fadingFills.set(shape, running);
  } catch {
    // The nucleation race `fadeShape` names: `update` below has already
    // written the destination, so the honest failure is to be there without
    // the travel.
  }
}

/** What the eye is seeing on the strength channel. See `liveOpacity`. */
function liveFill(shape: LiveShape, standing: unknown): number {
  const live = Number(shape.style?.fillOpacity);
  if (Number.isFinite(live)) return live;
  const last = Number(standing ?? 0);
  return Number.isFinite(last) ? last : 0;
}

/**
 * A name's reading strength, painted, on the text's own channel.
 *
 * The visibility pass's hand: `from` and `to` are absolute fill values — the
 * lane multiplied its strengths by each label's authored base already — and
 * only the text part moves. The plate is untouched, so a whisper keeps its
 * gap; naming's `opacity` is untouched, so a show fade and a yielding never
 * overwrite each other. A name recovering takes `restorePlan`, one yielding
 * takes `weakenPlan`: the arrival and the release, borrowed from the motion
 * the lanes already speak. Absent plans land outright, the reduced-motion
 * rule every painter here follows.
 *
 * Elements G6 has not built yet are skipped, not failed: the store the lanes
 * update alongside already carries the strength, and the element is built
 * from it.
 */
export function paintLabelStrength(
  graph: Graph,
  patches: { id: string; from: number; to: number }[],
  options: { weakenPlan?: MotionPlan; restorePlan?: MotionPlan } = {},
): void {
  for (const patch of patches) {
    if (
      !Number.isFinite(patch.from) ||
      !Number.isFinite(patch.to)
    ) {
      continue;
    }
    const element = liveElement(graph, patch.id);
    if (!element) continue;
    const text =
      element.labelParts().find((part) => part.nodeName === "text") ?? null;
    // Read the painted strength before update commits the destination. Reading
    // it afterwards gives `to` as the starting value and skips the fade.
    const from = text ? liveFill(text, patch.from) : patch.from;
    const plan =
      patch.to > from ? options.restorePlan : options.weakenPlan;
    const interrupted = text !== null && fadingFills.has(text);
    if (text && plan === undefined) {
      fadingFills.get(text)?.cancel();
      fadingFills.delete(text);
    }
    // The commit; the fade below is only the travel — see `fadeShape`.
    if (!element.commitLabelFill(patch.to)) {
      element.update({ labelFillOpacity: patch.to });
    }
    if (plan !== undefined && text) {
      fadeFill(text, from, patch.to, plan);
    } else if (text && interrupted) {
      // G can reapply a cancelled effect on its next animation frame. Commit
      // the snap on that same timeline so it cannot restore the old strength.
      try {
        const committed = text.animate([
          { fillOpacity: patch.to }, { fillOpacity: patch.to },
        ], { duration: 0, fill: "both" });
        if (committed) fadingFills.set(text, committed);
      } catch {
        // The destination is already written if the shape cannot animate.
      }
    }
  }
}

/** Whether this frame changes whether a name is showing at all. */
function naming(delta: Record<string, unknown>): boolean {
  return "labelOpacity" in delta || "labelBackgroundOpacity" in delta;
}

/**
 * Reconcile data with one authored lifecycle.
 *
 * Existing marks update directly because hover and naming are pointer-direct.
 * Only identity entering or leaving gets an autonomous motion.
 */
export async function transitionCanvasData(
  graph: Graph,
  next: CanvasData,
  cancelled: () => boolean,
  options: CanvasMotionOptions = {},
): Promise<CanvasTransition> {
  const previousNodes = new Set(
    graph.getNodeData().map((node) => String(node.id)),
  );
  const previousEdges = new Set(
    graph.getEdgeData().map((edge) => String(edge.id)),
  );
  const nextNodeIds = new Set(next.nodes.map((node) => node.id));
  const nextEdgeIds = new Set(next.edges.map((edge) => edge.id));
  const bornNodes = next.nodes.filter((node) => !previousNodes.has(node.id));
  const bornEdges = next.edges.filter((edge) => !previousEdges.has(edge.id));
  const diedNodeIds = [...previousNodes].filter((id) => !nextNodeIds.has(id));
  const diedEdgeIds = [...previousEdges].filter((id) => !nextEdgeIds.has(id));

  if (reducedMotion() || options.still) {
    if (cancelled() || graph.destroyed) {
      return { bornNodes, bornEdges, diedNodeIds, diedEdgeIds };
    }
    graph.setOptions({ animation: false });
    graph.setData(next as never);
    await graph.draw();
    return { bornNodes, bornEdges, diedNodeIds, diedEdgeIds };
  }

  const departingNodes = diedNodeIds
    .map((id) => graph.getNodeData(id))
    .filter(Boolean)
    .map((node) => node as CanvasDatum);
  const occludedNodes = departingNodes.filter((node) =>
    options.retainedNode?.(node.id),
  );
  const removedNodes = departingNodes.filter((node) =>
    !options.retainedNode?.(node.id),
  );
  const hiddenNodes = occludedNodes.map((node) => nodePose(node, 0, 1));
  const collapsedNodes = removedNodes.map((node) =>
    nodePose(node, 0, LIFECYCLE_SCALE),
  );
  const dyingEdges = diedEdgeIds
    .map((id) => graph.getEdgeData(id))
    .filter(Boolean)
    .map((edge) => edgeOpacity(edge as CanvasDatum, 0));
  const entering: CanvasData = {
    nodes: next.nodes.map((node) =>
      previousNodes.has(node.id)
        ? node
        : nodePose(node, 0, options.returningNode?.(node.id) ? 1 : LIFECYCLE_SCALE),
    ),
    edges: next.edges.map((edge) =>
      previousEdges.has(edge.id) ? edge : edgeOpacity(edge, 0),
    ),
  };
  const returningNodes = bornNodes.filter((node) =>
    options.returningNode?.(node.id),
  );
  const arrivingNodes = bornNodes.filter((node) =>
    !options.returningNode?.(node.id),
  );
  const returningEdges = bornEdges.filter((edge) =>
    options.returningEdge?.(edge.id),
  );
  const arrivingEdges = bornEdges.filter((edge) =>
    !options.returningEdge?.(edge.id),
  );

  /**
   * Every `await` here is a place the canvas can be unmounted under us.
   *
   * `graph.draw()` resolves a frame or more later, and by then the vocabulary
   * toggle may have destroyed the schema canvas — G6 logs "the graph instance
   * has been destroyed" for each call that lands afterwards. The checks after
   * each await were there; the ones *before* the next call were not, so a
   * destroy that happened during an await was caught one statement too late.
   */
  const gone = () => cancelled() || graph.destroyed;
  if (gone()) return { bornNodes, bornEdges, diedNodeIds, diedEdgeIds };

  /**
   * Withdrawal has an order because a constraint cannot remain visibly bound
   * to matter that has already ceased to occupy the field. Release the
   * departing constraints first while their endpoints still stand.
   */
  if (dyingEdges.length || hiddenNodes.length) {
    const releasePlan = options.releasePlan ?? DEFAULT_MOTION_PLANS.absorb;
    graph.setOptions({
      animation: planOptions(releasePlan),
      node: nodeUpdateAnimation(releasePlan),
      edge: edgeUpdateAnimation(releasePlan),
    });
    graph.setData({
      // A filter is one observer shutter: retained matter and its light fade
      // together at full size. Explicitly removed mass stays standing until
      // its constraints have released in this same stage.
      nodes: [...entering.nodes, ...removedNodes, ...hiddenNodes],
      edges: [...entering.edges, ...dyingEdges],
    } as never);
    await graph.draw();
    if (gone()) return { bornNodes, bornEdges, diedNodeIds, diedEdgeIds };
    graph.setOptions({ animation: false });
  }

  /** Only after its constraints have released may a departing mass collapse. */
  if (collapsedNodes.length) {
    const collapsePlan =
      options.collapsePlan ??
      (options.stellarNodes ? NODE_COLLAPSE_PLAN : DEFAULT_MOTION_PLANS.absorb);
    // Its own channels, not the release stage's. `setOptions` leaves the
    // previous `node` block standing, so a collapse that did not state one
    // contracted at whatever plan released the constraints a moment earlier —
    // the mass reading its own withdrawal at the speed of a filament's.
    graph.setOptions({
      animation: planOptions(collapsePlan),
      node: nodeUpdateAnimation(collapsePlan),
    });
    graph.setData({
      nodes: [...entering.nodes, ...collapsedNodes],
      edges: entering.edges,
    } as never);
    await graph.draw();
    if (gone()) return { bornNodes, bornEdges, diedNodeIds, diedEdgeIds };
    graph.setOptions({ animation: false });
  }

  if (gone()) return { bornNodes, bornEdges, diedNodeIds, diedEdgeIds };
  /**
   * Nothing is arriving or leaving, so this pass is only what the marks
   * *look* like — light lifting, a label appearing on a bond a person has
   * reached. Those ease.
   *
   * `marksNeverMove` is not in tension with it: this animates appearance, not
   * position, and a re-layout still cannot happen because none is being
   * asked for. Births and deaths keep their own plans below; only the
   * standing-still case gets `hold`, which is the shortest thing the spine
   * has and the one intended for a change that tracks a person rather than
   * announcing itself.
   */
  const settling =
    !bornNodes.length &&
    !bornEdges.length &&
    !collapsedNodes.length &&
    !dyingEdges.length;
  if (settling) {
    const appearancePlan = options.appearancePlan ?? DEFAULT_MOTION_PLANS.hold;
    const labelPlan = options.labelPlan ?? DEFAULT_MOTION_PLANS.emit;
    graph.setOptions({
      animation: planOptions(appearancePlan),
      node: nodeUpdateAnimation(appearancePlan),
      edge: edgeUpdateAnimation(appearancePlan, labelPlan),
    });
  }
  graph.setData(entering as never);
  await graph.draw();
  if (settling && !graph.destroyed) graph.setOptions({ animation: false });
  if (gone()) return { bornNodes, bornEdges, diedNodeIds, diedEdgeIds };

  /** Occluded matter returns as one field, without replaying nucleation. */
  if (returningNodes.length || returningEdges.length) {
    const returnPlan = options.revealPlan ?? DEFAULT_MOTION_PLANS.emit;
    graph.setOptions({
      animation: planOptions(returnPlan),
      node: nodeUpdateAnimation(returnPlan),
      edge: edgeUpdateAnimation(returnPlan),
    });
    if (returningNodes.length) {
      graph.updateNodeData(returningNodes.map(shown) as never);
    }
    if (returningEdges.length) {
      graph.updateEdgeData(returningEdges.map(shown) as never);
    }
    await graph.draw();
    if (!graph.destroyed) graph.setOptions({ animation: false });
    if (gone()) return { bornNodes, bornEdges, diedNodeIds, diedEdgeIds };
  }

  if (arrivingNodes.length || arrivingEdges.length) {
    const arrivalPlan =
      options.birthPlan ??
      (options.stellarNodes ? NODE_BIRTH_PLAN : DEFAULT_MOTION_PLANS.emit);
    graph.setOptions({
      animation: planOptions(arrivalPlan),
      node: nodeUpdateAnimation(arrivalPlan),
      edge: edgeUpdateAnimation(arrivalPlan),
    });

    const standing = new Map(
      next.nodes.filter((node) => previousNodes.has(node.id)).map((node) => [node.id, node]),
    );
    const anchor = anchorOf(arrivingNodes, arrivingEdges, standing);
    const distance = (node: CanvasDatum) => {
      const point = pointOf(node);
      if (!point || !anchor) return 0;
      return Math.hypot(point.x - anchor.x, point.y - anchor.y);
    };
    const { waves, stepMs } = staggerWaves(arrivingNodes, distance, {
      windowMs: options.staggerWindowMs,
    });
    const waveStepMs = Math.max(
      stepMs,
      arrivingNodes.length
        ? options.bindingDelayMs ?? DEFAULT_MOTION_PLANS.hold.durationMs
        : 0,
    );

    /**
     * An edge is drawn in the wave after the later of its ends.
     *
     * A filament that arrives before the disc it lands on reads as a line to
     * nowhere. Both ends already standing means the edge is the only new
     * thing, so it goes in the first wave with nothing to wait for.
     */
    const waveOfNode = new Map<string, number>();
    waves.forEach((wave, index) => {
      for (const node of wave) waveOfNode.set(node.id, index);
    });
    const waveOfEdge = (edge: CanvasDatum) =>
      Math.max(
        waveOfNode.get(edge.source ?? "") ?? -1,
        waveOfNode.get(edge.target ?? "") ?? -1,
      ) + 1;
    const edgeWaves: CanvasDatum[][] = Array.from(
      // One final wave lets a constraint bind only after its latest arriving
      // endpoint has become present. With no born nodes, a new edge between
      // standing bodies still belongs to the first and only wave.
      { length: waves.length ? waves.length + 1 : 1 },
      () => [],
    );
    for (const edge of arrivingEdges) {
      edgeWaves[Math.min(waveOfEdge(edge), edgeWaves.length - 1)].push(edge);
    }

    /**
     * The waves overlap on purpose, so they are started rather than awaited.
     *
     * Awaiting each draw would serialise the arrival into one full `emit` per
     * wave, and a ring of marks would take a second and a half to land. Each
     * wave touches a disjoint set of elements, so the draws do not contend
     * for the same matter; what the eye gets is a front crossing the new
     * region, which is the thing `stagger` was for.
     */
    const drawn: Promise<unknown>[] = [];
    for (let index = 0; index < edgeWaves.length; index += 1) {
      if (index > 0 && waveStepMs > 0) await sleep(waveStepMs);
      if (gone()) break;
      const nodeWave = waves[index] ?? [];
      if (nodeWave.length) {
        graph.updateNodeData(nodeWave.map(shown) as never);
      }
      const edgeWave = edgeWaves[index];
      if (edgeWave.length) {
        graph.updateEdgeData(edgeWave.map(shown) as never);
      }
      if (nodeWave.length || edgeWave.length) drawn.push(graph.draw());
    }
    await Promise.all(drawn);
    if (!graph.destroyed) graph.setOptions({ animation: false });
  }

  return { bornNodes, bornEdges, diedNodeIds, diedEdgeIds };
}

/** Restore the datum's own opacity — the pose it was authored at. */
function shown(datum: CanvasDatum): CanvasDatum {
  return {
    ...datum,
    style: {
      ...datum.style,
      opacity: (datum.style?.opacity as number | undefined) ?? 1,
    },
  };
}

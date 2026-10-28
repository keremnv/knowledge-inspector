/**
 * The field's renderer — what every canvas of placed marks shares.
 *
 * World's field draws referents and the assertions joining them; the
 * captured-source field draws verified source records. What a mark *means*
 * differs completely, and none of it crosses this module. What does not differ
 * is how a placed mark is held, dragged, dropped, restacked, named, lit for
 * visibility, framed and reconciled with the renderer — and that is all this
 * is: G6 lifecycle, authored frames keyed by renderer element ids, positions
 * read back, depth, camera intent and pointer events. Each consumer builds its
 * own frames and translates element ids back into its own typed subjects.
 *
 * Moved out of `WorldCanvas` rather than rewritten, when the source field
 * became the second consumer: the comments travel with the code they explain,
 * and World passes its own extras — bond labels, the fan, chip furniture —
 * through the hooks below rather than this module learning about them.
 */

import { Graph } from "@antv/g6";
import { keepRendererOutOfTabOrder } from "./rendererFocus";
import { isDecoration, PAINT_LAYER_MARK } from "./marks";
import { paintDepths, restackTop } from "./fieldDepth";
import {
  convergeStrandedToFrame,
  paintLabelStrength,
  reducedMotion,
  restyleCanvasData,
  transitionCanvasData,
  type CanvasData,
  type CanvasDatum,
} from "./canvasMotion";
import { cancelPan, type CameraInsets } from "./canvasFocus";
import type { CameraRecorder } from "./cameraMemory";
import {
  paintedLabelBox,
  paintedMarkBox,
  resolveVisibility,
  VISIBILITY_STRENGTHS_ON,
  type VisibilityBox,
  type VisibilityOccluder,
  type VisibilityRank,
} from "./visibility";
import {
  transitionContact,
  type ContactEvent,
  type ContactState,
} from "./canvasInteraction";
import {
  scaleMotionPlan,
  type MotionPlan,
  type MotionPlans,
} from "../styles/motion";
import { g6KeyframeMotion } from "../styles/motionG6";

type Ref<T> = { current: T };
type Point = { x: number; y: number };

export type FieldFrame = {
  nodes: CanvasDatum[];
  edges: CanvasDatum[];
  animateInitial: boolean;
  still: boolean;
  fieldIds: Set<string>;
  /**
   * This frame re-places matter that was already standing, because a person
   * asked it to. The one case where `marksNeverMove` is suspended, so it is
   * carried on the frame rather than inferred: a mark that moves for any other
   * reason is a bug, and a canvas that guessed could not tell them apart.
   */
  arranged: boolean;
};

export type MaterialTuning = {
  /**
   * Whether a mark answers the pointer's load.
   *
   * The lab trial is adjudicated: on, on both surfaces. A disc that does not
   * yield under a press reads as a picture of a disc, and the deformation is
   * the cheapest way this canvas says a mark is a thing rather than a label.
   * Still a switch, because the lab is where it was decided and has to be able
   * to show the other answer.
   */
  contact: boolean;
  /** Resting diameter retained while pointer load is applied. */
  pressScale: number;
};

export const MATERIAL_DEFAULTS: MaterialTuning = {
  // Temporarily off: no press compression on nodes or their labels. The
  // mechanics stay (`animateContact`, `pressScale`) so this comes back by
  // flipping this to `true`; the lab can still opt a surface back in.
  contact: false,
  pressScale: 0.96,
};

/** Press and drag are node-local; edges and labels stay at rest until release. */
export function contactOwnsPointer(phase: ContactState["phase"]) {
  return phase === "pressed" || phase === "dragging";
}

/**
 * Which contact phases hold the lane, and why `releasing` is not one of them.
 *
 * A pointer that is down owns the field: `pressed` and `dragging` are both
 * cases where the person is still authoring, and a global redraw underneath
 * them would answer a question they have not finished asking.
 *
 * `releasing` is the opposite. The pointer is already up, the click has
 * already committed, and what is still running is one body relaxing a load
 * on its own two shapes — a transform G6 leaves alone across `setData`, so
 * nothing about a redraw disturbs it. Holding the lane through it made the
 * observer's aperture wait out the body's viscoelastic return, which are two
 * different causes with no reason to be serialized: the person acted once
 * and should see one answer, not the slower of two.
 */
export function contactHoldsLane(phase: ContactState["phase"]) {
  return phase === "pressed" || phase === "dragging";
}

/** Centre a restored field once, after the renderer has its real host size. */
async function centreStandingField(
  graph: Graph,
  ids: string[],
  insets: CameraInsets,
) {
  const [width, height] = graph.getSize();
  const points = ids
    .map((id) => graph.getElementPosition(id))
    .filter((point): point is [number, number, number] => Boolean(point))
    .map((point) => graph.getViewportByCanvas(point));
  if (!width || !height || !points.length) return;
  const minX = Math.min(...points.map((point) => point[0]));
  const maxX = Math.max(...points.map((point) => point[0]));
  const minY = Math.min(...points.map((point) => point[1]));
  const maxY = Math.max(...points.map((point) => point[1]));
  await graph.translateBy(
    [
      (insets.left + width - insets.right - minX - maxX) / 2,
      (insets.top + height - insets.bottom - minY - maxY) / 2,
    ],
    false,
  );
}

/**
 * The renderer a field is drawn into, with the behaviours every field has.
 *
 * The graph is created once per field. Data changes go through the lane, so a
 * placement never re-mounts the canvas and never resets the view.
 */
export function createFieldGraph(
  host: HTMLElement,
  data: CanvasData,
): { graph: Graph; dispose: () => void } {
  const blockMenu = (event: Event) => event.preventDefault();
  host.addEventListener("contextmenu", blockMenu);
  const graph = new Graph({
    container: host,
    data: data as never,
    animation: false,
    padding: 60,
    // Transparent on purpose. G6's `setOptions({ background })` stores the
    // colour but never paints it, so an opaque field set at mount stuck
    // through every theme flip. The live field is `--matter-canvas` on the
    // stage, the same path the product canvas uses.
    background: "transparent",
    // No `selected` element state. Selection is drawn over the canvas by the
    // ants, so the renderer is not also asked to thicken a line or lay a
    // halo under a disc — two marks for one fact, and the quieter one was
    // the only one anybody read.
    node: { style: { cursor: "grab" } },
    edge: { style: { cursor: "default" } },
    behaviors: [
      "zoom-canvas",
      {
        type: "drag-canvas",
        enable: (event: { targetType?: string }) => event.targetType === "canvas",
      },
      {
        type: "drag-element",
        key: "drag-element",
        // Product nodes are not combo containers. G6's default `move`
        // effect refreshes combo data on every pointer event, which is pure
        // bookkeeping here and makes the held object trail the pointer.
        dropEffect: "none",
        animation: false,
        enable: (event: unknown) => {
          const id = (event as { target?: { id?: unknown } })?.target?.id;
          return typeof id === "string" && !isDecoration(id);
        },
      },
    ],
  });
  keepRendererOutOfTabOrder(graph);
  return {
    graph,
    dispose: () => host.removeEventListener("contextmenu", blockMenu),
  };
}

/** Dragged positions belong to the person, so they are read back before use. */
export function harvestFieldPositions(graph: Graph): Map<string, Point> {
  const out = new Map<string, Point>();
  for (const node of graph.getNodeData()) {
    const id = String(node.id);
    if (isDecoration(id)) continue;
    const position = graph.getElementPosition(id);
    /**
     * `getElementPosition` answers `[null, null, 0]` for an element whose
     * transform it cannot resolve, and the array itself is always truthy.
     * Rounding that gives `NaN`, and `NaN` is what then goes to the store as
     * where the person put the mark — a place nothing can draw, hit-test or
     * lay out from, kept across reloads. A position that cannot be read is
     * not a position; the stored one stands.
     */
    if (!position || !Number.isFinite(position[0]) || !Number.isFinite(position[1])) {
      continue;
    }
    out.set(id, { x: Math.round(position[0]), y: Math.round(position[1]) });
  }
  return out;
}

/**
 * Settle which names read at full strength, off the drawing in front of
 * the reader.
 *
 * The boxes are painted ones — fans, fonts and stations already accounted
 * for — so this runs after a draw lands and under any movement that names
 * follow, never from a render. Only changed strengths are written, and they go
 * three places at once: the live text (through `paintLabelStrength`, on the
 * strength channel naming never touches), the G6 store (so it keeps telling
 * the truth), and the authored baseline (so the next restyle diffs against
 * what is actually painted rather than restating yesterday's strengths as a
 * change).
 *
 * A label whose box cannot be read keeps its last strength: an unlaid name
 * is not a lost contest. Strengths for elements that left the frame are
 * dropped, so a returning name re-contests rather than inheriting a
 * whisper from a crowd that is gone.
 */
export function settleFieldLabels(
  graph: Graph,
  frame: CanvasData | null,
  remembered: Map<string, { strength: number; base: number }>,
  rankOf: (elementId: string, labelFontFamily: unknown) => VisibilityRank,
  plans: MotionPlans,
  dragging: boolean,
) {
  if (!frame || graph.destroyed) return;
  const standing = new Set([...frame.nodes, ...frame.edges].map((datum) => datum.id));
  for (const id of [...remembered.keys()]) {
    if (!standing.has(id)) remembered.delete(id);
  }
  let settled: Map<string, number>;
  if (VISIBILITY_STRENGTHS_ON) {
    const boxes: VisibilityBox[] = [];
    const ranks = new Map<string, VisibilityRank>();
    const depths = new Map<string, number>();
    /**
     * A mark's depth as painted, not as authored.
     *
     * A held mark rides its settled depth from the grab — see
     * `rideSettledDepth`, which sets it on the graph — while the authored
     * frame keeps the rest depth until the drop draws. Read off the frame,
     * the held disc's own name yielded for the whole gesture to a name its
     * body already covered, then took its strength back on release: a
     * dimming that lasted exactly as long as the hand. Marks only; an
     * edge's depth is the one the frame stamped, which every patch below
     * carries back.
     */
    const markDepth = (datum: CanvasDatum): number | undefined => {
      let live: unknown;
      try {
        live = graph.getNodeData(datum.id)?.style?.zIndex;
      } catch {
        live = undefined;
      }
      if (typeof live === "number") return live;
      const authored = (datum.style as Record<string, unknown> | undefined)?.zIndex;
      return typeof authored === "number" ? authored : undefined;
    };
    for (const [datum, node] of [
      ...frame.nodes.map((datum) => [datum, true] as const),
      ...frame.edges.map((datum) => [datum, false] as const),
    ]) {
      const style = datum.style as Record<string, unknown> | undefined;
      if (!style) continue;
      if (typeof style.labelText !== "string" || !style.labelText) continue;
      const shown = (style.labelOpacity as number | undefined) ?? 1;
      if (!(shown > 0)) continue;
      const box = paintedLabelBox(graph, datum.id);
      if (!box) continue;
      boxes.push({ id: datum.id, ...box });
      ranks.set(datum.id, rankOf(datum.id, style.labelFontFamily));
      const z = node ? markDepth(datum) : style.zIndex;
      if (typeof z === "number") depths.set(datum.id, z);
    }
    // What the names are under: a label fully covered by a mark standing
    // above it leaves the fight — see `resolveVisibility`. Bodies only, at
    // the depth they are painted at.
    const occluders: VisibilityOccluder[] = [];
    for (const datum of frame.nodes) {
      const z = markDepth(datum) ?? PAINT_LAYER_MARK;
      const mark = paintedMarkBox(graph, datum.id);
      if (mark) occluders.push({ ...mark, z });
    }
    const prev = new Map(
      [...remembered].map(([id, record]) => [id, record.strength] as const),
    );
    settled = resolveVisibility(boxes, ranks, prev, {
      occluders,
      depths,
    });
  } else {
    // Strengths off: every standing name reads at its full authored
    // strength. Anything still dimmed from before the switch restores
    // through the normal paint below; afterwards this settles nothing.
    settled = new Map(
      [...remembered.keys()].map((id) => [id, 1] as const),
    );
  }
  const byId = new Map<string, { datum: CanvasDatum; node: boolean }>();
  for (const datum of frame.nodes) byId.set(datum.id, { datum, node: true });
  for (const datum of frame.edges) byId.set(datum.id, { datum, node: false });
  const nodePatches: CanvasDatum[] = [];
  const edgePatches: CanvasDatum[] = [];
  const paint: { id: string; from: number; to: number }[] = [];
  for (const [id, strength] of settled) {
    const record = remembered.get(id);
    if ((record?.strength ?? 1) === strength) continue;
    const entry = byId.get(id);
    const style = entry?.datum.style as Record<string, unknown> | undefined;
    if (!entry || !style) continue;
    const base =
      record?.base ??
      (typeof style.labelFillOpacity === "number" ? style.labelFillOpacity : 1);
    remembered.set(id, { strength, base });
    // The baseline carries what is painted — see above.
    style.labelFillOpacity = base * strength;
    // A drag owns the live position. Writing the whole authored datum here
    // would put its old coordinates back into G6's store between moves.
    // But an edge patch without a numeric zIndex makes G6 rewrite the
    // edge's depth from its endpoints (`runtime/data.js` sets it to the
    // fronter end minus one), sinking the name to the stroke layer — so
    // the authored depth rides along. Nodes skip that rewrite on update.
    const patchStyle: Record<string, unknown> = {
      labelFillOpacity: base * strength,
    };
    if (!entry.node && typeof style.zIndex === "number") {
      patchStyle.zIndex = style.zIndex;
    }
    (entry.node ? nodePatches : edgePatches).push({ id, style: patchStyle });
    paint.push({ id, from: base * (record?.strength ?? 1), to: base * strength });
  }
  if (!paint.length) return;
  if (nodePatches.length) graph.updateNodeData(nodePatches as never);
  if (edgePatches.length) graph.updateEdgeData(edgePatches as never);
  // Pointer travel already supplies the motion. Restarting a fade at each
  // position makes strength trail the hand and settle only after release.
  const tracking = dragging || reducedMotion();
  paintLabelStrength(graph, paint, {
    weakenPlan: tracking ? undefined : plans.absorb,
    restorePlan: tracking ? undefined : plans.emit,
  });
}

export type FieldLaneOptions = {
  graph: Ref<Graph | null>;
  /** Whether a held pointer owns the field, which holds every draw. */
  holds: () => boolean;
  pending: Ref<FieldFrame | null>;
  /** The frame this canvas last put on the field — see `authoredRef`. */
  authored: Ref<CanvasData | null>;
  /** Marks on the field last time we drew, for returning matter. */
  drawnIds: Ref<Set<string>>;
  /** Mark count on the field last time we drew, so growth can be noticed. */
  drawnCount: Ref<number>;
  /** Whether this field has a viewpoint yet — see `FieldFraming`. */
  established: Ref<boolean>;
  recorder: () => CameraRecorder | null;
  insets: () => CameraInsets;
  motion: () => MotionPlans;
  lifecycle: () => { birth: MotionPlan; collapse: MotionPlan };
  /** Which field member a drawn node or edge belongs to. */
  nodeMember: (elementId: string) => string;
  edgeMember: (elementId: string) => string;
  /** After a lane run: whether any frame landed, for the passes that follow. */
  afterDraw: (graph: Graph, drew: boolean) => void;
};

/**
 * G6 has one mutable scene, so it also gets one reconciliation lane.
 *
 * Selection, naming and placement can all change React data while an
 * animated draw is in flight. Keeping only the newest waiting frame avoids
 * drawing stale intermediate states, while the promise lane prevents two
 * calls from mutating the same scene concurrently. A frame received during
 * a drag waits here instead of being discarded. Returns the queue call.
 */
export function createFieldLane(lane: FieldLaneOptions): () => void {
  let drawLane: Promise<void> = Promise.resolve();
  return () => {
    const scheduledGraph = lane.graph.current;
    if (!scheduledGraph || lane.holds()) return;

    drawLane = drawLane
      .catch(() => undefined)
      .then(async () => {
        const graph = lane.graph.current;
        if (!graph || graph !== scheduledGraph || graph.destroyed) return;

        // Whether any frame landed this run, for the visibility pass below:
        // strengths settle off the drawing, so only a run that drew owes one.
        let drew = false;
        while (lane.pending.current && !lane.holds()) {
          const next = lane.pending.current;
          lane.pending.current = null;

          try {
            /**
             * Restored data was already rendered by the constructor. Do not
             * send it through a no-op animated draw before centring: G6
             * completes that camera-affecting frame after the draw promise and
             * used to undo the vertical half of the centre operation.
             */
            const restoring =
              !next.animateInitial &&
              lane.drawnCount.current === 0 &&
              next.nodes.length > 0;
            /**
             * Only if the constructor really held it. The stored field is put
             * back once the world's overview arrives, which can be after the
             * graph was built empty — then nothing was rendered, centring
             * asks for positions of elements that do not exist, and the field
             * stays blank until something else changes.
             */
            if (restoring && lane.authored.current?.nodes.length) {
              lane.drawnCount.current = next.nodes.length;
              /**
               * A stored camera is the establishment: the person framed this
               * field last visit, and centring over it would spend their
               * framing on the default. Nothing stored, centre as always.
               */
              if (!(await lane.recorder()?.restore(graph))) {
                if (next.nodes.length === 1) {
                  await graph.zoomTo(1, { duration: 0 });
                }
                await centreStandingField(
                  graph,
                  next.nodes
                    .map((node) => node.id)
                    .filter((id) => !isDecoration(id)),
                  lane.insets(),
                );
              }
              lane.established.current = true;
              drew = true;
              continue;
            }

            /**
             * The frame only changes what standing marks look like.
             *
             * Hover is the pointer-direct case the lifecycle was never for:
             * nothing arrives, nothing leaves, and `marksNeverMove` means
             * nothing is anywhere new. `graph.draw()` cannot express that
             * cheaply — with an update animation declared it builds one for
             * every element on the field whether or not it changed — so the
             * restyle goes to the elements and the draw is not asked for.
             *
             * An arrangement is excluded by name rather than by shape: the
             * marks did move, and `settle` is a body finding a new rest.
             */
            if (
              !next.arranged &&
              restyleCanvasData(graph, lane.authored.current, next, {
                // The one channel a restyle is not allowed to cut. A name
                // arriving is a body leaving its home, on this lane as on the
                // draw's — see `fadeShape`. Furniture withdrawing with its
                // plate takes the lifecycle's own release and reveal.
                labelPlan: reducedMotion() ? undefined : lane.motion().emit,
                revealPlan: reducedMotion() ? undefined : lane.motion().emit,
                releasePlan: reducedMotion() ? undefined : lane.motion().absorb,
              })
            ) {
              lane.authored.current = next;
              lane.drawnIds.current = next.fieldIds;
              lane.drawnCount.current = next.nodes.length;
              /**
               * Debts a cancelled lifecycle owed — see
               * `convergeStrandedToFrame`. The schema lane converges
               * asynchronously behind its flight; this lane is serial, so the
               * guard runs inline: a restyle that patched stranded poses
               * redraws before the loop continues, and the visibility pass
               * below reads the healed boxes. Positions are never converged —
               * a draw that re-applied stored positions mid-gesture would snap
               * the mark out from under the pointer, and the lane holds all
               * draws while one is held anyway.
               */
              if (convergeStrandedToFrame(graph, next)) {
                try {
                  await graph.draw();
                } catch {
                  // Healing is best-effort; the lane continues settled.
                }
              }
              drew = true;
              continue;
            }

            // A restyle has already continued above. Reaching this path means
            // identities, topology or authored positions changed, which is
            // the only reason the D3 body set should be rebuilt.
            lane.authored.current = next;
            const motion = lane.motion();
            await transitionCanvasData(
              graph,
              next,
              () => lane.graph.current !== graph || graph.destroyed,
              {
                // A restored field was standing when this person left it.
                still: next.still || restoring,
                birthPlan: lane.lifecycle().birth,
                collapsePlan: lane.lifecycle().collapse,
                releasePlan: motion.absorb,
                /**
                 * Standing marks are `still` — rule 1 — so `hold` is all the
                 * appearance plan usually has to carry: a colour, a light, a
                 * name. An arrangement is the one frame where matter that was
                 * already placed goes somewhere else, and a body moving to a
                 * new rest is `settle`. It is not `hold`, because `hold` means
                 * *you are moving it*, and nobody's pointer is on these.
                 */
                appearancePlan: next.arranged ? motion.settle : motion.hold,
                labelPlan: motion.emit,
                bindingDelayMs: motion.hold.durationMs,
                staggerWindowMs: motion.absorb.durationMs,
                retainedNode: (id) => next.fieldIds.has(lane.nodeMember(id)),
                returningNode: (id) => lane.drawnIds.current.has(lane.nodeMember(id)),
                returningEdge: (id) => lane.drawnIds.current.has(lane.edgeMember(id)),
                revealPlan: motion.emit,
              },
            );
            lane.drawnIds.current = next.fieldIds;
            if (lane.graph.current !== graph || graph.destroyed) return;
            drew = true;

            const count = next.nodes.length;
            const grew = count > lane.drawnCount.current;
            lane.drawnCount.current = count;
            if (grew && count === 1) {
              await graph.zoomTo(1, { duration: 0 });
            }
            if (restoring) {
              if (!(await lane.recorder()?.restore(graph))) {
                await centreStandingField(
                  graph,
                  next.nodes
                    .map((node) => node.id)
                    .filter((id) => !isDecoration(id)),
                  lane.insets(),
                );
              }
              lane.established.current = true;
            }
          } catch (problem: unknown) {
            if (lane.graph.current === graph) console.error(problem);
          }
        }
        if (lane.graph.current === graph && !graph.destroyed) {
          lane.afterDraw(graph, drew);
        }
      });
  };
}

type MaterialAnimation = {
  currentTime: number | null;
  finished: Promise<unknown>;
  cancel: () => void;
};

type MaterialShape = {
  attr: {
    (name: string): unknown;
    (attributes: Record<string, unknown>): void;
  };
  animate: (
    keyframes: Record<string, unknown>[],
    options: KeyframeAnimationOptions,
  ) => MaterialAnimation | null;
};

type MaterialElement = {
  getShape: (name: string) => MaterialShape | undefined;
};

export type FieldContact = {
  update: (event: ContactEvent) => ContactState;
  engage: (id: string) => ContactState | undefined;
  release: () => void;
  dispose: () => void;
};

/**
 * A mark under load: the contact state and the deformation it drives.
 *
 * `publish` hands each new state to the consumer's render (the lit subjects
 * stand down under a press); `settled` runs after a release has finished
 * relaxing, which is where the lane picks the field back up.
 */
export function createFieldContact(
  graph: Graph,
  options: {
    state: Ref<ContactState>;
    publish: (next: ContactState) => void;
    material: () => MaterialTuning;
    motion: () => MotionPlans;
    settled: () => void;
  },
): FieldContact {
  type RunningContact = {
    from: number;
    to: number;
    plan: MotionPlan;
    key: MaterialAnimation | null;
    label: MaterialAnimation | null;
  };
  const runningContact = new Map<string, RunningContact>();
  const updateContact = (event: ContactEvent) => {
    const next = transitionContact(options.state.current, event);
    if (next === options.state.current) return next;
    options.state.current = next;
    options.publish(next);
    return next;
  };
  const elementOf = (id: string): MaterialElement | undefined =>
    (
      graph as unknown as {
        context?: {
          element?: { getElement: (elementId: string) => MaterialElement };
        };
      }
    ).context?.element?.getElement(id);
  const scaleTransform = (scale: number) => [
    ["scale", scale, scale],
  ];
  /**
   * Contact acts on the two local shapes of one body. It never changes the
   * graph's global node mapper and therefore never asks unrelated matter to
   * refresh. The tracked trajectory also lets a quick release begin at the
   * compression actually reached, rather than jumping to the full load.
   */
  const animateContact = (
    id: string,
    target: number,
    plan: MotionPlan,
  ): Promise<void> => {
    const element = elementOf(id);
    const key = element?.getShape("key");
    const label = element?.getShape("label");
    if (!key) return Promise.resolve();

    const previous = runningContact.get(id);
    const elapsed = Math.max(
      0,
      Math.min(
        previous?.plan.durationMs ?? 0,
        Number(previous?.key?.currentTime ?? previous?.plan.durationMs ?? 0),
      ),
    );
    const progress = previous
      ? previous.plan.sample(elapsed) /
        Math.max(previous.plan.sample(previous.plan.durationMs), 1e-6)
      : 1;
    const from = previous
      ? previous.from + (previous.to - previous.from) * progress
      : target === 1
        ? options.material().pressScale
        : 1;

    previous?.key?.cancel();
    previous?.label?.cancel();
    runningContact.delete(id);

    const start = scaleTransform(from);
    const end = scaleTransform(target);
    key.attr({ transform: start });
    label?.attr({ transform: start });

    if (reducedMotion()) {
      key.attr({ transform: end });
      label?.attr({ transform: end });
      return Promise.resolve();
    }

    const motionOptions = g6KeyframeMotion(plan);
    let keyAnimation: MaterialAnimation | null = null;
    let labelAnimation: MaterialAnimation | null = null;
    try {
      keyAnimation = key.animate(
        [{ transform: start }, { transform: end }],
        motionOptions,
      );
      labelAnimation =
        label?.animate([{ transform: start }, { transform: end }], motionOptions) ??
        null;
    } catch {
      /**
       * The same nucleation race the stations and the ring hit.
       *
       * A body whose shapes are not laid out yet cannot be animated — G's
       * timeline reads a null transform and throws, out of a
       * `requestAnimationFrame` where nothing catches it. Contact is a
       * response to a press that has already happened, so the honest failure
       * is to land on the pose without the travel, not to abandon the frame.
       */
      key.attr({ transform: end });
      label?.attr({ transform: end });
      runningContact.delete(id);
      return Promise.resolve();
    }
    const running = {
      from,
      to: target,
      plan,
      key: keyAnimation,
      label: labelAnimation,
    };
    runningContact.set(id, running);

    const finished = [keyAnimation, labelAnimation]
      .filter((animation): animation is MaterialAnimation =>
        Boolean(animation),
      )
      .map((animation) => animation.finished.catch(() => undefined));
    // G's animation timeline can be replaced by a graph draw. The draw lane
    // is held while contact is live, but this deadline is the final safety
    // law: renderer interruption may shorten a release, never strand it.
    const deadline = new Promise<void>((resolve) => {
      window.setTimeout(resolve, plan.durationMs + 64);
    });
    return Promise.race([
      Promise.all(finished).then(() => undefined),
      deadline,
    ]).then(() => {
      if (runningContact.get(id) !== running) return;
      keyAnimation?.cancel();
      labelAnimation?.cancel();
      key.attr({ transform: end });
      label?.attr({ transform: end });
      runningContact.delete(id);
    });
  };
  const engage = (id: string) => {
    if (!options.material().contact || isDecoration(id)) return;
    const next = updateContact({ type: "press", id });
    if (next.phase !== "pressed" || next.id !== id) return;
    void animateContact(
      id,
      options.material().pressScale,
      options.motion().hold,
    );
    return next;
  };
  const release = () => {
    const next = updateContact({ type: "release" });
    if (next.phase !== "releasing") return;
    const { id } = next;
    const plans = options.motion();
    // A small contact deformation should clear within the pointer-response
    // window: the spring curve, run at `hold`. It is compressed because the
    // load was small, not to get out of the observer's way — nothing waits
    // on it now that `releasing` no longer holds the draw lane.
    const relax = scaleMotionPlan(
      plans.settle,
      plans.settle.durationMs / plans.hold.durationMs,
    );
    void animateContact(id, 1, relax).finally(() => {
      updateContact({ type: "settled", id });
      options.settled();
    });
  };
  return {
    update: updateContact,
    engage,
    release,
    dispose: () => {
      for (const running of runningContact.values()) {
        running.key?.cancel();
        running.label?.cancel();
      }
      runningContact.clear();
    },
  };
}

export type FieldPointerOptions = {
  /** Shared with the lane and the framing: a held mark owns the field. */
  dragging: Ref<boolean>;
  contact: FieldContact;
  /** Bumped by each wheel and press on the field: see `FieldFraming.intent`. */
  intent: Ref<number>;
  established: Ref<boolean>;
  recorder: () => CameraRecorder | null;
  motion: () => MotionPlans;
  /** A renderer element id → the selectable mark it draws, or nothing. */
  subject: (id: string | null) => string | null;
  hover: (id: string | null) => void;
  /** The whole of a name the mark had to cut, for the host's `title`. */
  title: (id: string | null) => string;
  depth: () => ReadonlyMap<string, number>;
  select: (id: string) => void;
  selectNothing: () => void;
  remove: (id: string) => void;
  /** The held mark has moved to `at`: bring along whatever rides with it. */
  follow: (id: string, at: [number, number]) => void;
  harvest: (droppedId?: string) => void;
  /** Whether a drag actually moved its mark, read after `harvest`. */
  moved: (id: string | null) => boolean;
  /** Bring a frame that waited out a drag up to where the drag ended. */
  restate: (id: string) => void;
  queue: () => void;
  settleLabels: (graph: Graph) => void;
  /** World's extras: the fan comes down under a press and back on release. */
  press?: (id: string, rightButton: boolean) => void;
  dropped?: (id: string | null, moved: boolean) => void;
  cancelled?: () => void;
  released?: () => void;
  /** A press this consumer already answered, which a canvas click must not undo. */
  canvasClaimed?: () => boolean;
};

export type FieldPointer = {
  /** Strengths, coalesced to one pass per frame — for movement without a draw. */
  scheduleLabels: () => void;
  /** Cancel a pending hover stand-down: the pointer reached a name. */
  holdHover: () => void;
  swallowReleaseClick: () => boolean;
  /** A removal decided on a press, so the menu the press emits stands down. */
  removeAtPress: (id: string, remove: () => void) => void;
  recentlyRemoved: (id: string) => boolean;
  dispose: () => void;
};

/**
 * Which mouse button a G6 pointer event arrived on, if it says.
 *
 * G6 hands through the renderer's federated event, which mirrors the DOM
 * button — but the only use here is telling a right press from a left one,
 * so both nestings are read and anything unreadable is not a right press.
 */
export function pressButton(event: unknown): number | null {
  // G6 spreads the renderer's button onto the forwarded event top level
  // (`behavior.js` forwards `{...event, button}`); the nestings are the
  // DOM event underneath, for a forwarder that does not spread.
  const outer = event as
    | { button?: unknown; nativeEvent?: unknown }
    | undefined;
  const native = outer?.nativeEvent as
    | { button?: unknown; nativeEvent?: { button?: unknown } }
    | undefined;
  const button =
    outer?.button ?? native?.button ?? native?.nativeEvent?.button;
  return typeof button === "number" ? button : null;
}

export function swallowMenu(event: unknown) {
  const e = event as {
    preventDefault?: () => void;
    nativeEvent?: Event;
  };
  e.preventDefault?.();
  e.nativeEvent?.preventDefault?.();
}

export function elementIdOf(event: unknown): string | null {
  const target = (event as { target?: { id?: unknown } } | undefined)?.target;
  return typeof target?.id === "string" ? target.id : null;
}

/**
 * A mark in the hand: hover, press, pick, drag, drop and removal.
 *
 * The renderer's listeners are attached when the field is created and never
 * again — re-registering them on every placement is how a canvas ends up
 * firing a click five times — so everything they consult is read through the
 * options at event time, never closed over from a render.
 */
export function bindFieldPointer(
  graph: Graph,
  host: HTMLElement,
  options: FieldPointerOptions,
): FieldPointer {
  /** Pending hover stand-down: leaving a disc is a reach before it is an exit. */
  let hoverStandDown: number | undefined;
  /**
   * Strengths under movement and the pointer, frame by frame.
   *
   * Movement that does not draw — a drag, a fan — moves names without the
   * lane, so a pass that only ran after draws would freeze strengths at their
   * earlier values. Coalesced to one pass per frame; at rest nothing is
   * announced and nothing runs.
   */
  let visibilityFrame = 0;
  const scheduleLabels = () => {
    if (visibilityFrame) return;
    visibilityFrame = window.requestAnimationFrame(() => {
      visibilityFrame = 0;
      if (!graph.destroyed) options.settleLabels(graph);
    });
  };

  /** One mark's riders, brought to where the pointer has it. */
  const followAt = (id: string) => {
    const position = graph.getElementPosition(id);
    // A body still nucleating answers `[null, null, 0]`, which is an array
    // and therefore truthy. Passed on, the nulls reach G6's vector maths and
    // throw out of a `requestAnimationFrame` — so a mark taken hold of while
    // its neighbours were still arriving killed the drag it was in.
    if (!position || !Number.isFinite(position[0]) || !Number.isFinite(position[1])) {
      return;
    }
    options.follow(id, [position[0], position[1]]);
  };

  /**
   * The gesture shows the settled state: the grab carries the depth the
   * drop will stamp.
   *
   * G6 fronts the held mark once, at `dragstart` — `frontElement` in its
   * drag behavior, above even the names — and the drop's redraw would sink
   * it back to the restack top: the release speaking for the gesture. The
   * prediction is the drop's own call — `restackTop`, the number
   * `restackDepths` records — so the grab rides what the release restates by
   * construction, not by agreeing on a formula. Written through
   * `setElementZIndex`, the renderer's own z channel: a targeted re-sort, not
   * a draw, so the mark stays under the pointer.
   *
   * A microtask behind the event, because the behavior's own listener runs
   * behind this one: behaviors bind when the graph initializes, after these
   * listeners attached, so a synchronous write lands under the fronting
   * rather than on top of it. The microtask drains before paint, so the
   * front never shows — the gesture's first frame is already the settled
   * one. The moves after need nothing: the behavior only translates from
   * there.
   */
  const rideSettledDepth = (id: string) => {
    const settled = restackTop(options.depth(), id);
    queueMicrotask(() => {
      if (graph.destroyed) return;
      void graph.setElementZIndex(id, settled);
    });
  };
  /**
   * A press that went nowhere restacks nothing — so neither does its depth.
   *
   * The grab rode the settled depth on the assumption of a drop, and the
   * release owes the mark its rest back: without this the predicted number
   * sticks in the store, because a draw that changed nothing restyles
   * nothing. The rest is the stamped paint, not a recomputation — same
   * readers, same answer.
   */
  const restoreRestDepth = (id: string) => {
    const rest = paintDepths(options.depth()).get(id) ?? PAINT_LAYER_MARK;
    void graph.setElementZIndex(id, rest);
  };

  let suppressReleaseClick = false;
  let releaseClickTimer: number | undefined;
  const markReleaseClick = () => {
    suppressReleaseClick = true;
    window.clearTimeout(releaseClickTimer);
    releaseClickTimer = window.setTimeout(() => {
      suppressReleaseClick = false;
    }, 0);
  };
  const swallowReleaseClick = () => {
    if (!suppressReleaseClick) return false;
    suppressReleaseClick = false;
    window.clearTimeout(releaseClickTimer);
    return true;
  };
  const holdHover = () => {
    window.clearTimeout(hoverStandDown);
    hoverStandDown = undefined;
  };
  const hovering = (id: string | null) => {
    if (options.dragging.current) return;
    holdHover();
    if (id !== null) {
      options.hover(id);
      return;
    }
    /**
     * Standing down is a reach too.
     *
     * What a hover reveals — a count, the names on the bonds around it —
     * stands off the disc, so leaving the disc is the first half of reaching
     * for one of them. Dropping the light on the frame the pointer crosses
     * the rim takes the answer away before the hand arrives, and on a
     * trackpad it also reads as flicker on any pass across the field.
     *
     * Arriving anywhere cancels it, so this only ever delays the moment
     * nothing is being looked at.
     */
    hoverStandDown = window.setTimeout(() => {
      hoverStandDown = undefined;
      options.hover(null);
    }, options.motion().emit.durationMs);
  };

  /**
   * A person's hand on the camera outranks any automatic move. A wheel or
   * a press anywhere on the field — a pan, a zoom, a drag, a pick — stops
   * a flight where it is, and a request still waiting for its drawing
   * gives up rather than pull the camera back afterwards. Whatever the
   * person framed is the viewpoint from then on.
   */
  const personTakesCamera = () => {
    options.intent.current += 1;
    options.established.current = true;
    cancelPan(graph);
  };
  host.addEventListener("wheel", personTakesCamera, { capture: true, passive: true });
  host.addEventListener("pointerdown", personTakesCamera, true);

  graph.on("node:pointerenter", (event) => {
    const id = options.subject(elementIdOf(event));
    host.title = options.title(id);
    hovering(id);
  });
  graph.on("node:pointerleave", () => {
    host.title = "";
    hovering(null);
  });
  /** The mark keeping the live field awake, whether or not it becomes a drag. */
  let physicsHeld: string | null = null;
  /**
   * The last mark a right press removed, so its menu can stand down.
   *
   * G6 synthesizes `contextmenu` from the right press itself (`behavior.js`
   * emits it inside the `pointerdown` forward), so the menu arrives in the
   * same tick as the removal it would repeat. Only a menu with no press
   * behind it at all — a keyboard-emitted one — falls through.
   */
  let lastRemoved: { id: string; at: number } | null = null;
  const recentlyRemoved = (id: string): boolean =>
    lastRemoved?.id === id && performance.now() - lastRemoved.at < 500;
  const removeAtPress = (id: string, remove: () => void) => {
    lastRemoved = { id, at: performance.now() };
    // A removal is the decision, so the press it arrived on has no claim on
    // the frame that answers it: the draw lane is released before the set
    // changes, and the collapse plays from there.
    options.contact.release();
    remove();
  };
  graph.on("node:pointerdown", (event) => {
    const raw = elementIdOf(event);
    const id = options.subject(raw);
    if (id) {
      physicsHeld = id;
      options.contact.engage(id);
      const right = pressButton(event) === 2;
      if (right && raw) removeAtPress(id, () => options.remove(id));
      options.press?.(id, right);
    }
  });
  graph.on("node:click", (event) => {
    if (swallowReleaseClick()) return;
    const id = options.subject(elementIdOf(event));
    if (!id) return;
    options.select(id);
  });
  graph.on("canvas:click", () => {
    if (options.canvasClaimed?.()) return;
    if (swallowReleaseClick()) return;
    options.selectNothing();
  });
  graph.on("node:contextmenu", (event) => {
    swallowMenu(event);
    const id = options.subject(elementIdOf(event));
    if (!id || recentlyRemoved(id)) return;
    /**
     * A menu with no press behind it — keyboard-emitted — removes at once,
     * the way a press does. Let go of the mark first: a press holds the draw
     * lane, which is right while a person is still deciding, and a removal
     * is the decision, so it has no claim on the frame that answers it.
     */
    options.contact.release();
    options.remove(id);
  });
  /** The mark under the pointer, kept because a lost release has no event. */
  let dragged: string | null = null;
  graph.on("node:dragstart", (event) => {
    options.dragging.current = true;
    const id = options.subject(elementIdOf(event));
    dragged = id;
    if (id) {
      physicsHeld = id;
      options.contact.update({ type: "drag", id });
      followAt(id);
      rideSettledDepth(id);
    }
    scheduleLabels();
  });
  graph.on("node:drag", (event) => {
    const id = options.subject(elementIdOf(event));
    if (!id) return;
    /**
     * A microtask behind the event, for the same reason the depth rides
     * one: the behavior translates after this listener runs — behaviors
     * bind when the graph initializes, after these listeners attached — so
     * a synchronous follow reads where the mark was, not where this move
     * put it, and the labels it lays out lag the line by a whole event.
     * The microtask drains before paint, so nothing ever shows the stale
     * frame. `dragstart` needs none of this: nothing has moved yet.
     */
    queueMicrotask(() => {
      if (graph.destroyed) return;
      followAt(id);
    });
    scheduleLabels();
  });
  // Dragging is the one interaction that changes state the field owns, so it
  // is written back rather than left in the renderer to be lost on the next
  // placement. The product canvas also swallows the click that fires after
  // a real drag, or the reader opens on a mark you were only moving.
  graph.on("node:dragend", (event) => {
    const id = options.subject(elementIdOf(event)) ?? dragged;
    if (id) followAt(id);
    options.dragging.current = false;
    dragged = null;
    markReleaseClick();
    options.harvest(id ?? undefined);
    if (id) options.restate(id);
    // A press that went nowhere restacks nothing — see `restoreRestDepth`.
    // A moved mark's draw restates the depth the grab already rode.
    const moved = options.moved(id);
    if (id && !moved) restoreRestDepth(id);
    options.contact.release();
    physicsHeld = null;
    options.dropped?.(id, moved);
    options.queue();
    scheduleLabels();
  });
  // Every camera move settles here; the recorder keeps only the settled,
  // person-moved camera — see `cameraMemory`.
  graph.on("aftertransform", () => options.recorder()?.capture(graph));

  // G6 owns picking, but release belongs to the pointer even when it leaves
  // the canvas. A lost release would leave matter compressed indefinitely.
  const cancelPointer = () => {
    options.cancelled?.();
    const wasDragging = options.dragging.current;
    const id = dragged ?? physicsHeld;
    options.dragging.current = false;
    dragged = null;
    physicsHeld = null;
    if (wasDragging) {
      options.harvest(id ?? undefined);
      if (id) options.restate(id);
      const moved = options.moved(id);
      if (id && !moved) restoreRestDepth(id);
      options.dropped?.(id, moved);
    }
    options.contact.release();
    options.queue();
    scheduleLabels();
  };
  const releasePointer = () => {
    physicsHeld = null;
    options.contact.release();
    options.released?.();
  };
  window.addEventListener("pointerup", releasePointer);
  window.addEventListener("pointercancel", cancelPointer);
  window.addEventListener("blur", cancelPointer);

  return {
    scheduleLabels,
    holdHover,
    swallowReleaseClick,
    removeAtPress,
    recentlyRemoved,
    dispose: () => {
      host.removeEventListener("wheel", personTakesCamera, true);
      host.removeEventListener("pointerdown", personTakesCamera, true);
      window.removeEventListener("pointerup", releasePointer);
      window.removeEventListener("pointercancel", cancelPointer);
      window.removeEventListener("blur", cancelPointer);
      window.clearTimeout(releaseClickTimer);
      holdHover();
      window.cancelAnimationFrame(visibilityFrame);
      visibilityFrame = 0;
    },
  };
}

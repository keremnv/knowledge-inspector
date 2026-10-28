/**
 * The vocabulary canvas — §7.1.
 *
 * Lifted out of `WorldPage` when the field arrived beside it: two canvases in
 * one component is how one of them ends up with the other's behaviours. Its
 * first arrangement is deterministic, but it is still a thinking surface:
 * marks can be moved and their positions survive label and selection changes.
 *
 * Selection is the field's, which is the product canvas's: marching ants on the
 * mark's own outline. A relation that stands on the field is a plate and takes
 * a box; one that collapsed onto a bond has the beads run along the filament.
 * The two canvases share the component so they cannot come to disagree about
 * what being selected looks like.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Graph } from "@antv/g6";
import { keepRendererOutOfTabOrder } from "./rendererFocus";
import type { WorldRelation } from "../api/world";
import {
  GRAPH_DNA_FOCUS,
  GRAPH_DNA_INTERACTION,
  GRAPH_DNA_THEME,
  type GraphDnaTheme,
  type ThemeMode,
} from "../styles/graphDna";
import { DEFAULT_MOTION_PLANS } from "../styles/motion";
import { SelectionAnts, type AntTarget } from "../styles/SelectionAnts";
import { labelUnderPointer } from "./labelPick";
import { furnitureOf, isDecoration, MARK_DEFAULTS, paintOf } from "./marks";
import { ensureWorldFilamentRegistered } from "./filaments";
import { observeHostSize } from "./canvasHost";
import {
  convergeStrandedToFrame,
  paintLabelStrength,
  reducedMotion,
  restyleCanvasData,
  transitionCanvasData,
  type CanvasData,
  type CanvasDatum,
} from "./canvasMotion";
import {
  paintedLabelBox,
  resolveVisibility,
  stampLabelStrength,
  visibilityKindOf,
  VISIBILITY_STRENGTHS_ON,
  type VisibilityBox,
  type VisibilityRank,
} from "./visibility";
import { useFocusPan, type CameraInsets } from "./canvasFocus";
import { relationsByKind, schemaLayout } from "./schemaGraph";
import { readSchemaPositions, writeSchemaPositions } from "./schemaMemory";
import { createCameraRecorder, type CameraRecorder } from "./cameraMemory";

export const FOCUS_THEME: GraphDnaTheme = {
  surface: GRAPH_DNA_FOCUS.field,
  canvas: GRAPH_DNA_FOCUS.field,
  filament: GRAPH_DNA_FOCUS.lit,
  node: GRAPH_DNA_FOCUS.lit,
  nodeLabel: GRAPH_DNA_FOCUS.litLabel,
  chip: GRAPH_DNA_FOCUS.chip,
  lensLabel: GRAPH_DNA_FOCUS.lensLabel,
  bondLabel: GRAPH_DNA_FOCUS.bondLabel,
};

/**
 * Where the wheel may take the camera, enforced natively: every viewport
 * transform clamps through the graph's `zoomRange`, so without these a long
 * scroll shrinks the vocabulary to a dot it takes luck to find again. (The
 * default rail is 0.01–10 — the dot, and the dinner plate.)
 */
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
/**
 * Where a fit may take it — narrower, because a fit chose the zoom and a
 * person did not. A seven-node vocabulary fits near 2x and reads well there;
 * past it lies the one-disc world fitted at 3.4x, filling the frame with a
 * dinner plate. People can still zoom past it by hand afterwards.
 */
const MAX_FIT_ZOOM = 2;

/**
 * The relation an element belongs to, if any.
 *
 * Module scope because the visibility pass ranks from outside any render;
 * pure, so the handlers and the pass share the one mapping. Kind discs are
 * not relations — the pass ranks those off the hovered kind instead.
 */
function relationOf(id: string | null): string | null {
  if (!id || id.startsWith("kind:") || isDecoration(id)) return null;
  if (id.startsWith("rel:")) return id.slice(4);
  if (id.startsWith("filament:")) return id.slice(9).split(":")[0] || null;
  return id.split(":")[0] || null;
}

export function SchemaCanvas({
  relations,
  mode,
  namedAtRest,
  active,
  selected,
  inverted = false,
  focusId = null,
  focusToken = 0,
  insets,
  world,
  revision,
  onHover,
  onSelect,
}: {
  relations: WorldRelation[];
  /** World identity for the arrangement store; null until the overview lands. */
  world: string | null;
  revision: number | null;
  mode: ThemeMode;
  namedAtRest: boolean;
  /** Hover only changes what the canvas names. */
  active: string | null;
  /** Click chooses what the reader opens. */
  selected: string | null;
  /** Vocabulary as a focus room — inverted field, same marks. */
  inverted?: boolean;
  /** A table-named relation to fly to. Canvas clicks do not set this. */
  focusId?: string | null;
  focusToken?: number;
  insets: CameraInsets;
  onHover: (relation: string | null) => void;
  onSelect: (relation: string | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const insetsRef = useRef(insets);
  insetsRef.current = insets;
  const focusIdRef = useRef(focusId);
  focusIdRef.current = focusId;
  const [ready, setReady] = useState(false);
  /**
   * How many nodes the camera has framed, at most.
   *
   * The vocabulary arrives in SHOW-staged waves — mechanical layers are off
   * until something reveals them — so the first non-empty frame is a subset
   * and a fit-once flag spends the one fit on it: measured, the camera
   * framed 7 nodes at zoom 2.21 and never looked at the other 11. Counting
   * instead keeps the lens contract — hiding never reframes — while new
   * matter still gets established: a frame may reframe only when it holds
   * more than every frame before it.
   */
  const fittedCountRef = useRef(0);
  const fitLaneRef = useRef<Promise<void>>(Promise.resolve());
  /**
   * The kind disc the pointer is on, if any.
   *
   * Local, and not lifted to the page, because it changes nothing the page
   * knows: the reader still opens relations, the table still lists them. All
   * this decides is which names this canvas draws — a drawing concern, kept
   * where the drawing is.
   */
  const [hoveredKind, setHoveredKind] = useState<string | null>(null);
  const [positions, setPositions] = useState(
    () => new Map<string, { x: number; y: number }>(),
  );
  const liveRef = useRef(positions);
  const draggingRef = useRef(false);
  /**
   * Whether the stored arrangement has been offered, so a write never lands
   * before the read it would overwrite.
   */
  const seededRef = useRef(false);
  /**
   * Put back the vocabulary arrangement this browser last held for this world.
   *
   * Once, when the world identity lands: this canvas mounts before the
   * overview arrives, so the store cannot be read at mount. Seeding is order
   * free — relations arrive separately, and the data memo below applies
   * stored positions to whichever marks exist whenever they do.
   */
  useEffect(() => {
    if (world == null || revision == null || seededRef.current) return;
    seededRef.current = true;
    const stored = readSchemaPositions(world, revision);
    if (!stored) return;
    // One map, like `harvest`: the live cache and the state move together.
    const restored = new Map(stored);
    liveRef.current = restored;
    setPositions(restored);
  }, [world, revision]);
  /** Keep the stored arrangement level with the one on screen. */
  useEffect(() => {
    if (world == null || revision == null || !seededRef.current) return;
    writeSchemaPositions(world, revision, positions);
  }, [world, revision, positions]);
  /**
   * This room's camera, kept level with the store — see `cameraMemory`. Null
   * until the world identity lands; the listeners below read it through the
   * ref so they never hold a stale recorder.
   */
  const recorder = useMemo(
    () =>
      world != null && revision != null
        ? createCameraRecorder("schema", world, revision)
        : null,
    [world, revision],
  );
  const recorderRef = useRef<CameraRecorder | null>(null);
  recorderRef.current = recorder;
  useEffect(() => () => recorder?.dispose(), [recorder]);
  const holdCamera = useCallback(
    () => recorderRef.current?.hold() ?? (() => {}),
    [],
  );
  /**
   * The last frame this canvas authored, so a repaint can be told from a
   * lifecycle. `restyleCanvasData` compares against it; without it every
   * hover would go down the lifecycle path — see the effect below.
   */
  const authoredRef = useRef<CanvasData | null>(null);
  /**
   * What the visibility pass remembers per label: last strength and authored
   * base — the field's `labelStrengthsRef`, same contract. The base here is
   * read from the record, not the style, because this lane re-maps
   * memo-stable layout data and a style may already carry a stamped
   * strength; the field rebuilds its data every frame and reads the
   * builder's fresh value instead.
   */
  const labelStrengthsRef = useRef(new Map<string, { strength: number; base: number }>());
  /**
   * Who the names are ranked from, for passes that run outside a render.
   * Mirrored below, beside `lit`.
   */
  const visibilitySubjectsRef = useRef<{
    hover: string | null;
    hoveredKind: string | null;
    selection: string | null;
    namedAtRest: boolean;
    lit: Set<string> | undefined;
  }>({ hover: null, hoveredKind: null, selection: null, namedAtRest: false, lit: undefined });
  /**
   * The lifecycle run currently awaited, if any, so a paint-only frame that
   * cancels it can still owe its fit to the settled drawing — see the data
   * effect below. The run never rejects; it reports through `console.error`.
   */
  const flightRef = useRef<Promise<void> | null>(null);
  const onHoverRef = useRef(onHover);
  const onSelectRef = useRef(onSelect);
  onHoverRef.current = onHover;
  onSelectRef.current = onSelect;

  const paint = useMemo(
    () => paintOf(inverted ? FOCUS_THEME : GRAPH_DNA_THEME[mode], inverted || mode === "dark"),
    [inverted, mode],
  );
  const byKind = useMemo(() => relationsByKind(relations), [relations]);
  const lit = useMemo(() => {
    const standing = hoveredKind ? byKind.get(hoveredKind) : null;
    return standing ? new Set(standing) : undefined;
  }, [byKind, hoveredKind]);
  visibilitySubjectsRef.current = {
    hover: active,
    hoveredKind,
    selection: selected,
    namedAtRest,
    lit,
  };
  const base = useMemo(
    () =>
      schemaLayout(relations, paint, paint, MARK_DEFAULTS, {
        namedAtRest,
        focused: active,
        lit,
      }),
    [relations, paint, namedAtRest, active, lit],
  );
  const data = useMemo(
    () => ({
      ...base.data,
      nodes: (base.data.nodes as Array<{
        id?: string;
        style?: Record<string, unknown>;
      }>).map((node) => {
        const at = node.id
          ? (liveRef.current.get(node.id) ?? positions.get(node.id))
          : null;
        // The selected plate hands its border to the ants, which trace exactly
        // where the stroke was. Leaving it on would put a solid rectangle
        // under the dotted one — the pair this change exists to remove.
        //
        // And it opens, on the field's rule: selection withdraws a mark's fill
        // into its marching boundary whatever the mark is. An authored
        // relation was the one plate on this canvas that stayed solid when
        // looked at, which made the vocabulary answer selection differently
        // from the field showing the same relation's tuples.
        //
        // A bond's plate is an edge label, not a node, so the same withdrawal
        // is restated for edges below: a bare-name edge id is exactly the
        // filament-drawn binary, and nothing else carries one.
        //
        // The plate's furniture withdraws with it: a shelf or crown left
        // standing beside an opened plate is the fill refusing to have gone.
        // Same restyle-lane fade as the field — see `restyleCanvasData`.
        const ringed = node.id === `rel:${selected}`;
        const furnitureOpen =
          node.id === `shelf:rel:${selected}` ||
          node.id === `crown:rel:${selected}`;
        if (!at && !ringed && !furnitureOpen) return node;
        return {
          ...node,
          style: {
            ...node.style,
            ...(at ? { x: at.x, y: at.y } : null),
            ...(ringed
              ? {
                  lineWidth: 0,
                  fill: paint.canvas,
                  fillOpacity: 1,
                  labelFill: paint.ink,
                }
              : null),
            ...(furnitureOpen ? { opacity: 0 } : null),
          },
        };
      }),
      edges: (base.data.edges as Array<{
        id?: string;
        style?: Record<string, unknown>;
      }>).map((edge) => {
        // The same withdrawal for a bond's plate: the ants trace the label's
        // background rect, so the selected bond opens to the canvas and reads
        // in ink — knocked-out semantic text included.
        if (edge.id !== selected) return edge;
        return {
          ...edge,
          style: {
            ...edge.style,
            labelBackgroundFill: paint.canvas,
            labelBackgroundOpacity: 1,
            labelFill: paint.ink,
          },
        };
      }),
    }),
    [base.data, paint, positions, selected],
  );
  /**
   * Strengths, stated, so a draw paints what the pass settled.
   *
   * A second memo rather than part of the build above, because the build
   * re-maps memo-stable layout data and the stamp mutates styles in place:
   * folding it in would re-read its own stamped values as bases on every
   * re-map. `stampLabelStrength` reads the base from the record once seen,
   * so re-mapping is idempotent — but it still has to run after the build,
   * which the dependency says. Same object back, under the name the effects
   * below draw from.
   */
  const stamped = useMemo(() => {
    for (const datum of [...data.nodes, ...data.edges] as {
      id?: string;
      style?: Record<string, unknown>;
    }[]) {
      if (datum.id === undefined) continue;
      stampLabelStrength(
        datum as { id: string; style?: Record<string, unknown> },
        labelStrengthsRef.current,
      );
    }
    return data;
  }, [data]);

  /**
   * Frame the ring, when the frame holds more than every frame before it,
   * and only when there is a frame to do it in.
   *
   * The count is recorded on success rather than on attempt: a fit that ran
   * against a zero-sized stage, or that throws, established nothing, and
   * must not spend the reframing a later, fuller frame is owed.
   *
   * A focus vetoes reframing, not establishment. A table naming a mark on an
   * already-framed ring must not move the world — but a ring nobody has ever
   * framed has no world to hold still, and the hash naming a relation on
   * arrival left exactly that: every fit vetoed, the camera wherever the
   * graph was built. The first frame is still owed under focus; the focus
   * pan then reveals the mark inside the framed ring.
   */
  const fit = (graph: Graph, force = false): Promise<void> => {
    const run = fitLaneRef.current.then(async () => {
      if (graph.destroyed || graphRef.current !== graph) return;
      if (!force && focusIdRef.current && fittedCountRef.current > 0) return;
      const [width, height] = graph.getSize();
      if (!(width > 1 && height > 1)) return;
      const count = graph.getNodeData().length;
      if (!count || (!force && count <= fittedCountRef.current)) return;
      if (!force && fittedCountRef.current === 0) {
        /**
         * A stored camera is the establishment: the person framed this room
         * last visit, and fitting over it would spend their framing on the
         * default. Growth still reframes — this yields only while no frame has
         * ever been established — and a double-click reframe forces past it.
         */
        if (await recorderRef.current?.restore(graph)) {
          fittedCountRef.current = count;
          return;
        }
      }
      // G6 fitView computes translation from an unclamped scale. On a small
      // vocabulary its zoom rail can therefore send the content offscreen.
      // Choose the bounded zoom first, then center the actual painted bounds.
      const bounds = [...graph.getNodeData(), ...graph.getEdgeData()].flatMap((datum) => {
        try {
          const box = graph.getElementRenderBounds(String(datum.id));
          return [...box.min, ...box.max].every(Number.isFinite) ? [box] : [];
        } catch {
          return [];
        }
      });
      if (!bounds.length) return;
      const minX = Math.min(...bounds.map((box) => box.min[0]));
      const maxX = Math.max(...bounds.map((box) => box.max[0]));
      const minY = Math.min(...bounds.map((box) => box.min[1]));
      const maxY = Math.max(...bounds.map((box) => box.max[1]));
      const insets = insetsRef.current;
      const margin = 48;
      const availableWidth = width - insets.left - insets.right - margin * 2;
      const availableHeight = height - insets.top - insets.bottom - margin * 2;
      if (availableWidth <= 0 || availableHeight <= 0) return;
      const zoom = Math.max(MIN_ZOOM, Math.min(
        MAX_FIT_ZOOM,
        availableWidth / Math.max(1, maxX - minX),
        availableHeight / Math.max(1, maxY - minY),
      ));
      const release = force ? undefined : recorderRef.current?.hold();
      try {
        await graph.zoomTo(zoom, false);
        if (graph.destroyed || graphRef.current !== graph) return;
        const centre = graph.getViewportByCanvas([(minX + maxX) / 2, (minY + maxY) / 2]);
        const delta: [number, number] = [
          (insets.left + width - insets.right) / 2 - centre[0],
          (insets.top + height - insets.bottom) / 2 - centre[1],
        ];
        // G's landmark setters treat zero in a typed vector as an omitted
        // coordinate. Avoid that fallback by a hundredth of a viewport pixel;
        // a symmetric, single-kind vocabulary would otherwise never pan in Y.
        const camera = graph.getCanvas().getCamera();
        const position = camera.getPosition();
        const focalPoint = camera.getFocalPoint();
        for (const axis of [0, 1] as const) {
          if (
            Math.fround(position[axis] - delta[axis] / zoom) === 0 ||
            Math.fround(focalPoint[axis] - delta[axis] / zoom) === 0
          ) delta[axis] -= 0.01;
        }
        const settle = DEFAULT_MOTION_PLANS.settle;
        await graph.translateBy(delta, reducedMotion() ? false : {
          duration: settle.durationMs,
          easing: settle.easing.g6,
        });
        if (graph.destroyed || graphRef.current !== graph) return;
        fittedCountRef.current = count;
      } finally {
        release?.();
      }
    }).catch((problem: unknown) => {
      if (!graph.destroyed && graphRef.current === graph) console.error(problem);
    });
    fitLaneRef.current = run;
    return run;
  };

  /**
   * Establish the framing again, on demand. Double-clicking empty canvas is
   * the way back from anywhere the wheel took the camera: the count and the
   * focus flight both yield to an explicit ask, and current node positions —
   * dragged or laid — are what get framed.
   */
  const reframe = async (graph: Graph) => {
    await fit(graph, true);
  };



  /**
   * A relation is a plate if it has one, and a filament if it does not.
   *
   * The same question `schemaLayout` already answered by which element it
   * emitted, asked of the drawing rather than re-derived from arity — so a
   * relation that changes projection cannot end up ringed as the shape it is
   * no longer drawn as.
   */
  const antTarget = useMemo<AntTarget | null>(() => {
    if (!selected) return null;
    const plate = `rel:${selected}`;
    const standing = (base.data.nodes as Array<{ id?: string }>).some(
      (node) => node.id === plate,
    );
    return standing
      ? { shape: "rect", id: plate }
      : { shape: "edge-label", id: selected, text: selected };
  }, [base.data.nodes, selected]);

  /**
   * Settle which names read at full strength, off the drawing in front of
   * the reader — the field's `applyVisibility`, same contract. Kind discs
   * are not relations, so they rank off the hovered kind rather than the
   * hovered relation; everything else ranks off the relation it belongs to.
   * Runs after every paint lands: the initial render, a restyle, a
   * lifecycle flight, and the converge redraw that can follow a restyle.
   */
  const applyVisibility = useCallback((graph: Graph) => {
    const frame = authoredRef.current;
    if (!frame || graph.destroyed) return;
    const remembered = labelStrengthsRef.current;
    const standing = new Set([...frame.nodes, ...frame.edges].map((datum) => datum.id));
    for (const id of [...remembered.keys()]) {
      if (!standing.has(id)) remembered.delete(id);
    }
    let settled: Map<string, number>;
    if (VISIBILITY_STRENGTHS_ON) {
      const subjects = visibilitySubjectsRef.current;
      const boxes: VisibilityBox[] = [];
      const ranks = new Map<string, VisibilityRank>();
      for (const datum of [...frame.nodes, ...frame.edges]) {
        const style = datum.style as Record<string, unknown> | undefined;
        if (!style) continue;
        if (typeof style.labelText !== "string" || !style.labelText) continue;
        const shown = (style.labelOpacity as number | undefined) ?? 1;
        if (!(shown > 0)) continue;
        const box = paintedLabelBox(graph, datum.id);
        if (!box) continue;
        boxes.push({ id: datum.id, ...box });
        const relation = relationOf(datum.id);
        const kindDisc = datum.id.startsWith("kind:") ? datum.id.slice(5) : null;
        ranks.set(datum.id, {
          selection: relation !== null && relation === subjects.selection,
          hover:
            (relation !== null && relation === subjects.hover) ||
            (kindDisc !== null && kindDisc === subjects.hoveredKind),
          named:
            relation !== null
              ? subjects.namedAtRest ||
                relation === subjects.hover ||
                (subjects.lit?.has(relation) ?? false)
              : kindDisc !== null && kindDisc === subjects.hoveredKind,
          kind: visibilityKindOf(style.labelFontFamily),
        });
      }
      const prev = new Map(
        [...remembered].map(([id, record]) => [id, record.strength] as const),
      );
      settled = resolveVisibility(boxes, ranks, prev);
    } else {
      // Strengths off: every standing name reads at its full authored
      // strength — see the field lane's pass, same contract.
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
      // The baseline carries what is painted, so the next restyle diffs
      // against it rather than restating it as a change.
      style.labelFillOpacity = base * strength;
      // Strength owns only its channel; the pointer owns the live position.
      // But an edge patch without a numeric zIndex makes G6 rewrite the
      // edge's depth from its endpoints, sinking the name to the stroke
      // layer — so the authored depth rides along. Nodes skip that rewrite.
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
    // Geometry follows the hand during a drag; a restarted fade would lag
    // behind it even though the crowding curve itself is already continuous.
    const tracking = draggingRef.current || reducedMotion();
    paintLabelStrength(graph, paint, {
      weakenPlan: tracking ? undefined : DEFAULT_MOTION_PLANS.absorb,
      restorePlan: tracking ? undefined : DEFAULT_MOTION_PLANS.emit,
    });
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // The vocabulary draws the same marks the field does, and G6 resolves an
    // edge's type as it builds it. Registration is global and idempotent.
    ensureWorldFilamentRegistered();
    const graph = new Graph({
      container: host,
      data: stamped as never,
      animation: false,
      padding: 48,
      zoomRange: [MIN_ZOOM, MAX_ZOOM],
      background: "transparent",
      // Selection is the ants, over the canvas — see `WorldCanvas`. No halo
      // under the plate and no thickened filament: one fact, one mark.
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
          dropEffect: "none",
          animation: false,
          enable: (event: unknown) => {
            const id = (event as { target?: { id?: unknown } })?.target?.id;
            return typeof id === "string" && !isDecoration(id);
          },
        },
      ],
    });

    const idOf = (event: unknown): string | null => {
      const target = (event as { target?: { id?: unknown } } | undefined)?.target;
      return typeof target?.id === "string" ? target.id : null;
    };
    const harvest = () => {
      const next = new Map<string, { x: number; y: number }>();
      for (const node of graph.getNodeData()) {
        const id = String(node.id);
        const at = graph.getElementPosition(id);
        if (at) next.set(id, { x: Math.round(at[0]), y: Math.round(at[1]) });
      }
      liveRef.current = next;
      setPositions(next);
    };
    const followFurniture = (id: string) => {
      const position = graph.getElementPosition(id);
      if (!position) return;
      liveRef.current.set(id, { x: position[0], y: position[1] });
      const present = new Set(graph.getNodeData().map((node) => String(node.id)));
      const offset = MARK_DEFAULTS.chipHeight / 2 + MARK_DEFAULTS.shelfGap;
      const moved: Record<string, [number, number]> = {};
      for (const furniture of furnitureOf(id)) {
        if (!present.has(furniture)) continue;
        moved[furniture] = [
          position[0],
          furniture.startsWith("crown:")
            ? position[1] - offset
            : position[1] + offset,
        ];
      }
      if (Object.keys(moved).length) void graph.translateElementTo(moved, false);
    };

    /**
     * Leaving a disc is not the same as having stopped looking at it.
     *
     * A kind's names appear beside it, so reading one means moving off the
     * disc towards the name — and clearing on `pointerleave` takes the answer
     * away on the way to it. The field solved this once already: stand down
     * after the same interval a name takes to arrive, and let arriving
     * anywhere cancel it. Crossing from a disc onto one of its names keeps the
     * light where it was.
     */
    let standDown: number | undefined;
    const arrive = () => {
      window.clearTimeout(standDown);
      standDown = undefined;
    };
    graph.on("node:pointerenter", (event) => {
      if (draggingRef.current) return;
      arrive();
      const id = idOf(event);
      // A kind names what stands on it; a relation names itself. Two different
      // answers to "what is the person looking at", and only the second is a
      // subject the reader could open, which is why only the second is lifted.
      setHoveredKind(id && id.startsWith("kind:") ? id.slice(5) : null);
      onHoverRef.current(relationOf(id));
    });
    graph.on("edge:pointerenter", () => {
      if (!draggingRef.current) arrive();
    });
    graph.on("node:pointerleave", () => {
      if (draggingRef.current) return;
      arrive();
      standDown = window.setTimeout(() => {
        standDown = undefined;
        setHoveredKind(null);
        onHoverRef.current(null);
      }, DEFAULT_MOTION_PLANS.emit.durationMs);
    });
    graph.on("node:click", (event) => {
      const relation = relationOf(idOf(event));
      if (relation) onSelectRef.current(relation);
    });
    graph.on("edge:click", (event) => {
      const relation = relationOf(idOf(event));
      if (relation) onSelectRef.current(relation);
    });
    /**
     * A binary relation is drawn as the name on a filament and nothing else.
     *
     * No plate, so no node to click — and G6 does not deliver clicks on these
     * labels, which left `source_scope_claim` and every other base binary
     * openable from the catalogue and not from the drawing of it. `labelPick`
     * is the same canvas-space hit test the field uses; the handler above stays
     * for the case where G6 does route the event.
     *
     * Only relation names. A spoke's role name is not a relation and has the
     * relation's own plate sitting at the end of it.
     */
    const reachableLabel = (id: string) => !id.includes(":");
    /**
     * The click that follows the press this handler already answered.
     *
     * Swallowing the `pointerdown` does not swallow the `click`: the browser
     * still dispatches one, G6's picker still fails to find the label under
     * it, and what it does find is the canvas — which is the gesture for
     * "nothing here", so the selection this press just made would be undone by
     * the release of the same press. Capture on the host beats the listener G6
     * has on its own canvas.
     *
     * Decided by *where* the click landed, not by how long ago the press was.
     * A time window was the first attempt and it is the wrong instrument: it
     * makes a slow click and a quick one two different gestures, which is a
     * distinction nobody makes on purpose and a bug nobody can describe.
     */
    const swallowLabelClick = (event: MouseEvent) => {
      if (
        !labelUnderPointer(graph, event.clientX, event.clientY, reachableLabel)
      ) {
        return;
      }
      event.stopPropagation();
      event.preventDefault();
    };
    /**
     * Whether the press this release belongs to landed on a name.
     *
     * G6's "click on nothing" does not come from the DOM `click` — swallowing
     * that was not enough, and the reader opened on the press and closed again
     * on the release. Whatever @antv/g derives its click from, it arrives as
     * `canvas:click`, so the answer is given there: every press through this
     * host records whether it hit a reachable label, and the release that
     * follows a hit is not "nothing here".
     *
     * Recorded on *every* press, hit or miss, so it is never stale — a press
     * on empty canvas clears it on the way in.
     */
    let pressedLabel = false;
    const clickLabel = (event: PointerEvent) => {
      if (draggingRef.current) return;
      const hit = labelUnderPointer(
        graph,
        event.clientX,
        event.clientY,
        reachableLabel,
      );
      pressedLabel = Boolean(hit);
      if (!hit) return;
      event.stopPropagation();
      event.preventDefault();
      onSelectRef.current(hit);
    };
    host.addEventListener("pointerdown", clickLabel, true);
    host.addEventListener("click", swallowLabelClick, true);
    graph.on("canvas:click", () => {
      if (pressedLabel) return;
      onSelectRef.current(null);
    });
    // The way back: double-clicking empty canvas reframes what is there.
    // Nodes and edges get their own dblclick events, so this only ever fires
    // for the void between marks.
    graph.on("canvas:dblclick", () => void reframe(graph));
    let visibilityFrame = 0;
    const scheduleVisibility = () => {
      if (visibilityFrame) return;
      visibilityFrame = window.requestAnimationFrame(() => {
        visibilityFrame = 0;
        if (graphRef.current === graph && !graph.destroyed) applyVisibility(graph);
      });
    };
    graph.on("node:dragstart", (event) => {
      draggingRef.current = true;
      const id = idOf(event);
      if (id && !isDecoration(id)) followFurniture(id);
      scheduleVisibility();
    });
    graph.on("node:drag", (event) => {
      const id = idOf(event);
      if (!id || isDecoration(id)) return;
      // A microtask behind the event: the behavior translates after this
      // listener runs — see the field's `node:drag` — so a synchronous
      // follow puts the furniture where the mark was. Drains before paint.
      queueMicrotask(() => {
        if (graph.destroyed) return;
        followFurniture(id);
      });
      scheduleVisibility();
    });
    graph.on("node:dragend", (event) => {
      const id = idOf(event);
      if (id && !isDecoration(id)) followFurniture(id);
      draggingRef.current = false;
      harvest();
      scheduleVisibility();
    });
    // Every camera move settles here; the recorder keeps only the settled,
    // person-moved camera — see `cameraMemory`.
    graph.on("aftertransform", () => recorderRef.current?.capture(graph));

    graphRef.current = graph;
    keepRendererOutOfTabOrder(graph);
    // The frame the graph was built from. Without it the first hover has
    // nothing to diff against and falls to the lifecycle path.
    authoredRef.current = {
      nodes: stamped.nodes as CanvasDatum[],
      edges: stamped.edges as CanvasDatum[],
    };
    // Unmounting mid-render is not a failure. Placing the first thing on the
    // field replaces this canvas with the field's, and G6 rejects whatever draw
    // was in flight with "the graph instance has been destroyed" — a real
    // error, reported, only if this graph is still the current one.
    void graph
      .render()
      .then(() => {
        if (graphRef.current !== graph) return;
        applyVisibility(graph);
        setReady(true);
      })
      .catch((problem: unknown) => {
        if (graphRef.current === graph) console.error(problem);
      });
    // Its own development-only name. A check aimed at the field should land on
    // the vocabulary canvas, not on whichever canvas rendered last.
    if (import.meta.env.DEV) {
      (window as unknown as { __worldVocabulary?: Graph }).__worldVocabulary = graph;
    }
    return () => {
      window.clearTimeout(standDown);
      window.cancelAnimationFrame(visibilityFrame);
      host.removeEventListener("pointerdown", clickLabel, true);
      host.removeEventListener("click", swallowLabelClick, true);
      graphRef.current = null;
      authoredRef.current = null;
      setReady(false);
      if (
        (window as unknown as { __worldVocabulary?: Graph }).__worldVocabulary ===
        graph
      ) {
        delete (window as unknown as { __worldVocabulary?: Graph })
          .__worldVocabulary;
      }
      graph.destroy();
    };
    // The graph is created once. Data changes below preserve viewport and
    // manually arranged positions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || draggingRef.current) return;
    let cancelled = false;
    const next = {
      nodes: stamped.nodes as CanvasDatum[],
      edges: stamped.edges as CanvasDatum[],
    };
    /**
     * Hovering a relation is a repaint, and it must not go through the
     * lifecycle.
     *
     * Nothing arrives, nothing leaves and nothing is anywhere new when a
     * relation lights its role names — the same pointer-direct case the field
     * canvas has always sent to `restyleCanvasData`. Sending it to
     * `transitionCanvasData` instead let G6 own the label fade, and G6 will
     * happily run two fades on one plate: hover on authors the name, hover off
     * authors it away thirty milliseconds later, and the abandoned fade
     * finishes last and writes *its* end value back. The plate is then opaque
     * while the data says it is transparent, and because G6 diffs authored
     * data against authored data, nothing afterwards ever writes it again.
     *
     * A role plate is painted in the canvas colour, so what that leaves on
     * screen is a gap bitten out of the filament where the name used to be —
     * for the life of the page, and only when the pointer moved quickly enough
     * to overlap the two fades.
     *
     * `fadeShape` is the interlock: it cancels the fade already running on a
     * shape before starting the next one. The field canvas has had it all
     * along. This is the same canvas asking the same question, so it takes the
     * same path, and falls through to the lifecycle when the frame is
     * genuinely more than paint.
     */
    if (
      restyleCanvasData(graph, authoredRef.current, next, {
        // A name arriving is a body leaving its home. Absent under reduced
        // motion, which lands it outright — `restyleCanvasData` says so.
        // Furniture takes the same rule, on the lifecycle's own pair.
        labelPlan: reducedMotion() ? undefined : DEFAULT_MOTION_PLANS.emit,
        revealPlan: reducedMotion() ? undefined : DEFAULT_MOTION_PLANS.emit,
        releasePlan: reducedMotion() ? undefined : DEFAULT_MOTION_PLANS.absorb,
      })
    ) {
      authoredRef.current = next;
      // The paint landed in place — nothing moved, so the boxes this reads
      // are the boxes the restyle just left.
      applyVisibility(graph);
      // Debts a cancelled lifecycle owed. A paint-only frame landing
      // mid-transition — the hash naming a relation on arrival — takes this
      // lane while the run carrying the new matter is still awaiting, and
      // cancelling that run cancels its fit with it: measured, the camera
      // never established and nothing afterwards ever owed it again. Worse,
      // the run can strand transient poses in the model — births frozen at
      // opacity 0 and mid-flight size — which restyle never patches, because
      // it diffs authored frames and both say the end state. Both debts are
      // owed to the settled drawing rather than to this tick: converge the
      // model to this frame, redraw, then offer establishment against true
      // bounds. The flight check yields to a newer lifecycle, which
      // converges for itself; `fit` still decides the camera, and the count
      // gate keeps paint from reframing once anything has established.
      const flight = flightRef.current;
      const frame = next;
      const oweEstablishment = fittedCountRef.current === 0;
      void Promise.resolve(flight).then(async () => {
        if (graphRef.current !== graph || flightRef.current !== flight) return;
        if (convergeStrandedToFrame(graph, frame)) {
          try {
            await graph.draw();
          } catch {
            return;
          }
          if (graphRef.current !== graph) return;
          // The redraw re-laid the converged marks, so the boxes moved.
          applyVisibility(graph);
        }
        if (oweEstablishment) void fit(graph);
      });
      return;
    }
    authoredRef.current = next;
    const flight = (async () => {
      try {
        await transitionCanvasData(
          graph,
          next,
          () => cancelled || graphRef.current !== graph,
        );
        if (cancelled || graphRef.current !== graph) return;
        // New matter standing means new boxes to contest.
        applyVisibility(graph);
        // Establish the vocabulary's camera when the frame earns it. A SHOW
        // change is a lens over the same map and must not reframe whatever
        // remains — but the first sight of new matter is establishment, not
        // a lens change, and `fit` reframes for exactly that.
        //
        // Not against a viewport with no size in it. This canvas is built
        // while it may still be parked behind the field, and a fit computed
        // against nothing establishes nothing — the resize observer below
        // finishes the job when the stage is actually given room.
        await fit(graph);
      } catch (problem: unknown) {
        if (graphRef.current === graph) console.error(problem);
      }
    })();
    flightRef.current = flight;
    return () => {
      cancelled = true;
    };
  }, [stamped]);

  // A renderer sized once is sized wrong the moment anything else on the page
  // takes room. The camera is left alone — resizing is not new matter, and
  // vocabulary then clear must return to the same view, not a fresh fit.
  //
  // Unless no fit could have meant anything yet. A stage that had no room
  // when the ring was drawn has room now; `fit` itself decides whether this
  // frame earns the reframing, so this just offers it the moment.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    return observeHostSize(host, (width, height) => {
      const graph = graphRef.current;
      if (!graph) return;
      graph.resize(width, height);
      void fit(graph);
    });
  }, []);

  useFocusPan(graphRef, ready, focusId, focusToken, insetsRef, holdCamera);

  return (
    <div className="world__stage">
      <div className="world__surface" ref={hostRef} />
      <SelectionAnts
        graph={ready ? graphRef.current : null}
        target={antTarget}
        clearance={GRAPH_DNA_INTERACTION.selectionClearance}
        dotGap={GRAPH_DNA_INTERACTION.selectionDotGap}
        lineWidth={GRAPH_DNA_INTERACTION.selectionLine}
        speed={
          GRAPH_DNA_INTERACTION.selectionMotion
            ? GRAPH_DNA_INTERACTION.selectionSpeed
            : 0
        }
        color={paint.ink}
        motion={DEFAULT_MOTION_PLANS}
        animated={GRAPH_DNA_INTERACTION.selectionMotion}
      />
    </div>
  );
}

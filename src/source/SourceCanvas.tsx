import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Graph } from "@antv/g6";
import { GRAPH_DNA_INTERACTION, GRAPH_DNA_THEME, type ThemeMode } from "../styles/graphDna";
import { DEFAULT_MOTION_PLANS, NODE_BIRTH_PLAN, NODE_COLLAPSE_PLAN } from "../styles/motion";
import { SelectionAnts, type AntTarget } from "../styles/SelectionAnts";
import { createCameraRecorder, type CameraRecorder } from "../world/cameraMemory";
import { refreshFieldText, useFieldFontEpoch } from "../world/fieldFonts";
import { cancelPan, resolveFocusId, useFocusPan, type Box, type CameraInsets, type FieldFraming } from "../world/canvasFocus";
import { observeHostSize } from "../world/canvasHost";
import { contactId, IDLE_CONTACT, type ContactState } from "../world/canvasInteraction";
import type { CanvasData, CanvasDatum } from "../world/canvasMotion";
import { stampFieldPaint } from "../world/fieldPaint";
import {
  bindFieldPointer,
  elementIdOf,
  swallowMenu,
  contactHoldsLane,
  contactOwnsPointer,
  createFieldContact,
  createFieldGraph,
  createFieldLane,
  harvestFieldPositions,
  MATERIAL_DEFAULTS,
  settleFieldLabels,
  type FieldFrame,
} from "../world/fieldRenderer";
import { ensureWorldFilamentRegistered } from "../world/filaments";
import { FOCUS_THEME } from "../world/SchemaCanvas";
import { discLabelTruncated, MARK_DEFAULTS, paintOf } from "../world/marks";
import { stampLabelStrength, visibilityKindOf } from "../world/visibility";
import type { Point } from "../world/workingSet";
import { sourceConnectionName, sourceKeyLabel, type SourceField } from "./sourceField";
import { bindLabelPicking } from "../world/labelPick";
import { createSpreadField, SPREAD_FRAME_EVENT, spreadOwnerForSelection, spreadYieldsToHold, type SpreadField } from "../world/spread";
import { sourceAttention, sourceCanonicalFrame, restationSourcePlates, type SourcePlatePose } from "./sourceCanonicalFrame";
import { SourcePassThrough } from "./SourcePassThrough";
import type { SourcePresentation } from "./sourcePresentation";
import "../world/fieldStage.css";

const LIFECYCLE = { birth: NODE_BIRTH_PLAN, collapse: NODE_COLLAPSE_PLAN };

/**
 * The captured-source field: verified records a person placed, drawn and
 * handled by the same renderer mechanics as World's field.
 *
 * This component owns no source meaning. The workspace hands it a field of
 * placed records and receives back element ids — selected, moved, removed —
 * which it translates into its own record and observation subjects. Only
 * explicitly shown structural observations are drawn; membership and evidence
 * remain Source-owned.
 */
export function SourceCanvas({ field, mode, selected, reveal, insets, onSelect, onPositions, onRemove, presentation, labels: names, cameraRoom, standing = false, handleName = "__sourceFieldGraph", namedAtRest = false, inverted = false, fit = false, passThrough = false }: {
  field: SourceField;
  /**
   * Draw the hidden part of a line across a record it does not join
   * (`SourcePassThrough`). The record canvas only: the schema keeps World's look (O12).
   */
  passThrough?: boolean;
  /**
   * The field this canvas mounts with is a remembered one (O8.8): built
   * holding it and drawn still, as World draws a stored field, so the
   * remembered camera is the establishment rather than a birth's framing.
   */
  standing?: boolean;
  /** The development-build window name this graph is exposed under. */
  handleName?: string;
  /** Every connection named at rest, as World's "names" toggle does (O12). */
  namedAtRest?: boolean;
  /** World's focus-room palette, as World draws its schema (O12). */
  inverted?: boolean;
  /**
   * Frame every mark when first drawn, unless a remembered camera was put
   * back, and again on a double-click of empty canvas: World's schema fit (O12).
   */
  fit?: boolean;
  /** Remember the camera on refresh in this tab (O8.8), using the shared recorder. */
  cameraRoom?: string;
  presentation: SourcePresentation;
  /** Each mark's name by element id (O17); a mark not named here is called by its key. */
  labels?: ReadonlyMap<string, string>;
  mode: ThemeMode;
  /** The placed mark the Reader is open on, by element id. */
  selected: string | null;
  /** A mark to bring into view: an explicit Show on canvas or list choice. */
  reveal: { id: string; token: number } | null;
  insets: CameraInsets;
  onSelect: (elementId: string | null) => void;
  onPositions: (positions: Map<string, Point>, droppedId?: string) => void;
  onRemove: (elementId: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [mountedStanding] = useState(standing);
  // The settled, person-moved camera, kept for this capture; restored on the
  // first draw of a remembered field, as World's field restores its own.
  const recorder = useMemo(() => cameraRoom ? createCameraRecorder("field", cameraRoom, 1, "sessionStorage") : null, [cameraRoom]);
  const recorderRef = useRef<CameraRecorder | null>(recorder);
  recorderRef.current = recorder;
  useEffect(() => () => recorder?.dispose(), [recorder]);
  const holdCamera = useCallback(() => recorderRef.current?.hold() ?? (() => {}), []);
  const graphRef = useRef<Graph | null>(null);
  const motionRef = useRef(DEFAULT_MOTION_PLANS);
  const materialRef = useRef(MATERIAL_DEFAULTS);
  const params = MARK_DEFAULTS;
  const contactRef = useRef<ContactState>(IDLE_CONTACT);
  const [contact, setContact] = useState<ContactState>(IDLE_CONTACT);
  const [hovered, setHovered] = useState<string | null>(null);
  const pointerOwnsLoad = contactOwnsPointer(contact.phase);
  const litHover = pointerOwnsLoad ? null : hovered;
  const insetsRef = useRef(insets);
  insetsRef.current = insets;
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [ready, setReady] = useState(false);
  const drawnRef = useRef(0);
  const drawnFieldIds = useRef(new Set<string>());
  const pendingFrameRef = useRef<FieldFrame | null>(null);
  const authoredRef = useRef<CanvasData | null>(null);
  const labelStrengthsRef = useRef(new Map<string, { strength: number; base: number }>());
  const visibilitySubjectsRef = useRef<{ hover: string | null; selection: string | null }>({ hover: null, selection: null });
  visibilitySubjectsRef.current = { hover: litHover, selection: selected };
  const fieldRef = useRef(field);
  fieldRef.current = field;
  const onSelectRef = useRef(onSelect);
  const onRemoveRef = useRef(onRemove);
  onSelectRef.current = onSelect;
  onRemoveRef.current = onRemove;
  const cameraEstablishedRef = useRef(false);
  const cameraIntentRef = useRef(0);
  const draggingRef = useRef(false);
  const paint = useMemo(() => paintOf(inverted ? FOCUS_THEME : GRAPH_DNA_THEME[mode], inverted || mode === "dark"), [inverted, mode]);

  /**
   * Positions the renderer currently has, including a drag in flight. Adopted
   * from the field only when it hands over a new map — see World's `liveRef`,
   * whose reasons are the same.
   */
  const liveRef = useRef(new Map(field.positions));
  const liveSourceRef = useRef(field.positions);
  if (!draggingRef.current && liveSourceRef.current !== field.positions) {
    liveSourceRef.current = field.positions;
    liveRef.current = new Map(field.positions);
  }

  const stationMemory = useRef(new Map<string, "source" | "target">());
  const posesRef = useRef(new Map<string, SourcePlatePose>());
  const spreadRef = useRef<SpreadField | null>(null);
  const spreadOwnerRef = useRef<string | null>(null);
  const spreadSuspended = useRef(false);
  const labelPickRef = useRef<string | null>(null);
  const lastSelectedRef = useRef<string | null>(null);
  const [openedGroup, setOpenedGroup] = useState<string | null>(null);
  const openedGroupRef = useRef(openedGroup); openedGroupRef.current = openedGroup;
  const frozenSubjects = useRef({ hovered, selected });
  const subjects = useMemo(() => {
    if (pointerOwnsLoad) return frozenSubjects.current;
    return frozenSubjects.current = { hovered, selected };
  }, [hovered, selected, pointerOwnsLoad]);
  const attention = useMemo(() => sourceAttention(field, litHover, selected, namedAtRest), [field, litHover, selected, namedAtRest]);
  const namedRef = useRef(attention.named);

  const labels = useMemo(
    () => new Map(field.records.map((record) => [record.elementId, names?.get(record.elementId) ?? sourceKeyLabel(record.table, record.key)])),
    [field.records, names],
  );
  const labelsRef = useRef(labels);
  labelsRef.current = labels;

  const labelRank = useCallback((id: string, font: unknown) => {
    const subject = visibilitySubjectsRef.current;
    const owner = posesRef.current.get(id)?.owner ?? id;
    return { selection: owner === subject.selection, hover: owner === subject.hover,
      named: namedRef.current?.has(id) ?? false, kind: visibilityKindOf(font) };
  }, []);

  // A face finished loading: every plate is measured again — see `fieldFonts`.
  const fontEpoch = useFieldFontEpoch();
  useEffect(() => {
    const graph = graphRef.current;
    if (fontEpoch && graph) refreshFieldText(graph);
  }, [fontEpoch]);

  const data = useMemo<CanvasData>(() => {
    const canonical = sourceCanonicalFrame(field, liveRef.current, labels, paint, params, selected,
      subjects, stationMemory.current, attention, presentation, openedGroup);
    posesRef.current = canonical.poses;
    namedRef.current = canonical.named;
    const nodes: CanvasDatum[] = canonical.data.nodes;
    for (const node of nodes) stampLabelStrength(node, labelStrengthsRef.current);
    const edges = canonical.data.edges;
    for (const edge of edges) stampLabelStrength(edge, labelStrengthsRef.current);
    stampFieldPaint(nodes, edges, field.depth, labelRank);
    return { nodes, edges };
  }, [field, labels, paint, params, selected, presentation, attention, subjects, openedGroup, labelRank, fontEpoch]);

  const antTarget = useMemo<AntTarget | null>(
    () => selected && field.positions.has(selected)
      ? { shape: "circle", id: selected, diameter: params.discDiameter, clearance: 0 }
      : selected && field.references.some((reference) => reference.elementId === selected)
        ? { shape: "edge-label", id: selected, clearance: 0 } : null,
    [field.references, field.positions, params.discDiameter, selected],
  );
  const antsGone = useCallback((id: string) => !fieldRef.current.positions.has(id) && !fieldRef.current.references.some((reference) => reference.elementId === id), []);

  const harvest = useCallback((droppedId?: string) => {
    const graph = graphRef.current;
    if (!graph) return;
    const out = harvestFieldPositions(graph);
    if (!out.size) return;
    liveRef.current = new Map([...liveRef.current, ...out]);
    onPositions(out, droppedId);
  }, [onPositions]);
  const harvestRef = useRef(harvest);
  harvestRef.current = harvest;
  const dragMoved = (id: string | null): boolean => {
    if (!id) return false;
    const live = liveRef.current.get(id);
    const stored = fieldRef.current.positions.get(id);
    return !!live && !!stored && (live.x !== stored.x || live.y !== stored.y);
  };
  /** A frame that waited out a drag carries the mark where the drag began. */
  const restatePendingDrag = (id: string) => {
    const frame = pendingFrameRef.current;
    const at = liveRef.current.get(id);
    if (!frame || !at) return;
    pendingFrameRef.current = {
      ...frame,
      nodes: frame.nodes.map((node) => node.id === id ? { ...node, style: { ...node.style, x: at.x, y: at.y } } : node),
    };
  };

  const applyVisibility = useCallback((graph: Graph) => {
    settleFieldLabels(
      graph,
      authoredRef.current,
      labelStrengthsRef.current,
      labelRank,
      motionRef.current,
      draggingRef.current,
    );
  }, [labelRank]);

  // World's schema fit (`SchemaCanvas` `fit`): the zoom bounded first, then the
  // painted bounds centred in the unobscured canvas.
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const fittedRef = useRef(false);
  const restoredRef = useRef(false);
  const frameAll = useCallback(async (graph: Graph, force = false) => {
    if (graph.destroyed || graphRef.current !== graph || (!force && (fittedRef.current || restoredRef.current))) return;
    const [width, height] = graph.getSize();
    if (!(width > 1 && height > 1)) return;
    const boxes = [...graph.getNodeData(), ...graph.getEdgeData()].flatMap((datum) => {
      try {
        const box = graph.getElementRenderBounds(String(datum.id));
        return [...box.min, ...box.max].every(Number.isFinite) ? [box] : [];
      } catch { return []; }
    });
    if (!boxes.length) return;
    const minX = Math.min(...boxes.map((b) => b.min[0])), maxX = Math.max(...boxes.map((b) => b.max[0]));
    const minY = Math.min(...boxes.map((b) => b.min[1])), maxY = Math.max(...boxes.map((b) => b.max[1]));
    const insets = insetsRef.current, margin = 48;
    const room = [width - insets.left - insets.right - margin * 2, height - insets.top - insets.bottom - margin * 2];
    if (room[0] <= 0 || room[1] <= 0) return;
    const zoom = Math.max(0.25, Math.min(2, room[0] / Math.max(1, maxX - minX), room[1] / Math.max(1, maxY - minY)));
    const release = recorderRef.current?.hold();
    try {
      await graph.zoomTo(zoom, false);
      if (graph.destroyed || graphRef.current !== graph) return;
      const centre = graph.getViewportByCanvas([(minX + maxX) / 2, (minY + maxY) / 2]);
      const delta: [number, number] = [(insets.left + width - insets.right) / 2 - centre[0], (insets.top + height - insets.bottom) / 2 - centre[1]];
      // As World's: G reads a zero in a typed vector as an omitted coordinate.
      const camera = graph.getCanvas().getCamera(), position = camera.getPosition(), focal = camera.getFocalPoint();
      for (const axis of [0, 1] as const) {
        if (Math.fround(position[axis] - delta[axis] / zoom) === 0 || Math.fround(focal[axis] - delta[axis] / zoom) === 0) delta[axis] -= 0.01;
      }
      await graph.translateBy(delta, false);
      fittedRef.current = true;
    } finally {
      release?.();
    }
  }, []);

  const queueCanvasDraw = useMemo(() => createFieldLane({
    graph: graphRef,
    holds: () => draggingRef.current || contactHoldsLane(contactRef.current.phase),
    pending: pendingFrameRef,
    authored: authoredRef,
    drawnIds: drawnFieldIds,
    drawnCount: drawnRef,
    established: cameraEstablishedRef,
    // A fitted canvas learns whether the remembered camera was put back.
    recorder: () => recorderRef.current && fitRef.current ? { ...recorderRef.current,
      restore: async (graph: Graph) => (restoredRef.current = await recorderRef.current!.restore(graph)) } : recorderRef.current,
    insets: () => insetsRef.current,
    motion: () => motionRef.current,
    lifecycle: () => LIFECYCLE,
    nodeMember: (id) => id,
    edgeMember: (id) => id,
    afterDraw: (graph, drew) => {
      if (drew) applyVisibility(graph);
      if (!spreadSuspended.current) spreadRef.current?.commit(spreadOwnerRef.current);
      if (drew && fitRef.current) void frameAll(graph);
    },
  }), [applyVisibility, frameAll]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Mounted by an explicit placement, everything arriving is a birth; a
    // remembered field is already standing, as World builds a stored one.
    ensureWorldFilamentRegistered();
    const initial: CanvasData = mountedStanding ? data : { nodes: [], edges: [] };
    const { graph, dispose: disposeGraph } = createFieldGraph(host, initial);
    graphRef.current = graph;
    // Nodes and edges have their own double-click: this is empty canvas only.
    if (fitRef.current) graph.on("canvas:dblclick", () => void frameAll(graph, true));
    authoredRef.current = initial;
    const contactBody = createFieldContact(graph, {
      state: contactRef,
      publish: setContact,
      material: () => materialRef.current,
      motion: () => motionRef.current,
      settled: queueCanvasDraw,
    });
    spreadRef.current = createSpreadField({ graph, params: () => params,
      motion: () => motionRef.current, enabled: () => true,
      reduced: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches });
    const picking = bindLabelPicking(graph, host, {
      dragging: () => draggingRef.current,
      reachable: (id) => posesRef.current.has(id),
      pick: (id, button) => {
        const summary = posesRef.current.get(id)?.summary;
        if (button === 2 && !summary) { pointer.removeAtPress(id, () => onRemoveRef.current(id)); return; }
        pointer.holdHover();
        if (summary) { setOpenedGroup(openedGroupRef.current === id ? null : id); return; }
        setOpenedGroup(null); labelPickRef.current = id; onSelectRef.current(id);
      },
    });
    const placed = (id: string | null) => id && fieldRef.current.positions.has(id) ? id : null;
    const pointer = bindFieldPointer(graph, host, {
      dragging: draggingRef,
      contact: contactBody,
      intent: cameraIntentRef,
      established: cameraEstablishedRef,
      recorder: () => recorderRef.current,
      motion: () => motionRef.current,
      subject: placed,
      hover: setHovered,
      title: (id) => {
        const label = id ? labelsRef.current.get(id) : undefined;
        return label && discLabelTruncated(label, params) ? label.replace("\n", " · ") : "";
      },
      depth: () => fieldRef.current.depth,
      select: (id) => { setOpenedGroup(null); onSelectRef.current(id); },
      selectNothing: () => { setOpenedGroup(null); onSelectRef.current(null); },
      remove: (id) => onRemoveRef.current(id),
      follow: (id, at) => {
        liveRef.current.set(id, { x: at[0], y: at[1] });
        restationSourcePlates(graph, id, liveRef.current, posesRef.current, params);
      },
      harvest: (dropped) => harvestRef.current(dropped),
      moved: dragMoved,
      restate: restatePendingDrag,
      queue: queueCanvasDraw,
      settleLabels: applyVisibility,
      canvasClaimed: picking.claimed,
      press: (id, right) => {
        const owner = spreadOwnerRef.current;
        // Selection can name a record whose entrance is still queued, as in
        // World. Only the renderer's currently drawn incident edges can yield.
        let ownerStrokes: ReturnType<Graph["getRelatedEdgesData"]> = [];
        if (owner) {
          try { ownerStrokes = graph.getRelatedEdgesData(owner); } catch { /* not drawn yet */ }
        }
        if (owner && !right && spreadYieldsToHold("neighbourhood", owner, id, ownerStrokes)) {
          spreadRef.current?.suspend(); spreadSuspended.current = true;
        }
      },
      dropped: (_id, moved) => {
        spreadSuspended.current = false;
        if (!moved) spreadRef.current?.commit(spreadOwnerRef.current);
      },
      cancelled: () => { picking?.reset(); spreadSuspended.current = false; },
      released: () => {
        if (spreadSuspended.current) { spreadSuspended.current = false; spreadRef.current?.commit(spreadOwnerRef.current); }
      },
    });
    const edgeId = (event: unknown) => {
      const id = elementIdOf(event);
      return fieldRef.current.references.some((reference) => reference.elementId === id) ? id : null;
    };
    graph.on("edge:click", (event) => {
      if (pointer.swallowReleaseClick() || draggingRef.current) return;
      const id = edgeId(event);
      if (id) { labelPickRef.current = id; onSelectRef.current(id); }
    });
    graph.on("edge:contextmenu", (event) => {
      swallowMenu(event);
      const id = edgeId(event);
      if (id) onRemoveRef.current(id);
    });
    graph.on("edge:pointerenter", (event) => {
      pointer.holdHover();
      const reference = fieldRef.current.references.find((item) => item.elementId === edgeId(event));
      host.title = reference ? sourceConnectionName(reference, (id) => labelsRef.current.get(id) ?? id) : "";
    });
    graph.on("edge:pointerleave", () => { host.title = ""; });
    let spreadContainer: HTMLElement | null = null;
    void graph.render().then(() => {
      spreadContainer = graph.getCanvas().getContainer();
      spreadContainer?.addEventListener(SPREAD_FRAME_EVENT, pointer.scheduleLabels);
      if (graphRef.current === graph) setReady(true);
    }).catch((problem: unknown) => {
      if (graphRef.current === graph) console.error(problem);
    });
    // A canvas has no DOM to address; development builds expose the field
    // graph for browser-automated geometry checks, under its own name.
    const handle = window as unknown as Record<string, Graph | undefined>;
    if (import.meta.env.DEV) handle[handleName] = graph;
    return () => {
      disposeGraph();
      pointer.dispose();
      picking?.dispose();
      spreadContainer?.removeEventListener(SPREAD_FRAME_EVENT, pointer.scheduleLabels);
      spreadRef.current?.dispose(); spreadRef.current = null;
      contactBody.dispose();
      pendingFrameRef.current = null;
      authoredRef.current = null;
      graphRef.current = null;
      setReady(false);
      if (handle[handleName] === graph) delete handle[handleName];
      graph.destroy();
    };
    // The graph is created once; frames go through the lane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready || !stageSize.width || !stageSize.height || !graphRef.current) return;
    if (!data.nodes.length) {
      // An emptied field has no viewpoint left to keep: the next first
      // placement is composed afresh, and no flight lands on a mark that left.
      cameraEstablishedRef.current = false;
      cancelPan(graphRef.current);
    }
    pendingFrameRef.current = {
      nodes: data.nodes,
      edges: data.edges,
      animateInitial: !mountedStanding,
      still: false,
      fieldIds: new Set(fieldRef.current.positions.keys()),
      arranged: false,
    };
    queueCanvasDraw();
  }, [data, queueCanvasDraw, ready, stageSize.height, stageSize.width]);

  useEffect(() => {
    if (!ready) return;
    if (lastSelectedRef.current !== selected) {
      const reference = field.references.find((r) => r.elementId === selected);
      spreadOwnerRef.current = selected && labelPickRef.current === selected
        ? spreadOwnerForSelection(selected, reference ? { source: reference.child, target: reference.parent } : null, spreadOwnerRef.current)
        : selected;
      lastSelectedRef.current = selected;
      labelPickRef.current = null;
    }
    spreadRef.current?.commit(spreadOwnerRef.current);
  }, [ready, selected, field.references]);

  useEffect(() => {
    if (openedGroup && !posesRef.current.has(openedGroup)) setOpenedGroup(null);
  }, [field.references, openedGroup]);

  // Resizing is not new matter: the renderer follows the host, the camera stays.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    return observeHostSize(host, (width, height) => {
      graphRef.current?.resize(width, height);
      setStageSize((current) => current.width === width && current.height === height ? current : { width, height });
    });
  }, []);

  const fieldFraming = useMemo<FieldFraming>(() => ({
    // A record is drawn with nothing else: no participants to bring with it.
    participants: (_graph, id) => {
      const reference = fieldRef.current.references.find((item) => item.elementId === id);
      return reference ? [...new Set([reference.child, reference.parent])] : [];
    },
    established: cameraEstablishedRef,
    intent: cameraIntentRef,
    holding: () => draggingRef.current,
    /** Frame the actual canonical disc and plate bounds at their resting size. */
    extent: (graph, id): Box | null => {
      if (fieldRef.current.references.some((reference) => reference.elementId === id)) {
        try {
          const bounds = graph.getElementRenderBounds(id);
          const a = graph.getViewportByCanvas(bounds.min), b = graph.getViewportByCanvas(bounds.max);
          return { left: Math.min(a[0], b[0]), top: Math.min(a[1], b[1]), right: Math.max(a[0], b[0]), bottom: Math.max(a[1], b[1]) };
        } catch { return null; }
      }
      const at = graph.getElementPosition(id);
      if (!at || !Number.isFinite(at[0]) || !Number.isFinite(at[1])) return null;
      const rim = params.discDiameter / 2;
      let min = [at[0] - rim, at[1] - rim], max = [at[0] + rim, at[1] + rim];
      try {
        const drawn = graph.getElementRenderBounds(id);
        min = [Math.min(min[0], drawn.min[0]), Math.min(min[1], drawn.min[1])];
        max = [Math.max(max[0], drawn.max[0]), Math.max(max[1], drawn.max[1])];
      } catch {
        // Not laid out yet: use the canonical resting disc.
      }
      const a = graph.getViewportByCanvas(min as never), b = graph.getViewportByCanvas(max as never);
      const box = { left: Math.min(a[0], b[0]), top: Math.min(a[1], b[1]), right: Math.max(a[0], b[0]), bottom: Math.max(a[1], b[1]) };
      return Object.values(box).every(Number.isFinite) ? box : null;
    },
  }), [params.discDiameter]);
  useFocusPan(graphRef, ready, reveal?.id ?? null, reveal?.token ?? 0, insetsRef, holdCamera, fieldFraming);

  const selectionArrivalDelay = useMemo(() => {
    const graph = graphRef.current;
    if (!ready || !selected || !graph || graph.destroyed) return 0;
    return resolveFocusId(graph, selected) ? 0 : NODE_BIRTH_PLAN.durationMs;
  }, [ready, selected]);

  return <div className="world__stage source-field__stage" data-contact-phase={contact.phase} data-canvas-treatment="canonical">
    <div className="world__surface" ref={hostRef} />
    {passThrough && <SourcePassThrough graph={ready ? graphRef.current : null} references={field.references} selected={selected}
      color={paint.field} lineWidth={params.edgeWidth} traceToken={data} />}
    <SelectionAnts
      graph={ready ? graphRef.current : null}
      target={antTarget}
      clearance={GRAPH_DNA_INTERACTION.selectionClearance}
      dotGap={GRAPH_DNA_INTERACTION.selectionDotGap}
      lineWidth={GRAPH_DNA_INTERACTION.selectionLine}
      speed={GRAPH_DNA_INTERACTION.selectionMotion ? GRAPH_DNA_INTERACTION.selectionSpeed : 0}
      color={paint.ink}
      motion={DEFAULT_MOTION_PLANS}
      arrivalDelay={selectionArrivalDelay}
      animated={GRAPH_DNA_INTERACTION.selectionMotion}
      held={contactId(contact) === selected}
      // Every frame this field authors, not just the selection: hover
      // restations, opened counts and selection-only text move a selected
      // plate through the restyle lane, which emits nothing the ants hear.
      // World passes its station subjects for the same reason.
      traceToken={data}
      gone={antsGone}
    />
  </div>;
}

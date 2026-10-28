import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SourceCell, SourceSearchRequest, SourceCatalogue, SourceContext, SourceIdentity, SourceOrder, SourceRecordWindow, SourceFindHit, SourceRecord, SourceRow, SourceFKObservation,
  SourceFKDeclaration, SourceIncomingCount, SourceIncomingGroup } from "../api/source";
import { sourceClient, sourceContextKey, sourceSession, sourceGrounded, SourceReadError } from "../api/sourceClient";
import { Swap } from "../styles/Swap";
import { OverlayPanel } from "../world/WorldOverlay";
import { PanelBack } from "../world/panelChrome";
import { TableAction, TableFooter, TableHeader, TableSearch } from "../world/tableChrome";
import { usePresence } from "../styles/usePresence";
import { readStoredPanelSize, storePanelSize } from "../world/WorldResize";
import { useBrowserTheme } from "../world/useBrowserTheme";
import { useNavigationFocus } from "../world/useNavigationFocus";
import { worldChromeDockVars, worldShellStyle } from "../world/worldChrome";
import { chromeClass, OverlayChromeProvider, OVERLAY_RANK, useDismissableLayer, useOverlayChrome } from "../world/worldOverlayChrome";
import { CaptureDetails, Loading, Problem, RecordDetails, TableDetails } from "./SourceDetails";
import { ReaderDisclosure } from "../world/ReaderDisclosure";
import { SourceReaderPanel, useSourceScroll, type SourceScrollPosition } from "./SourcePanel";
import { SourceFind, emptySourceFind, type SourceFindDraft } from "./SourceFind";
import { SourceRowsView } from "./SourceRowsView";
import { BulkOutcomeNote, type BulkOutcome } from "./SourceOutcome";
import { identityBlocksPlacement, identityExplanation, readFailure, stoppedRecovery } from "./sourceExplain";
import { ExpandThrough, IncomingReferences, OutgoingReferences, ReferenceActions, ReferenceDetails, addressableReference, incomingColumns, incomingCountText, referenceName } from "./SourceReferences";
import { sourcePresentation } from "./sourcePresentation";
import { SourceCanvas } from "./SourceCanvas";
import { schemaNamed, SOURCE_SHOW_DEFAULT, SourceFieldList, SourcePlacement, SourceShowBand, SourceUnplaceable, type SourceShow } from "./SourceFieldControls";
import { SourceGlobalFind } from "./SourceGlobalFind";
import { schemaElement, sourceSchemaField } from "./sourceSchemaField";
import { Instrument } from "../world/Instrument";
import {
  emptySourceField,
  moveSourceRecords,
  placedRecord,
  placeSourceRecord,
  removeSourceRecord,
  removeSourceTable,
  separateSourceRecords,
  clearSourceField,
  adoptSourceRecords,
  expandSourceGroup,
  expansionKey,
  expansionShown,
  placeSourceRecords,
  retractSourceExpansion,
  restoreSourceField,
  showSourceReference,
  hideSourceReference,
  sourceKeyText,
  sourceRecordName,
  type PlacedRecord,
  type SourceField,
} from "./sourceField";
import { measuredHandles, sourceDockLayout, SOURCE_DOCK_MIN, SOURCE_HANDLES_FINE, type SourceDock } from "./sourceLayout";
import { useSourceRead } from "./useSourceRead";
import { readSourceField, readSourceNaming, readSourceShow, sourceCameraRoom, writeSourceField, writeSourceNaming, writeSourceShow, type SourceNaming } from "./sourceFieldMemory";
import "../world/WorldShell.css";
import "../world/WorldReader.css";
import "./SourceWorkspace.css";

type Relation = SourceCatalogue["relations"][number];
const PAGE = 50;
type RecordSubject = Pick<PlacedRecord, "recordId" | "table" | "key">;
type ObservationSubject = { childId: string; declarationId: string; observationId: string };
type BrowseState = { relation: Relation | null; offset: number; limit: number; window: number };
/** The child table read as "rows referencing this record through FK k". The
 * count is the Reader's, from this same capture; the rows are read anew. */
type IncomingSubject = { parent: RecordSubject; declaration: SourceFKDeclaration; count: SourceIncomingCount };
type TableVisit = { browse: BrowseState; draft: SourceFindDraft; search: SourceSearchRequest | null | undefined; sort: SourceOrder | null;
  searchPage: { offset: number; limit: number }; incoming: IncomingSubject | null; reader: ReaderStep; trail: ReaderStep[]; readerOpen: boolean };
type ReaderStep = { row: SourceRow | null; placed: RecordSubject | null; observation: ObservationSubject | null; referencePage: number };

const FOCUS_TARGETS = {
  readerPanel: 'source-reader', tablePanel: 'source-tables',
  reader: '#source-reader > .motion-swap > .motion-swap__is [data-focus-subject]',
  table: '#source-tables .source-table-slot > .motion-swap > .motion-swap__is [data-focus-subject]',
  readerReturn: '#source-tables .motion-swap__is button[aria-pressed="true"][data-row], #source-tables .source-catalogue-heading h2, [data-overlay="source-tables"] > .ov__handle',
  tableReturn: '[data-overlay="source-tables"] > .ov__handle',
  fallback: '#source-tables .motion-swap__is [data-focus-subject], [data-overlay="source-tables"] > .ov__handle',
};
/** A Reader opened from the canvas returns to the record it was opened from. */
const FIELD_FOCUS_TARGETS = {
  ...FOCUS_TARGETS,
  readerReturn: `.source-field-list button[aria-pressed="true"], ${FOCUS_TARGETS.readerReturn}`,
};

/** A referencing table when the catalogue page holding it is not loaded. Its
 * identity is the one its own rows report, never assumed. */
function childRelation(table: string): Relation {
  return {
    name: table, kind: "table", read_status: "available", reason: null, row_count: null, row_count_status: "not_computed",
    identity: { status: "not_started", key_columns: [], verified_rows: null, reason: null },
  };
}

/**
 * Whether a table's rows can stand on the canvas: a readable table with a
 * declared primary key whose identity has not already failed. Verification
 * still decides each row; this only sorts the catalogue.
 */
function placeableTable(item: Relation): boolean {
  return item.kind === "table" && item.read_status === "available" && (item.primary_key?.length ?? 0) > 0 &&
    !["invalid", "no_declared_key", "unsupported"].includes(item.identity?.status ?? "");
}

/**
 * Said when the file's declarations decide what can be done at all. Only what
 * is recorded as constraints: the data may still hold relationships no
 * declaration names.
 */
function declaredStructureNote(relations?: Relation[]): string | null {
  const tables = (relations ?? []).filter((item) => item.kind === "table" && item.read_status === "available");
  if (!tables.length) return null;
  const keys = tables.some((item) => (item.primary_key?.length ?? 0) > 0);
  const references = tables.some((item) => (item.foreign_keys?.length ?? 0) > 0);
  const caveat = " This describes the recorded constraints only, not whether the data relates.";
  if (!keys && !references) return "This file declares no primary keys and no foreign keys. Its tables can be read, but records cannot be placed on the canvas or followed through declared references." + caveat;
  if (!keys) return "This file declares no primary keys. Its tables and declared references can be read, but no record can be placed on the canvas or followed." + caveat;
  if (!references) return "This file declares no foreign keys. Records can be placed on the canvas, but there are no declared references to follow." + caveat;
  return null;
}

/** A placed record's table when the catalogue page holding it is not loaded. */
function placedRelation(table: string, record?: SourceRecord): Relation {
  return {
    name: table, kind: "table", read_status: "available", reason: null, row_count: null, row_count_status: "not_computed",
    identity: record?.identity ?? { status: "verified", key_columns: [], verified_rows: null, reason: null },
    columns: record?.columns,
  };
}

function Workspace({ context }: { context: SourceContext }) {
  const { hidden } = useOverlayChrome();
  const contextKey = sourceContextKey(context);
  const [presentation] = useState(() => sourcePresentation(window.location.search));
  // The cells of every verified record read, by handle: a record's name is
  // read from them (O17), so naming needs no read of its own.
  const [recordCells, setRecordCells] = useState(new Map<string, readonly SourceCell[]>());
  const rememberDisplay = useCallback((record: SourceRecord) => {
    if (record.identity.status !== "verified") return;
    setRecordCells((current) => current.get(record.record_id) === record.cells ? current : new Map([...current, [record.record_id, record.cells]]));
  }, []);
  // Which column names each table's records: the person's choice, kept for this capture (O17).
  const [naming, setNaming] = useState<SourceNaming>(() => readSourceNaming(context));
  useEffect(() => writeSourceNaming(context, naming), [context, naming]);
  const nameOf = useCallback((table: string, key: SourceCell[], recordId: string | null, cells?: readonly SourceCell[]) =>
    sourceRecordName(table, key, (recordId ? recordCells.get(recordId) : undefined) ?? cells, naming[table]), [recordCells, naming]);
  const api = useMemo(() => sourceClient(context), [context]);
  const [fatal, setFatal] = useState<SourceReadError | null>(null);
  const onFailure = useCallback((error: SourceReadError) => { if (error.stopsContext) setFatal(error); }, []);
  const [catalogueOffset, setCatalogueOffset] = useState(0);
  const loadOverview = useCallback((signal: AbortSignal) => api.overview(1, 0, signal), [api]);
  const overview = useSourceRead(loadOverview, onFailure, !fatal);
  const loadCatalogue = useCallback((signal: AbortSignal) => api.schema(PAGE, catalogueOffset, signal), [api, catalogueOffset]);
  const catalogue = useSourceRead(loadCatalogue, onFailure, !fatal);
  // World's catalogue search and placement filter (O8.6), over the loaded page.
  const [catalogueQuery, setCatalogueQuery] = useState("");
  const [placementFilter, setPlacementFilter] = useState<"all" | "placeable" | "other">("all");
  const shownTables = useMemo(() => (catalogue?.data?.relations ?? []).filter((item) =>
    (placementFilter === "all" || placeableTable(item) === (placementFilter === "placeable")) &&
    item.name.toLowerCase().includes(catalogueQuery.trim().toLowerCase())), [catalogue?.data, placementFilter, catalogueQuery]);
  // The schema view (O8.12): every table of the capture and its declared
  // foreign keys, on its own canvas. Read whole, page after page, when first
  // asked for; the record canvas stays as it was underneath.
  // World's vocabulary (O12, changed 2026-10-25): the schema is what an empty
  // canvas shows, as World's default screen. It gives way to the first record
  // placed and comes back when the last one leaves; with records on the
  // canvas it is entered on purpose and left with "clear" or Escape. A canvas
  // about to be restored opens on its records, never on the schema first.
  const [schemaView, setSchemaView] = useState(() => !readSourceField(context));
  const loadSchema = useCallback(async (signal: AbortSignal) => {
    const relations: Relation[] = [];
    for (let offset: number | null = 0; offset !== null;) {
      const page = await api.schema(100, offset, signal);
      relations.push(...page.relations);
      offset = page.has_more ? page.next_offset : null;
    }
    return relations;
  }, [api]);
  const schemaRead = useSourceRead(loadSchema, onFailure, !fatal);
  // What the file declares, said once at the start when it changes what can be
  // done: no keys, nothing can be placed; no references, nothing can be followed.
  const declarationNote = useMemo(() => declaredStructureNote(schemaRead?.data), [schemaRead?.data]);
  const [schemaField, setSchemaField] = useState<SourceField | null>(null);
  useEffect(() => { if (schemaRead?.data) setSchemaField(sourceSchemaField(contextKey, schemaRead.data)); }, [schemaRead?.data, contextKey]);
  const schemaLabels = useMemo(() => new Map((schemaRead?.data ?? []).map((item) => [schemaElement(item.name), item.name])), [schemaRead?.data]);
  // A window sequence is local UI ownership, never a source record identity.
  const [browse, setBrowse] = useState<BrowseState>({ relation: null, offset: 0, limit: PAGE, window: 0 });
  const { relation } = browse;
  const [catalogueVisible, setCatalogueVisible] = useState(true);
  const [tableTrail, setTableTrail] = useState<TableVisit[]>([]);
  // undefined = browsing; null = unsubmitted draft; object = submitted search.
  const [findDraft, setFindDraft] = useState(emptySourceFind);
  const [search, setSearch] = useState<SourceSearchRequest | null | undefined>();
  const [searchPage, setSearchPage] = useState({ offset: 0, limit: PAGE });
  const [incoming, setIncoming] = useState<IncomingSubject | null>(null);
  // World's sort: one column, by the database, for the table on show.
  const [sort, setSort] = useState<SourceOrder | null>(null);
  const { offset, limit } = search === undefined ? browse : searchPage;
  const [row, setRow] = useState<SourceRow | null>(null);
  // The canvas field: verified records placed in this complete context only.
  const [field, setField] = useState(() => emptySourceField(contextKey));
  // The renderer is created by the first explicit placement, then kept so the
  // last removal can withdraw its mark; the quiet opening has no canvas at all.
  const [canvasMounted, setCanvasMounted] = useState(false);
  // A Reader subject chosen from the canvas, independent of the table window.
  const [placedSubject, setPlacedSubject] = useState<RecordSubject | null>(null);
  const [observationSubject, setObservationSubject] = useState<ObservationSubject | null>(null);
  const [trail, setTrail] = useState<ReaderStep[]>([]);
  const [referencePage, setReferencePage] = useState(0);
  const placementOwner = useRef<{ sequence: number; controller?: AbortController }>({ sequence: 0 });
  const [placementRead, setPlacementRead] = useState<{ subject: string; pending: boolean; error?: Error } | null>(null);
  const cancelPlacement = () => {
    placementOwner.current.sequence += 1;
    placementOwner.current.controller?.abort();
    setPlacementRead(null);
  };
  const clearTrail = () => { setObservationSubject(null); setTrail([]); setReferencePage(0); cancelPlacement(); };
  const [reveal, setReveal] = useState<{ id: string; token: number } | null>(null);
  // Selectors tried in order: the first present control takes focus.
  const [focusRequest, setFocusRequest] = useState<string[] | null>(null);
  const loadRows = useCallback(async (signal: AbortSignal) => {
    if (!relation || relation.read_status !== "available") return null;
    if (search === null) return null;
    const rows = search === undefined ? await api.rows(relation.name, limit, offset, signal, sort)
      : await api.search(relation.name, search, limit, offset, signal, sort);
    if (rows.name !== relation.name || rows.offset !== offset) throw new SourceReadError("source_window_mismatch", 409);
    return rows;
  }, [api, relation?.name, relation?.read_status, limit, offset, browse.window, search, sort]);
  const windowResult = useSourceRead(loadRows, onFailure, !fatal);
  const windowRows = windowResult?.data;
  const readerTable = placedSubject?.table ?? relation?.name ?? null;
  const handle = placedSubject ? placedSubject.recordId : row?.record_id;
  const grounded = useCallback((record: SourceRecord) =>
    sourceGrounded(context, record.grounding), [context]);
  const loadRecord = useCallback(async (signal: AbortSignal) => {
    if (!handle || !readerTable) return null;
    const record = await api.record(handle, signal);
    if (record.record_id !== handle || record.name !== readerTable || record.grounding.table !== readerTable || !grounded(record)) {
      throw new SourceReadError("source_context_mismatch", 409);
    }
    return record;
  }, [api, handle, readerTable, grounded]);
  const recordResult = useSourceRead(loadRecord, onFailure, !fatal);
  useEffect(() => { if (recordResult?.data) rememberDisplay(recordResult.data); }, [recordResult?.data, rememberDisplay]);
  const readerRelation = placedSubject
    ? catalogue?.data?.relations.find((item) => item.name === placedSubject.table) ?? placedRelation(placedSubject.table, recordResult?.data ?? undefined)
    : relation;
  const readerRecordSubject = Boolean(row || placedSubject);

  const loadReferences = useCallback(async (signal: AbortSignal) => {
    if (!handle || observationSubject) return null;
    return api.outgoingReferences(handle, 10, referencePage, signal);
  }, [api, handle, observationSubject, referencePage]);
  const referencesResult = useSourceRead(loadReferences, onFailure, !fatal && !!recordResult?.data && !observationSubject);
  // Read separately from outgoing: either can fail without hiding the other.
  const [incomingWindow, setIncomingWindow] = useState<{ record: string; offset: number } | null>(null);
  const incomingOffset = incomingWindow && incomingWindow.record === handle ? incomingWindow.offset : 0;
  const incomingAvailable = recordResult?.data?.record_id === handle && !!recordResult?.data?.actions.incoming_references;
  const loadIncoming = useCallback(async (signal: AbortSignal) => {
    if (!handle || !readerTable || observationSubject) return null;
    const page = await api.incomingReferences(handle, 10, incomingOffset, signal);
    if (page.groups.some((group) => group.declaration.parent_table !== readerTable)) throw new SourceReadError("source_reference_mismatch", 409);
    return page;
  }, [api, handle, readerTable, observationSubject, incomingOffset]);
  const incomingResult = useSourceRead(loadIncoming, onFailure, !fatal && incomingAvailable && !observationSubject);
  const loadObservation = useCallback(async (signal: AbortSignal) => {
    if (!observationSubject) return null;
    const observation = await api.reference(observationSubject.childId, observationSubject.declarationId, signal);
    if (observation.observation_id !== observationSubject.observationId) throw new SourceReadError("source_reference_mismatch", 409);
    return observation;
  }, [api, observationSubject]);
  const observationResult = useSourceRead(loadObservation, onFailure, !fatal && !!observationSubject);
  const observation = observationResult?.data ?? null;

  // Expiry, a mismatched generation or a lost capture leaves nothing placed:
  // a stale field is never left standing as though it were still current.
  useEffect(() => {
    if (!fatal) return;
    cancelPlacement();
    setObservationSubject(null); setTrail([]); setTableTrail([]); setFocusRequest(null); setIncoming(null);
    setField(emptySourceField(contextKey));
    setPlacedSubject(null);
    setReveal(null);
    setCanvasMounted(false); setRecordCells(new Map());
  }, [fatal, contextKey]);

  const [tablesOpen, setTablesOpen] = useState(true);
  const [readerOpen, setReaderOpen] = useState(false);
  const [primary, setPrimary] = useState<SourceDock>("tables");
  const [tablesWidth, setTablesWidth] = useState(() => readStoredPanelSize("ki.source.tables.width", 420));
  const [readerWidth, setReaderWidth] = useState(() => readStoredPanelSize("ki.source.reader.width", 380));
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageWidth, setStageWidth] = useState(() => window.innerWidth);
  const [handles, setHandles] = useState(SOURCE_HANDLES_FINE);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      // A narrowing viewport keeps the dock that holds focus: in the compact
      // arrangement it is the one drawn, and at desktop width the other yields.
      const focused = document.activeElement?.closest("#source-tables, #source-reader")?.id;
      if (focused) setPrimary(focused === "source-tables" ? "tables" : "reader");
      setStageWidth(Math.round(stage.getBoundingClientRect().width));
      setHandles((current) => {
        const next = measuredHandles(stage);
        return current.left === next.left && current.right === next.right ? current : next;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);
  // One geometry for the drawn docks, the canvas insets and the camera.
  const layout = sourceDockLayout(stageWidth, { tablesOpen, readerOpen, tablesWidth, readerWidth, primary }, handles);
  const openReader = () => { setReaderOpen(true); setPrimary("reader"); };
  const openTables = () => { setTablesOpen(true); setPrimary("tables"); };
  const browserTheme = useBrowserTheme();
  const [localTheme, setLocalTheme] = useState<"light" | "dark" | null>(null);
  const mode = localTheme ?? browserTheme;
  // As in World: palette and dock insets ease only after the first frame, so
  // the opening appearance is not itself a transition.
  const [motionReady, setMotionReady] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMotionReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const dismissReader = () => {
    cancelPlacement();
    // Compact hands the one dock back to Tables: return keyboard focus to the
    // record the Reader was opened from, as the desktop return does.
    if (layout.compact && tablesOpen && document.activeElement?.closest("#source-reader")) {
      setFocusRequest(['.source-field-list button[aria-pressed="true"]',
        '#source-tables .motion-swap__is button[aria-pressed="true"][data-row]', "#source-tables .source-table-slot .motion-swap__is h2"]);
    }
    setReaderOpen(false);
  };
  useDismissableLayer(layout.reader.open && !fatal, OVERLAY_RANK.reader, dismissReader);
  useDismissableLayer(layout.tables.open && !fatal, OVERLAY_RANK.drawer, () => setTablesOpen(false));
  const tableSubject = JSON.stringify([contextKey, catalogueVisible ? ["catalogue"] : ["table", relation?.name ?? null]]);
  const readerSubject = JSON.stringify([contextKey, observationSubject?.observationId ?? null, readerTable, readerRecordSubject ? handle ?? ["window", browse.window, row ? windowRows?.rows.indexOf(row) : null] : "schema"]);
  const currentSubjectRef = useRef(readerSubject);
  currentSubjectRef.current = readerSubject;
  useEffect(() => {
    cancelPlacement();
    return () => { placementOwner.current.sequence += 1; placementOwner.current.controller?.abort(); };
  }, [readerSubject, fatal]);
  // Presentation memory only, bounded and scoped to this complete context.
  const scrollMemory = useRef(new Map<string, SourceScrollPosition>());
  const scrollFor = (key: string) => {
    let position = scrollMemory.current.get(key);
    if (!position) {
      position = { top: 0, left: 0 }; scrollMemory.current.set(key, position);
      if (scrollMemory.current.size > 64) scrollMemory.current.delete(scrollMemory.current.keys().next().value!);
    }
    return position;
  };
  const tableScroll = scrollFor(`table:${relation?.name}`);
  const catalogueScroll = scrollFor("catalogue");
  const readerScroll = scrollFor(readerSubject);
  const catalogueViewport = useSourceScroll(catalogueScroll);
  const targets = fatal ? { ...FOCUS_TARGETS, reader: ".source-fatal h2", table: ".source-fatal h2", fallback: ".source-fatal h2" }
    : placedSubject || observationSubject ? FIELD_FOCUS_TARGETS : FOCUS_TARGETS;
  const navigation = useNavigationFocus({ reader: fatal ? "stopped" : readerSubject, table: `${tableSubject}:${catalogueOffset}`, readerOpen: Boolean(fatal) || layout.reader.open, tablesOpen: layout.tables.open }, targets);
  // Explicit focus for a control that a removal takes away. Runs after the
  // navigation hook's own layout effect, so its deferred recovery sees focus
  // already placed and stands down.
  useLayoutEffect(() => {
    if (!focusRequest) return;
    let frame = 0;
    const focusLive = () => {
      for (const selector of focusRequest) {
        const target = document.querySelector<HTMLElement>(selector);
        if (!target || target.matches(':disabled')) continue;
        // An existing preferred target may still be sliding into view. Do not
        // let a wider fallback heading take its focus before the row arrives.
        if (target.closest('[inert], [aria-hidden="true"]')) break;
        const box = target.getBoundingClientRect();
        if (!box.width || !box.height || box.left >= innerWidth || box.right <= 0) break;
        target.focus({ preventScroll: true });
        if (document.activeElement === target) { setFocusRequest(null); return; }
      }
      frame = requestAnimationFrame(focusLive);
    };
    frame = requestAnimationFrame(focusLive);
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);
  const changeSearch = (next: SourceSearchRequest | null | undefined) => {
    clearTrail();
    setSearch(next); setSearchPage({ offset: 0, limit: PAGE }); setIncoming(null);
    setBrowse((current) => ({ ...current, window: current.window + 1 }));
    setRow(null);
  };
  const showCatalogue = () => { cancelPlacement(); setCatalogueVisible(true); openTables(); };
  const backTable = (keyboard = false) => {
    const previous = tableTrail.at(-1);
    if (!previous) return;
    cancelPlacement();
    setBrowse(previous.browse); setFindDraft(previous.draft); setSearch(previous.search); setSearchPage(previous.searchPage);
    setIncoming(previous.incoming); setSort(previous.sort);
    // A window-only occurrence is not an identity that can be restored into a fresh read.
    setRow(previous.reader.row?.record_id ? previous.reader.row : null);
    setPlacedSubject(previous.reader.placed); setObservationSubject(previous.reader.observation);
    setReferencePage(previous.reader.referencePage);
    setTrail(previous.trail.filter((step) => !step.row || !!step.row.record_id)); setReaderOpen(previous.readerOpen);
    setTableTrail((steps) => steps.slice(0, -1)); setCatalogueVisible(false);
    if (keyboard) {
      setPrimary(previous.readerOpen ? "reader" : "tables");
      setFocusRequest([previous.readerOpen ? FOCUS_TARGETS.reader : FOCUS_TARGETS.table]);
    }
  };
  const rememberTable = () => {
    if (relation) setTableTrail((steps) => [...steps.slice(-19), { browse, draft: findDraft, search, sort, searchPage, incoming,
      reader: { row, placed: placedSubject, observation: observationSubject, referencePage }, trail, readerOpen }]);
  };
  const choose = (item: Relation, keyboard = false) => {
    setCatalogueVisible(false);
    if (relation?.name === item.name) {
      if (keyboard) setFocusRequest([FOCUS_TARGETS.table]);
      return;
    }
    rememberTable();
    clearTrail();
    setFindDraft(emptySourceFind);
    setSearch(undefined); setSearchPage({ offset: 0, limit: PAGE }); setIncoming(null); setSort(null);
    setBrowse((current) => ({ relation: item, offset: 0, limit: PAGE, window: current.window + 1 }));
    setRow(null); setPlacedSubject(null); setReaderOpen(true);
    if (keyboard) { openReader(); setFocusRequest([FOCUS_TARGETS.reader]); }
  };
  // Ascending, descending, unsorted: World's header cycle. A new order is a
  // new table, so the window starts again at its first page.
  const reorder = (next: SourceOrder | null) => {
    clearTrail(); setSort(next); setRow(null);
    setSearchPage((current) => ({ ...current, offset: 0 }));
    setBrowse((current) => ({ ...current, offset: 0, window: current.window + 1 }));
  };
  const cycleSort = (column: string) => reorder(sort?.column !== column ? { column, desc: false } : sort.desc ? null : { column, desc: true });
  // Global find (O8.11): a found record opens in the Reader, as one chosen in
  // its table does, and direct placement places it. A row without a verified
  // key opens its table, filtered by the same text.
  const openFound = (hit: SourceFindHit, text: string) => {
    clearTrail(); cancelPlacement();
    if (hit.record_id) {
      setPlacedSubject({ recordId: hit.record_id, table: hit.table, key: hit.key }); setRow(null); openReader();
      if (presentation.placement === "direct") setDirectRow(hit.record_id);
      return;
    }
    rememberTable(); setCatalogueVisible(false);
    setFindDraft({ ...emptySourceFind, text });
    setSearch({ mode: "literal", text }); setSearchPage({ offset: 0, limit: PAGE }); setIncoming(null); setSort(null);
    setBrowse((current) => ({ relation: catalogue?.data?.relations.find((item) => item.name === hit.table) ?? childRelation(hit.table),
      offset: 0, limit: PAGE, window: current.window + 1 }));
    setRow(null); setPlacedSubject(null); openTables();
  };
  // A table found by name (O10) opens in the Tables dock, as one chosen in the catalogue does.
  const openFoundTable = (name: string) => {
    cancelPlacement();
    choose(catalogue?.data?.relations.find((item) => item.name === name) ?? schemaRead?.data?.find((item) => item.name === name) ?? childRelation(name));
    openTables();
  };
  const page = (nextOffset: number, nextLimit: number) => {
    clearTrail();
    if (search === undefined) setBrowse((current) => ({ ...current, offset: nextOffset, limit: nextLimit, window: current.window + 1 }));
    else {
      setSearchPage({ offset: nextOffset, limit: nextLimit });
      setBrowse((current) => ({ ...current, window: current.window + 1 }));
    }
    setRow(null); setReaderOpen(true);
  };
  // Referenced by: the child table, narrowed to rows whose FK resolves to the
  // Reader's record. The Reader keeps that record, read by its handle.
  const openIncoming = (group: SourceIncomingGroup, keyboard = false) => {
    if (!record || group.declaration.validation.status !== "verified_declaration") return;
    const fk = group.declaration;
    const parent: RecordSubject = placedRecord(field, record.record_id) ?? { recordId: record.record_id, table: record.name, key: record.key };
    if (!catalogueVisible && relation?.name === fk.child_table && incoming?.declaration.declaration_id === fk.declaration_id &&
        incoming.parent.recordId === record.record_id) {
      openTables();
      if (keyboard) setFocusRequest([FOCUS_TARGETS.table]);
      return;
    }
    cancelPlacement();
    rememberTable();
    setCatalogueVisible(false);
    setFindDraft(emptySourceFind);
    setSearch({ mode: "reference", record: record.record_id, fk: fk.declaration_id }); setSearchPage({ offset: 0, limit: PAGE });
    setIncoming({ parent, declaration: fk, count: group.count });
    if (relation?.name !== fk.child_table) setSort(null);
    setBrowse((current) => ({ relation: catalogue?.data?.relations.find((item) => item.name === fk.child_table) ?? childRelation(fk.child_table),
      offset: 0, limit: PAGE, window: current.window + 1 }));
    setRow(null); setPlacedSubject(parent);
    openTables();
    if (keyboard) setFocusRequest([FOCUS_TARGETS.table]);
  };
  const select = (next: SourceRow) => {
    clearTrail(); setRow(next); setPlacedSubject(null); openReader();
    if (presentation.placement === "direct") setDirectRow(next.record_id ?? null);
  };

  // Placement needs the verified record in hand, read in this context.
  const record = recordResult?.data && recordResult.data.record_id === handle ? recordResult.data : null;
  const shownPlaced = placedRecord(field, handle);
  // What the table panel marks as on the canvas, as World's did: each placed
  // record's row, and each table whose every row is placed. A table's size is
  // the exact count its verified key read reported; no other count is claimed.
  const [tableRows, setTableRows] = useState(new Map<string, number>());
  const learnRows = useCallback((table: string, identity?: SourceIdentity | null) => {
    const rows = identity?.status === "verified" ? identity.verified_rows : null;
    if (typeof rows === "number") setTableRows((known) => known.get(table) === rows ? known : new Map([...known, [table, rows]]));
  }, []);
  useEffect(() => { if (windowRows) learnRows(windowRows.name, windowRows.identity); }, [windowRows, learnRows]);
  const placedHandles = useMemo(() => new Set(field.records.map((placed) => placed.recordId)), [field.records]);
  const wholeTables = useMemo(() => {
    const counts = new Map<string, number>();
    for (const placed of field.records) counts.set(placed.table, (counts.get(placed.table) ?? 0) + 1);
    return new Set([...counts].filter(([table, count]) => tableRows.get(table) === count).map(([table]) => table));
  }, [field.records, tableRows]);
  const tablesOnCanvas = useMemo(() => new Set(field.records.map((placed) => placed.table)), [field.records]);
  // O8.10: what the canvas draws. Hidden records stay in the field and on its
  // list; only the drawing leaves them out, with the connections drawn to them.
  const [show, setShow] = useState<SourceShow>(() => readSourceShow(context) ?? SOURCE_SHOW_DEFAULT);
  useEffect(() => writeSourceShow(context, show), [context, show]);
  const shownField = useMemo(() => {
    if (show.connections && !show.hiddenTables.length) return field;
    const hidden = new Set(show.hiddenTables);
    const records = field.records.filter((placed) => !hidden.has(placed.table));
    const drawn = new Set(records.map((placed) => placed.elementId));
    return { ...field, records,
      references: show.connections ? field.references.filter((reference) => drawn.has(reference.child) && drawn.has(reference.parent)) : [],
      positions: new Map([...field.positions].filter(([id]) => drawn.has(id))),
      depth: new Map([...field.depth].filter(([id]) => drawn.has(id))) };
  }, [field, show]);
  // O8.8: the canvas left on this identical capture comes back, every record
  // and connection read and verified again first. A record is found by its
  // handle when the generation is unchanged, otherwise by its table and key.
  // Nothing is written back until that read ends, so an empty opening never
  // erases what was kept; and a person who starts placing first keeps theirs.
  // A read that could pass (busy, unreachable, a server fault, a limit) is no
  // answer about a record: then nothing is stood, nothing kept is written over,
  // and the person chooses to try again or to start without it.
  const [restore, setRestore] = useState<{ reading: boolean; field?: SourceField; restored?: number; lost?: number;
    unplaceable?: number; lostConnections?: number; unread?: Error }>(() => ({ reading: !!readSourceField(context) }));
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  useEffect(() => {
    const stored = readSourceField(context);
    if (!stored) return;
    const controller = new AbortController(), signal = controller.signal;
    let active = true, unread: Error | null = null;
    const PASSING = new Error("a read that could pass");
    /** One read: a stopped context stops the workspace; a passing failure stops the restore; anything else is no answer. */
    const attempt = async <T,>(read: () => Promise<T>): Promise<T | null> => {
      try { return await read(); } catch (error) {
        if (error instanceof SourceReadError && error.stopsContext) { onFailure(error); throw error; }
        if (error instanceof SourceReadError && ["retry", "narrow", "smaller"].includes(readFailure(error).recovery)) { unread = error; throw PASSING; }
        return null;
      }
    };
    void (async () => {
      const records = new Map<string, SourceRecord>(), observations = new Map<string, SourceFKObservation>();
      let lost = 0, unplaceable = 0, lostConnections = 0;
      try {
        for (const entry of stored.records) {
          let found: SourceRecord | null = null, keyless = false;
          if (stored.generation === context.generation) found = await attempt(() => api.record(entry.recordId, signal));
          if (!found && entry.key.every((cell) => (cell.storage_class === "integer" || cell.storage_class === "text") && "exact" in cell)) {
            const key = entry.key.map((cell) => ({ column: cell.column, storage_class: cell.storage_class as "integer" | "text", exact: (cell as { exact: string }).exact }));
            const row = (await attempt(() => api.search(entry.table, { mode: "primary_key", key }, 1, 0, signal)))?.rows[0];
            // Found by its key, but its table's rows have no record identity in this session.
            keyless = !!row && !row.record_id;
            found = row?.record_id ? await attempt(() => api.record(row.record_id!, signal)) : null;
          }
          if (!active) return;
          if (found && found.name === entry.table && JSON.stringify(found.grounding.key) === JSON.stringify(entry.key)) records.set(entry.elementId, found);
          else if (keyless) unplaceable += 1;
          else lost += 1;
        }
        for (const reference of stored.references) {
          const child = records.get(reference.child), parent = records.get(reference.parent);
          const observation = child && parent ? await attempt(() => api.reference(child.record_id, reference.declarationId, signal)) : null;
          if (!active) return;
          if (observation?.status === "resolved" && observation.parent?.record_id === parent?.record_id) observations.set(reference.elementId, observation);
          else lostConnections += 1;
        }
      } catch (error) {
        if (error === PASSING && active && unread) setRestore({ reading: false, unread });
        return; // or the context stopped, and the workspace says so
      }
      let restored: SourceField;
      try { restored = restoreSourceField(contextKey, stored, records, observations, grounded); }
      catch { restored = emptySourceField(contextKey); lost = stored.records.length; }
      for (const record of records.values()) { learnRows(record.name, record.identity); rememberDisplay(record); }
      setField((current) => current.records.length ? current : restored);
      if (restored.records.length) setCanvasMounted(true);
      setRestore({ reading: false, field: restored, restored: restored.records.length, lost, unplaceable, lostConnections });
    })();
    return () => { active = false; controller.abort(); };
  }, [restoreAttempt]);
  const retryRestore = () => { setRestore({ reading: true }); setRestoreAttempt((count) => count + 1); };
  // Writing back waits for the restore to end, and for a person's choice when it could not read.
  useEffect(() => {
    if (restore.reading || restore.unread || fatal) return;
    const timer = window.setTimeout(() => writeSourceField(context, field), 250);
    return () => window.clearTimeout(timer);
  }, [field, restore.reading, restore.unread, fatal, context]);
  const showOnCanvas = () => {
    if (!record || fatal) return;
    learnRows(record.name, record.identity);
    const placed = placeSourceRecord(field, contextKey, record, grounded);
    // Opened individually: no expansion takes it back any more (O8.9).
    setField(adoptSourceRecords(placed.field, [placed.elementId]));
    setCanvasMounted(true);
    setReveal((current) => ({ id: placed.elementId, token: (current?.token ?? 0) + 1 }));
  };
  // Direct placement (the default, O1): selecting a row also places its record once
  // the verified exact read is in hand. A row without a handle stays in its table.
  const [directRow, setDirectRow] = useState<string | null>(null);
  useEffect(() => {
    if (!directRow) return;
    if (handle !== directRow || recordResult?.error) { setDirectRow(null); return; }
    if (!record) return;
    setDirectRow(null);
    showOnCanvas();
  });
  // A connection's removal hides only it; a record's takes it and its connections.
  const removeMark = (elementId: string, focus?: string) => {
    cancelPlacement();
    setField((current) => current.references.some((reference) => reference.elementId === elementId)
      ? hideSourceReference(current, elementId) : removeSourceRecord(current, elementId));
    if (focus) setFocusRequest([focus]);
  };
  const removeFromList = (elementId: string) => {
    const after = field.references.some((item) => item.elementId === elementId)
      ? hideSourceReference(field, elementId) : removeSourceRecord(field, elementId);
    removeMark(elementId, after.records.length ? `[data-field-record="${after.records[0].elementId}"]` : '.source-canvas');
  };
  // World's right press in the tables: a marked row's record, or every
  // record of a table, leaves the canvas.
  const takeOffRecord = (recordId: string) => {
    const placed = placedRecord(field, recordId);
    if (placed) removeMark(placed.elementId);
  };
  const takeOffTable = (table: string) => {
    cancelPlacement(); setField((current) => removeSourceTable(current, table));
    setOutcomes((current) => new Map([...current].filter(([, outcome]) => outcome.table !== table)));
  };
  // World's catalogue "clear".
  const clearCanvas = () => { cancelPlacement(); setField(clearSourceField); setOutcomes(new Map()); };
  // World's "separate", with its undo for as long as nothing else has moved.
  const [separated, setSeparated] = useState<{ field: SourceField; before: SourceField["positions"] } | null>(null);
  const separate = () => {
    const next = separateSourceRecords(field);
    if (next === field) return;
    setSeparated({ field: next, before: field.positions });
    setField(next);
  };
  // One bulk run at a time: World's add-all, or a group expansion. Each page
  // is one field update; a run started from the table stops when the table
  // on show changes under it, as World's buffer check does.
  const [bulk, setBulk] = useState<{ kind: "add" | "expand"; key?: string; placed: number; skipped: number } | null>(null);
  // What each run did, kept by the action it answers (an expansion key, or the
  // table window an add all read) and shown where that action is offered.
  const [outcomes, setOutcomes] = useState(new Map<string, BulkOutcome>());
  const setOutcome = useCallback((origin: string, outcome: BulkOutcome | null) => setOutcomes((current) => {
    if (!outcome && !current.has(origin)) return current;
    const next = new Map(current);
    if (outcome) next.set(origin, outcome); else next.delete(origin);
    return next;
  }), []);
  const fieldRef = useRef(field);
  fieldRef.current = field;
  const bulkToken = useRef(0);
  const stopRequest = useRef(0);
  const tableShown = JSON.stringify([relation?.name ?? null, search ?? null, sort]);
  const tableShownRef = useRef(tableShown);
  tableShownRef.current = tableShown;
  const stopBulk = () => { stopRequest.current = bulkToken.current; bulkToken.current += 1; setBulk(null); };
  // A record to bring into view once it stands on the canvas: its element id
  // is only known after the placement lands.
  const [revealRecord, setRevealRecord] = useState<string | null>(null);
  useEffect(() => {
    const placed = revealRecord ? placedRecord(field, revealRecord) : undefined;
    if (!placed) return;
    setRevealRecord(null);
    setReveal((current) => ({ id: placed.elementId, token: (current?.token ?? 0) + 1 }));
  }, [field, revealRecord]);
  /** Place what `read` returns, page after page, or (`whole` false) only its first page. */
  const runBulk = async (kind: "add" | "expand", key: string | undefined, origin: string, table: string,
    read: (offset: number) => Promise<SourceRecordWindow>, place: (page: SourceRecordWindow) => void, whole = true) => {
    if (bulk || fatal) return;
    const token = ++bulkToken.current, shownAtStart = tableShownRef.current;
    const live = () => bulkToken.current === token && (kind === "expand" || tableShownRef.current === shownAtStart);
    // A new run answers for its action: the last result of it is not this one's.
    setOutcome(origin, null); setBulk({ kind, key, placed: 0, skipped: 0 });
    let offset = 0, placed = 0, skipped = 0, already = 0, unread = false;
    let identity: SourceIdentity | undefined;
    const finish = (state: BulkOutcome["state"], extra: Partial<BulkOutcome> = {}) =>
      setOutcome(origin, { kind, origin, table, state, placed, already, skipped, unread, identity, ...extra });
    const stopped = () => finish("stopped", { stopped: stopRequest.current === token ? "person" : "table_changed" });
    try {
      for (;;) {
        const page = await read(offset);
        if (!live()) { stopped(); return; }
        identity = page.identity ?? identity;
        const fresh = page.records.filter((entry) => !placedRecord(fieldRef.current, entry.record.record_id)).length;
        place(page);
        setCanvasMounted(true);
        // Bring the run into view where it starts, as a single placement is.
        if (!offset && page.records.length) setRevealRecord(page.records[0].record.record_id);
        placed += fresh; already += page.records.length - fresh; skipped += page.skipped;
        setBulk({ kind, key, placed, skipped });
        // No row of this window had a record identity, and the table says none
        // will: further pages would be read only to be skipped.
        if (!page.records.length && page.skipped && identityBlocksPlacement(page.identity)) { unread = page.has_more; break; }
        if (!whole || !page.has_more || page.next_offset === null) break;
        offset = page.next_offset;
      }
      finish(skipped ? (placed || already ? "partial" : "nothing") : placed || already ? "complete" : "nothing");
    } catch (error) {
      if (!live()) { stopped(); return; }
      const failure = error instanceof Error ? error : new Error(String(error));
      finish("failed", { error: failure });
      if (failure instanceof SourceReadError) onFailure(failure);
    } finally {
      if (bulkToken.current === token) setBulk(null);
    }
  };
  // Every page is checked whole before it is placed: one bad record places none.
  const placePage = (records: SourceRecord[]) => {
    try { placeSourceRecords(emptySourceField(contextKey), contextKey, records, grounded); }
    catch { throw new SourceReadError("source_context_mismatch", 409); }
    for (const placed of records) { learnRows(placed.name, placed.identity); rememberDisplay(placed); }
    setField((current) => placeSourceRecords(current, contextKey, records, grounded).field);
  };
  /** The whole group (the Reader's expand through), or only `shown`, the window on show (add all, O8.5). */
  const expandGroup = async (parentId: string, fk: SourceFKDeclaration, shown?: { offset: number; limit: number; order: SourceOrder | null }) => {
    const key = expansionKey(parentId, fk.declaration_id);
    let parent: SourceRecord | null = null;
    await runBulk("expand", key, key, fk.child_table, async (offset) => {
      parent ??= await api.record(parentId);
      const request = { mode: "reference" as const, record: parentId, fk: fk.declaration_id };
      return shown ? api.recordWindow(fk.child_table, request, shown.limit, shown.offset, undefined, shown.order)
        : api.recordWindow(fk.child_table, request, 100, offset);
    }, (page) => {
      const members = page.records.map((entry) => ({ record: entry.record, observation: entry.observation! }));
      try { expandSourceGroup(emptySourceField(contextKey), contextKey, key, parent!, members, grounded); }
      catch { throw new SourceReadError("source_reference_mismatch", 409); }
      for (const member of [parent!, ...members.map((entry) => entry.record)]) { learnRows(member.name, member.identity); rememberDisplay(member); }
      setField((current) => expandSourceGroup(current, contextKey, key, parent!, members, grounded));
    }, !shown);
  };
  const takeBackGroup = (parentId: string, fk: SourceFKDeclaration) => {
    const key = expansionKey(parentId, fk.declaration_id);
    cancelPlacement(); setField((current) => retractSourceExpansion(current, key)); setOutcome(key, null);
  };
  const addOrigin = `add:${tableShown}:${offset}:${limit}`;
  // A table read with verified keys, or one that should verify: the rows decide.
  const canAddAll = !!relation && !identityBlocksPlacement(windowRows?.identity) && (windowRows?.identity?.status === "verified" || placeableTable(relation));
  // World's table footer, page-limited by the owner (O8.5): add the rows on the
  // page shown (its offset, size, search, sort or reference group), or take
  // every row of the table off.
  const addAll = () => {
    if (!relation || search === null) return;
    const shown = { offset, limit, order: sort };
    if (referencing) { void expandGroup(referencing.parent.recordId, referencing.declaration, shown); return; }
    const table = relation.name, request = search ?? null;
    void runBulk("add", undefined, addOrigin, table, () => api.recordWindow(table, request, shown.limit, shown.offset, undefined, shown.order),
      (page) => placePage(page.records.map((entry) => entry.record)), false);
  };
  const undoSeparate = separated?.field === field ? () => {
    setField({ ...field, positions: new Map(separated.before) });
    setSeparated(null);
  } : undefined;
  const selectMark = (elementId: string | null, travel = false) => {
    clearTrail();
    const reference = field.references.find((item) => item.elementId === elementId);
    if (reference) {
      const childMark = field.records.find((item) => item.elementId === reference.child)!;
      setPlacedSubject(childMark);
      // Exact child read is still owned by the workspace; never synthesize a record.
      setObservationSubject({ childId: childMark.recordId,
        declarationId: reference.observation.declaration.declaration_id, observationId: reference.observation.observation_id });
      openReader();
      if (travel) setReveal((current) => ({ id: reference.elementId, token: (current?.token ?? 0) + 1 }));
      return;
    }
    if (!elementId) { setPlacedSubject(null); setRow(null); return; }
    const placed = field.records.find((item) => item.elementId === elementId);
    if (!placed) return;
    setPlacedSubject(placed); setRow(null); openReader();
    if (travel) setReveal((current) => ({ id: elementId, token: (current?.token ?? 0) + 1 }));
  };

  const pushReader = () => setTrail((steps) => [...steps, { row, placed: placedSubject, observation: observationSubject, referencePage }]);
  const inspectReference = (next: SourceFKObservation) => {
    if (!record || next.child_record_id !== record.record_id) return;
    cancelPlacement(); pushReader();
    setObservationSubject({ childId: record.record_id, declarationId: next.declaration.declaration_id, observationId: next.observation_id });
    if (presentation.placement === "direct") setDirectReference(next.observation_id);
    openReader();
  };
  const goBack = () => {
    const previous = trail.at(-1);
    if (!previous) return;
    cancelPlacement();
    setRow(previous.row); setPlacedSubject(previous.placed); setObservationSubject(previous.observation);
    setReferencePage(previous.referencePage); setTrail((steps) => steps.slice(0, -1));
  };
  const openParent = () => {
    if (!observation || !addressableReference(observation)) return;
    cancelPlacement(); pushReader();
    const parent = observation.parent!;
    setPlacedSubject(placedRecord(field, parent.record_id) ?? { recordId: parent.record_id!, table: parent.name, key: parent.key });
    setObservationSubject(null); setReferencePage(0); openReader();
  };
  /** The record holding the reference: the other end of a connection. */
  const openChild = () => {
    if (!observation) return;
    cancelPlacement(); pushReader();
    setPlacedSubject(placedRecord(field, observation.child_record_id) ??
      { recordId: observation.child_record_id, table: observation.grounding.table, key: observation.grounding.key });
    setObservationSubject(null); setReferencePage(0); openReader();
  };
  const showReference = async () => {
    if (!observation || !record) return;
    await placeReference(observation, record);
  };
  /** Show one addressable observation of `child` on the canvas; true once it stands. */
  const placeReference = async (observation: SourceFKObservation, record: SourceRecord): Promise<boolean> => {
    if (fatal || !addressableReference(observation)) return false;
    cancelPlacement();
    const controller = new AbortController();
    placementOwner.current.controller = controller;
    const sequence = placementOwner.current.sequence;
    const subject = readerSubject;
    const owns = () => !controller.signal.aborted && sequence === placementOwner.current.sequence && currentSubjectRef.current === subject;
    setPlacementRead({ subject, pending: true });
    try {
      const parent = await api.record(observation.parent!.record_id!, controller.signal);
      if (!owns()) return false;
      if (parent.name !== observation.declaration.parent_table) throw new SourceReadError("source_reference_mismatch", 409);
      // Validate before entering a React updater so a rejected payload is a
      // contained read failure, never an exception during rendering.
      try { showSourceReference(field, contextKey, observation, record, parent, grounded); }
      catch { throw new SourceReadError("source_reference_mismatch", 409); }
      rememberDisplay(parent);
      learnRows(record.name, record.identity); learnRows(parent.name, parent.identity);
      setField((current) => {
        const shown = showSourceReference(current, contextKey, observation, record, parent, grounded).field;
        return adoptSourceRecords(shown, [record.record_id, parent.record_id].map((id) => placedRecord(shown, id)!.elementId));
      });
      setCanvasMounted(true);
      // The field update is atomic. Reveal is resolved against its latest identities below.
      setReferenceReveal(observation.observation_id);
      setPlacementRead(null);
      return true;
    } catch (error) {
      if (!owns()) return false;
      const failure = error instanceof Error ? error : new Error(String(error));
      setPlacementRead({ subject, pending: false, error: failure });
      if (failure instanceof SourceReadError) onFailure(failure);
      return false;
    }
  };
  // World's reader: a value naming a disc goes to it. Here a foreign-key value
  // whose reference resolves goes to the record it names; with direct
  // placement the connection is shown on the way, as inspecting it would.
  // The value last followed, so a placement that failed on the way can be asked again.
  const lastReach = useRef<SourceFKObservation | null>(null);
  const reachReference = async (next: SourceFKObservation) => {
    if (!record || next.child_record_id !== record.record_id || !addressableReference(next)) return;
    lastReach.current = next;
    if (presentation.placement === "direct" && !(await placeReference(next, record))) return;
    cancelPlacement(); pushReader();
    const parent = next.parent!;
    setPlacedSubject(placedRecord(field, parent.record_id!) ?? { recordId: parent.record_id!, table: parent.name, key: parent.key });
    setObservationSubject(null); setReferencePage(0); openReader();
  };
  const reach = useMemo(() => {
    // Each FK column of a resolved reference; a column two references share
    // reaches neither, rather than guess between them.
    const byColumn = new Map<string, SourceFKObservation | null>();
    for (const observation of referencesResult?.data?.observations ?? []) {
      if (!addressableReference(observation)) continue;
      for (const pair of observation.declaration.pairs) {
        if (!pair.child_column) continue;
        byColumn.set(pair.child_column, byColumn.has(pair.child_column) ? null : observation);
      }
    }
    return new Map([...byColumn].filter((entry): entry is [string, SourceFKObservation] => entry[1] !== null));
  }, [referencesResult?.data]);
  // The full references list waits behind a closed disclosure, kept open once opened.
  const [referencesOpen, setReferencesOpen] = useState(false);
  const [referenceReveal, setReferenceReveal] = useState<string | null>(null);
  useEffect(() => {
    if (!referenceReveal) return;
    const reference = field.references.find((item) => item.observation.observation_id === referenceReveal);
    if (reference) setReveal((current) => ({ id: reference.elementId, token: (current?.token ?? 0) + 1 }));
    setReferenceReveal(null);
  }, [field.references, referenceReveal]);
  // Direct placement (the default, O1): inspecting a reference also shows it, once
  // the observation and its child record are read. Only an addressable
  // observation is shown; any other status stays in the Reader as before.
  const [directReference, setDirectReference] = useState<string | null>(null);
  useEffect(() => {
    if (!directReference) return;
    if (observationSubject?.observationId !== directReference) { setDirectReference(null); return; }
    if (observationResult?.error || recordResult?.error) { setDirectReference(null); return; }
    if (observation?.observation_id !== directReference || !record) return;
    setDirectReference(null);
    if (addressableReference(observation)) void showReference();
  });
  const shownReference = observationSubject ? field.references.find((item) => item.observation.observation_id === observationSubject.observationId) : undefined;
  const selectedElement = observationSubject ? shownReference?.elementId ?? null : shownPlaced?.elementId ?? null;
  const activePlacement = placementRead?.subject === readerSubject ? placementRead : null;
  // World's Delete: the selected mark leaves the canvas (a connection is hidden,
  // O2). Never while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // World's: Escape leaves the schema room; on the empty canvas there is no room to leave.
      if (event.key === "Escape" && schemaView && field.records.length && !event.defaultPrevented &&
          !(event.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable='true'], .ov")) {
        event.preventDefault(); setSchemaView(false); return;
      }
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if ((event.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (!selectedElement || fatal || schemaView) return;
      event.preventDefault();
      removeFromList(selectedElement);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // A table chosen on the schema opens in the Tables dock, as one chosen in the
  // catalogue does; a chosen declaration is only selected.
  const [schemaSelected, setSchemaSelected] = useState<string | null>(null);
  const chooseSchemaMark = (elementId: string | null) => {
    setSchemaSelected(elementId);
    const item = schemaRead?.data?.find((candidate) => schemaElement(candidate.name) === elementId);
    if (item) { choose(item); openTables(); }
  };
  const hasRecords = field.records.length > 0;
  // Each placed record's name, by mark (O17): canvas discs and the records list.
  const recordNames = useMemo(() => new Map(field.records.map((placed) => [placed.elementId, nameOf(placed.table, placed.key, placed.recordId)])),
    [field.records, nameOf]);
  // On the crossing, as World does (`setVocabularyFocus(!hasField)`), once any
  // remembered canvas has been read back.
  useEffect(() => { if (!restore.reading) setSchemaView(!hasRecords); }, [hasRecords, restore.reading]);

  const counts = overview?.data?.counts;
  const referencing = search?.mode === "reference" && incoming && search.record === incoming.parent.recordId &&
    search.fk === incoming.declaration.declaration_id ? incoming : null;
  // The table panel shows the result of the action it offers: add all for this
  // window, or the group it is narrowed to (whichever control started it).
  const dockOutcome = referencing ? outcomes.get(expansionKey(referencing.parent.recordId, referencing.declaration.declaration_id))
    : outcomes.get(addOrigin);
  const readerTitle = observationSubject ? "reference" : readerTable ?? "reader";
  const readerKey = placedSubject?.key ?? row?.key;
  const readerCaption = observationSubject ? observation ? referenceName(observation) : "loading reference…" : !readerRecordSubject ? readerRelation?.kind === "view" ? "view · computed output" : readerRelation?.kind : handle && readerKey ? sourceKeyText(readerKey)
    : `row ${offset + (row ? windowRows?.rows.indexOf(row) ?? 0 : 0) + 1} · this page only`;
  const readerActions = observationSubject ? observationResult?.error ? null
    : observation && <ReferenceActions observation={observation} childReady={!!record} visible={!!shownReference} pending={!!activePlacement?.pending}
      onOpenParent={openParent} onCancel={() => {
        cancelPlacement(); setFocusRequest(['#source-reader .motion-swap__is .source-reference-actions [data-reference-show]', FOCUS_TARGETS.reader]);
      }} onShow={() => void showReference()} onHide={() => {
        cancelPlacement();
        if (shownReference) setField((current) => hideSourceReference(current, shownReference.elementId));
        setFocusRequest(['#source-reader .motion-swap__is .source-reference-actions [data-reference-show]', FOCUS_TARGETS.reader]);
      }} />

    : record && readerRecordSubject ? <SourcePlacement placed={shownPlaced} onShow={showOnCanvas} onRemove={() => shownPlaced && removeMark(shownPlaced.elementId, '#source-reader .motion-swap__is [data-placement="show"]')} /> : null;
  const readerBody = observationSubject ? observationResult?.error ? <Problem error={observationResult.error} onRetry={observationResult.retry} />
    : observation ? <ReferenceDetails observation={observation} context={context} childReady={!!record} childError={recordResult?.error} onRetryChild={recordResult?.retry} pending={!!activePlacement?.pending} error={activePlacement?.error}
      onRetryPlacement={() => void showReference()}
      drawn={!!shownReference} ends={observation.parent?.record_id ? {
        child: nameOf(observation.grounding.table, observation.grounding.key, observation.child_record_id),
        parent: nameOf(observation.parent.name, observation.parent.key, observation.parent.record_id),
        onChild: openChild, onParent: openParent } : undefined} /> : <Loading />
    : !readerTable || !readerRelation ? <CaptureDetails context={context} />
    : !readerRecordSubject ? <><TableDetails relation={readerRelation} identity={windowRows?.identity} /><CaptureDetails context={context} /></>
    : !handle && row ? <><SourceUnplaceable relation={readerRelation} identity={windowRows?.identity} /><RecordDetails row={row} relation={readerRelation} context={context} identity={windowRows?.identity} columns={windowRows?.columns} /></>
    : recordResult?.error ? <Problem error={recordResult.error} onRetry={recordResult.retry} />
    : record ? <>{activePlacement?.error && <div className="source-placement-problem" data-placement-problem>
      <Problem error={activePlacement.error} onRetry={() => { if (lastReach.current) void reachReference(lastReach.current); }} /></div>}
    <RecordDetails row={record} record={record} relation={readerRelation} context={context} reach={reach} onReach={(observation) => void reachReference(observation)} nameOf={nameOf}>
      {record.actions.incoming_references && <ExpandThrough page={incomingResult?.data ?? undefined}
        state={(group) => {
          const key = expansionKey(record.record_id, group.declaration.declaration_id);
          return { shown: expansionShown(field, key), running: bulk?.key === key ? bulk.placed : null, outcome: outcomes.get(key) };
        }}
        onExpand={(group) => void expandGroup(record.record_id, group.declaration)}
        onTakeBack={(group) => takeBackGroup(record.record_id, group.declaration)} />}
      {record.actions.incoming_references && <IncomingReferences page={incomingResult?.data ?? undefined} error={incomingResult?.error} onRetry={incomingResult?.retry} offset={incomingOffset}
        open={!catalogueVisible && incoming?.parent.recordId === record.record_id && relation?.name === incoming.declaration.child_table ? incoming.declaration.declaration_id : null}
        onPage={(next) => setIncomingWindow({ record: record.record_id, offset: next })} onOpen={openIncoming} />}
      {/* "on this disc" (O8.7) is paused by the owner: kept, not shown. */}
      {/* The declared references, statuses and all, behind a disclosure: the
          values above reach what resolves (the owner hid the section, O14). */}
      <ReaderDisclosure data-own-state className="source-details source-references" label={`references${referencesResult?.data?.total ? ` · ${referencesResult.data.total} declared` : ""}`}
        open={referencesOpen} onToggle={(event) => {
          // Only the live Reader speaks: the outgoing copy a swap keeps for its
          // exit reports its own toggles, and must not close the new one.
          if (event.currentTarget.closest(".motion-swap__was")) return;
          const open = event.currentTarget.open; if (open !== referencesOpen) setReferencesOpen(open);
        }}>
        <OutgoingReferences bare page={referencesResult?.data ?? undefined} error={referencesResult?.error} onRetry={referencesResult?.retry} offset={referencePage} onPage={setReferencePage} onInspect={inspectReference} />
      </ReaderDisclosure>
      </RecordDetails></> : <Loading />;
  // Presentation restoration waits for asynchronous content, not just the
  // initial loading panel. This neither starts nor authorizes a source read.
  const readerReady = observationSubject ? !!observationResult?.error || !!observation && !!(record || recordResult?.error)
    : !readerRecordSubject || !handle || !!recordResult?.error || !!record && !!(referencesResult?.data || referencesResult?.error) &&
      (!record.actions.incoming_references || !!(incomingResult?.data || incomingResult?.error));
  const canvasStyle = { left: layout.left, right: layout.right };
  const invitation = usePresence(!relation && field.records.length === 0 && !fatal && !schemaView);

  return <main {...navigation} onPointerDownCapture={() => { setFocusRequest(null); navigation.onPointerDownCapture(); }} onKeyDownCapture={(event) => {
    // A handled filter Escape is editing, not travel to the Reader subject
    // that clearing the selected row reveals. An empty filter still dismisses.
    const target = event.target as Element;
    const filtering = target.closest(".source-find");
    const clearsFilter = event.key === "Escape" && filtering && target.matches('input[type="search"]') &&
      Boolean(findDraft.text || findDraft.column || findDraft.mode === "primary_key");
    if (event.key !== "Escape" || clearsFilter) setFocusRequest(null);
    if ((filtering && (event.key !== "Escape" || clearsFilter)) ||
        ((event.key === "Enter" || event.key === " ") && target.closest('[aria-label="Row windows"]'))) navigation.onPointerDownCapture();
    else navigation.onKeyDownCapture(event);
  }} className={`product-shell source-workspace${schemaView ? " is-schema" : ""}${hidden ? " is-chrome-hidden" : ""}${mode === "dark" ? " is-dark" : ""}${motionReady ? " is-motion-ready" : ""}${layout.compact ? " is-compact" : ""}`} style={{ ...worldShellStyle(mode, { focus: schemaView }), ...worldChromeDockVars({ tablesWidth: layout.tables.width, readerWidth: layout.reader.width }) }}>
    <header className={chromeClass("product-shell__top")}><div className="product-shell__bar">
      <span className="product-shell__workspace">Knowledge Inspector</span><span>source</span>
      <div className="product-shell__utils"><button type="button" className="product-shell__theme" onClick={() => setLocalTheme(mode === "light" ? "dark" : "light")} aria-label={`Use ${mode === "light" ? "dark" : "light"} appearance`}>{mode === "light" ? "dark" : "light"}</button></div>
    </div></header>
    <div className="source-stage" ref={stageRef}>
      <section className="source-canvas" tabIndex={-1} aria-label="Source canvas" data-unobscured={layout.canvas} data-camera-insets={JSON.stringify(layout.camera)}>
        {!schemaView && restore.reading && <p className="source-restore" role="status">restoring the canvas…</p>}
        {!schemaView && restore.field && restore.field === field && (restore.restored || restore.lost || restore.unplaceable) ? <p className="source-restore" role="status">
          restored {restore.restored} {restore.restored === 1 ? "record" : "records"} from the last visit
          {restore.lost ? ` · ${restore.lost} not found in this capture` : ""}{restore.unplaceable ? ` · ${restore.unplaceable} cannot be placed in this session` : ""}
          {restore.lostConnections ? ` · ${restore.lostConnections} ${restore.lostConnections === 1 ? "connection" : "connections"} not restored` : ""}</p> : null}
        {restore.unread && <div className="source-restore source-restore--problem" role="alert" data-restore-problem>
          <p>the canvas from your last visit could not be read yet: {readFailure(restore.unread).sentence} It is kept as it was.
            <small className="source-problem__code"> details · <code>{(restore.unread as SourceReadError).code}</code></small></p>
          <TableAction className="source-retry" onClick={retryRestore}>try again</TableAction>
          <TableAction onClick={() => setRestore({ reading: false })}>start without it</TableAction></div>}
        {/* Both canvases stay mounted once drawn, the one not in view parked,
            as World keeps its field and its schema. */}
        {!fatal && canvasMounted && <div className={`source-layer${schemaView ? " is-parked" : ""}`} inert={schemaView || undefined}>
          <SourceCanvas passThrough cameraRoom={sourceCameraRoom(context)} standing={!!restore.field && restore.field === field} presentation={presentation} labels={recordNames} field={shownField} mode={mode} selected={selectedElement} reveal={reveal} insets={layout.camera}
          onSelect={(elementId) => selectMark(elementId)} onRemove={(elementId) => removeMark(elementId)}
          onPositions={(moved, dropped) => setField((current) => moveSourceRecords(current, moved, dropped))} /></div>}
        {!fatal && schemaField && <div className={`source-layer source-schema${schemaView ? "" : " is-parked"}`} inert={!schemaView || undefined} data-schema-tables={schemaField.records.length} data-schema-references={schemaField.references.length}>
          {/* Table names are the labels: a schema disc has no key to show. The
              schema arrives whole, so it stands rather than being born: centred,
              or framed as last left. */}
          <SourceCanvas standing inverted fit namedAtRest={schemaNamed(show)} handleName="__sourceSchemaGraph" cameraRoom={`${sourceCameraRoom(context)}:schema`} presentation={presentation} labels={schemaLabels} field={schemaField} mode={mode}
            selected={schemaSelected} reveal={null} insets={layout.camera} onSelect={chooseSchemaMark} onRemove={() => {}}
            onPositions={(moved, dropped) => setSchemaField((current) => current && moveSourceRecords(current, moved, dropped))} /></div>}
        {schemaView && declarationNote && <p className="source-declared-note" data-declared-note>{declarationNote}</p>}
        {schemaView && !schemaRead?.data && <p className="source-restore" role="status">{schemaRead?.error ? "the schema could not be read" : "reading the schema…"}</p>}
        {schemaView && schemaRead?.error && <div className="source-schema-problem"><Problem error={schemaRead.error} onRetry={schemaRead.retry} /></div>}
        {invitation.mounted && <div className={`source-quiet motion-layer motion-layer--fade${invitation.shown ? " is-in" : ""}`} aria-hidden={!invitation.shown} inert={!invitation.shown || undefined} style={canvasStyle}><h1 tabIndex={-1}>choose a table to inspect</h1></div>}
        {!fatal && <Instrument>
          <div className="instrument__group" role="group" aria-label="find"><SourceGlobalFind find={(text, cursor, signal) => api.find(text, cursor, 20, signal)} onFailure={onFailure} onPick={openFound} onPickTable={openFoundTable}
            nameOf={(hit) => hit.record_id ? nameOf(hit.table, hit.key, hit.record_id, hit.cells) : `${hit.table} · no verified key`} /></div>
          {/* World's: nothing to press on the empty canvas, whose screen the schema
              is; with records, "schema" enters it and "clear" leaves. */}
          {hasRecords && (schemaView
            ? <div className="instrument__group" role="group" aria-label="Clear focus"><button type="button" onClick={() => setSchemaView(false)} title="Back to the records on the canvas">clear</button></div>
            : <div className="instrument__group" role="group" aria-label="View"><button type="button" onClick={() => setSchemaView(true)} title="Every table and its declared foreign keys">schema</button></div>)}
          {schemaView ? <SourceShowBand schema show={show} tables={[]} onShow={setShow} />
            : field.records.length > 0 && <SourceShowBand show={show} tables={[...tablesOnCanvas]} onShow={setShow} />}
          {!schemaView && field.records.length > 0 && <SourceFieldList records={field.records} names={recordNames} references={field.references} selected={selectedElement}
            onSelect={(elementId) => selectMark(elementId, true)} onRemove={removeFromList} onSeparate={separate} onUndoSeparate={undoSeparate} />}
        </Instrument>}
      </section>
      {fatal ? <div className="source-fatal"><h2 tabIndex={-1} data-focus-subject>source reads stopped</h2><Problem error={fatal} /><p data-stopped-recovery>Nothing was read from another capture or the original file, and the canvas was cleared. {stoppedRecovery(fatal)}</p></div> : <>
        <OverlayPanel id="source-tables" title="tables" open={layout.tables.open} onToggle={(open) => open ? openTables() : setTablesOpen(false)} handleWhen="closed" width={layout.tables.width} onWidthChange={(size) => { setTablesWidth(size); setPrimary("tables"); storePanelSize("ki.source.tables.width", size); }} minWidth={SOURCE_DOCK_MIN} maxWidth={layout.tables.maxWidth} reserve={layout.right} flush surface="panel">
          <div className="table source-dock"><div className="source-table-slot"><Swap id={tableSubject} className="motion-swap--fill">
            {catalogueVisible ? <div className="source-table-view">
              <TableHeader className="source-catalogue-heading" title="tables" heading onClose={() => setTablesOpen(false)} actions={relation && <TableAction onClick={(event) => { setCatalogueVisible(false); if (event.detail === 0) setFocusRequest([FOCUS_TARGETS.table]); }}>resume {relation.name}</TableAction>} />
              <div className="table__scroll table__scroll--flow source-catalogue" {...catalogueViewport}>
                <p>{counts ? `${counts.tables} tables · ${counts.views} views${counts.unsupported_virtual_or_shadow ? ` · ${counts.unsupported_virtual_or_shadow} unsupported objects` : ""}` : "source catalogue"}</p>
                {declarationNote && <p className="source-limitation" data-declared-note>{declarationNote}</p>}
                {overview?.error && <Problem error={overview.error} onRetry={overview.retry} />}
                <TableSearch value={catalogueQuery} onChange={setCatalogueQuery} label="Search tables" />
                <div className="table__filters source-placement-filter"><label>Canvas placement <select aria-label="Canvas placement" value={placementFilter}
                  onChange={(event) => setPlacementFilter(event.target.value as typeof placementFilter)}>
                  <option value="all">All tables</option>
                  <option value="placeable">Can place on canvas</option>
                  <option value="other">Cannot place on canvas</option>
                </select></label>
                  <span role="status">{shownTables.length} of {catalogue?.data?.relations.length ?? 0}{catalogue?.data && catalogue.data.total > catalogue.data.relations.length ? " on this page" : ""}</span></div>
                {catalogue?.error ? <Problem error={catalogue.error} onRetry={catalogue.retry} /> : catalogue?.data ? <>
                  {(catalogueQuery || placementFilter !== "all") && !shownTables.length && <p className="table__empty">No tables match.</p>}
                  <div className="table__catalogue source-table-list" aria-label="table catalogue">{shownTables.map((item) => <button type="button" className="table__row" data-loaded key={item.name} aria-pressed={relation?.name === item.name} data-present={wholeTables.has(item.name) || undefined}
                    title={tablesOnCanvas.has(item.name) ? `${wholeTables.has(item.name) ? "Every row is on the canvas. " : ""}Right-click takes every row of ${item.name} off the canvas` : undefined}
                    onContextMenu={tablesOnCanvas.has(item.name) ? (event) => { event.preventDefault(); takeOffTable(item.name); } : undefined}
                    onClick={(event) => choose(item, event.detail === 0)}><span title={item.name}>{item.name}</span><span className="table__origin">{item.kind}{item.read_status === "unsupported" && " · unsupported"}</span></button>)}</div>
                  {catalogue.data.total === 0 && <p>no tables or views</p>}
                  {catalogue.data.total > PAGE && <TableFooter className="table__foot table__pager"><button type="button" disabled={catalogueOffset === 0} onClick={() => setCatalogueOffset(Math.max(0, catalogueOffset - PAGE))}>previous tables</button>
                    <span>{catalogueOffset + 1}–{catalogueOffset + catalogue.data.relations.length} of {catalogue.data.total}</span>
                    <button type="button" disabled={!catalogue.data.has_more} onClick={() => setCatalogueOffset(catalogue.data!.next_offset!)}>next tables</button></TableFooter>}
                </> : <Loading />}
                <CaptureDetails context={context} />
              </div>
              {/* World's catalogue footer: one action takes everything off the canvas. */}
              <TableFooter className="table__foot source-canvas-clear"><button type="button" disabled={!field.records.length} onClick={clearCanvas} title="Clear the canvas">clear</button></TableFooter>
            </div> : relation ? <div className="source-table-view">
              <TableHeader className="source-table-heading" title={relation.name} heading onClose={() => setTablesOpen(false)} subjects={<nav className="table__subjects" aria-label="table navigation">
                <TableAction data-catalogue onClick={showCatalogue}>tables</TableAction>
                {tableTrail.length > 0 && <PanelBack onBack={(event) => backTable(event.detail === 0)} label="back to previous table" />}
              </nav>} actions={<>{sort && <TableAction data-unsort onClick={() => reorder(null)}>unsort</TableAction>}
                {canAddAll && (() => {
                  // O17: the person names this table's records by one of its columns, or by key.
                  const chosen = naming[relation.name] ?? "", columns = windowRows?.columns ?? relation.columns ?? [];
                  return <label className="source-naming" title={chosen ? `${relation.name} records are named by ${chosen} on the canvas: your choice, in this tab` : `${relation.name} records are named by their key`}>
                    <span>name by</span>
                    <select aria-label={`name ${relation.name} records by`} value={chosen} onChange={(event) => {
                      const column = event.target.value, table = relation.name;
                      setNaming((current) => { const next = { ...current }; if (column) next[table] = column; else delete next[table]; return next; });
                    }}>
                      <option value="">key</option>
                      {columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
                    </select>
                  </label>;
                })()}
                <TableAction data-table-info onClick={() => {
                cancelPlacement(); if (readerRecordSubject || observationSubject) pushReader();
                setObservationSubject(null); setReferencePage(0); setRow(null); setPlacedSubject(null); openReader();
              }}>table info</TableAction></>} />
              {/* Where Find would be: the relationship this table is narrowed to, as World's
                  "mentioning", and World's "whole relation" to drop it. */}
              {referencing && <div className="table__filters source-incoming-subject"><p data-incoming-subject>
                {referencing.count.status === "exact" ? incomingCountText(referencing.count) : "rows"} referencing{" "}
                <b>{nameOf(referencing.parent.table, referencing.parent.key, referencing.parent.recordId)}</b>{" "}
                through {incomingColumns(referencing.declaration)}{referencing.count.status !== "exact" && ` · ${incomingCountText(referencing.count)}`}</p>
                <TableAction data-whole-table onClick={(event) => {
                  changeSearch(undefined);
                  if (event.detail === 0) setFocusRequest(['#source-tables .source-table-slot .motion-swap__is .source-find input[type="search"]', FOCUS_TARGETS.table]);
                }}>whole table</TableAction></div>}
              {relation.read_status === "available" && !referencing && <SourceFind draft={findDraft} onDraft={setFindDraft} name={relation.name} columns={relation.columns ?? []} onEdit={() => changeSearch(null)} onSubmit={changeSearch} onClear={() => changeSearch(undefined)} />}
              {relation.read_status === "available" ? search === null ? <p className="source-find-prompt" role="status">press enter to filter</p> : <SourceRowsView searching={search !== undefined} named={naming[relation.name]} name={relation.name} rows={windowRows} error={windowResult?.error} onRetry={windowResult?.retry} selected={row} placed={placedHandles} onTakeOff={takeOffRecord} order={sort} onOrder={cycleSort} offset={offset} limit={limit} onPage={page} onSelect={select} scroll={tableScroll} /> : <p role="alert">read unavailable · {relation.reason}</p>}
              {relation.read_status === "available" && search !== null && <div className="source-bulk">
                {bulk?.skipped ? <p className="source-note">{bulk.skipped} {bulk.skipped === 1 ? "row" : "rows"} without a verified key · not placed</p> : null}
                {!bulk && dockOutcome && <BulkOutcomeNote outcome={dockOutcome} />}
                {!canAddAll && identityBlocksPlacement(windowRows?.identity) && <p className="source-limitation" data-placement-limit>rows of {relation.name} cannot be placed · {identityExplanation(windowRows?.identity)!.short}</p>}
                <TableFooter className="table__foot source-bulk__actions">
                  <button type="button" onClick={addAll} disabled={!!bulk || !canAddAll} aria-busy={!!bulk || undefined}
                    title={canAddAll ? "Place every row on this page on the canvas" : "No verified records to place on the canvas"}
                    style={{ fontVariantNumeric: "tabular-nums" }}>{bulk ? `adding… ${bulk.placed}` : "add all"}</button>
                  {bulk && <button type="button" onClick={stopBulk}>stop</button>}
                  <button type="button" onClick={() => takeOffTable(relation.name)} disabled={!!bulk || !tablesOnCanvas.has(relation.name)}
                    title="Take every row of this table off the canvas">clear</button>
                </TableFooter></div>}
            </div> : <div />}
          </Swap></div></div>
        </OverlayPanel>
        <OverlayPanel id="source-reader" title="reader" side="right" open={layout.reader.open} onToggle={(open) => open ? openReader() : dismissReader()} handleWhen="closed" width={layout.reader.width} onWidthChange={(size) => { setReaderWidth(size); setPrimary("reader"); storePanelSize("ki.source.reader.width", size); }} minWidth={SOURCE_DOCK_MIN} maxWidth={layout.reader.maxWidth} reserve={layout.left} flush>
          <Swap id={readerSubject} className="motion-swap--fill">
            <SourceReaderPanel title={readerTitle} caption={readerCaption} onClose={dismissReader} onBack={trail.length > 0 ? goBack : undefined} scroll={readerScroll} ready={readerReady} actions={readerActions}>{readerBody}</SourceReaderPanel>
          </Swap>
        </OverlayPanel>
      </>}
    </div>
  </main>;
}

export function SourceWorkspace() {
  const result = useSourceRead(sourceSession);
  return <OverlayChromeProvider>{result?.data ? <Workspace key={sourceContextKey(result.data)} context={result.data} /> : <main className="source-start" style={worldShellStyle("light")}><h1>source</h1>{result?.error ? <Problem error={result.error} onRetry={result.retry} /> : <Loading />}</main>}</OverlayChromeProvider>;
}

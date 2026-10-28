import { FOCUS_PAD } from "../world/worldChrome";

/** The interactive canvas a desktop source workspace always keeps clear. */
export const SOURCE_CANVAS_MIN = 320;
/** The narrowest a dock is drawn; a person's preference is never saved below it. */
export const SOURCE_DOCK_MIN = 280;
export const SOURCE_DOCK_MAX = 720;
/** Below this width the workspace shows one dock at a time. */
export const SOURCE_COMPACT_BELOW = 900;

export type SourceDock = "tables" | "reader";

/**
 * What a closed dock still covers, as drawn: both handles stand flush to their
 * window edge (the owner wants the Reader's there too, where World floats a
 * right-hand tab `--ov-float` clear of it). Read from the live CSS
 * (`--ov-handle` grows on coarse pointers) rather than assumed.
 */
export type SourceHandles = { left: number; right: number };
export const SOURCE_HANDLES_FINE: SourceHandles = { left: 34, right: 34 };

export function measuredHandles(root: Element = document.documentElement): SourceHandles {
  const style = getComputedStyle(root);
  const handle = Number.parseFloat(style.getPropertyValue("--ov-handle"));
  if (!Number.isFinite(handle)) return SOURCE_HANDLES_FINE;
  return { left: handle, right: handle };
}

export type SourceDockLayout = {
  compact: boolean;
  tables: { open: boolean; width: number; maxWidth: number };
  reader: { open: boolean; width: number; maxWidth: number };
  /** What the docks cover on each side, open body or closed handle. */
  left: number;
  right: number;
  /** The unobscured interactive canvas between them. */
  canvas: number;
  camera: { left: number; right: number; top: number; bottom: number };
};

/**
 * Where the docks stand and what canvas they leave, from one measurement.
 *
 * The docks float over the canvas, so their drawn widths, the quiet field's
 * insets and the camera's framing room are three readings of the same
 * geometry; computing them here, from the stage width actually measured, is
 * what keeps them in agreement. Preferences are never rewritten: a saved wide
 * dock is drawn narrower while the viewport cannot afford it, and comes back
 * when it can.
 *
 * Desktop (900px and wider): both docks may stay open. When their preferred
 * widths would leave less than `SOURCE_CANVAS_MIN`, the dock the person did not
 * most recently open yields first, down to `SOURCE_DOCK_MIN`, then the other.
 * At 900px that still leaves both docks at least 290px and the canvas 320px.
 *
 * Compact (below 900px): one dock at a time. Requested-open state is kept for
 * both, but only the most recently opened dock is drawn open; the other stands
 * as its handle and returns, with its subject, when the first closes. The open
 * dock yields width to keep 320px of canvas where the viewport allows it
 * (about 644px and wider); narrower than that, the dock keeps its minimum and the
 * canvas is what remains. Placement is not claimed as supported there.
 */
export function sourceDockLayout(stage: number, docks: {
  tablesOpen: boolean;
  readerOpen: boolean;
  tablesWidth: number;
  readerWidth: number;
  primary: SourceDock;
}, handles: SourceHandles = SOURCE_HANDLES_FINE): SourceDockLayout {
  const compact = stage < SOURCE_COMPACT_BELOW;
  const clamp = (width: number, max: number) => Math.max(SOURCE_DOCK_MIN, Math.min(width, max, SOURCE_DOCK_MAX));
  let tablesOpen = docks.tablesOpen;
  let readerOpen = docks.readerOpen;
  if (compact && tablesOpen && readerOpen) {
    if (docks.primary === "tables") readerOpen = false;
    else tablesOpen = false;
  }
  // One dock open: the other is its handle, on whichever side that is.
  const single = (closed: number) => stage - closed - SOURCE_CANVAS_MIN;
  const tablesSingle = single(handles.right);
  const readerSingle = single(handles.left);
  let tables = clamp(docks.tablesWidth, tablesSingle);
  let reader = clamp(docks.readerWidth, readerSingle);
  let tablesMax = clamp(SOURCE_DOCK_MAX, tablesSingle);
  let readerMax = clamp(SOURCE_DOCK_MAX, readerSingle);
  if (tablesOpen && readerOpen) {
    const budget = stage - SOURCE_CANVAS_MIN;
    const yielding: SourceDock = docks.primary === "tables" ? "reader" : "tables";
    if (tables + reader > budget) {
      if (yielding === "reader") {
        reader = Math.max(SOURCE_DOCK_MIN, budget - tables);
        tables = Math.max(SOURCE_DOCK_MIN, budget - reader);
      } else {
        tables = Math.max(SOURCE_DOCK_MIN, budget - reader);
        reader = Math.max(SOURCE_DOCK_MIN, budget - tables);
      }
    }
    // A drag may widen a dock only into width the other has left.
    tablesMax = clamp(budget - reader, budget - reader);
    readerMax = clamp(budget - tables, budget - tables);
  }
  const left = tablesOpen ? tables : handles.left;
  const right = readerOpen ? reader : handles.right;
  return {
    compact,
    tables: { open: tablesOpen, width: tables, maxWidth: tablesMax },
    reader: { open: readerOpen, width: reader, maxWidth: readerMax },
    left,
    right,
    canvas: Math.max(0, stage - left - right),
    camera: { left: left + FOCUS_PAD, right: right + FOCUS_PAD, top: FOCUS_PAD, bottom: FOCUS_PAD },
  };
}

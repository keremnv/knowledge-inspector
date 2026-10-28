/**
 * The World shell's own tokens, in one place so the page has one source of
 * drift.
 *
 * The World page renders the real canvases, the
 * real tables and the real reader panels against fixtures. The one thing it
 * could not import was the shell itself: the chrome palette, the matter
 * tokens, the focus override and the motion spine were an inline object in
 * `WorldPage`, so there is no second design surface. Chrome
 * disagrees with the product's is worse than no design surface, because it
 * reports a look the product does not have.
 *
 * Anything a page would be sad to have two of belongs here.
 */

import type { CSSProperties } from "react";
import {
  chromeCssVariables,
  focusCssVariables,
  GRAPH_DNA_CHROME,
  GRAPH_DNA_FOCUS,
  GRAPH_DNA_THEME,
  radixValue,
  type ThemeMode,
} from "../styles/graphDna";
import {
  DEFAULT_MOTION_PLANS,
  motionCssVariables,
  type MotionPlans,
} from "../styles/motion";
import { typeCssVariables } from "../styles/type";

/**
 * The clearance a camera move leaves around a mark it brings into view.
 *
 * Measured against the *visible remainder* — what the docks leave — not the
 * host, because the panels sit over the canvas rather than shrinking it.
 */
export const FOCUS_PAD = 48;

/** What a closed TABLES dock still occupies: its handle. */
export const TABLES_HANDLE_RESERVE = 44;

export const TABLES_WIDTH_DEFAULT = 360;

export type WorldShellOptions = {
  /** Vocabulary focus: the chrome tokens *become* the focus palette. */
  focus?: boolean;
  /** The spine to emit for the inspector. */
  motion?: MotionPlans;
};

/**
 * Every custom property the World shell puts on its root element.
 *
 * Order matters: the spine first because nothing overrides it, then chrome,
 * then — in focus — the focus palette *rewriting the chrome tokens*. That
 * last part has to happen here rather than as a `.is-focus` rule, because the
 * canvases read the computed values off the element and a class the canvas
 * cannot see would leave the field painted in the ordinary palette while the
 * chrome around it changed.
 */
export function worldShellStyle(
  mode: ThemeMode,
  options: WorldShellOptions = {},
): CSSProperties {
  const focusVars = options.focus ? focusCssVariables(GRAPH_DNA_FOCUS) : null;
  return {
    ...motionCssVariables(options.motion ?? DEFAULT_MOTION_PLANS),
    ...typeCssVariables(),
    ...chromeCssVariables(GRAPH_DNA_CHROME[mode]),
    "--matter-canvas": radixValue(GRAPH_DNA_THEME[mode].canvas),
    "--matter-surface": radixValue(GRAPH_DNA_THEME[mode].surface),
    ...(focusVars
      ? {
          ...focusVars,
          "--canvas": focusVars["--focus-field"],
          "--panel": focusVars["--focus-field"],
          "--ink": focusVars["--focus-ink"],
          "--ink-muted": focusVars["--focus-ink-muted"],
          "--rule": focusVars["--focus-rule"],
          "--matter-surface": focusVars["--focus-field"],
          "--matter-canvas": focusVars["--focus-field"],
        }
      : {}),
  } as CSSProperties;
}

/**
 * How much of the field the docks are covering right now.
 *
 * Both surfaces frame marks against this, so both have to agree about what a
 * closed dock still takes.
 *
 * Covering, not open — the same distinction the bands make in
 * the shell styles, and it took the same correction. This used to read
 * `focus ? FOCUS_PAD : ...` on both sides, on the reasoning that a focus room
 * is the whole window. Only the left dock is actually withdrawn by focus, and
 * even that is undone on the world's default screen, where the vocabulary is
 * what the surface *is* and TABLES stays as the way onto the field. So focus
 * framed the ring against a window while an opaque 360px drawer stood on it,
 * and the left third of the vocabulary was drawn underneath.
 *
 * `unfielded` is that default screen. It only matters while `focus` is set.
 */
export function worldCameraInsets(dock: {
  focus?: boolean;
  unfielded?: boolean;
  tablesOpen: boolean;
  tablesWidth: number;
  readerOpen: boolean;
  readerWidth: number;
}) {
  const tablesShown = !dock.focus || Boolean(dock.unfielded);
  return {
    left: tablesShown
      ? (dock.tablesOpen ? dock.tablesWidth : TABLES_HANDLE_RESERVE) + FOCUS_PAD
      : FOCUS_PAD,
    right: (dock.readerOpen ? dock.readerWidth : 0) + FOCUS_PAD,
    top: FOCUS_PAD,
    bottom: FOCUS_PAD,
  };
}

/**
 * CSS variables that park the identity and instrument bars in the canvas
 * remainder, not the window.
 *
 * The bars read `--chrome-inset-*`, which CSS derives from these docks and
 * from whether a drawer is still `.is-open` (including through absorb). That
 * is how a closing TABLES panel keeps the bar displaced until the drawer has
 * actually left, rather than overlapping for the duration of the slide.
 */
export function worldChromeDockVars(dock: {
  tablesWidth: number;
  readerWidth: number;
}): CSSProperties {
  return {
    "--chrome-dock-left": `${dock.tablesWidth}px`,
    "--chrome-dock-right": `${dock.readerWidth}px`,
    "--chrome-dock-left-closed": `${TABLES_HANDLE_RESERVE}px`,
  } as CSSProperties;
}

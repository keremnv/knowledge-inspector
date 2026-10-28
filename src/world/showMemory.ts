/**
 * The filter menu, remembered between visits — in this browser, for this world.
 *
 * The SHOW layers plus the three menu toggles that sit with them (names,
 * spread, frame). Like the field store this is display state only: which layers
 * someone left showing says nothing about the world, so it lives in the browser
 * next to the field rather than on the host.
 *
 * Keyed by world **without** revision. A filter names a layer — a stable
 * concept — not a tuple id, so a rebuild does not retire what it means. A new
 * revision keeps the person's filters and drops their field, which is the
 * honest split: the arrangement addressed claims that may be gone, while
 * "mechanical overwhelms me" is still true.
 */

import { SHOW_DEFAULT, SHOW_LAYERS, type ShowLayer, type ShowState } from "./show";

const STORAGE_PREFIX = "worldir.show";

/** The filter menu as one flat record. */
export type StoredShowPrefs = {
  show: ShowState;
  namedAtRest: boolean;
  spreadOnSelect: boolean;
  framing: boolean;
};

type StoredShow = {
  version: 1;
  world: string;
} & StoredShowPrefs;

function keyOf(world: string): string {
  return `${STORAGE_PREFIX}:${world}`;
}

/** Put the filter menu away. */
export function writeShow(world: string, prefs: StoredShowPrefs): void {
  try {
    const stored: StoredShow = { version: 1, world, ...prefs };
    window.localStorage.setItem(keyOf(world), JSON.stringify(stored));
  } catch {
    // Same as the field store: private mode or quota means the menu lives in
    // the tab only. It is still on screen; it just will not outlive it.
  }
}

/**
 * Take the filter menu back out, or nothing.
 *
 * Anything unreadable is nothing rather than a guess — a half-understood
 * filter would hide a layer the person never hid, which reads as the world
 * going quiet rather than a preference failing to load.
 */
export function readShow(world: string): StoredShowPrefs | null {
  try {
    const raw = window.localStorage.getItem(keyOf(world));
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<StoredShow>;
    if (stored.version !== 1 || stored.world !== world) return null;
    if (!stored.show || typeof stored.show !== "object") return null;
    const show = { ...stored.show };
    // Older version-1 records predate this category. A mechanical preference
    // was never a choice about unstated material; preserve it independently.
    if (show.unstated === undefined) show.unstated = SHOW_DEFAULT.unstated;
    for (const layer of SHOW_LAYERS) {
      if (typeof (show as Record<ShowLayer, unknown>)[layer] !== "boolean") {
        return null;
      }
    }
    if (
      typeof stored.namedAtRest !== "boolean" ||
      typeof stored.spreadOnSelect !== "boolean" ||
      typeof stored.framing !== "boolean"
    ) {
      return null;
    }
    return {
      show: show as ShowState,
      namedAtRest: stored.namedAtRest,
      spreadOnSelect: stored.spreadOnSelect,
      framing: stored.framing,
    };
  } catch {
    return null;
  }
}

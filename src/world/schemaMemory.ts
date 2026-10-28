/**
 * The vocabulary arrangement, remembered between visits — in this browser, for
 * this world.
 *
 * Where the kind discs and relation plates stand after someone dragged them.
 * Display state only, like the field store: it says nothing about the world,
 * so it lives in the browser next to the field rather than on the host.
 *
 * Keyed by world **and revision**, on the field store's argument: a vocabulary
 * id means something only within the revision it was read from, and a rebuild
 * can retire or rename a relation. A new revision starts from the laid-out
 * vocabulary rather than from dragged positions for marks that may be gone.
 */

import type { Point } from "./workingSet";

const STORAGE_PREFIX = "worldir.schema";

/** How the arrangement looks flattened. */
type StoredSchema = {
  version: 1;
  world: string;
  revision: number;
  positions: [string, Point][];
};

function keyOf(world: string, revision: number): string {
  return `${STORAGE_PREFIX}:${world}:${revision}`;
}

/**
 * Put the vocabulary arrangement away.
 *
 * An empty arrangement clears the slot rather than storing emptiness, so a
 * vocabulary dragged back to nothing — or never dragged — leaves no slot for
 * the next visit to mistake for an arrangement.
 */
export function writeSchemaPositions(
  world: string,
  revision: number,
  positions: Map<string, Point>,
): void {
  try {
    const key = keyOf(world, revision);
    if (!positions.size) {
      window.localStorage.removeItem(key);
      return;
    }
    const stored: StoredSchema = {
      version: 1,
      world,
      revision,
      positions: [...positions],
    };
    window.localStorage.setItem(key, JSON.stringify(stored));
  } catch {
    // Same as the field store: private mode or quota means the arrangement
    // lives in the tab only.
  }
}

/**
 * Take the vocabulary arrangement back out, or nothing.
 *
 * Anything unreadable is nothing rather than a guess. Entries that are not a
 * pair of numbers are dropped while the rest still restore — a mark that was
 * never put anywhere is placed by arrival, which is the recoverable outcome.
 */
export function readSchemaPositions(
  world: string,
  revision: number,
): Map<string, Point> | null {
  try {
    const raw = window.localStorage.getItem(keyOf(world, revision));
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<StoredSchema>;
    if (
      stored.version !== 1 ||
      stored.world !== world ||
      stored.revision !== revision ||
      !Array.isArray(stored.positions)
    ) {
      return null;
    }
    const positions = new Map<string, Point>();
    for (const [id, at] of stored.positions) {
      if (typeof id === "string" && Number.isFinite(at?.x) && Number.isFinite(at?.y)) {
        positions.set(id, at);
      }
    }
    return positions.size ? positions : null;
  } catch {
    return null;
  }
}

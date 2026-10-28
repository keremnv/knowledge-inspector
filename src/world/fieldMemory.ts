/**
 * The field, remembered between visits — in this browser, for this world.
 *
 * A field is not a view of the World. It is a subgraph a person built by
 * asking for things one expansion at a time, and then arranged by hand: the
 * expensive part is not the fetching, it is the reading and the dragging. Until
 * now a reload threw all of it away, which made the canvas a place you visited
 * rather than a place you kept work in.
 *
 * What is stored is display state, and only display state — which marks someone
 * put on the field and where they stand. **It cannot change a claim.** Every
 * tuple in here was read out of the compiled world and is re-read from it on
 * the next visit; nothing restored from this store is evidence of anything, and
 * the world is still the only thing that says what is true. That is also why it
 * lives in the browser rather than on the host: this describes one screen, not
 * one operator — the same argument the panel sizes in `WorldResize` and the
 * sibling `worldir.*` stores keep.
 *
 * Keyed by world **and revision**. A field is a set of assertion ids, and an
 * assertion id means something only within the revision it was read from — a
 * rebuild can retire a tuple, and restoring a mark for one would be the surface
 * asserting something the world no longer does. A new revision therefore starts
 * from an empty field rather than from a plausible-looking old one.
 *
 * Key scheme — everything this surface keeps in the browser:
 *
 * - `worldir.field:<world>:<revision>` — this store: the field's marks and
 *   where they stand.
 * - `worldir.show:<world>` — `showMemory`: the filter menu. No revision:
 *   layers are stable concepts, so filters survive a rebuild.
 * - `worldir.schema:<world>:<revision>` — `schemaMemory`: the vocabulary
 *   arrangement.
 * - `worldir.camera:<room>:<world>:<revision>` — `cameraMemory`: each room's
 *   camera, which frames a revision-scoped arrangement.
 * - `worldir.frames:<world>:<revision>` — `frameAnswers`: frame answers,
 *   facts about the revision, so a framed field comes back framed.
 * - `ontology-author.worldReaderWidth`, `ontology-author.worldFrontierWidth`
 *   — `WorldResize`: panel sizes. Global: chrome, not content.
 *
 * The scoping rule: state that addresses content ids carries the revision,
 * and a rebuild retires it. State that addresses stable concepts (layers) or
 * chrome does not. Every store is versioned and fails to nothing — anything
 * unreadable restores as if it were never kept.
 */

import {
  emptySet,
  type FieldAssertion,
  type FieldBond,
  type FieldDemand,
  type FieldReferent,
  type Point,
  type WorkingSet,
} from "./workingSet";

const STORAGE_PREFIX = "worldir.field";

/** How the working set looks with its Maps and Sets flattened. */
type StoredField = {
  version: 1;
  world: string;
  revision: number;
  referents: [string, FieldReferent][];
  assertions: [string, FieldAssertion][];
  demands: [string, FieldDemand][];
  bonds: FieldBond[];
  positions: [string, Point][];
  /**
   * Paint depth, newest writer only. Optional so a field put away before
   * depth existed still comes back — with an empty stack, which paints
   * exactly the creation order it always did. Values put away as bare drop
   * counts come back verbatim and are re-homed to dense ranks on first
   * paint — see `paintDepths` — so the order survives the format.
   */
  depth?: [string, number][];
  expanded: string[];
};

function keyOf(world: string, revision: number): string {
  return `${STORAGE_PREFIX}:${world}:${revision}`;
}

/**
 * Put the field away.
 *
 * An empty field clears the slot rather than storing emptiness, so "take
 * everything off and go back to the vocabulary" is a thing that persists too —
 * otherwise the next visit would restore a field the person had just cleared.
 */
export function writeField(
  world: string,
  revision: number,
  set: WorkingSet,
): void {
  try {
    const key = keyOf(world, revision);
    if (!set.referents.size && !set.assertions.size && !set.demands.size) {
      window.localStorage.removeItem(key);
      return;
    }
    const stored: StoredField = {
      version: 1,
      world,
      revision,
      referents: [...set.referents],
      assertions: [...set.assertions],
      demands: [...set.demands],
      bonds: set.bonds,
      positions: [...set.positions],
      depth: [...set.depth],
      expanded: [...set.expanded],
    };
    window.localStorage.setItem(key, JSON.stringify(stored));
  } catch {
    // Private-mode browsers refuse writes, and a large field can exceed the
    // quota. Either way the field is still on screen; it just will not outlive
    // the tab.
  }
}

/**
 * Take the field back out, or nothing.
 *
 * Anything unreadable — absent, malformed, written by a version of this module
 * that stored a different shape — is nothing rather than a guess. A field
 * assembled from half-understood JSON would put marks on the canvas that no
 * longer mean what they claim to.
 */
export function readField(world: string, revision: number): WorkingSet | null {
  try {
    const raw = window.localStorage.getItem(keyOf(world, revision));
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<StoredField>;
    if (
      stored.version !== 1 ||
      stored.world !== world ||
      stored.revision !== revision ||
      !Array.isArray(stored.referents) ||
      !Array.isArray(stored.assertions) ||
      !Array.isArray(stored.demands) ||
      !Array.isArray(stored.bonds) ||
      !Array.isArray(stored.positions) ||
      !Array.isArray(stored.expanded)
    ) {
      return null;
    }
    const set = emptySet();
    for (const [id, referent] of stored.referents) set.referents.set(id, referent);
    for (const [id, assertion] of stored.assertions) set.assertions.set(id, assertion);
    for (const [key, demand] of stored.demands) set.demands.set(key, demand);
    set.bonds = stored.bonds;
    /**
     * A place has to be a pair of numbers.
     *
     * Anything else is dropped rather than restored, and the mark is placed by
     * arrival like one that was never put anywhere — which is the recoverable
     * outcome. Restoring it hands the renderer a position it cannot resolve,
     * and a mark whose transform will not resolve is invisible, unhittable,
     * and gets written back over the good copy on the next harvest.
     */
    for (const [id, at] of stored.positions) {
      if (Number.isFinite(at?.x) && Number.isFinite(at?.y)) set.positions.set(id, at);
    }
    // A finite number or it is not one; anything else is dropped and the
    // mark paints in creation order, the recoverable outcome. Legacy drop
    // counts pass through untouched — order is order, whatever the scale,
    // and paint re-homes them.
    if (Array.isArray(stored.depth)) {
      for (const [id, depth] of stored.depth) {
        if (typeof id === "string" && Number.isFinite(depth)) set.depth.set(id, depth);
      }
    }
    for (const key of stored.expanded) set.expanded.add(key);
    return set.referents.size ? set : null;
  } catch {
    return null;
  }
}

/**
 * Whether this browser is holding a field at all — a hint, read at mount.
 *
 * The surface has to choose what to paint before it knows which world it is
 * opening: the world's id and revision arrive with the overview, one network
 * round trip later, and the real restore cannot happen until then. Painting
 * the wrong screen for that half second is what a person sees as the surface
 * flipping on its own — the ground going dark and then light again while they
 * watch.
 *
 * So this answers the only question the first paint needs: *is there a field
 * to come back to?* It does not say which, and it decides nothing. `readField`
 * is still the authority, keyed by world and revision, and still refuses a
 * field written for another revision — this only chooses which screen is
 * showing while that runs, and a wrong guess costs exactly the flip it was
 * meant to save.
 */
export function holdsField(): boolean {
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(`${STORAGE_PREFIX}:`)) return true;
    }
  } catch {
    // No storage to read is the same answer as no field in it.
  }
  return false;
}

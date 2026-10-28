/**
 * Frame answers, remembered between visits — in this browser, for this world.
 *
 * Whether a referent takes part in every tuple of a relation is a fact about
 * the world, asked over the network per candidate — and before the answers
 * arrive the field draws unframed, so a framed field came back visibly wrong
 * for the round trip and then snapped into its frame. The answers do not
 * change within a revision, so keeping them makes the next visit's first
 * frame the framed one, with no fetch at all for candidates asked before.
 *
 * Keyed by world **and revision**, on the field store's argument: a rebuild
 * can change what a referent takes part in. Display-adjacent but
 * content-derived — it lives in the browser because it describes one screen's
 * standing questions, and a new revision starts unanswered rather than
 * plausibly wrong.
 */

const STORAGE_PREFIX = "worldir.frames";

/** How the answer cache looks flattened: candidate id, ambient relations. */
type StoredFrames = {
  version: 1;
  world: string;
  revision: number;
  answers: [string, string[]][];
};

function keyOf(world: string, revision: number): string {
  return `${STORAGE_PREFIX}:${world}:${revision}`;
}

/**
 * Take the answer cache back out, or an empty one.
 *
 * Anything unreadable is an empty cache rather than nothing: a miss only
 * costs the fetch it always cost, so unlike the arrangement stores there is
 * no wrong restore to refuse — the frame just arrives a round trip later,
 * the way it did before anything was kept.
 */
export function readFrameAnswers(
  world: string,
  revision: number,
): Map<string, Set<string>> {
  const empty = new Map<string, Set<string>>();
  try {
    const raw = window.localStorage.getItem(keyOf(world, revision));
    if (!raw) return empty;
    const stored = JSON.parse(raw) as Partial<StoredFrames>;
    if (
      stored.version !== 1 ||
      stored.world !== world ||
      stored.revision !== revision ||
      !Array.isArray(stored.answers)
    ) {
      return empty;
    }
    const answers = new Map<string, Set<string>>();
    for (const [id, names] of stored.answers) {
      if (typeof id !== "string" || !Array.isArray(names)) continue;
      answers.set(
        id,
        new Set(names.filter((name): name is string => typeof name === "string")),
      );
    }
    return answers;
  } catch {
    return empty;
  }
}

/**
 * Put the answer cache away, whole.
 *
 * Written per answer, not debounced: answers arrive once per candidate, not
 * at gesture rate, and a tab closed mid-burst keeps what it learned rather
 * than refetching it next visit.
 */
export function writeFrameAnswers(
  world: string,
  revision: number,
  known: ReadonlyMap<string, Set<string>>,
): void {
  try {
    const stored: StoredFrames = {
      version: 1,
      world,
      revision,
      answers: [...known].map(([id, names]) => [id, [...names]]),
    };
    window.localStorage.setItem(keyOf(world, revision), JSON.stringify(stored));
  } catch {
    // Same as the arrangement stores: private mode or quota means the cache
    // lives in the tab only, and the next visit asks again.
  }
}

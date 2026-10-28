/**
 * Which end of a filament its name stands at.
 *
 * A name appears because a person is looking at one of the two marks it joins,
 * and it stands a fixed distance from *that* mark. That is the whole rule, and
 * it is a question each filament answers about its own two ends. Nothing else
 * on the field has standing to answer it.
 *
 * It used to be answered globally: one anchor for the whole canvas, and every
 * filament asked "is the field's anchor one of my ends?". Most of the time the
 * answer was no — you were pointing at something else entirely — and a filament
 * that answered no had no end to measure from, so it fell to the midpoint of
 * its own stroke. Measured on a 30-mark field, pointing at one referent moved
 * the names on filaments it shares no mark with, out to their midpoints and
 * back again on release. The midpoint was never a resting position; it was the
 * value a filament got for being asked a question about somebody else.
 *
 * So the resolver takes a filament and its two ends, and reads no further.
 */

/**
 * The end a name measures from. Total: every filament always has one.
 *
 * There is deliberately no "none" here. The absent case is what produced the
 * midpoint — a filament with no end to measure from fell back to a ratio of
 * its own stroke — and it is also wrong on the way out: a name that is fading
 * because you looked away must fade *where it stands*, not slide somewhere
 * else while it goes. A filament nobody is looking at keeps the last station
 * it had, which costs nothing, because nobody is looking at it.
 */
export type Station = "source" | "target";

export type StationSubjects = {
  /** The mark under the pointer, if any. Ungated by press: see `holdsUnderLoad`. */
  hovered: string | null;
  /** The mark a person chose, which outlives the pointer moving away. */
  selected: string | null;
};

/**
 * What each filament last measured from, keyed by the assertion it draws.
 *
 * Only one clause reads it — see `bondStation` — and it exists because G6
 * retargets hover from a disc to the plate as the pointer crosses onto a name.
 * Pointing at a name must not restation the name.
 *
 * Per filament, not one latch for the field. A single latch went stale the
 * moment the pointer moved to unrelated matter, and then spoke for filaments
 * it had never been about.
 */
export type StationMemory = Map<string, "source" | "target">;

/**
 * Whether the pointer is on this filament's own name, or a sibling's.
 *
 * Parallel claims share a stroke and a count, so pointing at any of them is
 * pointing at all of them: the group opens as one and it must not restation
 * as several.
 */
function pointingAtOwnName(
  hovered: string,
  bond: { source: string; target: string },
  siblingsOf: (assertionId: string) => { source: string; target: string } | null,
): boolean {
  const at = siblingsOf(hovered);
  if (!at) return false;
  return (
    (at.source === bond.source && at.target === bond.target) ||
    (at.source === bond.target && at.target === bond.source)
  );
}

/**
 * The end a bond's name stands at.
 *
 * Order is the rule's meaning. Hover outranks selection because the pointer is
 * the more recent act, and dropping the hover falls straight through to the
 * selection clause — which is why a name returns to the selected mark when the
 * pointer leaves, without anything having to remember that it should.
 *
 * `remember` is written on every clause that resolves from an actual subject,
 * and read on none of them. Only the pointing-at-the-name clause reads it.
 */
export function bondStation(
  bond: { source: string; target: string },
  subjects: StationSubjects,
  memory: StationMemory,
  key: string,
  siblingsOf: (assertionId: string) => { source: string; target: string } | null,
  fallback: Station,
): Station {
  const settle = (end: Station): Station => {
    memory.set(key, end);
    return end;
  };
  const { hovered, selected } = subjects;
  if (hovered !== null) {
    if (hovered === bond.source) return settle("source");
    if (hovered === bond.target) return settle("target");
    if (pointingAtOwnName(hovered, bond, siblingsOf)) {
      // Held, not resolved: the pointer is on the name, and a name does not
      // move because you looked at it. Selection still answers if this
      // filament has never been stationed.
      const held = memory.get(key);
      if (held) return held;
      if (selected === bond.source) return settle("source");
      if (selected === bond.target) return settle("target");
      return settle(fallback);
    }
  }
  if (selected === bond.source) return settle("source");
  if (selected === bond.target) return settle("target");
  // Nobody is looking at either end, so this name is not shown. Hold where it
  // stood rather than resolve somewhere new — a name on its way out must not
  // travel while it fades. No `settle`: nothing acted, so nothing is recorded.
  return memory.get(key) ?? fallback;
}

/**
 * The end a spoke's name stands at.
 *
 * No held clause. A spoke runs from a referent to a plate, so the plate the
 * pointer crosses onto genuinely *is* one of its two ends, and the hover that
 * retargets there is a hover on the spoke's own end rather than beside it.
 */
export function spokeStation(
  spoke: { source: string; target: string },
  subjects: StationSubjects,
  memory: StationMemory,
  key: string,
): Station {
  const settle = (end: Station): Station => {
    memory.set(key, end);
    return end;
  };
  const { hovered, selected } = subjects;
  if (hovered === spoke.source) return settle("source");
  if (hovered === spoke.target) return settle("target");
  if (selected === spoke.source) return settle("source");
  if (selected === spoke.target) return settle("target");
  // Held on the way out, for the same reason a bond's name is. A role name
  // reads from its referent, so that is where one starts.
  return memory.get(key) ?? "source";
}

/**
 * The end a filament falls back to before anyone has acted on either of them.
 *
 * The relation's first referent role, which `FieldBond.spokes` already carries
 * in role order. A resting position that follows the vocabulary means the same
 * relation always reads from the same side, which is a fact about the world
 * rather than about who happened to point at what first.
 */
export function defaultStation(bond: {
  source: string;
  spokes: { id: string }[];
}): Station {
  const first = bond.spokes[0]?.id;
  return first === undefined || first === bond.source ? "source" : "target";
}

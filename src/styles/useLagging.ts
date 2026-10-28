/**
 * Reading: what the surface shows while a read is outstanding.
 *
 * Loading has been fixed one flash at a time — a placeholder here, a gate
 * there — and every fix held only its own site, because there was no stated
 * system for the next site to follow. These are the laws; `useLagging` is the
 * primitive that keeps the first of them.
 *
 * 1. Hold what is true. A subject change keeps the old content mounted until
 *    the new content is ready, and the exchange is then one `Swap` — old out,
 *    new in, nothing between. The canvas, the dock and every control stay
 *    live; only the column lags, by the length of the read.
 *
 * 2. A first read says so. With nothing true to hold — a first open, a new
 *    table, boot — the slot carries one line in its own voice: "Reading …".
 *    Never a skeleton, never a spinner: a read is a lookup, and
 *    `STILL_RULES.nothingIsIndeterminate` says nothing on the read plane is
 *    indeterminate.
 *
 * 3. Nothing claims what it does not know. No zero for an unanswered count,
 *    no "no X" before the settled answer, no "not loaded" while loading.
 *    RelationTable's `pages.has(0)` gate is the pattern: emptiness is a
 *    verdict on an answer, never the absence of rows.
 *
 * 4. Controls speak. A busy control flips its own label to its verb —
 *    `loading`, `adding… n / total` — carries `aria-busy`, and holds its
 *    size. No overlay; the control says what it is doing.
 *
 * 5. Arrivals emit; rows don't. Content landing in a slot emits on the spine;
 *    windowed rows ticking into a table are not arrivals (`rowsNeverFly`).
 *
 * 6. Reads read; writes wait. Waiting-with-a-status is for writes
 *    (`attention`); a read names its lookup and gets on with it.
 *
 * Every read ends in one of three states — content, empty, or failure — and
 * says which. An indefinite "Reading …" is a missing branch, not patience.
 */

import { useState } from "react";

/**
 * The shown value lags its target until the target is ready to be shown.
 *
 * `ready` names the moment: the detail has landed, the document has settled,
 * the read has failed — whatever "there is now something true to draw" means
 * for this slot. It takes what is showing as well as what is wanted, so a
 * first read can advance at once (law 2) while a subject change holds (law 1).
 *
 * A render-phase update, so the new subject is already showing on this pass —
 * see `Swap` for the pattern. The guard flips the moment the set lands, so
 * this terminates.
 */
export function useLagging<T>(
  target: T,
  ready: (target: T, shown: T) => boolean,
  equal: (a: T, b: T) => boolean,
): T {
  const [shown, setShown] = useState(target);
  if (ready(target, shown) && !equal(shown, target)) setShown(target);
  return shown;
}

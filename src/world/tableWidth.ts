/**
 * How much room a table has, in the two sizes its columns are written for.
 *
 * The dock is resizable, and at its narrow end the catalogue's four qualifier
 * columns took 268px of a 360px panel and left the relation name 42px — every
 * name printed as `chec…`, which is the one thing a catalogue exists to show.
 * Proportional shares do not fix that on their own: `tuples`, `construction`
 * and `mechanical` are simply longer than the space they are being given, so
 * `minmax(0, …)` clips them, and a clipped word costs the same room as the
 * whole one while saying less.
 *
 * So something has to say a *shorter true thing* rather than a clipped one,
 * and that is a choice of vocabulary rather than of geometry. This is the
 * measurement that choice hangs off.
 *
 * A measurement and not a media query, because the panel is not the viewport:
 * the dock is dragged to a width of its own while the window stays put. The
 * same reason `observeHostSize` exists for the canvases, and it is reused
 * here rather than re-derived — including its behaviour during a live panel
 * drag, so a table does not re-flow on every frame of a resize.
 */

import { useEffect, useState, type RefObject } from "react";
import { observeHostSize } from "./canvasHost";

export type TableWidth = "wide" | "narrow";

/**
 * Where the catalogue stops fitting its own words.
 *
 * Measured, not chosen: with the wide columns, `construction` is the first
 * header to clip, and it does so just under 460px of table. Below this the
 * table uses the short vocabulary; above it, the full one.
 */
export const TABLE_NARROW_PX = 460;

export function useTableWidth(ref: RefObject<HTMLElement | null>): TableWidth {
  const [width, setWidth] = useState<TableWidth>("wide");
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    return observeHostSize(host, (measured) => {
      setWidth(measured < TABLE_NARROW_PX ? "narrow" : "wide");
    });
  }, [ref]);
  return width;
}

/**
 * A snake_case identifier shortened so that what distinguishes it survives.
 *
 * Role names are data, not a closed vocabulary, so the catalogue's trick —
 * swap a long word for a known short one — is not available. What is available
 * is where the information sits. `earlier_action` and `earlier_serial_set`
 * clipped from the right both print `earlier…`: two columns, the same header,
 * and the reader cannot tell which is which. They differ in their *tails*.
 *
 * So the leading segments give way first, to their initials, and the last
 * segment is kept whole: `e_action` and `e_serial_set`. Nothing is invented —
 * every character shown is a character of the name, in its own order — and the
 * part a person is reading the header to find is the part that is never cut.
 *
 * A single-segment name has nothing to give and is returned as it is; clipping
 * is then the honest outcome, and the full name is on the `title`.
 */
export function shortenIdentifier(name: string, budget = 12): string {
  if (name.length <= budget) return name;
  const parts = name.split("_");
  if (parts.length < 2) return name;
  for (let cut = 1; cut < parts.length; cut += 1) {
    const said = [
      ...parts.slice(0, cut).map((part) => part.slice(0, 1)),
      ...parts.slice(cut),
    ].join("_");
    if (said.length <= budget) return said;
  }
  return [
    ...parts.slice(0, -1).map((part) => part.slice(0, 1)),
    parts[parts.length - 1],
  ].join("_");
}

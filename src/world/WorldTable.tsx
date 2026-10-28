/**
 * The world's own catalogue — idle body of the TABLES dock.
 *
 * Overview counts belong in the bar (what this world is). Rows are relations:
 * name, size, scope, mode, construction origin, stale. Clicking one opens that
 * relation's extension in the same panel. The frontier is a sibling subject,
 * not a row, because unresolved is not a property of the world.
 *
 * Scope is a column rather than a canvas mark. WORLD and PURPOSE are what a
 * relation is *for*, which is neither an origin (geometry) nor a status
 * (palette), and the canvas has no free axis left to say it in. A word in a
 * table says it exactly, and a blank says the world recorded no admission —
 * which is different from, and must not be drawn as, WORLD.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { WorldOverview, WorldRelation } from "../api/world";
import { ReadingAttribution, shownMode, shownRevision } from "./ReadingAttribution";
import { still } from "../styles/motion";
import { useRowWindow } from "./rowWindow";
import { chipKind } from "./schemaGraph";
import { TableBar, TableFooter, TableSearch, type TableChrome } from "./tableChrome";
import { useTableWidth, type TableWidth } from "./tableWidth";

// Retained for a future placement-filter control; currently unwired.
const PLACEMENT_FILTER_ENABLED = false;

const ROW_HEIGHT = 26;
const OVERSCAN = 8;
/**
 * The name is the row; everything else qualifies it.
 *
 * Four fixed columns totalling 268px inside a 360px dock left the relation
 * about 42px — every name in the catalogue printed as `chec…`, which is the
 * one thing a catalogue exists to show. The qualifiers hold single short words
 * (`world`, `base`, `mechanical`) and give way proportionally; only the count
 * and the stale mark, which are a number and a five-letter word, stay fixed.
 */
/**
 * The short vocabulary, and the rule for it.
 *
 * Every one of these is a real abbreviation of a closed vocabulary — the
 * values are `MECHANICAL | SEMANTIC | DERIVED | ADJUDICATED` and
 * `BASE | DERIVED`, so `mech` cannot be mistaken for a different word the way
 * a clipped `mechan…` can be mistaken for nothing at all. The full word stays
 * on the element's `title`, so the long form is always one hover away.
 *
 * `n` for a count is the one that is not an abbreviation but a convention, and
 * it is the right one: the column is a number, and the header only has to say
 * which number.
 */
const SHORT: Record<string, string> = {
  mechanical: "mech",
  semantic: "sem",
  adjudicated: "adjud",
  derived: "deriv",
  purpose: "purp",
};

const HEADINGS = {
  wide: { count: "tuples", construction: "construction", stale: "stale" },
  narrow: { count: "n", construction: "constr.", stale: "stale" },
} satisfies Record<TableWidth, Record<string, string>>;

/** The short form when there is one and the table is narrow; the word itself otherwise. */
function say(word: string, width: TableWidth): string {
  return width === "narrow" ? (SHORT[word] ?? word) : word;
}

export function WorldTable({
  neutral = false,
  overview,
  relations,
  complete,
  chrome,
  onOpen,
  onClearField,
  clearable,
  onField,
  onTakeOffRelation,
}: {
  /** Fully neutral world: the universally-BASE mode column is omitted. */
  neutral?: boolean;
  overview: WorldOverview | null;
  relations: WorldRelation[];
  /** Relations standing on the field in full — every tuple placed. */
  complete: Set<string>;
  chrome: TableChrome;
  onOpen: (name: string) => void;
  /** The whole field, emptied — the top level's only bulk action. */
  onClearField: () => void;
  /** Whether the field holds anything for clear to take off. */
  clearable: boolean;
  /** Relations with anything standing on the field — the rows that can take off. */
  onField: Set<string>;
  /** Everything of the named relation, off the field. */
  onTakeOffRelation: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [placement, setPlacement] = useState("all");
  // Placement needs a referent to anchor to (workingSet.place).
  const rows = useMemo(() => relations.filter((item) => {
    const placeable = item.roles.some((role) => role.referent);
    return (!PLACEMENT_FILTER_ENABLED || placement === "all" || placeable === (placement === "placeable"))
      && item.name.toLowerCase().includes(query.trim().toLowerCase());
  }), [relations, query, placement]);
  const frame = useRef<HTMLElement>(null);
  const width = useTableWidth(frame);
  const heading = HEADINGS[width];
  // Compatibility columns exist only where the world supplies them: a
  // column that is empty on every row is not information, and printing
  // its vocabulary (scope, construction origin, stale) into a neutral
  // world would promote compatibility metadata into a classification.
  const showScope = relations.some((item) => item.scope);
  const showConstruction = relations.some((item) => chipKind(item) !== "unstated");
  const showStale = relations.some((item) => item.stale);
  const columnWidths: Record<string, { wide: string; narrow: string }> = {
    scope: { wide: "minmax(0, 0.7fr)", narrow: "minmax(0, 0.62fr)" },
    mode: { wide: "minmax(0, 0.7fr)", narrow: "minmax(0, 0.6fr)" },
    construction: { wide: "minmax(0, 0.95fr)", narrow: "minmax(0, 0.66fr)" },
    stale: { wide: "40px", narrow: "30px" },
  };
  // The generic bridge's BASE is its default, not a recorded mode: a verified
  // reading prints a mode column only if some relation has another value.
  const showMode =
    (!neutral || relations.some((item) => item.mode !== "BASE")) &&
    relations.some((item) => shownMode(overview?.reading, item.mode) !== null);
  const visibleColumns = [
    ...(showScope ? ["scope"] : []),
    ...(showMode ? ["mode"] : []),
    ...(showConstruction ? ["construction"] : []),
    ...(showStale ? ["stale"] : []),
  ];
  const columns =
    width === "wide"
      ? ["minmax(0, 1.9fr)", "44px", ...visibleColumns.map((col) => columnWidths[col].wide)].join(" ")
      : ["minmax(0, 2.6fr)", "46px", ...visibleColumns.map((col) => columnWidths[col].narrow)].join(" ");
  const window_ = useRowWindow(rows.length, ROW_HEIGHT, OVERSCAN);
  const { reset } = window_;
  useEffect(reset, [query, reset]);
  const meta = useMemo(() => {
    if (!overview) return "Reading world";
    const bits = [
      `${overview.relations} relation${overview.relations === 1 ? "" : "s"}`,
      `${overview.referents} referent${overview.referents === 1 ? "" : "s"}`,
    ];
    // Revision 1 of the generic bridge is its default, not a recorded revision.
    if (shownRevision(overview.reading, overview.revision) !== null) bits.push(`rev ${overview.revision}`);
    if (overview.stale.length) bits.push(`${overview.stale.length} stale`);
    return bits.join(" · ");
  }, [overview]);

  return (
    <section
      className="table"
      aria-label="world relations"
      ref={frame}
      data-width={width}
    >
      <TableBar chrome={chrome} meta={meta} />
      <TableSearch value={query} onChange={setQuery} label="Search relations" />
      <ReadingAttribution reading={overview?.reading} />
      {PLACEMENT_FILTER_ENABLED && <div className="table__filters">
        <label>Field placement <select aria-label="Field placement" value={placement}
          onChange={(event) => setPlacement(event.target.value)}>
          <option value="all">All relations</option>
          <option value="placeable">Can place on field</option>
          <option value="other">Cannot place on field</option>
        </select></label>
        <span role="status">{rows.length} of {relations.length}</span>
      </div>}
      {query && !rows.length ? <p className="table__empty">No relations match this search.</p> : null}
      <div className="table__head" style={{ gridTemplateColumns: columns }}>
        <span>relation</span>
        <span title="tuples">{heading.count}</span>
        {showScope ? <span>scope</span> : null}
        {showMode ? <span>mode</span> : null}
        {/* `chipKind` is construction origin (mechanical/semantic/adjudicated),
            not `_world_assertions.origin` (asserted/derived) — bare "origin" sat
            one column from "mode", which can itself read "derived". Same word
            for two axes on one row; see styles/vocabulary.md §4. */}
        {showConstruction ? <span title="construction origin">{heading.construction}</span> : null}
        {showStale ? <span>{heading.stale}</span> : null}
      </div>
      <div
        className="table__scroll"
        ref={window_.ref}
        onScroll={window_.onScroll}
        onKeyDown={window_.onKeyDown}
        role="region"
        aria-label="Relation catalogue rows"
        tabIndex={window_.scrollable ? 0 : undefined}
      >
        <div
          className="table__spacer"
          style={{ height: rows.length * ROW_HEIGHT }}
        >
          {window_.indices.map((index) => {
            const item = rows[index];
            if (!item) return null;
            return (
              <div
                key={item.name}
                className="table__row"
                {...still("rowsNeverFly")}
                data-loaded
                data-present={complete.has(item.name) || undefined}
                style={{
                  top: index * ROW_HEIGHT,
                  height: ROW_HEIGHT,
                  gridTemplateColumns: columns,
                }}
                role="button"
                tabIndex={0}
                title={
                  onField.has(item.name)
                    ? `Right-click takes every row of ${item.name} off the field`
                    : undefined
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onOpen(item.name);
                  }
                }}
                onClick={() => onOpen(item.name)}
                // The canvas idiom, in the catalogue: a right-button press on
                // a mark takes it off the field at once. Only where there is
                // something to take off — otherwise the native menu is left
                // alone, so copy and inspect keep working on quiet rows.
                onContextMenu={
                  onField.has(item.name)
                    ? (event) => {
                        event.preventDefault();
                        onTakeOffRelation(item.name);
                      }
                    : undefined
                }
              >
                <span title={item.name}>{item.name}</span>
                <span title={`${item.count}`}>{item.count}</span>
                {showScope ? (
                  <span
                    className="table__origin"
                    title={item.scope ? item.scope.toLowerCase() : undefined}
                  >
                    {item.scope ? say(item.scope.toLowerCase(), width) : "—"}
                  </span>
                ) : null}
                {showMode ? (
                  <span
                    className="table__origin"
                    title={shownMode(overview?.reading, item.mode) ?? undefined}
                  >
                    {say(shownMode(overview?.reading, item.mode) ?? "", width)}
                  </span>
                ) : null}
                {showConstruction ? (
                  <span className="table__origin" title={chipKind(item)}>
                    {say(chipKind(item), width)}
                  </span>
                ) : null}
                {showStale ? (
                  <span className="table__origin">
                    {item.stale ? "stale" : ""}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      <TableFooter>
        <button
          type="button"
          onClick={onClearField}
          disabled={!clearable}
          title="Clear the field"
        >
          clear
        </button>
      </TableFooter>
    </section>
  );
}

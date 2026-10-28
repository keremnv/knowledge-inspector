/**
 * A relation's extension, as a table.
 *
 * §11: do not choose between graph and table. The canvas holds neighborhoods —
 * a few dozen marks someone arranged to think with — and the table holds
 * extensions, which at this world's largest relation is thousands of tuples and
 * at a real one will be more. They are two projections of one relation state,
 * and the seam between them is a row: selecting one places its tuple on the
 * field, and a tuple already on the field is marked in the margin here. That is
 * the whole of the two-way binding, and it is enough.
 *
 * **Windowed, and paged from SQL.** Only the rows in view are in the DOM, and
 * only the pages the window has touched are in memory. The scroller is sized to
 * `total * ROW_HEIGHT` from the count the server already knows, so the bar is
 * honest about the size of the relation before a single row has arrived, and
 * scrolling to the middle of a ten-thousand-row relation fetches one page
 * rather than ten thousand rows. Rows not yet loaded draw as ruled blanks: the
 * table's shape never jumps as pages land.
 *
 * **Sorting is the database's.** Changing the order discards the buffer and
 * re-asks, because a sort applied to the pages you happen to hold is not a
 * sort. SQLite orders the largest relation here in well under a millisecond.
 *
 * No table library. What a grid needs is a fixed row height, a spacer, and a
 * slice — thirty lines that we control the type of — and what a library would
 * add on top is a second set of opinions about focus, keyboard and styling to
 * fight with the design language.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { worldApi, type WorldReading, type WorldRelation, type WorldRole, type WorldTuple } from "../api/world";
import { occurrenceChip } from "./occurrence";
import { still } from "../styles/motion";
import { ProblemNotice } from "./ProblemNotice";
import { useRowWindow } from "./rowWindow";
import { shortenIdentifier, useTableWidth } from "./tableWidth";
import { TableBar, TableFooter, TableSearch, type TableChrome } from "./tableChrome";
import { originsLabel } from "./show";
import { shownMode } from "./ReadingAttribution";
import { Scalar, scalarKind, scalarLabel, scalarTitle } from "./scalar";

/** Fixed, because a windowed table needs to know where a row is without asking. */
const ROW_HEIGHT = 26;
const PAGE = 200;
/** Rows drawn above and below the viewport, so a fast scroll is not a white gap. */
const OVERSCAN = 8;

type Order = { role: string; desc: boolean } | null;

export function RelationTable({
  relation,
  subject,
  present,
  onFocus,
  onTakeOff,
  onPlaceMany,
  onBulkActive,
  onClearRelation,
  clearable,
  onWiden,
  onDerivation,
  chrome,
  reading,
}: {
  relation: WorldRelation;
  /**
   * The referent this extension was opened from, if it was opened from one.
   *
   * A referent's panel offers a relation by *its* count — "offered_by 608" —
   * so a table that then showed the relation's whole 1,208 would be answering
   * a question nobody asked. The server narrows and counts; the header says
   * which of the two things you are looking at.
   */
  subject?: { id: string; label: string } | null;
  /** Assertion ids already on the field, so a row can say it is there. */
  present: Set<string>;
  onFocus: (roles: WorldRole[], tuple: WorldTuple) => void;
  /** One row off the field — a single take-off, so its context stays standing. */
  onTakeOff: (assertionId: string) => void;
  /** A page of rows, onto the field — the bulk half of the §11 seam. */
  onPlaceMany: (relation: string, roles: WorldRole[], tuples: WorldTuple[]) => void;
  /** A bulk arrival started or ended, so the canvas can draw its frames still. */
  onBulkActive: (active: boolean) => void;
  /** Everything of the named relation, off the field — the inverse of add all. */
  onClearRelation: (relation: string) => void;
  /** Whether the relation has anything on the field for clear to take off. */
  clearable: boolean;
  /** Drop the subject and read the whole extension. */
  onWiden: () => void;
  /** §8.6, from where you are actually standing when you want it. */
  onDerivation: () => void;
  chrome: TableChrome;
  /** The World's reading descriptor, when it has one: it says which values are adapter defaults. */
  reading?: WorldReading;
}) {
  const mode = shownMode(reading, relation.mode);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);
  const [order, setOrder] = useState<Order>(null);
  const [total, setTotal] = useState(subject ? 0 : relation.count);
  const [roles, setRoles] = useState<WorldRole[]>(relation.roles);
  const [pages, setPages] = useState<Map<number, WorldTuple[]>>(new Map());
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * Tuples placed by the in-flight add-all, or null when the footer is idle.
   *
   * The count is the loading state: the button reads `adding… n / total`
   * while it is non-null, which is the same idiom as the frontier footer
   * flipping to `loading` — no spinner, no overlay, the control says what it
   * is doing. There is deliberately no separate "done" state: the rows tick
   * into the margin as they land, and that is the confirmation.
   */
  const [added, setAdded] = useState<number | null>(null);
  /**
   * Which add-all run owns the `added` count. A search typed mid-run starts a
   * new table while the old run is still awaiting its page, and the old run's
   * `finally` must not blank the new run's count on its way out.
   */
  const addingToken = useRef(0);
  const frame = useRef<HTMLElement>(null);
  const width = useTableWidth(frame);
  const window_ = useRowWindow(total, ROW_HEIGHT, OVERSCAN);
  const { first, last, reset } = window_;
  /** Pages already asked for, so a scroll does not re-ask on every frame. */
  const asked = useRef(new Set<number>());

  /**
   * What the buffer currently holds rows *of*.
   *
   * A page index only means something under one relation in one order, so this
   * is what a landing response is checked against — and it is the whole reason
   * the fetch below has no cleanup. Cancelling in-flight pages when the effect
   * re-runs looks right and is wrong here, because the effect re-runs on every
   * scroll: the first page was being discarded the instant the ResizeObserver
   * reported the real height, and since `asked` already held the index it was
   * never requested again. The table came up empty above whatever page you
   * scrolled to. A response is stale only when the thing it is a page of has
   * changed, which is exactly this key.
   */
  const buffer = `${search}\u0000${relation.name}\u0000${subject?.id ?? ""}\u0000${order?.role ?? ""}\u0000${order?.desc ?? false}`;
  const bufferRef = useRef(buffer);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // A new relation or a new order is a new table: the buffer cannot survive
  // either, since a page index means nothing once the ordering under it moves.
  useEffect(() => {
    bufferRef.current = buffer;
    asked.current = new Set();
    setPages(new Map());
    setTotal(0);
    setProblem(null);
    reset();
  }, [buffer, reset]);

  // Fetch whatever page the window is standing on, and no other. `asked` is a
  // ref rather than state because wanting a page and holding it are different
  // facts, and only the second one should redraw anything.
  useEffect(() => {
    const wanted = new Set<number>();
    // A subject-narrowed table does not know its size until the first page
    // answers — the window is empty because `total` is zero, not because there
    // is nothing to read — so page zero is always worth one ask.
    if (!asked.current.has(0) && (!total || first === 0)) wanted.add(0);
    for (let page = Math.floor(first / PAGE); page <= Math.floor((last - 1) / PAGE); page += 1) {
      if (page >= 0 && !asked.current.has(page)) wanted.add(page);
    }
    if (!wanted.size) return;
    const asOf = buffer;
    const current = () => live.current && bufferRef.current === asOf;
    for (const page of wanted) {
      asked.current.add(page);
      worldApi
        .rows(relation.name, {
          search,
          limit: PAGE,
          offset: page * PAGE,
          order: order?.role ?? null,
          desc: order?.desc,
          subject: subject?.id ?? null,
        })
        .then((answer) => {
          if (!current()) return;
          setTotal(answer.total);
          setRoles(answer.roles);
          setPages((held) => new Map(held).set(page, answer.rows));
        })
        .catch((failure: Error) => {
          if (!current()) return;
          // Forgotten rather than remembered as asked, so scrolling back over
          // a page that failed retries it instead of leaving a permanent hole.
          asked.current.delete(page);
          setProblem(failure.message);
        });
    }
  }, [relation.name, subject, order, search, buffer, first, last, total]);

  const rowAt = useCallback(
    (index: number): WorldTuple | null =>
      pages.get(Math.floor(index / PAGE))?.[index % PAGE] ?? null,
    [pages],
  );
  const shared = useMemo(() => sharedSegments(pages, roles), [pages, roles]);

  const placeable = roles.some((role) => role.referent);

  // A state column exists only where supplied tuples carry a state:
  // sources that supply none keep the catalogue they already had.
  const hasStance = useMemo(
    () => [...pages.values()].some((page) => page.some((tuple) => tuple.occurrence_state)),
    [pages],
  );
  const columns = useMemo(
    () => `${roles.map(() => "minmax(0, 1fr)").join(" ")} 84px${hasStance ? " 96px" : ""}`,
    [roles, hasStance],
  );

  /**
   * Everything in this table, onto the field — whatever the header says "this
   * table" is: the current search, order and subject narrow it exactly as they
   * narrow the rows on screen.
   *
   * Page by page rather than one request, because the server pages and the
   * field should grow while it runs rather than go quiet and jump. Each page
   * is checked against the buffer key like a scrolled page is: a search typed
   * mid-run is a new table, and the old run stops placing into it. A page
   * that fails stops the run with the table's own problem notice, and the
   * pages already placed stay placed — the margin says which.
   */
  const addAll = useCallback(async () => {
    if (added !== null || !placeable || !total) return;
    const asOf = buffer;
    addingToken.current += 1;
    const token = addingToken.current;
    const current = () =>
      live.current && bufferRef.current === asOf && addingToken.current === token;
    setAdded(0);
    onBulkActive(true);
    try {
      let bound = Math.ceil(total / PAGE);
      let placed = 0;
      for (let page = 0; page < bound; page += 1) {
        let answer;
        try {
          answer = await worldApi.rows(relation.name, {
            search,
            limit: PAGE,
            offset: page * PAGE,
            order: order?.role ?? null,
            desc: order?.desc,
            subject: subject?.id ?? null,
          });
        } catch (failure) {
          if (!current()) return;
          setProblem((failure as Error).message);
          return;
        }
        if (!current()) return;
        setTotal(answer.total);
        bound = Math.max(bound, Math.ceil(answer.total / PAGE));
        onPlaceMany(relation.name, answer.roles, answer.rows);
        placed += answer.rows.length;
        setAdded(placed);
        if (answer.rows.length < PAGE) break;
      }
    } finally {
      if (addingToken.current !== token) return;
      setAdded(null);
      // A task later, not now: this microtask still holds the last page's
      // placement, and releasing in it would batch the flag down with the
      // final data — the one render whose frame must go out still.
      window.setTimeout(() => {
        if (addingToken.current === token) onBulkActive(false);
      }, 0);
    }
  }, [
    added,
    buffer,
    onBulkActive,
    onPlaceMany,
    order,
    placeable,
    relation.name,
    search,
    subject,
    total,
  ]);

  return (
    <section
      className="table"
      aria-label={`${relation.name} extension`}
      ref={frame}
      data-width={width}
    >
      <TableBar
        chrome={chrome}
        title={relation.name}
        meta={
          pages.has(0) || problem ? (
            <>
              {total} tuple{total === 1 ? "" : "s"}
              {subject ? ` mentioning ${subject.label}` : ""}
              {/* The generic bridge's default mode is not a recorded one. */}
              {mode ? ` · ${mode}` : ""}
              {/* Printed only when the world recorded it. An absent admission
                  document is not a claim of WORLD scope, and filling one in here
                  would make the stronger claim on the world's behalf. */}
              {relation.scope ? ` · ${relation.scope.toLowerCase()}` : ""}
              {relation.stale ? " · stale" : ""}
              {relation.completeness && relation.completeness.status !== "COMPLETE"
                ? ` · ${relation.completeness.status.toLowerCase()}`
                : ""}
            </>
          ) : (
            /* The count is outstanding, not zero: the buffer was just reset and
               the first page has not answered. Printing the reset would flash
               "0 tuples" on every search and every subject change. */
            "Reading tuples…"
          )
        }
      >
        {subject ? (
          <button type="button" onClick={onWiden}>
            whole relation
          </button>
        ) : null}
        {order ? (
          <button type="button" onClick={() => setOrder(null)}>
            unsort
          </button>
        ) : null}
        <button type="button" onClick={onDerivation}>
          dependencies
        </button>
      </TableBar>
      <TableSearch value={query} onChange={setQuery} label="Search table values" />
      {!problem && pages.has(0) && total === 0 ?
        <p className="table__empty">{search ? "No rows match this search." : "This table has no rows."}</p> : null}

      <div className="table__head" style={{ gridTemplateColumns: columns }}>
        {roles.map((role) => (
          <button
            key={role.name}
            type="button"
            data-sorted={order?.role === role.name ? (order.desc ? "desc" : "asc") : undefined}
            onClick={() =>
              setOrder((current) =>
                current?.role === role.name && !current.desc
                  ? { role: role.name, desc: true }
                  : current?.role === role.name
                    ? null
                    : { role: role.name, desc: false },
              )
            }
            title={role.name}
          >
            {width === "narrow" ? shortenIdentifier(role.name) : role.name}
            {order?.role === role.name ? (order.desc ? " ↓" : " ↑") : ""}
          </button>
        ))}
        <span>origin</span>
        {hasStance ? <span>state</span> : null}
      </div>

      {problem ? <ProblemNotice message={problem} title="Unable to load relation" /> : null}

      <div className="table__scroll" ref={window_.ref} onScroll={window_.onScroll}
        onKeyDown={window_.onKeyDown} role="region" aria-label={`${relation.name} rows`} tabIndex={window_.scrollable ? 0 : undefined}>
        <div className="table__spacer" style={{ height: total * ROW_HEIGHT }}>
          {window_.indices.map((index) => {
            const tuple = rowAt(index);
            return (
              <div
                key={index}
                className="table__row"
                {...still("rowsNeverFly")}
                data-loaded={tuple ? true : undefined}
                data-present={tuple && present.has(tuple.assertion_id) ? true : undefined}
                style={{
                  top: index * ROW_HEIGHT,
                  height: ROW_HEIGHT,
                  gridTemplateColumns: columns,
                }}
                data-placeable={placeable}
                role={tuple && placeable ? "button" : undefined}
                tabIndex={tuple && placeable ? 0 : undefined}
                title={
                  tuple && present.has(tuple.assertion_id)
                    ? "Right-click takes this row off the field"
                    : placeable
                      ? "Place on field"
                      : "No referents to place on the field"
                }
                onKeyDown={(event) => {
                  if (tuple && placeable && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    onFocus(roles, tuple);
                  }
                }}
                onClick={tuple && placeable ? () => onFocus(roles, tuple) : undefined}
                // The canvas idiom, in the extension: a right-button press on
                // a placed row takes it back off at once. Left alone while a
                // bulk arrival owns the field, like the footer's clear.
                onContextMenu={
                  tuple && added === null && present.has(tuple.assertion_id)
                    ? (event) => {
                        event.preventDefault();
                        onTakeOff(tuple.assertion_id);
                      }
                    : undefined
                }
              >
                {tuple
                  ? roles.map((role) => (
                      <span
                        key={role.name}
                        title={scalarTitle(tuple.values[role.name])}
                        data-value-kind={scalarKind(tuple.values[role.name])}
                      >
                        {display(tuple.values[role.name], role.referent, shared.get(role.name))}
                      </span>
                    ))
                  : roles.map((role) => <span key={role.name} />)}
                <span className="table__origin">
                  {tuple
                    ? originsLabel(tuple.origins ?? tuple.origin).toLowerCase()
                    : ""}
                </span>
                {hasStance ? (
                  <span className="table__origin">
                    {tuple && occurrenceChip(tuple.occurrence_state) ? (
                      <span
                        className="table__stance"
                        data-occurrence-state={tuple.occurrence_state}
                        title={occurrenceChip(tuple.occurrence_state)!.title}
                      >
                        {occurrenceChip(tuple.occurrence_state)!.label}
                      </span>
                    ) : null}
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
          onClick={addAll}
          disabled={!placeable || !total || added !== null}
          aria-busy={added !== null || undefined}
          title={
            placeable
              ? "Place every row of this table on the field"
              : "No referents to place on the field"
          }
          // Auto-sized: the button grows into `adding… N / N` for the length
          // of the run, then settles back. Reserving the run's width kept
          // `clear` from shifting, but the reserved size read as the button's
          // size — normal sizing won.
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {added !== null ? `adding… ${added} / ${total}` : "add all"}
        </button>
        <button
          type="button"
          onClick={() => onClearRelation(relation.name)}
          disabled={added !== null || !clearable}
          title="Take every row of this table off the field"
        >
          clear
        </button>
      </TableFooter>
    </section>
  );
}

/**
 * How many leading segments every loaded id in each referent column shares.
 *
 * Measured over the rows held, so it can only shrink as pages land: a column
 * of `program:ts:<snapshot>:call_site:<hash>` reads from `call_site` on once
 * its rows agree on everything before it.
 */
function sharedSegments(
  pages: Map<number, WorldTuple[]>,
  roles: WorldRole[],
): Map<string, number> {
  const shared = new Map<string, number>();
  for (const role of roles) {
    if (!role.referent) continue;
    let prefix: string[] | null = null;
    for (const page of pages.values()) {
      for (const tuple of page) {
        const value = tuple.values[role.name];
        if (value === null || value === undefined) continue;
        const parts = String(value).split(":");
        if (!prefix) {
          prefix = parts;
          continue;
        }
        let same = 0;
        while (same < prefix.length && same < parts.length && prefix[same] === parts[same]) {
          same += 1;
        }
        prefix = prefix.slice(0, same);
      }
    }
    shared.set(role.name, prefix?.length ?? 0);
  }
  return shared;
}

/**
 * A cell.
 *
 * Referent ids arrive namespaced — `part:X160` — and whatever repeats down the
 * whole column, the namespace at least, is dropped from the referent columns
 * and kept on the cell's title, because an id you cannot read out of the table
 * is an id you cannot ask the rest of the product about. The last two segments
 * always stay: a kind and its hash say more than the hash alone. A scalar is
 * printed as it is: a colon inside a scalar is part of the value.
 */
function display(value: unknown, referent: boolean, shared = 1): ReactNode {
  // A stored NULL, an empty string, whitespace-only text and an unsent value
  // are each marked as themselves, in referent and scalar columns alike; the
  // dash that used to stand for the first two is also valid text.
  if (scalarLabel(value) !== undefined) return <Scalar value={value} />;
  // Scalar text that reads as a marker or as the dash is quoted, so the cell
  // alone tells it from the marker it imitates; any other value is as sent.
  if (!referent) return <Scalar value={value} />;
  const text = String(value);
  const parts = text.split(":");
  const drop = Math.min(Math.max(1, shared), Math.max(1, parts.length - 2));
  return parts.length > 1 ? parts.slice(drop).join(":") : text;
}

import { useCallback, useLayoutEffect, useRef, type ReactNode, type UIEvent } from "react";
import type { SourceOrder, SourceSearch, SourceRow, SourceRows } from "../api/source";
import { identityLimitation, Loading, Problem } from "./SourceDetails";
import { SourceValue } from "./SourceValue";
import { useSourceScroll, type SourceScrollPosition } from "./SourcePanel";
import { TableAction, TableFooter } from "../world/tableChrome";
import { still } from "../styles/motion";

/** What a header press does next, in World's cycle: ascending, descending, unsorted. */
const nextSort = (column: string, sorted: SourceOrder | null) =>
  !sorted ? `sort by ${column}, ascending` : !sorted.desc ? `sort by ${column}, descending` : `stop sorting by ${column}`;

/**
 * Which sides of the row table still hide columns. The table scrolls sideways
 * when its columns are wider than the panel; an edge that has more beyond it
 * darkens, so a cut-off column reads as cut off rather than as the last one.
 * Measured on scroll and on resize, and written to the frame's attributes, so
 * scrolling never renders the table again.
 */
function useSideCue(ref: (element: HTMLDivElement | null) => void, onScroll: (event: UIEvent<HTMLDivElement>) => void, content: unknown) {
  const frame = useRef<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const measure = useCallback(() => {
    const element = scroller.current, host = frame.current;
    if (!element || !host) return;
    host.toggleAttribute("data-more-left", element.scrollLeft > 1);
    host.toggleAttribute("data-more-right", element.scrollLeft + element.clientWidth < element.scrollWidth - 1);
    // The cues stop at the scrollbars, not over them.
    host.style.setProperty("--side-cue-right", `${element.offsetWidth - element.clientWidth}px`);
    host.style.setProperty("--side-cue-height", `${element.clientHeight}px`);
  }, []);
  useLayoutEffect(() => {
    const element = scroller.current;
    measure();
    if (!element) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [content, measure]);
  // Stable, so the scroll position's own ref is not called again on every render.
  const scrollRef = useCallback((element: HTMLDivElement | null) => { scroller.current = element; ref(element); }, [ref]);
  const scrolled = useCallback((event: UIEvent<HTMLDivElement>) => { onScroll(event); measure(); }, [onScroll, measure]);
  return { frame, scroller, scrollRef, scrolled };
}

/** This view owns no requests: an outgoing table cannot restart a row read. */
export function SourceRowsView({ name, named, actions, rows, error, selected, placed, order, offset, limit, onPage, onSelect, onTakeOff, onOrder, onUnsort, onRetry, scroll, searching = false }: {
  name: string;
  /** The column that names this table's records, if a person chose one (O17). */
  named?: string;
  /** What can be done with the whole set (keep all, remove set): on the same bar as the page size, never a bar of its own. */
  actions?: ReactNode;
  /** Record handles on the canvas: their rows carry World's margin rule. */
  placed: ReadonlySet<string>;
  searching?: boolean;
  rows?: SourceRows | SourceSearch | null;
  error?: Error;
  selected: SourceRow | null;
  scroll: SourceScrollPosition;
  offset: number;
  limit: number;
  onPage: (offset: number, limit: number) => void;
  onSelect: (row: SourceRow) => void;
  /** World's right press on a marked row: its record leaves the canvas. */
  onTakeOff: (recordId: string) => void;
  /** World's sortable headers: the database orders, the header asks. */
  order: SourceOrder | null;
  onOrder: (column: string) => void;
  /** Back to the table's own order. */
  onUnsort: () => void;
  onRetry?: () => void;
}) {
  const search = rows && "completion" in rows ? rows : null;
  const viewport = useSourceScroll(scroll);
  const side = useSideCue(viewport.ref, viewport.onScroll, rows);
  // Unsort pressed from the keyboard: its button goes, so focus waits on the rows
  // region while the table reloads, then returns to the header that was sorted.
  const refocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const column = refocus.current;
    if (!column || (!rows && !error)) return;
    refocus.current = null;
    if (error) return;
    side.scroller.current?.querySelector<HTMLButtonElement>(`th[data-column="${CSS.escape(column)}"] .source-sort`)?.focus();
  }, [rows, error]);
  const pending = !rows && !error;
  const previousAvailable = !pending && offset > 0;
  const nextAvailable = Boolean(rows?.has_more && rows.next_offset !== null && rows.next_offset <= 1_000_000);
  return <div className="source-browse">
    <div className="source-browse__status" aria-live="polite">
      {/* The order is said above the rows, where it is seen whichever columns are
          scrolled into view, and is undone beside the words that name it. */}
      {order && <p className="source-sorted" data-sorted-by><span>sorted by <b>{order.column}</b>, {order.desc ? "descending" : "ascending"}
        {rows?.order?.tiebreak === "unspecified" && " · ties keep no fixed order · positions apply to this page only"}</span>
        <TableAction data-unsort onClick={(event) => {
          if (event.detail === 0) { refocus.current = order.column; side.scroller.current?.focus({ preventScroll: true }); }
          onUnsort();
        }}>unsort</TableAction></p>}
      {error ? <><Problem error={error} onRetry={onRetry} narrow={searching ? "Narrow it: under precise lookup, search one column, or look up an exact key." : "Choose fewer rows per page."} />
        {searching && <p>filter incomplete · no absence claim</p>}</> : !rows ? <Loading /> : <>
        {rows.ordering === "unspecified_window_only" && <p>{identityLimitation(rows.identity) ?? "unordered rows"} · positions apply to this page only</p>}
        {!!search?.reference?.unchecked_rows && <p>{search.reference.unchecked_rows} {search.reference.unchecked_rows === 1 ? "row" : "rows"} with a BLOB over 1 MiB could not be checked · not listed</p>}
      </>}
    </div>
    <div className="source-row-frame" ref={side.frame}><div className="table__scroll source-row-scroll" {...viewport} ref={side.scrollRef} onScroll={side.scrolled} role="region" aria-label={`${name} rows`} tabIndex={0} aria-busy={!rows && !error}>
      {rows && (rows.returned === 0 ? <p>{search ? search.completion !== "complete" ? "filter incomplete" : offset > 0 ? "no further matches"
        : search.search.mode === "reference" ? "no referencing rows in this capture" : `no matches · ${search.search.case === "match" ? "matches case" : "ignores case"}; NULL and BLOB excluded` : "no rows on this page"}</p> : <table className="table__data source-row-table"><thead><tr><th scope="col"><span className="sr-only">Window position</span></th>{rows.columns.map((column) => {
          const sorted = order?.column === column.name ? order : null;
          // The arrow is the order's picture, hidden from speech: aria-sort says it. Its
          // place is kept when unsorted, so sorting never shifts the columns, and a
          // hovered unsorted header shows it faintly: a press sorts ascending.
          return <th scope="col" key={column.name} data-column={column.name} aria-sort={sorted ? sorted.desc ? "descending" : "ascending" : undefined}>
            <button type="button" className="source-sort" data-sorted={sorted ? sorted.desc ? "desc" : "asc" : undefined} title={nextSort(column.name, sorted)}
              onClick={() => onOrder(column.name)}>{column.name}<span className="source-sort__mark" aria-hidden="true">{sorted?.desc ? "↓" : "↑"}</span></button>{column.name === named && <small className="source-named" title="names this table's records">name</small>}</th>;
        })}</tr></thead>
        {/* The whole row is the pointer target, as in World's tables; the
            first cell stays the one keyboard control so the table keeps its
            row and cell semantics. It shows no number: the key beside it
            already says which row it is. Its margin carries World's rule for
            a record on the canvas; selection is a tint, so the rule keeps one
            meaning. A click that ends a text selection is copying, not
            selecting. */}
        <tbody>{rows.rows.map((row, index) => <tr {...still("rowsNeverFly")} key={index} className={row === selected || row.record_id && row.record_id === selected?.record_id ? "is-selected" : ""}
          data-present={!!row.record_id && placed.has(row.record_id) || undefined}
          title={row.record_id && placed.has(row.record_id) ? "Right-click takes this row off the canvas" : undefined}
          onContextMenu={row.record_id && placed.has(row.record_id) ? (event) => { event.preventDefault(); onTakeOff(row.record_id!); } : undefined}
          onClick={(event) => { if (!(event.target as Element).closest("button") && window.getSelection()?.isCollapsed !== false) onSelect(row); }}>
          <td><button data-row data-focus-subject={row === selected || !!row.record_id && row.record_id === selected?.record_id || undefined} type="button" aria-label={`Inspect row ${offset + index + 1}`} aria-pressed={row === selected || !!row.record_id && row.record_id === selected?.record_id} onClick={() => onSelect(row)} />
            {!!row.record_id && placed.has(row.record_id) && <span className="sr-only">on canvas</span>}</td>
          {row.cells.map((cell) => <td key={cell.column} data-matched={search?.rows[index].matched_columns.includes(cell.column) || undefined}><SourceValue value={cell} />{search?.rows[index].matched_columns.includes(cell.column) && <span className="sr-only"> · matched {cell.column}</span>}</td>)}
        </tr>)}</tbody></table>)}
    </div></div>
    <TableFooter className="table__foot table__pager source-pager" aria-label="Row windows" aria-busy={pending}>
      {/* Keep the navigation control and its focus through loading/end/error.
          aria-disabled is enforced here as well as announced by the browser. */}
      <button type="button" aria-disabled={!previousAvailable} onClick={() => { if (previousAvailable) onPage(Math.max(0, offset - limit), limit); }}>previous rows</button>
      <span role="status">{error ? "page unavailable" : rows ? rows.returned ? `${search ? "matches" : "rows"} ${offset + 1}–${offset + rows.returned}${rows.has_more ? " · more available" : search?.completion === "complete" ? " · no more matches" : search ? " · bounded results" : " · end"}` : "0 rows" : "loading…"}</span>
      <button type="button" aria-disabled={!nextAvailable} onClick={() => { if (nextAvailable) onPage(rows!.next_offset!, limit); }}>next rows</button>
    </TableFooter>
    <div className="table__foot source-window-bar">
      <label className="table__filters source-window-size"><span className="sr-only">rows per page</span><select aria-label="rows per page" value={limit} onChange={(event) => onPage(0, Number(event.target.value))}>
        {[1, 10, 25, 50].map((size) => <option key={size} value={size}>{size} rows</option>)}
      </select></label>
      {actions}
    </div>
    {rows?.has_more && rows.next_offset !== null && rows.next_offset > 1_000_000 && <p>further rows exceed the offset limit</p>}
  </div>;
}

import type { SourceOrder, SourceSearch, SourceRow, SourceRows } from "../api/source";
import { identityLimitation, Loading, Problem } from "./SourceDetails";
import { SourceValue } from "./SourceValue";
import { useSourceScroll, type SourceScrollPosition } from "./SourcePanel";
import { TableFooter } from "../world/tableChrome";
import { still } from "../styles/motion";

/** This view owns no requests: an outgoing table cannot restart a row read. */
export function SourceRowsView({ name, named, rows, error, selected, placed, order, offset, limit, onPage, onSelect, onTakeOff, onOrder, onRetry, scroll, searching = false }: {
  name: string;
  /** The column that names this table's records, if a person chose one (O17). */
  named?: string;
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
  onRetry?: () => void;
}) {
  const search = rows && "completion" in rows ? rows : null;
  const viewport = useSourceScroll(scroll);
  const pending = !rows && !error;
  const previousAvailable = !pending && offset > 0;
  const nextAvailable = Boolean(rows?.has_more && rows.next_offset !== null && rows.next_offset <= 1_000_000);
  return <div className="source-browse">
    <div className="source-browse__status" aria-live="polite">
      {error ? <><Problem error={error} onRetry={onRetry} narrow={searching ? "Narrow it: under precise lookup, search one column, or look up an exact key." : "Choose fewer rows per page."} />
        {searching && <p>filter incomplete · no absence claim</p>}</> : !rows ? <Loading /> : <>
        {rows.ordering === "unspecified_window_only" && <p>{identityLimitation(rows.identity) ?? "unordered rows"} · positions apply to this page only</p>}
        {rows.order?.tiebreak === "unspecified" && <p>ties in {rows.order.column} keep no fixed order · positions apply to this page only</p>}
        {!!search?.reference?.unchecked_rows && <p>{search.reference.unchecked_rows} {search.reference.unchecked_rows === 1 ? "row" : "rows"} with a BLOB over 1 MiB could not be checked · not listed</p>}
      </>}
    </div>
    <div className="table__scroll source-row-scroll" {...viewport} role="region" aria-label={`${name} rows`} tabIndex={0} aria-busy={!rows && !error}>
      {rows && (rows.returned === 0 ? <p>{search ? search.completion !== "complete" ? "filter incomplete" : offset > 0 ? "no further matches"
        : search.search.mode === "reference" ? "no referencing rows in this capture" : `no matches · ${search.search.case === "match" ? "matches case" : "ignores case"}; NULL and BLOB excluded` : "no rows on this page"}</p> : <table className="table__data source-row-table"><thead><tr><th scope="col"><span className="sr-only">Window position</span></th>{rows.columns.map((column) => {
          const sorted = order?.column === column.name ? order : null;
          return <th scope="col" key={column.name} aria-sort={sorted ? sorted.desc ? "descending" : "ascending" : undefined}>
            <button type="button" className="source-sort" data-sorted={sorted ? sorted.desc ? "desc" : "asc" : undefined} title={`sort by ${column.name}`}
              onClick={() => onOrder(column.name)}>{column.name}{sorted ? sorted.desc ? " ↓" : " ↑" : ""}</button>{column.name === named && <small className="source-named" title="names this table's records">name</small>}</th>;
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
    </div>
    <TableFooter className="table__foot table__pager source-pager" aria-label="Row windows" aria-busy={pending}>
      {/* Keep the navigation control and its focus through loading/end/error.
          aria-disabled is enforced here as well as announced by the browser. */}
      <button type="button" aria-disabled={!previousAvailable} onClick={() => { if (previousAvailable) onPage(Math.max(0, offset - limit), limit); }}>previous rows</button>
      <span role="status">{error ? "page unavailable" : rows ? rows.returned ? `${search ? "matches" : "rows"} ${offset + 1}–${offset + rows.returned}${rows.has_more ? " · more available" : search?.completion === "complete" ? " · no more matches" : search ? " · bounded results" : " · end"}` : "0 rows" : "loading…"}</span>
      <button type="button" aria-disabled={!nextAvailable} onClick={() => { if (nextAvailable) onPage(rows!.next_offset!, limit); }}>next rows</button>
    </TableFooter>
    <label className="table__filters source-window-size"><span className="sr-only">rows per page</span><select aria-label="rows per page" value={limit} onChange={(event) => onPage(0, Number(event.target.value))}>
      {[1, 10, 25, 50].map((size) => <option key={size} value={size}>{size} rows</option>)}
    </select></label>
    {rows?.has_more && rows.next_offset !== null && rows.next_offset > 1_000_000 && <p>further rows exceed the offset limit</p>}
  </div>;
}

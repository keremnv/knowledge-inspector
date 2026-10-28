/**
 * Read-only physical SQLite inspection, explicitly distinct from the semantic
 * snapshot/assertion explorer. No row ID is invented for unkeyed query results.
 * A window offset is NOT a persistent record identity.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { sqliteApi, type SQLiteRows, type SQLiteSchema } from "../api/sqlite";
import "./SQLiteTablesPage.css";

const PAGE_SIZE = 50;

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function SQLiteTablesPage() {
  const [schema, setSchema] = useState<SQLiteSchema | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [windowRows, setWindowRows] = useState<SQLiteRows | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const keyboardTravel = useRef<{ source: HTMLElement; destination: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // Pagination temporarily removes its rows and footer while fetching. Keep
  // keyboard travel attached to the new window rather than losing it to body.
  useLayoutEffect(() => {
    const travel = keyboardTravel.current;
    if (!travel || (document.activeElement !== travel.source && document.activeElement !== document.body)) return;
    const destination = travel.destination === 'subject'
      ? root.current?.querySelector<HTMLElement>('h2')
      : Array.from(root.current?.querySelectorAll<HTMLButtonElement>('.ki-sqlite-pager button') ?? [])
          .find(button => button.textContent === travel.destination && !button.disabled)
        ?? root.current?.querySelector<HTMLElement>('.ki-sqlite-scroll');
    if (!destination) return;
    destination.focus();
    keyboardTravel.current = null;
  }, [selected, windowRows]);

  useEffect(() => {
    let active = true;
    sqliteApi
      .schema()
      .then((data) => {
        if (!active) return;
        setSchema(data);
        setSelected(data.tables[0]?.name ?? data.views[0] ?? null);
      })
      .catch((e: unknown) => {
        if (active) setSchemaError(String(e));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    setBusy(true);
    setRowError(null);
    setWindowRows(null);
    sqliteApi
      .rows(selected, { limit: PAGE_SIZE, offset })
      .then((data) => {
        if (active) setWindowRows(data);
      })
      .catch((e: unknown) => {
        if (active) setRowError(String(e));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [selected, offset]);

  const choices = useMemo(() => {
    const all = [
      ...(schema?.tables.map((t) => ({
        name: t.name,
        kind: "table" as const,
        count: t.rows,
      })) ?? []),
      ...(schema?.views.map((name) => ({
        name,
        kind: "view" as const,
        count: null,
      })) ?? []),
    ];
    return all.filter((x) =>
      x.name.toLowerCase().includes(filter.trim().toLowerCase()),
    );
  }, [schema, filter]);
  const meta = schema?.tables.find((t) => t.name === selected);
  const rows = windowRows;
  const hasMore = !!rows && rows.offset + rows.rows.length < rows.total;

  function choose(name: string) {
    setSelected(name);
    setOffset(0);
  }

  return (
    <div className="ki-sqlite-page" ref={root}
      onPointerDownCapture={() => { keyboardTravel.current = null; }}
      onKeyDownCapture={(event) => {
        keyboardTravel.current = null;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const source = event.target as HTMLElement;
        if (source.closest('.ki-sqlite-pager')) keyboardTravel.current = { source, destination: source.textContent ?? '' };
        else if (source.closest('nav, button.ki-sqlite-fk')) keyboardTravel.current = { source, destination: 'subject' };
      }}>
      <header className="ki-sqlite-header">
        <div>
          <div className="ki-sqlite-kicker">KNOWLEDGE INSPECTOR · STRUCTURAL MODE</div>
          <h1>SQLite tables</h1>
          <p>Recorded data and physical relationships. No conceptual adoption is implied.</p>
        </div>
        <a href="/" className="ki-sqlite-back">
          Back to explorer ↗
        </a>
      </header>
      {schemaError && (
        <div role="alert" className="ki-sqlite-error">
          {schemaError}
        </div>
      )}
      {schema && (
        <div className="ki-sqlite-origin">
          <span>{schema.file}</span>
          <code
            title={`SHA-256 of the file when the adapter started (${schema.file_sha256}); not re-checked on later reads`}
          >
            SHA-256 {schema.file_sha256.slice(0, 16)}… (at startup)
          </code>
          <span>
            {schema.tables.length} tables · {schema.views.length} views
          </span>
        </div>
      )}
      <div className="ki-sqlite-body">
        <aside className="ki-sqlite-sidebar" aria-label="SQLite objects">
          <label htmlFor="ki-sqlite-filter">Find a table or view</label>
          <input
            id="ki-sqlite-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Name"
          />
          <nav aria-label="Database objects">
            {choices.map((x) => (
              <button
                type="button"
                key={x.kind + ":" + x.name}
                aria-current={x.name === selected ? "page" : undefined}
                className={x.name === selected ? "is-selected" : ""}
                onClick={() => choose(x.name)}
              >
                <span>{x.name}</span>
                <small>
                  {x.kind}
                  {x.count !== null ? ` · ${x.count.toLocaleString()}` : ""}
                </small>
              </button>
            ))}
          </nav>
        </aside>
        <main className="ki-sqlite-main">
          {selected && (
            <>
              <div className="ki-sqlite-panel-heading">
                <div>
                  <span className="ki-sqlite-kicker">
                    {meta ? "PHYSICAL TABLE" : "SQL VIEW"}
                  </span>
                  <h2 tabIndex={-1}>{selected}</h2>
                </div>
                <span>{rows ? `${rows.total.toLocaleString()} rows` : ""}</span>
              </div>
              {meta && (
                <section className="ki-sqlite-structure" aria-label="Table structure">
                  <div>
                    <strong>Primary key</strong>{" "}
                    {meta.pk.length ? meta.pk.join(" + ") : "Not declared"}
                  </div>
                  <div>
                    <strong>Foreign keys</strong>{" "}
                    {meta.fks.length ? (
                      meta.fks.map((group, i) => {
                        const target = group[0]?.table;
                        const known =
                          target !== undefined &&
                          schema?.tables.some((t) => t.name === target);
                        const targetText = (r: (typeof group)[number]) =>
                          r.to ??
                          (r.resolved_to
                            ? `${r.resolved_to} (implicit target)`
                            : "parent primary key (implicit target)");
                        const label = (
                          <>
                            {group.map((r) => r.from).join(" + ")} → {group[0].table} (
                            {group.map(targetText).join(" + ")})
                          </>
                        );
                        // Table-level navigation only: opening the target table
                        // does not filter to the referenced record. Record-level
                        // traversal is deferred, never guessed.
                        return known ? (
                          <button
                            type="button"
                            className="ki-sqlite-fk is-link"
                            key={i}
                            onClick={() => choose(target)}
                            title={`Open table ${target} (table-level; does not follow to the referenced record)`}
                          >
                            {label}
                          </button>
                        ) : (
                          <span className="ki-sqlite-fk" key={i}>
                            {label}
                          </span>
                        );
                      })
                    ) : (
                      "Not declared"
                    )}
                  </div>
                </section>
              )}
              {rows && (
                <p className="ki-sqlite-identity" role="status">
                  {rows.navigable
                    ? "Record keys verified for structural navigation."
                    : "Table-only records: no durable per-row identity is inferred."}
                  {rows.ordering_guarantee ? ` Row order: ${rows.ordering_guarantee}.` : ""}
                </p>
              )}
              {rowError && (
                <div className="ki-sqlite-error" role="alert">
                  {rowError}
                </div>
              )}
              {busy && <p role="status">Reading SQLite…</p>}
              {rows && (
                <>
                  <div
                    className="ki-sqlite-scroll"
                    role="region"
                    aria-label="SQLite rows"
                    tabIndex={0}
                  >
                    <table>
                      <thead>
                        <tr>
                          {rows.columns.map((col) => {
                            const generated = meta?.columns.find((c) => c.name === col)?.generated;
                            return (
                              <th key={col} scope="col">
                                {col}
                                {generated ? ` · generated ${generated.toLowerCase()}` : ""}
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.rows.map((row, index) => (
                          <tr key={index}>
                            {rows.columns.map((col) => (
                              <td
                                key={col}
                                title={renderCell(row[col])}
                                className={row[col] === null ? "is-null" : ""}
                              >
                                {renderCell(row[col])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <footer className="ki-sqlite-pager">
                    <span>
                      {rows.total
                        ? `${rows.offset + 1}–${rows.offset + rows.rows.length} of ${rows.total}`
                        : "No records"}
                    </span>
                    <div>
                      <button
                        type="button"
                        disabled={offset === 0 || busy}
                        onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                      >
                        Previous
                      </button>
                      <button
                        type="button"
                        disabled={!hasMore || busy}
                        onClick={() => setOffset(offset + PAGE_SIZE)}
                      >
                        Next
                      </button>
                    </div>
                  </footer>
                </>
              )}
            </>
          )}
          {!selected && !schemaError && <p>No SQLite tables or views discovered.</p>}
        </main>
      </div>
    </div>
  );
}

/**
 * Find across the capture: World's finder, over Source tables and records.
 *
 * As World's, it asks as you type, a beat after the last keystroke (O10), and
 * lists matching tables first, then records. The records are the per-table
 * literal search, table after table, ignoring case as the table filter does
 * (O11); when the request's cap ran out first, the list says so and offers to
 * continue rather than claiming there is nothing more. An answer to a query
 * nobody is typing any more is dropped.
 *
 * A failed request is said once, as an alert, and stays with the field while
 * the list is closed (its description); what was already found stays listed,
 * and "try again" asks the same question again when repeating can help. A
 * stopped context is the workspace's to report, as for every other read.
 */
import { useEffect, useId, useRef, useState } from "react";
import type { SourceFindHit, SourceGlobalFind as Answer } from "../api/source";
import { SourceReadError } from "../api/sourceClient";
import { readFailure } from "./sourceExplain";
import { sourceValueText } from "./sourceValueText";
import { usePresence } from "../styles/usePresence";
import "../world/WorldFinder.css";

/** World's pause before a keystroke becomes a question. */
const ASK_AFTER_MS = 160;

type Relation = Answer["relations"][number];
type Item = { kind: "table"; relation: Relation } | { kind: "hit"; hit: SourceFindHit } | { kind: "more"; cursor: string } | { kind: "retry" };
/** A failed request: its question, and where it was continuing from. */
type Failed = { error: Error; text: string; cursor: string | null; serial: number };

/** Why a table was not searched, in plain words; the code stays beside it. */
const SKIPPED: Record<string, string> = {
  find_budget_exceeded: "too large to search here; use its table's filter",
  source_query_budget_exceeded: "its search ran out of its query limit; use its table's filter",
  unsupported_virtual_source: "a virtual table, which is not read",
  unsupported_source_operation: "could not be searched",
};
const skippedText = (table: Answer["skipped"][number]) => SKIPPED[table.reason] ? `${SKIPPED[table.reason]} · ${table.reason}` : table.reason;
type Asked = { text: string; relations: Relation[]; hits: SourceFindHit[]; next: string | null; stoppedEarly: boolean; skipped: Answer["skipped"] };

export function SourceGlobalFind({ find, onPick, onPickTable, nameOf, onFailure }: {
  find: (text: string, cursor: string | null, signal: AbortSignal) => Promise<Answer>;
  /** A stopped context goes to the workspace, which stops every read. */
  onFailure?: (error: SourceReadError) => void;
  onPick: (hit: SourceFindHit, text: string) => void;
  onPickTable: (name: string) => void;
  /** A found record's name (O17): its table's naming column, or its key label. */
  nameOf: (hit: SourceFindHit) => string;
}) {
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState<Asked | null>(null);
  const [problem, setProblem] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const generation = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const listId = useId(), problemId = useId();
  const text = query.trim();
  const failed = problem && problem.text === text ? readFailure(problem.error) : null;
  const presence = usePresence(open && !!text && (busy || !!asked || !!problem));
  const items: Item[] = asked ? [
    ...asked.relations.map((relation) => ({ kind: "table" as const, relation })),
    ...asked.hits.map((hit) => ({ kind: "hit" as const, hit })),
    // A continuation that failed is asked again from the same place.
    ...(asked.next && !failed ? [{ kind: "more" as const, cursor: asked.next }] : []),
    ...(failed?.recovery === "retry" ? [{ kind: "retry" as const }] : []),
  ] : failed?.recovery === "retry" ? [{ kind: "retry" as const }] : [];

  const ask = async (question: string, cursor: string | null) => {
    window.clearTimeout(timer.current);
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const token = ++generation.current;
    setBusy(true); setProblem(null); setOpen(true);
    try {
      const answer = await find(question, cursor, controller.signal);
      if (token !== generation.current) return;
      setAsked((current) => {
        const more = cursor && current?.text === question ? current : null;
        return { text: question, relations: more ? more.relations : answer.relations,
          hits: [...(more?.hits ?? []), ...answer.hits], next: answer.next_cursor,
          stoppedEarly: answer.completion === "budget_exceeded", skipped: [...(more?.skipped ?? []), ...answer.skipped] };
      });
      if (!cursor) setActive(0);
    } catch (failure) {
      if (token === generation.current && !controller.signal.aborted) {
        const error = failure instanceof Error ? failure : new Error(String(failure));
        if (error instanceof SourceReadError && error.stopsContext) { onFailure?.(error); return; }
        // What a continuation had already found stays listed.
        setAsked((current) => cursor && current?.text === question ? current : null);
        setProblem({ error, text: question, cursor, serial: token });
        if (!cursor) setActive(0);
      }
    } finally {
      if (token === generation.current) setBusy(false);
    }
  };

  // As you type: the question is asked a beat after the last keystroke.
  useEffect(() => {
    if (!text) { generation.current += 1; inFlight.current?.abort(); setAsked(null); setProblem(null); setBusy(false); return; }
    if (asked?.text === text) return;
    timer.current = window.setTimeout(() => void ask(text, null), ASK_AFTER_MS);
    return () => window.clearTimeout(timer.current);
    // `ask` reads only refs and setters; the question is the text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  useEffect(() => () => { window.clearTimeout(timer.current); inFlight.current?.abort(); }, []);

  const choose = (item: Item | undefined) => {
    if (item?.kind === "retry") { if (problem) void ask(problem.text, problem.cursor); return; }
    if (!item || !asked) return;
    if (item.kind === "more") { void ask(asked.text, item.cursor); return; }
    if (item.kind === "table") onPickTable(item.relation.name);
    else onPick(item.hit, asked.text);
    setOpen(false);
  };

  const option = (item: Item, index: number) => <li key={item.kind === "table" ? `table:${item.relation.name}` : item.kind === "hit" ? `${item.hit.table}:${index}` : item.kind}
    id={`${listId}-${index}`} role="option" aria-selected={index === active}
    className={index === active ? "nodefind__row nodefind__row--active" : "nodefind__row"}
    onMouseDown={(event) => { event.preventDefault(); choose(item); }} onMouseEnter={() => setActive(index)}>
    {item.kind === "table" ? <>
      <span className="nodefind__label">{item.relation.name}</span>
      <span className="nodefind__anchor">{item.relation.kind}</span>
    </> : item.kind === "hit" ? <>
      <span className="nodefind__label">{nameOf(item.hit)}</span>
      <span className="nodefind__anchor">{item.hit.cells.map((cell) => `${cell.column} ${sourceValueText(cell)}`).join(" · ")}</span>
    </> : item.kind === "retry" ? <span className="nodefind__label">{busy ? "searching…" : "try again"}</span>
    : <span className="nodefind__label">{busy ? "searching…" : asked?.stoppedEarly ? "the search stopped early · continue" : "more results"}</span>}
  </li>;

  return <div className="nodefind source-global-find" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>
    <input className="nodefind__input" type="text" role="combobox" aria-label="Find tables and records" placeholder="find…"
      title={failed ? `${asked ? "could not continue: " : ""}${failed.sentence}` : "Tables by name, records by any value; ignores case"}
      aria-expanded={presence.mounted} aria-controls={listId} aria-autocomplete="list"
      aria-activedescendant={open && items[active] ? `${listId}-${active}` : undefined}
      aria-describedby={failed ? problemId : undefined} aria-invalid={failed ? true : undefined}
      value={query} onFocus={() => setOpen(true)}
      onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (open && (asked || problem)) setOpen(false); else setQuery(""); return; }
        if (event.key === "ArrowDown" && items.length) { event.preventDefault(); setOpen(true); setActive((index) => (index + 1) % items.length); return; }
        if (event.key === "ArrowUp" && items.length) { event.preventDefault(); setActive((index) => (index - 1 + items.length) % items.length); return; }
        if (event.key !== "Enter") return;
        event.preventDefault();
        // The answer in hand picks what is highlighted; otherwise ask now.
        if (items.length && (asked?.text === text || failed)) { setOpen(true); choose(items[active]); }
        else if (text) void ask(text, null);
      }} />
    {/* Said once, by the field: the open list shows it, and so does the field's title while it is closed. */}
    {failed && <p key={problem!.serial} className="source-find-problem sr-only" role="alert" id={problemId} data-find-problem>
      {asked ? "could not continue: " : ""}{failed.sentence}<span className="source-problem__code"> · {failed.code}</span></p>}
    {presence.mounted && <ul id={listId} role="listbox" aria-label="found tables and records"
      className={`nodefind__list motion-layer motion-layer--fade${presence.shown ? " is-in" : ""}`}>
      {failed && !asked ? <>
          <li className="nodefind__row nodefind__row--empty" role="presentation">{failed.sentence}</li>
          {items.map(option)}
        </>
        : !asked || asked.text !== text ? <li className="nodefind__row nodefind__row--empty" role="presentation">searching every table…</li>
        : <>
          {items.map(option)}
          {failed && <li className="nodefind__row nodefind__row--empty" role="presentation">could not continue: {failed.sentence}</li>}
          {!asked.hits.length && !asked.relations.length && !asked.next && !failed && <li className="nodefind__row nodefind__row--empty" role="presentation">
            {asked.skipped.length ? "no matches in the tables searched" : "no tables or records match"}</li>}
          {asked.skipped.length > 0 && <li className="nodefind__row nodefind__row--empty" role="presentation">
            not searched: {asked.skipped.map((table) => `${table.table} (${skippedText(table)})`).join(", ")}</li>}
        </>}
    </ul>}
  </div>;
}

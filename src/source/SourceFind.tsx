import { useEffect, useRef } from "react";
import { TableSearch } from "../world/tableChrome";
import type { SourceColumn, SourceSearchKey, SourceSearchRequest } from "../api/source";

export type SourceFindDraft = {
  mode: "literal" | "primary_key"; text: string; column: string;
  values: Record<string, SourceSearchKey>; precise?: boolean;
  /** Precise lookup's "match case": the exact rule instead of ignoring case (O11). */
  matchCase?: boolean;
};
/**
 * Precise lookup (column, match case, exact primary key) is hidden for now; its
 * code and contract stay. The tests that keep the hidden control working turn
 * it on with `localStorage["ki.source.preciseLookup"] = "on"`.
 */
export function preciseLookupShown(): boolean {
  try { return window.localStorage.getItem("ki.source.preciseLookup") === "on"; } catch { return false; }
}
/** A table's filter runs as typing pauses, as the catalogue's search does. */
export const FILTER_PAUSE_MS = 300;
export const emptySourceFind: SourceFindDraft = { mode: "literal", text: "", column: "", values: {} };

/** Controlled presentation: outgoing Swap snapshots retain their own draft. */
export function SourceFind({ name, columns, draft, onDraft, onEdit, onSubmit, onClear }: {
  name: string; columns: SourceColumn[]; draft: SourceFindDraft; onDraft: (draft: SourceFindDraft) => void;
  onEdit: () => void; onSubmit: (request: SourceSearchRequest) => void; onClear: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const keys = columns.filter((c) => c.pk_order).sort((a, b) => a.pk_order - b.pk_order);
  const { mode, text, column, values } = draft;
  const component = (name: string): SourceSearchKey => Object.prototype.hasOwnProperty.call(values, name) ? values[name] : { column: name, storage_class: "integer", exact: "" };
  // Typing schedules the filter; a pause runs it, Enter runs it at once. Only
  // typing schedules: a draft restored by Back does not run again.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => { if (pending.current) clearTimeout(pending.current); pending.current = null; };
  useEffect(() => cancel, []);
  const literal = (value: string): SourceSearchRequest => ({ mode: "literal", text: value, ...(column ? { column: JSON.parse(column) as string } : {}), ...(draft.matchCase ? { case: "match" as const } : {}) });
  const clear = () => { cancel(); onDraft(emptySourceFind); onClear(); input.current?.focus({ preventScroll: true }); };
  return <form className="source-find" aria-label={`filter ${name}`} onSubmit={(event) => {
    event.preventDefault(); cancel();
    if (mode === "literal") {
      if (text === "") onClear();
      else onSubmit(literal(text));
    } else onSubmit({ mode: "primary_key", key: keys.map((key) => component(key.name)) });
  }}>
    <TableSearch maxLength={1024} inputRef={input} label={`filter ${name}`} placeholder={mode === "primary_key" ? "exact key lookup" : `filter ${name}…`}
      value={mode === "literal" ? text : ""} clearable={!!(text || mode === "primary_key" || column)} clearLabel="clear" onClear={clear}
      onChange={(value) => {
        onDraft({ ...draft, mode: "literal", text: value }); cancel();
        if (value === "") { onClear(); return; }
        pending.current = setTimeout(() => { pending.current = null; onSubmit(literal(value)); }, FILTER_PAUSE_MS);
      }} />
    {preciseLookupShown() && <div className="table__filters source-filter-options"><small>{mode === "primary_key" ? "exact key" : `${draft.matchCase ? "matches case" : "ignores case"}${column ? ` · ${JSON.parse(column) as string}` : ""}`}</small><details open={draft.precise ?? false} onToggle={(event) => { const precise = event.currentTarget.open; if (precise !== (draft.precise ?? false)) onDraft({ ...draft, precise }); }}>
      <summary>precise lookup</summary>
      <label>lookup <select aria-label="lookup mode" value={mode} onChange={(event) => { onDraft({ ...draft, mode: event.target.value as SourceFindDraft["mode"] }); onEdit(); }}>
        <option value="literal">value</option><option value="primary_key" disabled={!keys.length}>exact primary key</option>
      </select></label>
      {mode === "literal" ? <label>column <select aria-label="search columns" value={column} onChange={(event) => { onDraft({ ...draft, column: event.target.value }); onEdit(); }}>
        <option value="">all searchable columns</option>{columns.map((c) => <option key={c.name} value={JSON.stringify(c.name)}>{c.name}</option>)}
      </select></label> : null}
      {mode === "literal" && <label className="source-find__case"><input type="checkbox" checked={draft.matchCase ?? false}
        onChange={(event) => { onDraft({ ...draft, matchCase: event.target.checked }); onEdit(); }} /> match case</label>}
      {mode === "literal" ? null : keys.map((key) => <div className="source-find__line" key={key.name}><label>{key.name}
        <input aria-label={`exact ${key.name}`} value={component(key.name).exact} maxLength={1024} onChange={(event) => {
          onDraft({ ...draft, values: { ...values, [key.name]: { ...component(key.name), exact: event.target.value } } }); onEdit();
        }} />
      </label><select aria-label={`${key.name} storage class`} value={component(key.name).storage_class} onChange={(event) => {
        onDraft({ ...draft, values: { ...values, [key.name]: { ...component(key.name), storage_class: event.target.value as "integer" | "text" } } }); onEdit();
      }}><option value="integer">INTEGER</option><option value="text">TEXT</option></select></div>)}
      {/* With key fields beside the search box, Enter no longer submits by itself: this does. */}
      {mode === "primary_key" && <button type="submit" className="table__action">look up</button>}
      <p>{mode === "literal" ? `Literal TEXT substring, ${draft.matchCase ? "matching case exactly as recorded" : "ignoring case (full Unicode case folding; accents written differently do not match)"}. INTEGER matches exact decimal integers; finite REAL uses numeric equality. NULL and BLOB contents are excluded. Whitespace is literal. Clearing resumes browsing.` : "All primary-key components are required in their actual INTEGER or TEXT storage class. TEXT is case-sensitive and exact. REAL, NULL and BLOB key lookups are unsupported."}</p>
    </details></div>}
  </form>;
}

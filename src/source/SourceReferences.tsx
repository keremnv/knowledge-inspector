/** Fetch-free evidence panels. Request ownership lives above the Swap boundary. */
import { ReaderAction, ReaderActions } from "../world/ReaderChrome";
import { ReaderDisclosure } from "../world/ReaderDisclosure";
import { TableFooter } from "../world/tableChrome";
import type { SourceContext, SourceFKDeclaration, SourceFKObservation, SourceIncomingCount, SourceIncomingGroup,
  SourceIncomingReferences, SourceReferences } from "../api/source";
import { CaptureDetails, DeclarationDetails, Loading, Problem } from "./SourceDetails";
import { sourceKeyText } from "./sourceField";
import { SourceValue } from "./SourceValue";
import { BulkOutcomeNote, type BulkOutcome } from "./SourceOutcome";
import { declarationExplanation, identityBlocksPlacement, identityExplanation } from "./sourceExplain";

export const REFERENCE_STATUS: Record<SourceFKObservation["status"], string> = {
  resolved: "resolved",
  resolved_unaddressable: "matching row has no verified record identity",
  null_reference: "NULL reference · no target required",
  dangling: "no matching record in this capture",
  ambiguous: "multiple matching records · no single target",
  invalid_declaration: "invalid reference declaration",
  unsupported: "reference could not be checked",
  budget_exceeded: "reference check incomplete · query limit reached",
};
export function addressableReference(observation: SourceFKObservation): boolean {
  return observation.status === "resolved" && observation.declaration.validation.status === "verified_declaration" && !!observation.parent?.record_id &&
    observation.parent.identity.status === "verified";
}
export function referenceName(observation: SourceFKObservation): string {
  return `FK ${observation.declaration.recorded_id} · ${observation.declaration.child_table} → ${observation.declaration.parent_table ?? "unresolved parent table"}`;
}

/**
 * What the canvas draws (owner decisions O1, O2): a connection is a reference
 * someone followed or expanded, and nothing more. Said where connections are
 * inspected and where the canvas's drawing is chosen, never as a banner.
 */
export const CANVAS_CONNECTIONS = "Connections on the canvas are references you followed or expanded. Other recorded references between these records may not be drawn.";

/**
 * Each end of a drawn connection, as the Reader names it: the record holding
 * the reference and the record it references, by their exact keys (O17 keeps
 * keys in the evidence; the canvas name is the hover, as on a dotted value).
 */
export type ReferenceEnds = { child: string; parent: string; onChild: () => void; onParent: () => void };

export function ReferenceEvidence({ observation, detailed = false, ends }: { observation: SourceFKObservation; detailed?: boolean; ends?: ReferenceEnds }) {
  const fk = observation.declaration;
  const parentText = <>{observation.parent?.name ?? fk.parent_table ?? fk.recorded_pairs[0]?.table ?? "unresolved table"}
    {observation.parent && <> · {observation.parent.key.length ? sourceKeyText(observation.parent.key) : "row without a verified key"}</>}</>;
  const childText = `${observation.grounding.table} · ${sourceKeyText(observation.grounding.key)}`;
  return <div className="source-reference-evidence">
    {ends && <p className="source-reference-from" data-reference-child>from <button type="button" className="source-reach" title={ends.child}
      aria-label={`go to ${childText}, the record holding this reference`} onClick={ends.onChild}>{childText}</button></p>}
    <dl className="source-facts">{observation.child_values.map((cell) => <div key={cell.column}>
      <dt>{cell.column}</dt><dd><SourceValue value={cell} /></dd>
    </div>)}</dl>
    <p className="source-reference-target" data-reference-parent>→ {ends ? <button type="button" className="source-reach" title={ends.parent}
      aria-label={`go to ${observation.parent?.name ?? "the referenced record"}, the record this references`} onClick={ends.onParent}>{parentText}</button> : parentText}</p>
    <p className={`source-reference-status${observation.status === "resolved" || observation.status === "null_reference" ? " source-note" : " source-reference-status--blocked"}`} data-reference-status={observation.status}>{REFERENCE_STATUS[observation.status]}</p>
    {fk.validation.status !== "verified_declaration" && <p className="source-limitation" data-declaration-limit>{declarationExplanation(fk.validation.reason)}
      <small> · declaration <code>{fk.validation.status}</code>{fk.validation.reason && <> · <code>{fk.validation.reason}</code></>}</small></p>}
    {detailed && <ReaderDisclosure className="source-details" label="reference details">
      <dl className="reader-metadata"><dt>reference</dt><dd>{referenceName(observation)}</dd>
        <dt>resolution</dt><dd><code>{observation.status}</code>{observation.reason && <> · <code>{observation.reason}</code></>}</dd></dl>
      <table className="source-reference-pairs"><caption>ordered child → parent column pairs</caption>
        <thead><tr><th>position</th><th>child column / recorded value</th><th>parent column / matched value</th></tr></thead>
        <tbody>{fk.pairs.map((pair) => {
          const child = observation.child_values.find((value) => value.column === pair.child_column);
          const target = observation.parent?.target_values.find((value) => value.column === pair.parent_column);
          return <tr key={pair.seq}><td>{pair.seq + 1}</td><td>{pair.child_column ?? "unresolved column"}
            {child ? <SourceValue value={child} detailed /> : <small>value unavailable</small>}</td>
            <td>{pair.parent_column ?? "unresolved column"}{target ? <SourceValue value={target} detailed /> : <small>no matched value</small>}
            <small>{pair.target_basis}</small></td></tr>;
        })}</tbody></table>
      <DeclarationDetails fk={fk} />
      {!fk.pairs.length && <dl className="source-facts">{observation.child_values.map((cell) => <div key={cell.column}><dt>{cell.column}</dt><dd><SourceValue value={cell} detailed /></dd></div>)}</dl>}
      {observation.parent && <><dl className="reader-metadata"><dt>parent identity</dt><dd>{observation.parent.identity.status}{observation.parent.identity.reason && ` · ${observation.parent.identity.reason}`}</dd></dl>
        <dl className="source-facts">{observation.parent.key.map((cell) => <div key={cell.column}><dt>{cell.column}</dt><dd><SourceValue value={cell} detailed /></dd></div>)}</dl>
        <dl className="reader-metadata"><dt>parent handle</dt><dd><code>{observation.parent.record_id ?? "unavailable"}</code></dd></dl></>}
      <h3>observation grounding</h3><dl className="reader-metadata">
        <dt>observation</dt><dd><code>{observation.observation_id}</code></dd>
        <dt>child handle</dt><dd><code>{observation.child_record_id}</code></dd>
        <dt>child key</dt><dd>{sourceKeyText(observation.grounding.key)}</dd>
        <dt>grounding basis</dt><dd><code>{observation.grounding.basis}</code></dd>
        <dt>captured row</dt><dd>{observation.grounding.schema}.{observation.grounding.table}</dd>
        <dt>capture SHA-256</dt><dd><code>{observation.grounding.capture_digest}</code></dd>
        <dt>generation</dt><dd><code>{observation.grounding.generation}</code></dd>
        <dt>comparison basis</dt><dd><code>{observation.comparison_basis}</code></dd>
      </dl><p className="source-note">Resolution describes this capture under the checked SQLite parent-affinity and collation rules, not independent factual verification.</p>
    </ReaderDisclosure>}
  </div>;
}

export function OutgoingReferences({ page, error, offset, onPage, onInspect, onRetry, bare = false }: {
  page?: SourceReferences; error?: Error; offset: number;
  onPage: (offset: number) => void; onInspect: (observation: SourceFKObservation) => void; onRetry?: () => void;
  /** Inside a disclosure that already names it: no heading of its own. */
  bare?: boolean;
}) {
  return <section className="world-reader__section source-outgoing" aria-label="outgoing references">{!bare && <h3>references{page && page.total > 0 && <small> · {page.total} declared</small>}</h3>}
    {error ? <Problem error={error} onRetry={onRetry} /> : !page ? <Loading /> : page.total === 0 ? <p className="source-note">none declared</p> : page.observations.map((observation) => <article className="source-fk" key={observation.observation_id}>
      <ReferenceEvidence observation={observation} />
      <ReaderAction bleed aria-label={`inspect FK ${observation.declaration.recorded_id} reference`} onClick={() => onInspect(observation)}>inspect reference</ReaderAction>
    </article>)}
    <TableFooter role="navigation" className="table__foot table__pager source-pager" aria-label="outgoing reference pages" hidden={!!page && page.total <= 10 && offset === 0}>
      <button type="button" aria-disabled={offset === 0 || !page && !error} onClick={() => { if (offset > 0 && (page || error)) onPage(Math.max(0, offset - 10)); }}>previous references</button>
      <span>{page ? `${page.total ? offset + 1 : 0}–${offset + page.observations.length} of ${page.total} constraints${page.has_more ? " · more available" : ""}` : error ? "page unavailable" : "loading…"}</span>
      <button type="button" aria-disabled={!page?.has_more} onClick={() => { if (page?.has_more) onPage(page.next_offset!); }}>next references</button>
    </TableFooter>
  </section>;
}

export function incomingColumns(fk: SourceFKDeclaration): string {
  return (fk.pairs.length ? fk.pairs.map((pair) => pair.child_column ?? "unresolved column") : fk.recorded_pairs.map((pair) => pair.from)).join(", ");
}
/** A declaration seen from its parent: the child table and its FK columns. */
export function incomingName(fk: SourceFKDeclaration): string {
  return `${fk.child_table} · ${incomingColumns(fk)}`;
}
/** Unavailable or not checked is never zero, and an exact zero is never "unavailable". */
export function incomingCountText(count: SourceIncomingCount): string {
  if (count.status === "exact") return `${count.value} ${count.value === 1 ? "row" : "rows"}`;
  if (count.status === "invalid_declaration") return "no count · invalid declaration";
  if (count.status === "not_checked") return "count not checked · page limit reached";
  return count.reason === "source_query_budget_exceeded" ? "count unavailable · query limit reached"
    : count.reason === "incoming_page_budget_exceeded" ? "count unavailable · page limit reached"
    : count.reason === "child_blob_matching_budget_exceeded" ? "count unavailable · BLOB values too large to check"
    : "count unavailable";
}
export function incomingBrowsable(group: SourceIncomingGroup): boolean {
  return group.declaration.validation.status === "verified_declaration" && !(group.count.status === "exact" && group.count.value === 0);
}

/** One line per declaration that names this record's table, as World lists a
 * referent's relations. Opening a line reads its rows in the Tables dock; it
 * places nothing on the canvas. */
export function IncomingReferences({ page, error, offset, open, onPage, onOpen, onRetry }: {
  page?: SourceIncomingReferences; error?: Error; offset: number; open?: string | null;
  onPage: (offset: number) => void; onOpen: (group: SourceIncomingGroup, keyboard: boolean) => void; onRetry?: () => void;
}) {
  const groups = page?.groups ?? [];
  const listed = groups.filter(incomingBrowsable);
  const absent = groups.filter((group) => group.count.status === "exact" && group.count.value === 0 &&
    group.declaration.validation.status === "verified_declaration");
  const limited = groups.filter((group) => group.declaration.validation.status !== "verified_declaration");
  return <section className="world-reader__section world-reader__section--list source-incoming" aria-label="incoming references"><h3>referenced by{page && page.total > 0 && <small> · {page.total} declared</small>}</h3>
    {error ? <Problem error={error} onRetry={onRetry} /> : !page ? <Loading /> : page.total === 0 ? <p className="source-note world-reader__absent">none declared</p> : <>
      {listed.length > 0 && <ul className="gm__list">{listed.map((group) => {
        const fk = group.declaration, current = open === fk.declaration_id;
        return <li key={fk.declaration_id}><button type="button" className={current ? "is-selected" : undefined} aria-pressed={current}
          aria-label={`${incomingName(fk)}, ${incomingCountText(group.count)}, open in tables`} title={group.count.reason ?? undefined}
          onClick={(event) => onOpen(group, event.detail === 0)}>
          <span className="gm__list-name">{incomingName(fk)}</span>
          <span className="gm__list-meta" data-incoming-count={group.count.status}>{group.count.status === "exact" ? group.count.value : incomingCountText(group.count)} · table</span>
        </button></li>;
      })}</ul>}
      {absent.length > 0 && <p className="world__note world-reader__absent" data-incoming-absent>No rows in this capture reference this record through {absent.map((group) => incomingName(group.declaration)).join("; ")}.</p>}
      {limited.map((group) => <p className="source-limitation world-reader__absent" key={group.declaration.declaration_id} data-declaration-limit>
        {incomingName(group.declaration)} · {declarationExplanation(group.declaration.validation.reason)} No count, and its rows are not followed.
        <small> · declaration <code>{group.declaration.validation.status}</code>{group.declaration.validation.reason && <> · <code>{group.declaration.validation.reason}</code></>}</small></p>)}
    </>}
    <TableFooter role="navigation" className="table__foot table__pager source-pager" aria-label="incoming reference pages" hidden={!!page && page.total <= 10 && offset === 0}>
      <button type="button" aria-disabled={offset === 0 || !page && !error} onClick={() => { if (offset > 0 && (page || error)) onPage(Math.max(0, offset - 10)); }}>previous declarations</button>
      <span>{page ? `${page.total ? offset + 1 : 0}–${offset + page.groups.length} of ${page.total} declarations` : error ? "page unavailable" : "loading…"}</span>
      <button type="button" aria-disabled={!page?.has_more} onClick={() => { if (page?.has_more) onPage(page.next_offset!); }}>next declarations</button>
    </TableFooter>
  </section>;
}

/** Hiding is display only; it never stands for a change to the recorded data. */
export const HIDE_CONNECTION = "hide connection on canvas · the recorded reference is unchanged";

/**
 * World's "expand through" (O8.9): each group of records referencing this one
 * through a declaration, placed on the canvas with its connections in one
 * action, and taken back the same way. Acting on the canvas comes before
 * reading the rows, as in World, so it stands above "referenced by".
 */
export function ExpandThrough({ page, state, onExpand, onTakeBack }: {
  page?: SourceIncomingReferences;
  state: (group: SourceIncomingGroup) => { shown: boolean; running: number | null; outcome?: BulkOutcome };
  onExpand: (group: SourceIncomingGroup) => void;
  onTakeBack: (group: SourceIncomingGroup) => void;
}) {
  const groups = (page?.groups ?? []).filter(incomingBrowsable);
  if (!groups.length) return null;
  return <section className="world-reader__section world-reader__section--list source-expand" aria-label="expand through"><h3>expand through</h3>
    <ul className="gm__list">{groups.map((group) => {
      const fk = group.declaration, { shown, running, outcome } = state(group);
      // Known before the click: the service says this table's rows cannot have
      // a record identity in this session. The count still stands, and the
      // rows stay readable through "referenced by" below.
      const limit = !shown && identityBlocksPlacement(group.child_identity) ? identityExplanation(group.child_identity) : null;
      const count = group.count.status === "exact" ? group.count.value : incomingCountText(group.count);
      return <li key={fk.declaration_id}><button type="button" className={shown ? "is-selected" : undefined} aria-pressed={shown}
        disabled={running !== null} aria-busy={running !== null || undefined} aria-disabled={limit ? true : undefined}
        aria-label={`${incomingName(fk)}, ${shown ? "take off the canvas" : limit ? `${incomingCountText(group.count)}, cannot be placed: ${limit.short}`
          : `${incomingCountText(group.count)}, place on the canvas`}`}
        onClick={() => limit ? undefined : shown ? onTakeBack(group) : onExpand(group)}>
        <span className="gm__list-name">{incomingName(fk)}</span>
        <span className="gm__list-meta" data-expand-state={shown ? "shown" : running !== null ? "running" : limit ? "unplaceable" : "available"}>
          {shown ? "take off" : running !== null ? `expanding… ${running}` : limit ? <>{count} · not placeable</> : count}</span>
      </button>
      {limit && !outcome && <p className="source-limitation" data-expand-limit>{fk.child_table} rows cannot be placed · {limit.short} · they can be read under "referenced by"
        <small> · <code>{group.child_identity!.status}</code>{group.child_identity!.reason && <> · <code>{group.child_identity!.reason}</code></>}</small></p>}
      {outcome && running === null && <BulkOutcomeNote outcome={outcome} />}</li>;
    })}</ul>
  </section>;
}

export function ReferenceActions({ observation, visible, pending, childReady, onOpenParent, onShow, onHide, onCancel }: {
  observation: SourceFKObservation; visible: boolean; pending: boolean; childReady: boolean;
  onOpenParent: () => void; onShow: () => void; onHide: () => void; onCancel: () => void;
}) {
  return (
    <ReaderActions className="world-reader__actions source-reference-actions">{addressableReference(observation) && <>
      <ReaderAction onClick={onOpenParent}>open referenced record</ReaderAction>
      <ReaderAction data-reference-show disabled={pending || !childReady} onClick={onShow}>{visible ? "reveal connection" : "show connection"}</ReaderAction>
    </>}
    {visible && <ReaderAction data-reference-hide title={HIDE_CONNECTION} onClick={onHide}>hide connection</ReaderAction>}
    {pending && <ReaderAction onClick={onCancel}>cancel placement</ReaderAction>}
    </ReaderActions>
  );
}

export function ReferenceDetails({ observation, context, pending, error, childReady, childError, onRetryChild, onRetryPlacement, ends, drawn = false }: {
  observation: SourceFKObservation; context: SourceContext; pending: boolean; error?: Error; childReady: boolean; childError?: Error;
  onRetryChild?: () => void;
  /** Ask again for the placement that failed (`error`): the same show connection. */
  onRetryPlacement?: () => void;
  /** Both ends, when the reference resolves to a record that can be opened. */
  ends?: ReferenceEnds;
  /** Whether this reference is drawn on the canvas now. */
  drawn?: boolean;
}) {
  return <>
    {addressableReference(observation) && !childReady && !childError && <p role="status">loading child record…</p>}
    {childError && <Problem error={childError} onRetry={onRetryChild} />}
    {pending && <p role="status">loading referenced record…</p>}
    {error && <div className="source-placement-problem" data-placement-problem><Problem error={error} onRetry={onRetryPlacement} /></div>}
    <ReferenceEvidence observation={observation} detailed ends={addressableReference(observation) ? ends : undefined} />
    {drawn && <p className="source-note" data-canvas-connections>{CANVAS_CONNECTIONS}</p>}
    <CaptureDetails context={context} />
  </>;
}

/** Fetch-free evidence panels. Request ownership lives above the Swap boundary. */
import { ReaderAction, ReaderActions } from "../world/ReaderChrome";
import { ReaderDisclosure } from "../world/ReaderDisclosure";
import type { SourceContext, SourceFKDeclaration, SourceFKObservation, SourceIncomingCount, SourceIncomingGroup } from "../api/source";
import { CaptureDetails, DeclarationDetails, Loading, Problem } from "./SourceDetails";
import { sourceKeyText } from "./sourceField";
import { SourceValue } from "./SourceValue";
import { declarationExplanation } from "./sourceExplain";

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

/**
 * The declared outgoing references, every one, statuses and all: the complete
 * list behind "references" (decision 4). The record's values reach what
 * resolves; this list is where a NULL, dangling or unchecked reference is audited.
 */
export function OutgoingReferences({ observations, total, done, capped, error, onInspect, onRetry }: {
  observations?: SourceFKObservation[]; total: number | null; done: boolean; capped?: boolean; error?: Error;
  onInspect: (observation: SourceFKObservation) => void; onRetry?: () => void;
}) {
  return <section className="world-reader__section source-outgoing" aria-label="outgoing references">
    {!observations ? error ? <Problem error={error} onRetry={onRetry} /> : <Loading /> : total === 0 ? null : observations.map((observation) => <article className="source-fk" key={observation.observation_id}>
      <ReferenceEvidence observation={observation} />
      <ReaderAction bleed aria-label={`inspect FK ${observation.declaration.recorded_id} reference`} onClick={() => onInspect(observation)}>inspect reference</ReaderAction>
    </article>)}
    {observations && <DiscoveryState done={done} capped={capped} error={error} onRetry={onRetry} />}
  </section>;
}

/** Said only while a list is incomplete: still reading, stopped at its limit, or a page failed. */
export function DiscoveryState({ done, capped, error, onRetry }: { done: boolean; capped?: boolean; error?: Error; onRetry?: () => void }) {
  if (error) return <div className="source-discovery" data-discovery="incomplete"><small className="source-limitation">coverage incomplete</small> <Problem error={error} onRetry={onRetry} /></div>;
  if (capped) return <p className="source-discovery" data-discovery="capped"><small className="source-limitation">coverage incomplete · declaration limit</small></p>;
  if (!done) return <p className="source-discovery" role="status" data-discovery="checking"><small>checking declarations…</small></p>;
  return null;
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

/**
 * The incoming declarations that lead somewhere (decision 4): each with rows,
 * or whose count is not known, as World lists a referent's relations, plus an
 * invalid declaration as the exception it is. A declaration with an exact zero
 * is silent here; the complete list, zeros included, is under "references".
 * Groups show as their pages arrive. Following a group with exactly one row
 * opens that row; any other group opens in Tables.
 */
export function IncomingReferences({ groups, done, capped, error, open, following, onFollow, onRetry }: {
  groups?: SourceIncomingGroup[]; done: boolean; capped?: boolean; error?: Error; open?: string | null; following?: string | null;
  onFollow: (group: SourceIncomingGroup, keyboard: boolean) => void; onRetry?: () => void;
}) {
  const listed = (groups ?? []).filter(incomingBrowsable);
  const limited = (groups ?? []).filter((group) => group.declaration.validation.status !== "verified_declaration");
  if (groups && done && !error && !capped && !listed.length && !limited.length) return null;
  return <section className="world-reader__section world-reader__section--list source-incoming" aria-label="incoming references"><h3>referenced by</h3>
    {!groups ? error ? <Problem error={error} onRetry={onRetry} /> : <Loading /> : <>
      {listed.length > 0 && <ul className="gm__list">{listed.map((group) => {
        const fk = group.declaration, current = open === fk.declaration_id, busy = following === fk.declaration_id;
        return <li key={fk.declaration_id}><button type="button" className={current ? "is-selected" : undefined} aria-pressed={current}
          aria-busy={busy || undefined} aria-label={`${incomingName(fk)}, ${incomingCountText(group.count)}`} title={group.count.reason ?? undefined}
          onClick={(event) => onFollow(group, event.detail === 0)}>
          <span className="gm__list-name">{incomingName(fk)}</span>
          <span className="gm__list-meta" data-incoming-count={group.count.status}>{group.count.status === "exact" ? group.count.value : incomingCountText(group.count)}</span>
        </button></li>;
      })}</ul>}
      {limited.map((group) => <p className="source-limitation world-reader__absent" key={group.declaration.declaration_id} data-declaration-limit>
        {incomingName(group.declaration)} · {declarationExplanation(group.declaration.validation.reason)} No count, and its rows are not followed.
        <small> · declaration <code>{group.declaration.validation.status}</code>{group.declaration.validation.reason && <> · <code>{group.declaration.validation.reason}</code></>}</small></p>)}
      <DiscoveryState done={done} capped={capped} error={error} onRetry={onRetry} />
    </>}
  </section>;
}

/** Every incoming declaration with its count, zeros included: the complete list under "references". */
export function IncomingLedger({ groups }: { groups?: SourceIncomingGroup[] }) {
  if (!groups?.length) return null;
  return <section className="world-reader__section source-incoming-ledger" aria-label="incoming declarations"><h4>referenced through</h4>
    <dl className="source-facts">{groups.map((group) => <div key={group.declaration.declaration_id} data-incoming-ledger={group.count.status}>
      <dt>{incomingName(group.declaration)}</dt><dd>{group.count.status === "exact" ? group.count.value : incomingCountText(group.count)}</dd>
    </div>)}</dl>
  </section>;
}

/** Hiding is display only; it never stands for a change to the recorded data. */
export const HIDE_CONNECTION = "hide connection on canvas · the recorded reference is unchanged";

export function ReferenceActions({ observation, visible, pending, childReady, onShow, onHide, onCancel }: {
  observation: SourceFKObservation; visible: boolean; pending: boolean; childReady: boolean;
  onShow: () => void; onHide: () => void; onCancel: () => void;
}) {
  return (
    <ReaderActions className="world-reader__actions source-reference-actions">
    {addressableReference(observation) && <ReaderAction data-reference-show disabled={pending || !childReady} onClick={onShow}>{visible ? "reveal connection" : "show connection"}</ReaderAction>}
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

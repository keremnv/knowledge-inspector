import type { ReactNode } from "react";
import type { SourceCatalogue, SourceCell, SourceColumn, SourceContext, SourceFKDeclaration, SourceFKObservation, SourceIdentity, SourceRecord, SourceRow } from "../api/source";
import { sourceKeyLabel } from "./sourceField";
import { SourceValue } from "./SourceValue";
import { ReaderDisclosure } from "../world/ReaderDisclosure";
import { TableAction } from "../world/tableChrome";
import { declarationExplanation, identityExplanation, readFailure } from "./sourceExplain";

type Relation = SourceCatalogue["relations"][number];

/**
 * A failed read, said plainly, with its code in the details. Fetch-free:
 * retained Swap snapshots never initiate reads. `onRetry` asks the owning read
 * to repeat once, and is offered only where repeating can help (busy,
 * unreachable, a server fault); a read over its budget gets `narrow`, the way
 * to ask a smaller question, and a stopped context gets nothing here.
 */
export function Problem({ error, onRetry, narrow }: { error: Error; onRetry?: () => void; narrow?: string }) {
  const failure = readFailure(error);
  return <>
    <p className="source-problem" role="alert">{failure.sentence}{failure.recovery === "narrow" && narrow ? ` ${narrow}` : ""}
      {failure.code && <> <small className="source-problem__code">details · <code>{failure.code}</code>{failure.detail && ` · ${failure.detail}`}</small></>}</p>
    {onRetry && failure.recovery === "retry" && <TableAction className="source-retry" data-retry onClick={onRetry}>try again</TableAction>}
  </>;
}
export function Loading() { return <p role="status">loading…</p>; }

export function identityLimitation(identity?: SourceIdentity): string | null {
  return identityExplanation(identity)?.short ?? null;
}

export function Identity({ identity }: { identity: SourceIdentity }) {
  return <dl className="reader-metadata">
    <dt>identity</dt><dd>{identity.status}</dd>
    {identity.reason && <><dt>reason</dt><dd><code>{identity.reason}</code></dd></>}
    <dt>verified rows</dt><dd>{identity.verified_rows ?? "not established"}</dd>
  </dl>;
}

export function CaptureDetails({ context }: { context: SourceContext }) {
  return <ReaderDisclosure className="source-details" label="source details">
    <dl className="reader-metadata"><dt>captured</dt><dd>{context.captured_at}</dd>
      <dt>time basis</dt><dd>capture observation, not producer commit time</dd>
      <dt>source namespace</dt><dd><code>{context.source_namespace}</code></dd>
      <dt>generation</dt><dd><code>{context.generation}</code></dd>
      <dt>capture SHA-256</dt><dd><code>{context.capture_digest}</code></dd>
      <dt>session</dt><dd><code>{context.session}</code></dd>
      <dt>idle expiry</dt><dd>{context.idle_ttl_seconds === null ? "none" : `${context.idle_ttl_seconds} seconds`}</dd>
      <dt>formats</dt><dd>{context.capture_version} · {context.projection_version} · SQLite {context.sqlite_version}</dd></dl>
    <p className="source-note">Fixed capture. A new capture requires an operator restart and explicit workspace reopening.</p>
  </ReaderDisclosure>;
}

export function DeclarationDetails({ fk }: { fk: SourceFKDeclaration }) {
  return <><dl className="reader-metadata">
    <dt>recorded FK</dt><dd>{fk.recorded_id}</dd>
    <dt>recorded constraint</dt><dd>{fk.recorded_pairs.map((pair) => `${pair.seq + 1}. ${pair.from} → ${pair.table}.${pair.to ?? "(target omitted)"}`).join("; ")}</dd>
    <dt>resolved pairs</dt><dd>{fk.pairs.map((pair) => `${pair.seq + 1}. ${pair.child_column ?? "unknown"} → ${pair.parent_column ?? "unknown"} (${pair.target_basis})`).join("; ") || "unavailable"}</dd>
    <dt>ON UPDATE</dt><dd>{fk.on_update}</dd><dt>ON DELETE</dt><dd>{fk.on_delete}</dd><dt>MATCH</dt><dd>{fk.match}</dd>
    <dt>declaration check</dt><dd><code>{fk.validation.status}</code>{fk.validation.reason && ` · ${fk.validation.reason}`}</dd>
    <dt>declaration</dt><dd><code>{fk.declaration_id}</code></dd>
  </dl><p className="source-note">Historical enforcement is not established.</p></>;
}

export function TableDetails({ relation, identity }: { relation: Relation; identity?: SourceIdentity }) {
  const state = identity ?? relation.identity;
  const limitation = identityLimitation(state);
  return <>
    {relation.read_status === "unsupported" && <p role="alert">read unavailable · {relation.reason}</p>}
    {(relation.primary_key === undefined || (relation.primary_key.length > 1 || !relation.columns) && relation.primary_key.length > 0) &&
      <p className="source-table-key"><span>key · </span>{relation.primary_key?.join(" + ") ?? "metadata unavailable"}</p>}
    {limitation && <p className="source-limitation">{limitation} · rows stay on this page</p>}
    {limitation && <p className="source-note" data-identity-explanation>{identityExplanation(state)!.sentence}</p>}
    <h3>columns</h3>
    {relation.columns ? <dl className="source-columns source-facts">{relation.columns.map((column) => <div key={column.name}>
      <dt>{column.name}</dt><dd className="source-column-type"><code>{column.declared_type || "not declared"}</code>
        {column.pk_order > 0 && relation.primary_key?.length === 1 && <small>key</small>}</dd>
    </div>)}</dl> : <p>column metadata unavailable</p>}
    {relation.foreign_keys === undefined ? <p>reference metadata unavailable</p> : relation.foreign_keys.length ? <section className="world-reader__section">
      <h3>references</h3>
      {relation.foreign_keys.map((fk) => <ReaderDisclosure className="source-fk" key={fk.declaration_id} label={<>
        <span className="source-schema-reference">{fk.recorded_pairs.map((pair) => `${pair.from} → ${pair.table}.${pair.to ?? "(implicit key)"}`).join("; ")}</span>
        {fk.validation.status !== "verified_declaration" && <small className="source-limitation" data-declaration-limit>{fk.validation.status} declaration</small>}
      </>}>
        {fk.validation.status !== "verified_declaration" && <p className="source-limitation">{declarationExplanation(fk.validation.reason)} It stays listed as recorded; it is not followed.</p>}
        <DeclarationDetails fk={fk} />
      </ReaderDisclosure>)}
    </section> : <p className="source-note">references · none declared</p>}
    <ReaderDisclosure className="source-details" label="schema details">
      <Identity identity={state} />
      <dl className="reader-metadata"><dt>row count</dt><dd>not computed</dd></dl>
      <p className="source-note">Declared types are schema metadata; values can have other SQLite storage classes.</p>
      {relation.columns?.map((column) => <section className="source-column-constraints" key={column.name}>
        <h4>{column.name}</h4><dl className="reader-metadata">
          <dt>PK position</dt><dd>{column.pk_order}</dd>
          <dt>NOT NULL</dt><dd>{column.notnull ? "recorded" : "not recorded"}</dd>
          <dt>default SQL</dt><dd>{column.default_sql !== null ? <code>{column.default_sql}</code> : "not declared"}</dd>
          {column.generated && <><dt>column kind</dt><dd>generated {column.generated}</dd></>}
        </dl>
      </section>)}
      {relation.kind === "view" && <><h3>recorded view SQL</h3><pre>{relation.view_sql ?? "definition unavailable"}</pre><p>Computed output; lineage not recorded.</p></>}
    </ReaderDisclosure>
  </>;
}

export function RecordDetails({ row, relation, context, record, identity, columns, children, reach, onReach, nameOf }: {
  row: SourceRow; relation: Relation; context: SourceContext; record?: SourceRecord; identity?: SourceIdentity; columns?: SourceColumn[]; children?: ReactNode;
  /** A value that names a record this one reaches, by column: World's role value naming a disc. */
  reach?: ReadonlyMap<string, SourceFKObservation>;
  onReach?: (observation: SourceFKObservation) => void;
  /** A record's name (O17), for the record a dotted value reaches. */
  nameOf?: (table: string, key: SourceCell[], recordId: string | null) => string;
}) {
  const schema = record?.columns ?? columns ?? relation.columns;
  const state = record?.identity ?? identity;
  return <>
    <dl className="source-cells source-facts">{row.cells.map((cell) => <div key={cell.column}>
      <dt>{cell.column}{record?.key.some((key) => key.column === cell.column) && <small>key</small>}</dt><dd>{(() => {
        // World's reader: a value naming a disc is a button, dotted and muted,
        // that goes to it; any other value stays text.
        const reached = reach?.get(cell.column);
        return reached && onReach ? <button type="button" className="source-reach" title={nameOf ? nameOf(reached.parent!.name, reached.parent!.key, reached.parent!.record_id) : sourceKeyLabel(reached.parent!.name, reached.parent!.key)}
          aria-label={`go to ${reached.parent!.name} referenced by ${cell.column}`} onClick={() => onReach(reached)}><SourceValue value={cell} /></button> : <SourceValue value={cell} />;
      })()}</dd>
    </div>)}</dl>
    {children}
    <ReaderDisclosure className="source-details" label="value details">
      <dl className="source-facts">{row.cells.map((cell) => {
        const column = schema?.find((item) => item.name === cell.column);
        return <div key={cell.column}><dt>{cell.column}</dt><dd><SourceValue value={cell} detailed />
          <small>declared type · {column ? column.declared_type || "not declared" : "metadata unavailable"}{column?.generated && ` · generated ${column.generated}`}</small></dd></div>;
      })}</dl>
    </ReaderDisclosure>
    <ReaderDisclosure className="source-details" label="identity details">
      {state && <Identity identity={state} />}
      {record ? <><p className="source-note">Source grounding supports addressability, not independent factual verification or semantic endorsement.</p>
        <dl className="reader-metadata"><dt>registered handle</dt><dd><code>{record.record_id}</code></dd><dt>source</dt><dd>{record.grounding.schema}.{record.grounding.table}</dd>
          <dt>capture SHA-256</dt><dd><code>{record.grounding.capture_digest}</code></dd><dt>generation</dt><dd><code>{record.grounding.generation}</code></dd></dl></>
        : <p>No registered source handle. This selection is local to this window; its position is not a persistent record identity.{relation.kind === "view" && " Computed output; lineage not recorded."}</p>}
    </ReaderDisclosure>
    <CaptureDetails context={context} />
  </>;
}

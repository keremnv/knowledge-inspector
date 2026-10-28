import type { WorldReading } from "../api/world";

/** Only this descriptor establishes external-reader attribution. No fallback. */
export function verifiedReading(reading?: WorldReading): reading is WorldReading {
  return !!reading && reading.interpretation_source === "external_reader_declaration" && reading.adapter === "generic_sqlite_v1";
}

/**
 * The generic bridge's compatibility defaults, and only those.
 *
 * `revision 1` and `BASE` mode are values the generic SQLite adapter fills in
 * to satisfy the World interface; SQLite has no revision history and the
 * adapter makes no BASE-semantics claim. Printing them in a header reads as if
 * the producer recorded them, so a verified generic reading leaves exactly
 * these two values out of its prominent summaries (the API still reports
 * them, and "Adapter compatibility values" below says so).
 *
 * The test is the verified descriptor, never the value or an id prefix: a
 * World with no descriptor keeps printing its revision and mode, because
 * another producer may have recorded them. A value other than the documented
 * default is printed even here, since it is not the adapter's default.
 */
export function shownRevision(reading: WorldReading | undefined, revision: number): number | null {
  return verifiedReading(reading) && revision === 1 ? null : revision;
}

/** The lower-cased mode, or null where it is the generic bridge's default. */
export function shownMode(reading: WorldReading | undefined, mode: string): string | null {
  return verifiedReading(reading) && mode === "BASE" ? null : mode.toLowerCase();
}

/**
 * The persistent qualification: this World's names and roles are an
 * interpretation supplied by an external reader declaration, not source facts.
 *
 * It says only what the descriptor establishes. It does not say who the
 * reader is, that a person wrote it, that the interpretation is correct, or
 * that the database's producer endorses it. Absent where there is no verified
 * descriptor: a World without one makes no such claim.
 */
export function ReadingBadge({ reading }: { reading?: WorldReading }) {
  if (!verifiedReading(reading)) return null;
  return (
    <span
      className="product-shell__local world__reading-badge"
      role="note"
      title="The relation names, roles and labels in this World are an interpretation supplied by an external reader declaration. SQLite rows and locators are the source; the declaration is not, and nothing here establishes producer endorsement. Details: Reading attribution."
    >
      Reader-declared interpretation
    </span>
  );
}

/**
 * The same qualification, in the docks where the names are read.
 *
 * The bar is chrome: it recedes in focus and sheds cells when the docks leave
 * it little room, so it cannot be the only place this appears. The catalogue
 * dock and every reader panel carry it where the declared names are printed.
 * Quiet by design: one short line per panel, never per row.
 */
export function ReadingQualifier({ reading }: { reading?: WorldReading }) {
  if (!verifiedReading(reading)) return null;
  return (
    <p className="world-reader__qualifier" role="note">
      Reader-declared interpretation
    </p>
  );
}

/** How a display-label column came to be chosen, from the descriptor alone. */
function labelChoice(source: WorldReading["entities"][number]["label_column_source"]): string {
  if (source === "declared") return "declared by the reader";
  if (source === "adapter_default") return "adapter default (the declaration names none, so the first key column stands in)";
  return "provenance of this choice not stated";
}

export function ReadingAttribution({ reading }: { reading?: WorldReading }) {
  if (!verifiedReading(reading)) return null;
  return (
    <details className="world-reading">
      <summary>
        <span>Reading attribution</span>
        <span className="world-reading__qualifier"> · reader-declared interpretation</span>
      </summary>
      <div className="world-reading__body">
        <p>This World is a reading through an external reader declaration.</p>
        <p>Declaration digest (SHA-256): <code>{reading.declaration_digest}</code></p>
        {reading.reader_note !== null ? <p>Reading note supplied by the declaration: {reading.reader_note}</p> : null}
        <p>Structural checks establish source addressability, not semantic correctness, human authorship or producer endorsement.</p>
        <ul>
          {reading.entities.map(entity => <li key={entity.kind}>
            Declared namespace <code>{entity.kind}</code> → SQLite {entity.source.kind} <code>{entity.source.name}</code>; keys: {entity.key_columns.join(", ")}; display-label column: <code>{entity.label_column}</code> ({labelChoice(entity.label_column_source)}).
          </li>)}
        </ul>
        <details>
          <summary>Adapter compatibility values</summary>
          <p>Generic SQLite bridge: revision 1, BASE mode, created revision 1, stale false and assertion state UNKNOWN are adapter defaults. The World interface requires them and the API reports them unchanged; they do not say that the database's producer recorded a revision, declared BASE semantics or made an assessment. For that reason this reading prints neither revision 1 nor BASE mode in its headers, catalogue, tables or readers (any other value would be printed). Commitment IDs echo assertion IDs; warrant bases and candidate associations are empty compatibility shapes. Scope, completeness, governance and demand are absent.</p>
          <p>Source rows and SQLite locators ground navigation. A locator is not a warrant; empty compatibility collections establish no absence of possible evidence or authority.</p>
        </details>
      </div>
    </details>
  );
}

export function RelationAttribution({ reading, name }: { reading?: WorldReading; name: string }) {
  if (!verifiedReading(reading)) return null;
  const relation = reading.relations.find(item => item.name === name);
  if (!relation) return null;
  return (
    <details className="world-reader__section world-attribution">
      <summary>Relation reading attribution</summary>
      <p>Relation name <code>{relation.name}</code> supplied by reader declaration.</p>
      <p>Source: SQLite {relation.source.kind} <code>{relation.source.name}</code>. Source keys: {relation.key_columns.join(", ")}.</p>
      <ul>{relation.roles.map(role => <li key={role.name}>
        Declared role <code>{role.name}</code> → source column <code>{role.column}</code>{role.target_kind === null ? " (scalar)" : `; declared target namespace: ${role.target_kind}`}.
      </li>)}</ul>
      {relation.description !== null ? <p>Description supplied by reader declaration: {relation.description}</p> : null}
      <p>{relation.origin === null ? "No construction origin declared." : `Construction origin supplied by reader declaration: ${relation.origin}.`}</p>
      <p>{relation.occurrence_state === null ? "No occurrence state declared." : `Occurrence state supplied by reader declaration: ${relation.occurrence_state}.`}</p>
      <p>These choices describe the reading. Row values and native locations come from SQLite; declaration validation does not verify meaning.</p>
      <p>Declaration digest: <code>{reading.declaration_digest}</code></p>
    </details>
  );
}

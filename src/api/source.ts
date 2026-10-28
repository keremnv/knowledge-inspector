/** Captured source v1 DTOs. No World semantic aliases.
 * Integer exact values and REAL bits are strings; do not infer identity from cells.
 * See API_CONTRACT.md: /source/v1 reads require an explicit session+generation.
 */
export type SourceScalar =
  | { storage_class: "null"; exact: null }
  | { storage_class: "integer"; exact: string }
  | { storage_class: "text"; exact: string }
  | { storage_class: "real"; ieee754_hex: string; display: string; finite: boolean }
  | { storage_class: "blob"; bytes: number; sha256: string | null; preview_only: true; reason?: string };
export type SourceCell = SourceScalar & { column: string };
export type SourceCapture = {
  source_namespace: string;
  generation: string;
  capture_digest: string;
  capture_version: "sqlite_capture_v1";
  captured_at: string;
  time_basis: "capture_observation_not_producer_commit";
  sqlite_version: string;
};
export type SourceContext = SourceCapture & {
  session: string;
  projection_version: "sqlite_source_v1";
  /** null: no idle expiry (ki open); bounded seconds for the standalone service. */
  idle_ttl_seconds: number | null;
  capabilities: {
    schema: true;
    row_windows: true;
    verified_pk_records: true;
    outgoing_fk_observations: true;
    incoming_fk_observations: boolean;
    conceptual_readings: false;
    browser_refresh: false;
    query_mappings: false;
    keyless_record_handles: false;
    view_record_handles: false;
  };
};
export type SourceEnvelope<T> = { context: SourceContext; data: T };
export type SourceIdentity = {
  /** `interrupted`: this answer's verification was cut short by its request's
   * cap (a find); nothing was registered and a later read tries again. Only an
   * answer says it; a table's remembered state is then `not_started`. */
  status: "not_started" | "checking" | "verified" | "no_declared_key" |
    "view_table_only" | "invalid" | "unsupported" | "budget_exceeded" | "interrupted";
  key_columns: string[];
  verified_rows: number | null;
  reason: string | null;
};
export type SourceColumn = {
  name: string;
  declared_type: string;
  notnull: boolean;
  pk_order: number;
  default_sql: string | null;
  generated: "VIRTUAL" | "STORED" | null;
};
export type SourceFKDeclaration = {
  declaration_id: string;
  child_table: string;
  recorded_id: number;
  recorded_pairs: { seq: number; from: string; table: string; to: string | null }[];
  on_update: string;
  on_delete: string;
  match: string;
  parent_table: string | null;
  pairs: { seq: number; child_column: string | null; parent_column: string | null;
    target_basis: "resolved_parent_pk" | "recorded_target" }[];
  validation: { status: "invalid" | "unsupported" | "verified_declaration"; reason: string | null };
  historical_enforcement: "not_established";
};
export type SourceRow = { record_id: string | null; key: SourceCell[]; cells: SourceCell[] };
export type SourceGrounding = SourceCapture & {
  schema: "main";
  table: string;
  key: SourceCell[];
  basis: "stored_row_verified_declared_pk";
};
export type SourceRecord = SourceRow & {
  record_id: string;
  name: string;
  kind: "source_record";
  schema: "main";
  columns: SourceColumn[];
  identity: SourceIdentity;
  grounding: SourceGrounding;
  actions: { outgoing_references: true; incoming_references: boolean };
};
export type SourceFKObservation = {
  observation_id: string;
  child_record_id: string;
  declaration: SourceFKDeclaration;
  child_values: SourceCell[];
  status: "null_reference" | "invalid_declaration" | "unsupported" | "budget_exceeded" |
    "dangling" | "ambiguous" | "resolved" | "resolved_unaddressable";
  reason: string | null;
  parent: null | { name: string; record_id: string | null; key: SourceCell[];
    identity: SourceIdentity; target_values: SourceCell[] };
  grounding: SourceGrounding;
  comparison_basis: "sqlite_fk_parent_affinity_and_collation";
  historical_enforcement: "not_established";
};
/** Child rows whose declared FK resolves to one parent record. `exact` 0 is
 * an observed absence in this capture; `unavailable` claims nothing. */
export type SourceIncomingCount =
  | { status: "exact"; value: number; reason: null }
  | { status: "unavailable"; value: null; reason: string | null }
  /** The page's aggregate budget was spent before this count started. */
  | { status: "not_checked"; value: null; reason: string }
  | { status: "invalid_declaration"; value: null; reason: string | null };
/** One declaration naming the parent's table. A group has no identity of its
 * own: its members are the outgoing observations (child, declaration). */
export type SourceIncomingGroup = { declaration: SourceFKDeclaration; count: SourceIncomingCount;
  /** The child table's identity as already known, never verified for this answer:
   * a count is not a claim that the rows can be placed. Older services omit it. */
  child_identity?: SourceIdentity | null };
export type SourceIncomingReferences = {
  record_id: string;
  direction: "incoming";
  total: number;
  groups: SourceIncomingGroup[];
  comparison_basis: "sqlite_fk_parent_affinity_and_collation";
  offset: number;
  has_more: boolean;
  next_offset: number | null;
};
export type SourceCatalogue = {
  relations: { name: string; kind: "table" | "view" | "virtual" | "shadow";
    identity: SourceIdentity; read_status: "available" | "unsupported";
    reason: string | null; row_count: null; row_count_status: "not_computed";
    columns?: SourceColumn[]; primary_key?: string[]; foreign_keys?: SourceFKDeclaration[];
    view_sql?: string | null; lineage?: "not_recorded" | null }[];
  total: number;
  offset: number;
  has_more: boolean;
  next_offset: number | null;
  counts: { tables: number; views: number; unsupported_virtual_or_shadow: number };
};
export type SourceRows = {
  name: string;
  kind: "table" | "view";
  columns: SourceColumn[];
  identity: SourceIdentity;
  rows: SourceRow[];
  offset: number;
  returned: number;
  has_more: boolean;
  next_offset: number | null;
  /** `column` when a sort was asked for; see `order`. */
  ordering: "verified_primary_key" | "unspecified_window_only" | "column";
  /** The sort the window was read in, and how its ties were broken. */
  order?: { column: string; desc: boolean; tiebreak: "verified_primary_key" | "row_location" | "unspecified" } | null;
  lineage: "not_recorded" | null;
};
/** One answer of global find (O8.11): the per-table literal search across every table. */
export type SourceFindHit = { table: string; record_id: string | null; key: SourceCell[]; matched_columns: string[]; cells: SourceCell[] };
/** `casefold_v1`: full Unicode case folding, no normalization; `exact_v1`: code points as recorded. */
export type SourceTextComparison = { policy: "casefold_v1" | "exact_v1"; unicode_version: string };
export type SourceGlobalFind = {
  text: string;
  case: "ignore" | "match";
  /** Tables and views whose names match: on the first answer only (O10). */
  relations: { name: string; kind: string }[];
  hits: SourceFindHit[];
  /** `more`: the answer was full; `budget_exceeded`: the request's cap ran out first. Never a claim of no further matches. */
  completion: "complete" | "more" | "budget_exceeded";
  next_cursor: string | null;
  /** Tables not searched, with why (`find_budget_exceeded`: too large to search within one find). */
  skipped: { table: string; reason: string }[];
  tables: number;
  text_comparison: SourceTextComparison;
};
/** A requested sort: one column, ascending unless `desc`. */
export type SourceOrder = { column: string; desc: boolean };
/** A window of rows as the verified records single reads return, for placing many at once. */
export type SourceRecordWindow = {
  name: string;
  /** The identity the window was read under (older services omit it). */
  identity?: SourceIdentity;
  records: { record: SourceRecord; observation?: SourceFKObservation }[];
  /** Rows in the window without a verified handle: counted, never placed. */
  skipped: number;
  offset: number;
  returned: number;
  has_more: boolean;
  next_offset: number | null;
  ordering: SourceRows["ordering"];
  order?: SourceRows["order"];
};
export type SourceReferences = {
  record_id: string;
  direction: "outgoing";
  total: number;
  observations: SourceFKObservation[];
  offset: number;
  has_more: boolean;
  next_offset: number | null;
};

export type SourceSearchKey = { column: string; storage_class: "integer" | "text"; exact: string };
export type SourceSearchRequest =
  /** `case: "match"` keeps the exact rule; the default ignores case (O11, casefold_v1). */
  | { mode: "literal"; text: string; column?: string; case?: "match" }
  | { mode: "primary_key"; key: SourceSearchKey[] }
  /** Child rows referencing one parent record through one declaration. */
  | { mode: "reference"; record: string; fk: string };
export type SourceSearch = SourceRows & {
  /** `observation_id` is present in reference mode, null without a child handle. */
  rows: (SourceRow & { matched_columns: string[]; observation_id?: string | null })[];
  search: { mode: "literal" | "primary_key" | "reference"; text: string | null; column: string | null;
    key: SourceSearchKey[] | null; record?: string; fk?: string; case?: "ignore" | "match" };
  /** Literal mode: the text rule applied, versioned (O11). */
  text_comparison?: SourceTextComparison;
  completion: "complete" | "window";
  searched_columns: string[];
  excluded_storage_classes: string[];
  reference?: { record_id: string; declaration: SourceFKDeclaration;
    comparison_basis: "sqlite_fk_parent_affinity_and_collation";
    unchecked_rows: number; unchecked_reason: string | null };
};

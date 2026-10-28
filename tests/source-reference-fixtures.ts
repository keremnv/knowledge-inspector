import type { SourceContext, SourceRecord, SourceFKObservation } from "../src/api/source";
export const context: SourceContext = {
  session: "ses1_fk /+Ω", generation: "gen1_fk /+Ω", source_namespace: "src1_fk",
  capture_digest: "c".repeat(64), capture_version: "sqlite_capture_v1", captured_at: "2026-10-18T10:00:00Z",
  time_basis: "capture_observation_not_producer_commit", sqlite_version: "3.51.1", projection_version: "sqlite_source_v1", idle_ttl_seconds: 3600,
  capabilities: { schema: true, row_windows: true, verified_pk_records: true, outgoing_fk_observations: true,
    incoming_fk_observations: false, conceptual_readings: false, browser_refresh: false, query_mappings: false, keyless_record_handles: false, view_record_handles: false },
};
export const identity = { status: "verified" as const, key_columns: ["id"], verified_rows: 2, reason: null };
export const column = { name: "id", declared_type: "INTEGER", pk_order: 1, notnull: false, default_sql: null, generated: null };
export function record(name: string, id: string): SourceRecord {
  const key = [{ column: "id", storage_class: "integer" as const, exact: id }];
  return { record_id: `sr1:${name}/${id} /+Ω`, name, kind: "source_record", schema: "main", key, cells: key, identity, columns: [column],
    grounding: { ...context, schema: "main", table: name, key, basis: "stored_row_verified_declared_pk" },
    actions: { outgoing_references: true, incoming_references: false } };
}
export const child = record("Child", "1"), secondChild = record("Child", "2"), parent = record("Parent", "10");
export function observation(c = child, p = parent, number = 0): SourceFKObservation {
  return { observation_id: `so1:${c.record_id}/${number}`, child_record_id: c.record_id,
    declaration: { declaration_id: `sf1:${c.name}/${number} /+Ω`, child_table: c.name, recorded_id: number,
      recorded_pairs: [{ seq: 0, from: "parent_id", table: p.name, to: "id" }], on_update: "NO ACTION", on_delete: "NO ACTION", match: "NONE",
      parent_table: p.name, pairs: [{ seq: 0, child_column: "parent_id", parent_column: "id", target_basis: "recorded_target" }],
      validation: { status: "verified_declaration", reason: null }, historical_enforcement: "not_established" },
    child_values: [{ column: "parent_id", storage_class: "text", exact: "010" }],
    status: "resolved", reason: null, parent: { name: p.name, record_id: p.record_id, key: p.key, identity, target_values: p.key },
    grounding: c.grounding, comparison_basis: "sqlite_fk_parent_affinity_and_collation", historical_enforcement: "not_established" };
}

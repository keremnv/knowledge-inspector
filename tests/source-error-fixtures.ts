/** The Child/Parent fixture behind a mocked HTTP boundary, for failure cases.
 * Any request can be answered differently by an override; nothing here is
 * SQLite evidence. Shared by the failure spec and its audit probe. */
import type { Page, Route } from "@playwright/test";
import type { SourceFindHit, SourceGlobalFind, SourceRecord } from "../src/api/source";
import { context, column, identity, child, parent, secondChild, observation } from "./source-reference-fixtures";

export { context, child, parent, observation };
export const reader = (p: Page) => p.locator("#source-reader > .motion-swap > .motion-swap__is");
export const tables = (p: Page) => p.locator("#source-tables .source-table-slot > .motion-swap > .motion-swap__is");
export const field = (p: Page) => p.locator(".source-field-list [data-field-record]");
export const find = (p: Page) => p.getByRole("combobox", { name: "Find tables and records" });
export type Override = (route: Route, url: URL) => Promise<boolean> | boolean;

const fk = { name: "parent_id", declared_type: "TEXT", pk_order: 0, notnull: false, default_sql: null, generated: null };
/** A Child record carries the parent_id its reference reads, so the Reader can offer it as a dotted value. */
const withFk = (r: SourceRecord): SourceRecord => r.name !== "Child" ? r
  : { ...r, columns: [column, fk], cells: [...r.key, { column: "parent_id", storage_class: "text", exact: "010" }] };
const records = [child, secondChild, parent].map(withFk);
const columnsOf = (table: string | null) => table === "Child" ? [column, fk] : [column];

export const refuse = (status: number, error: string) => (route: Route) => route.fulfill({ status, json: { error } }).then(() => true);
export function found(text: string, hits: SourceFindHit[], skipped: SourceGlobalFind["skipped"], completion: SourceGlobalFind["completion"], next: string | null = null): SourceGlobalFind {
  return { text, case: "ignore", relations: [], hits, completion, next_cursor: completion === "complete" ? null : next, skipped, tables: 2,
    text_comparison: { policy: "casefold_v1", unicode_version: "15.1.0" } };
}
export const hit = (r = child): SourceFindHit => ({ table: r.name, record_id: r.record_id, key: r.key, matched_columns: ["id"], cells: r.key.map((cell) => ({ ...cell })) });

export async function mock(p: Page, override?: Override) {
  const requests: URL[] = [];
  await p.route("**/source/v1/**", async (route) => {
    const url = new URL(route.request().url()); requests.push(url);
    if (override && await override(route, url)) return;
    if (url.pathname.endsWith("/session")) return route.fulfill({ json: context });
    const table = url.searchParams.get("table");
    let data: unknown;
    if (/\/(overview|schema)$/.test(url.pathname)) data = { relations: ["Child", "Parent"].map((name) => ({ name, kind: "table", identity, read_status: "available", reason: null, row_count: null, row_count_status: "not_computed", columns: columnsOf(name), primary_key: ["id"], foreign_keys: [] })), total: 2, offset: 0, has_more: false, next_offset: null, counts: { tables: 2, views: 0, unsupported_virtual_or_shadow: 0 } };
    else if (url.pathname.endsWith("/rows") || url.pathname.endsWith("/search")) {
      const mode = url.searchParams.get("mode");
      const key = mode === "primary_key" ? JSON.parse(url.searchParams.get("key")!) : null;
      const rows = records.filter((r) => r.name === table && (!key || r.key[0].exact === key[0].exact));
      data = { name: table, kind: "table", identity, columns: columnsOf(table), rows, offset: 0, returned: rows.length, has_more: false, next_offset: null, ordering: "verified_primary_key", order: null, lineage: null,
        ...(url.pathname.endsWith("/search") ? { search: mode === "primary_key" ? { mode, text: null, column: null, key }
          : { mode: "literal", text: url.searchParams.get("text"), column: url.searchParams.get("column"), key: null, case: "ignore" },
          ...(mode === "primary_key" ? {} : { text_comparison: { policy: "casefold_v1", unicode_version: "15.1.0" } }),
          completion: "complete", searched_columns: ["id"], excluded_storage_classes: ["null", "blob"] } : {}) };
    } else if (url.pathname.endsWith("/record")) data = records.find((r) => r.record_id === url.searchParams.get("id"));
    else if (url.pathname.endsWith("/references")) {
      const all = [observation()].filter((o) => o.child_record_id === url.searchParams.get("record"));
      data = { record_id: url.searchParams.get("record"), direction: "outgoing", total: all.length, observations: all, offset: 0, has_more: false, next_offset: null };
    } else if (url.pathname.endsWith("/reference")) data = observation();
    else if (url.pathname.endsWith("/find")) data = found(url.searchParams.get("text")!, [], [], "complete");
    else throw new Error(`Unexpected source request ${url.pathname}`);
    await route.fulfill({ json: { context, data } });
  });
  return requests;
}
export async function open(p: Page, table = "Child", search = "?placement=explicit") {
  await p.goto(`/source${search}`);
  await p.getByRole("button", { name: `${table} table`, exact: true }).click();
}

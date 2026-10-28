import { chooseSourceTable as choose } from "./source-navigation";
/** Busy refusals and incoming count states with controlled responses. These
 * are mocks, not SQLite evidence; the live spec uses the real adapter. */
import { test, expect, type Page } from "@playwright/test";
import type { SourceIncomingCount, SourceRecord } from "../src/api/source";
import { SourceReadError } from "../src/api/sourceClient";
import { context, column, identity, child, record, observation } from "./source-reference-fixtures";

const reader = (p: Page) => p.locator("#source-reader > .motion-swap > .motion-swap__is");
const tables = (p: Page) => p.locator("#source-tables .source-table-slot > .motion-swap > .motion-swap__is");
const incoming = (p: Page) => reader(p).locator(".source-incoming");
const target: SourceRecord = { ...record("Parent", "10"), actions: { outgoing_references: true, incoming_references: true } };
const records = [child, target];
const counts: SourceIncomingCount[] = [
  { status: "exact", value: 2, reason: null },
  { status: "unavailable", value: null, reason: "incoming_page_budget_exceeded" },
  { status: "not_checked", value: null, reason: "incoming_page_budget_exceeded" },
];
type Refusal = { route: string; status: number; error: string } | null;

async function mock(p: Page) {
  const state: { refuse: Refusal; requests: URL[] } = { refuse: null, requests: [] };
  await p.route("**/source/v1/**", async (route) => {
    const url = new URL(route.request().url()); state.requests.push(url);
    if (url.pathname.endsWith("/session")) return route.fulfill({ json: context });
    const refuse = state.refuse;
    if (refuse && url.pathname.endsWith(refuse.route) && (refuse.route !== "/references" || url.searchParams.get("direction") === "incoming")) {
      state.refuse = null; // one refusal; the person decides whether to try again
      return route.fulfill({ status: refuse.status, json: { error: refuse.error } });
    }
    let data: unknown;
    if (/\/(overview|schema)$/.test(url.pathname)) data = { relations: ["Child", "Parent"].map((name) => ({ name, kind: "table", identity, read_status: "available", reason: null, row_count: null, row_count_status: "not_computed", columns: [column], primary_key: ["id"], foreign_keys: [] })), total: 2, offset: 0, has_more: false, next_offset: null, counts: { tables: 2, views: 0, unsupported_virtual_or_shadow: 0 } };
    else if (url.pathname.endsWith("/rows") || url.pathname.endsWith("/search")) {
      const name = url.searchParams.get("table"); const rows = records.filter((r) => r.name === name);
      data = { name, kind: "table", identity, columns: [column], rows, offset: 0, returned: rows.length, has_more: false, next_offset: null, ordering: "verified_primary_key", lineage: null };
      if (url.pathname.endsWith("/search")) Object.assign(data as object, { rows: rows.map((row) => ({ ...row, observation_id: `so1:${row.record_id}/2`, matched_columns: ["parent_id"] })), completion: "complete", excluded_storage_classes: ["null"], searched_columns: ["parent_id"],
        search: { mode: "reference", record: url.searchParams.get("record"), fk: url.searchParams.get("fk"), text: null, column: null, key: null },
        reference: { record_id: target.record_id, declaration: observation(child, target, 2).declaration, comparison_basis: "sqlite_fk_parent_affinity_and_collation", unchecked_rows: 0, unchecked_reason: null } });
    }
    else if (url.pathname.endsWith("/record")) data = records.find((r) => r.record_id === url.searchParams.get("id"));
    else if (url.pathname.endsWith("/references")) {
      const offset = Number(url.searchParams.get("offset")), record = url.searchParams.get("record");
      data = url.searchParams.get("direction") === "incoming"
        ? { record_id: record, direction: "incoming", total: counts.length, offset, has_more: false, next_offset: null, comparison_basis: "sqlite_fk_parent_affinity_and_collation",
            groups: counts.map((count, i) => ({ declaration: observation(child, target, i).declaration, count })) }
        : { record_id: record, direction: "outgoing", total: 0, observations: [], offset, has_more: false, next_offset: null };
    } else throw new Error(`Unexpected source request ${url.pathname}`);
    await route.fulfill({ json: { context, data } });
  });
  return state;
}
async function placeParent(p: Page) {
  await p.goto("/source?placement=explicit"); await choose(p, "Parent");
  await tables(p).getByRole("button", { name: "Inspect row 1", exact: true }).click();
  await reader(p).getByRole("button", { name: "show on canvas", exact: true }).click();
  await expect(p.locator("[data-field-record]")).toHaveText(["Parent 10"]);
}

test("busy codes never stop the context; capture failures still do", () => {
  for (const [code, status] of [["source_server_busy", 429], ["source_reader_busy", 429], ["source_server_busy", 503]] as const) {
    const error = new SourceReadError(code, status);
    expect([error.busy, error.stopsContext]).toEqual([true, false]);
    expect(error.message).toContain("Nothing on the canvas changed; try again.");
  }
  for (const [code, status] of [["source_capture_missing", 503], ["source_invalid_response", 503], ["source_generation_mismatch", 409], ["source_session_missing_or_expired", 410]] as const) {
    expect(new SourceReadError(code, status).stopsContext).toBe(true);
  }
});

for (const [status, error] of [[429, "source_server_busy"], [429, "source_reader_busy"], [503, "source_server_busy"]] as const) {
  test(`a ${status} ${error} keeps the canvas, retries only when asked, then recovers`, async ({ page }) => {
    const state = await mock(page); await placeParent(page);
    // A refused record read: the Reader says so; nothing else changes.
    state.refuse = { route: "/record", status, error };
    await choose(page, "Child");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await expect(reader(page).getByRole("alert")).toContainText(`The source service is busy with another read. Nothing on the canvas changed; try again. details · ${error}`);
    await expect(page.getByRole("heading", { name: "source reads stopped" })).toHaveCount(0);
    await expect(page.locator("[data-field-record]")).toHaveText(["Parent 10"]);
    expect(await page.evaluate(() => "__sourceFieldGraph" in window)).toBe(true);
    await page.waitForTimeout(1500); // longer than Retry-After: nothing retries by itself
    const childReads = () => state.requests.filter((u) => u.pathname.endsWith("/record") && u.searchParams.get("id") === child.record_id).length;
    expect(childReads()).toBe(1);
    await reader(page).getByRole("button", { name: "try again", exact: true }).press("Enter");
    await expect(reader(page).locator("h2")).toHaveAccessibleName("Child, id=1");
    await expect(reader(page).locator("h2")).toBeFocused(); // the vanished button hands focus to the subject
    expect(childReads()).toBe(2);
    await expect(page.locator("[data-field-record]")).toHaveText(["Parent 10"]);
  });
}

test("a busy incoming read leaves the record and its other sections, and tries again on request", async ({ page }) => {
  const state = await mock(page);
  state.refuse = { route: "/references", status: 429, error: "source_reader_busy" };
  await placeParent(page);
  await expect(incoming(page).getByRole("alert")).toContainText("source_reader_busy");
  await expect(reader(page).locator(".source-outgoing")).toContainText("none declared");
  await expect(reader(page).getByRole("button", { name: "reveal", exact: true })).toBeVisible();
  await incoming(page).getByRole("button", { name: "try again", exact: true }).press("Enter");
  await expect(incoming(page).locator("h3")).toHaveText("referenced by · 3 declared");
  await expect(reader(page).locator("h2")).toBeFocused(); // the vanished button hands focus to the subject
  expect(state.requests.filter((u) => u.searchParams.get("direction") === "incoming")).toHaveLength(2);
});

test("count states are named, never zero, and every verified group stays browsable", async ({ page }) => {
  await mock(page); await placeParent(page);
  const lines = incoming(page).locator(".gm__list li button");
  await expect(lines).toHaveCount(3);
  await expect(lines.locator(".gm__list-meta")).toHaveText(["2 · table", "count unavailable · page limit reached · table", "count not checked · page limit reached · table"]);
  await expect(lines.nth(2)).toHaveAccessibleName("Child · parent_id, count not checked · page limit reached, open in tables");
  await lines.nth(2).click();
  await expect(tables(page).locator("[data-incoming-subject]")).toHaveText(/^rows referencing Parent 10 through parent_id · count not checked · page limit reached$/);
  await expect(tables(page).getByRole("button", { name: "Inspect row 1", exact: true })).toBeVisible();
});

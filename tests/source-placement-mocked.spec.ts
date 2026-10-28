import { openSourceReferences } from "./canvas-parity";
import { chooseSourceTable as choose } from "./source-navigation";
/** Mocked HTTP boundary tests for source record placement. Timing controls
 * here are not real-database evidence; see source-placement-live.spec.ts. */
import { test, expect, type Page, type Route } from "@playwright/test";
import type { SourceCatalogue, SourceContext, SourceRecord, SourceRows } from "../src/api/source";

const context: SourceContext = {
  session: "ses1_place", generation: "gen1_place", source_namespace: "src1_fixture",
  capture_digest: "b".repeat(64), capture_version: "sqlite_capture_v1", captured_at: "2026-10-18T10:00:00Z",
  time_basis: "capture_observation_not_producer_commit", sqlite_version: "3.51.1", projection_version: "sqlite_source_v1", idle_ttl_seconds: 3600,
  capabilities: { schema: true, row_windows: true, verified_pk_records: true, outgoing_fk_observations: true,
    incoming_fk_observations: false, conceptual_readings: false, browser_refresh: false, query_mappings: false, keyless_record_handles: false, view_record_handles: false },
};
const verified = { status: "verified" as const, key_columns: ["id"], verified_rows: 3, reason: null };
const keyless = { status: "no_declared_key" as const, key_columns: [], verified_rows: null, reason: null };
const column = { name: "id", declared_type: "INTEGER", pk_order: 1, notnull: false, default_sql: null, generated: null };
const relation = (name: string, kind: "table" | "view", identity: typeof verified | typeof keyless) => ({ name, kind, identity, read_status: "available" as const,
  reason: null, row_count: null, row_count_status: "not_computed" as const, columns: [column], primary_key: identity === verified ? ["id"] : [], foreign_keys: [] });
const catalogue: SourceCatalogue = {
  relations: [relation("Alpha", "table", verified), relation("Bare", "table", keyless), relation("Shown", "view", keyless)],
  total: 3, offset: 0, has_more: false, next_offset: null, counts: { tables: 2, views: 1, unsupported_virtual_or_shadow: 0 },
};
// Two handles share key text on purpose: a label is never an identity.
const KEYS = ["9007199254740992", "9007199254740993", "9007199254740993"];
function rows(name: string): SourceRows {
  const handled = name === "Alpha";
  return { name, kind: name === "Shown" ? "view" : "table", columns: [column], identity: handled ? verified : keyless, offset: 0, returned: 3, has_more: false, next_offset: null,
    ordering: handled ? "verified_primary_key" : "unspecified_window_only", lineage: name === "Shown" ? "not_recorded" : null,
    rows: KEYS.map((exact, index) => ({ record_id: handled ? `sr1:${name}/${index}` : null, key: handled ? [{ column: "id", storage_class: "integer", exact }] : [],
      cells: [{ column: "id", storage_class: "integer", exact }] })) };
}
function record(id: string, grounding: Partial<SourceContext> = {}): SourceRecord {
  const row = rows("Alpha").rows.find((item) => item.record_id === id)!;
  return { ...row, record_id: id, name: "Alpha", kind: "source_record", schema: "main", columns: [column], identity: verified,
    grounding: { ...context, ...grounding, schema: "main", table: "Alpha", key: row.key, basis: "stored_row_verified_declared_pk" }, actions: { outgoing_references: true, incoming_references: false } };
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };

async function mock(page: Page, override?: (route: Route, url: URL) => Promise<boolean>) {
  await page.route("**/source/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (override && await override(route, url)) return;
    if (url.pathname.endsWith("/session")) return route.fulfill({ json: context });
    if (url.pathname.endsWith("/references")) return route.fulfill({ json: { context, data: {
      record_id: url.searchParams.get("record"), direction: "outgoing", total: 0, observations: [],
      offset: Number(url.searchParams.get("offset")), has_more: false, next_offset: null,
    } } });
    const data = url.pathname.endsWith("/rows") ? rows(url.searchParams.get("table")!)
      : url.pathname.endsWith("/record") ? record(url.searchParams.get("id")!) : catalogue;
    await route.fulfill({ json: { context, data } });
  });
}
const tables = (page: Page) => page.locator("#source-tables");
const reader = (page: Page) => page.locator("#source-reader > .motion-swap > .motion-swap__is");
const fieldList = (page: Page) => page.getByRole("region", { name: "Records on canvas" });
const show = (page: Page) => reader(page).locator('[data-placement="show"]');
async function drawn(page: Page) {
  return page.evaluate(() => (window as unknown as { __sourceFieldGraph?: { getNodeData: () => { id: string; style: { labelText: string; opacity: number; size: number } }[] } })
    .__sourceFieldGraph?.getNodeData().map((node) => ({ id: node.id, label: node.style.labelText, at: node.style.opacity === 1 && node.style.size === 90 })) ?? []);
}
async function field(page: Page) {
  return fieldList(page).locator("[data-field-record]").evaluateAll((buttons) => buttons.map((button) => [button.getAttribute("data-field-record"), button.textContent]));
}

// The explicit show on canvas action: these run with direct placement (the
// default, O1) turned off.
for (const motion of ["reduce", "no-preference"] as const) {
  test.describe(`placement: ${motion}`, () => {
    test.use({ reducedMotion: motion });

    test("show on canvas waits for the verified read and a late earlier reply cannot be placed", async ({ page }) => {
      const started = deferred(), release = deferred(), completed = deferred();
      // The transport ignores cancellation: ownership alone must reject the reply.
      await page.addInitScript(() => {
        const original = window.fetch.bind(window);
        window.fetch = (input, init) => original(input, String(input).startsWith("/source/v1/record") ? { ...init, signal: undefined } : init);
      });
      await mock(page, async (route, url) => {
        if (!url.pathname.endsWith("/record") || url.searchParams.get("id") !== "sr1:Alpha/0") return false;
        started.resolve(); await release.promise;
        try { await route.fulfill({ json: { context, data: record("sr1:Alpha/0") } }); } finally { completed.resolve(); }
        return true;
      });
      await page.goto("/source?placement=explicit");
      await choose(page, "Alpha");
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
      await started.promise;
      await expect(reader(page)).toContainText("loading…");
      await expect(show(page)).toHaveCount(0);
      await tables(page).getByRole("button", { name: "Inspect row 2", exact: true }).click();
      await expect(reader(page).locator(".source-cells code")).toHaveText("9007199254740993");
      await show(page).click();
      await expect.poll(() => field(page)).toEqual([["record-1", "Alpha 9007199254740993"]]);
      release.resolve(); await completed.promise;
      await expect(reader(page).locator(".source-cells code")).toHaveText("9007199254740993");
      await expect.poll(async () => (await drawn(page)).map((mark) => mark.id)).toEqual(["record-1"]);
      expect(await field(page)).toEqual([["record-1", "Alpha 9007199254740993"]]);
    });

    test("distinct handles with identical key text stay distinct, and Show again adds nothing", async ({ page }) => {
      await mock(page);
      await page.goto("/source?placement=explicit");
      await choose(page, "Alpha");
      for (const row of [2, 3, 2, 3]) {
        await tables(page).getByRole("button", { name: `Inspect row ${row}`, exact: true }).click();
        await show(page).click();
      }
      await expect.poll(() => field(page)).toEqual([["record-1", "Alpha 9007199254740993"], ["record-2", "Alpha 9007199254740993"]]);
      await expect.poll(async () => (await drawn(page)).filter((mark) => mark.at).length).toBe(2);
      expect((await drawn(page)).map((mark) => mark.label)).toEqual(["Alpha 9007199254740993", "Alpha 9007199254740993"]);
      // Each mark opens its own handle.
      await fieldList(page).locator('[data-field-record="record-1"]').press("Enter");
      await expect(fieldList(page).locator('[data-field-record="record-1"]')).toHaveAttribute("aria-pressed", "true");
      await expect(fieldList(page).locator('[data-field-record="record-2"]')).toHaveAttribute("aria-pressed", "false");
      await expect(reader(page).locator("details.source-details").filter({ has: page.getByText("identity details", { exact: true }) })).toContainText("sr1:Alpha/1");
    });

    test("keyboard places, inspects and removes, and focus stays on live controls", async ({ page }) => {
      await mock(page);
      await page.goto("/source?placement=explicit");
      await choose(page, "Alpha");
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(reader(page).locator("h2")).toBeFocused();
      // Heading focus precedes the reference read. Check final Tab order only
      // after the short-result response has removed the loading pager.
      await expect(reader(page).locator(".source-outgoing")).toContainText("none declared");
      await expect(reader(page).getByRole("navigation", { name: "outgoing reference pages" })).toBeHidden();
      await page.keyboard.press("Tab");
      await expect(reader(page).getByRole("button", { name: "close" })).toBeFocused();
      // Canonical Reader order: subject chrome, readable evidence, pinned actions.
      // The declared references wait behind their own disclosure (O14.2), first.
      for (const label of ["references", "value details", "identity details", "source details"]) {
        await page.keyboard.press("Tab");
        await expect(reader(page).getByText(label, { exact: true })).toBeFocused();
      }
      await page.keyboard.press("Tab");
      await expect(page.locator("[data-placement=show]")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect.poll(() => field(page)).toEqual([["record-1", "Alpha 9007199254740992"]]);
      await page.keyboard.press("Tab");
      await expect(page.locator("[data-placement=remove]")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(fieldList(page)).toHaveCount(0);
      await expect(page.locator("[data-placement=show]")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect.poll(() => field(page)).toEqual([["record-2", "Alpha 9007199254740992"]]);
      // The list is the canvas's keyboard surface: open the Reader, then remove.
      await fieldList(page).locator("[data-field-record]").focus();
      await page.keyboard.press("Tab");
      await expect(fieldList(page).getByRole("button", { name: "remove Alpha 9007199254740992 from canvas" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("region", { name: "Source canvas" })).toBeFocused();
      await expect.poll(async () => (await drawn(page)).length).toBe(0);
      // The Reader keeps its subject; only the canvas changed.
      await expect(reader(page).locator(".source-cells code")).toHaveText("9007199254740992");
      expect(await page.evaluate(() => document.querySelectorAll(".source-canvas canvas[tabindex]:not([tabindex='-1'])").length)).toBe(0);
    });

    for (const destination of ["pager", "close", "tables"] as const) {
      test(`loading reference pager recovers focus without stealing later navigation: ${destination}`, async ({ page }) => {
        const started = deferred(), release = deferred();
        await mock(page, async (_route, url) => {
          if (!url.pathname.endsWith("/references")) return false;
          started.resolve(); await release.promise;
          return false;
        });
        try {
          await page.goto("/source?placement=explicit");
          await choose(page, "Alpha");
          await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).press("Enter");
          await started.promise;
          const heading = reader(page).locator("h2");
          await expect(heading).toBeFocused();
          // The loading pager lives in the references disclosure (O14.2): open
          // it, give the heading its focus back, and walk the same path.
          await openSourceReferences(page);
          await heading.focus();
          const summary = reader(page).locator("details.source-references > summary");
          await page.keyboard.press("Tab");
          await expect(reader(page).getByRole("button", { name: "close" })).toBeFocused();
          await page.keyboard.press("Tab");
          await expect(summary).toBeFocused();
          await page.keyboard.press("Tab");
          await expect(reader(page).getByRole("button", { name: "previous references" })).toBeFocused();
          if (destination === "close") {
            await page.keyboard.press("Shift+Tab");
            await page.keyboard.press("Shift+Tab");
            await expect(reader(page).getByRole("button", { name: "close" })).toBeFocused();
          } else if (destination === "tables") {
            await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).focus();
            await page.keyboard.press("Tab");
            await expect(tables(page).getByRole("button", { name: "Inspect row 2", exact: true })).toBeFocused();
          }
          release.resolve();
          await expect(reader(page).locator(".source-outgoing")).toContainText("none declared");
          await expect(reader(page).getByRole("navigation", { name: "outgoing reference pages" })).toBeHidden();
          if (destination === "close") {
            await expect(reader(page).getByRole("button", { name: "close" })).toBeFocused();
            await page.keyboard.press("Tab");
            await expect(summary).toBeFocused();
          } else if (destination === "tables") {
            await expect(tables(page).getByRole("button", { name: "Inspect row 2", exact: true })).toBeFocused();
            await page.keyboard.press("Tab");
            await expect(tables(page).getByRole("button", { name: "Inspect row 3", exact: true })).toBeFocused();
          } else {
            await expect(heading).toBeFocused();
            await page.keyboard.press("Tab");
            await expect(reader(page).getByRole("button", { name: "close" })).toBeFocused();
          }
        } finally { release.resolve(); }
      });
    }

    test("rapid placement, removal and selection leave no ghost marks", async ({ page }) => {
      await mock(page);
      await page.goto("/source?placement=explicit");
      await choose(page, "Alpha");
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
      await expect(show(page)).toBeVisible();
      for (let cycle = 0; cycle < 4; cycle += 1) {
        await show(page).click();
        await reader(page).getByRole("button", { name: "remove" }).click();
      }
      await show(page).click();
      await tables(page).getByRole("button", { name: "Inspect row 2", exact: true }).click();
      await show(page).click();
      await fieldList(page).locator("[data-field-record]").first().press("Enter");
      await fieldList(page).getByRole("button", { name: /^remove .*9007199254740993/ }).press("Enter");
      await expect.poll(() => field(page)).toEqual([["record-5", "Alpha 9007199254740992"]]);
      await expect.poll(async () => JSON.stringify(await drawn(page))).toBe(JSON.stringify([{ id: "record-5", label: "Alpha 9007199254740992", at: true }]));
    });

    test("keyless window rows and computed view output offer no placement", async ({ page }) => {
      await mock(page);
      await page.goto("/source?placement=explicit");
      for (const [name, kind, text] of [["Bare", "table", "no primary key"], ["Shown", "view", "computed view output"]] as const) {
        await choose(page, name, kind);
        await tables(page).getByRole("button", { name: "Inspect row 3", exact: true }).click();
        await expect(reader(page)).toContainText(text);
        await expect(show(page)).toHaveCount(0);
      }
      await expect(page.locator(".source-canvas > .source-layer:not(.source-schema) canvas")).toHaveCount(0);
    });
  });
}

test("a record grounded in another generation stops reads and is never placeable", async ({ page }) => {
  await mock(page, async (route, url) => {
    if (!url.pathname.endsWith("/record")) return false;
    await route.fulfill({ json: { context, data: record(url.searchParams.get("id")!, { generation: "gen1_other" }) } }); return true;
  });
  await page.goto("/source?placement=explicit");
  await choose(page, "Alpha");
  await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
  await expect(page.getByRole("heading", { name: "source reads stopped" })).toBeVisible();
  await expect(page.getByRole("alert").first()).toContainText("source_context_mismatch");
  await expect(page.locator("[data-placement]")).toHaveCount(0);
  await expect(page.locator(".source-canvas > .source-layer:not(.source-schema) canvas")).toHaveCount(0);
});

for (const status of [410, 409, 503] as const) {
  test(`a ${status} after placement clears the field at once, with no outgoing marks`, async ({ page }) => {
    let failing = false;
    await mock(page, async (route, url) => {
      if (!failing || !url.pathname.endsWith("/record")) return false;
      await route.fulfill({ status, json: { error: status === 410 ? "source_session_missing_or_expired" : status === 409 ? "source_generation_mismatch" : "source_capture_missing" } });
      return true;
    });
    await page.goto("/source?placement=explicit");
    await choose(page, "Alpha");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await show(page).click();
    await expect.poll(async () => (await drawn(page)).filter((mark) => mark.at).length).toBe(1);
    failing = true;
    await tables(page).getByRole("button", { name: "Inspect row 2", exact: true }).click();
    await expect(page.getByRole("heading", { name: "source reads stopped" })).toBeVisible();
    // Unmounted in the same commit as the stop: nothing old fades as if current.
    await expect(page.locator(".source-canvas > .source-layer:not(.source-schema) canvas")).toHaveCount(0);
    await expect(fieldList(page)).toHaveCount(0);
    expect(await page.evaluate(() => "__sourceFieldGraph" in window)).toBe(false);
  });
}

test("narrowing into the compact arrangement keeps the dock and control that hold focus", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await mock(page);
  await page.goto("/source?placement=explicit");
  await choose(page, "Alpha");
  const row = tables(page).getByRole("button", { name: "Inspect row 1", exact: true });
  await row.focus();
  await expect(page.locator(".ov.is-open")).toHaveCount(2);
  await page.setViewportSize({ width: 760, height: 800 });
  await expect(page.locator('[data-overlay="source-reader"]')).not.toHaveClass(/is-open/);
  await expect(page.locator('[data-overlay="source-tables"]')).toHaveClass(/is-open/);
  await expect(row).toBeFocused();
  // Master-detail: the Reader takes the one dock, and Escape hands it back.
  await page.keyboard.press("Enter");
  await expect(reader(page).locator("h2")).toBeFocused();
  await expect(page.locator('[data-overlay="source-tables"]')).not.toHaveClass(/is-open/);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-overlay="source-tables"]')).toHaveClass(/is-open/);
  await expect(page.locator('[data-overlay="source-reader"]')).not.toHaveClass(/is-open/);
  await expect(tables(page).getByRole("button", { name: "Inspect row 1", exact: true })).toBeFocused();
});

import { openSourceReferences } from "./canvas-parity";
import { chooseSourceTable as choose } from "./source-navigation";
/** Controlled protocol/timing cases. These are mocks, not real SQLite evidence. */
import { test, expect, type Page, type Route } from "@playwright/test";
import type { SourceFKObservation } from "../src/api/source";
import { context, column, identity, child, parent, secondChild, observation } from "./source-reference-fixtures";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const reader = (p: Page) => p.locator("#source-reader > .motion-swap > .motion-swap__is");
const tables = (p: Page) => p.locator("#source-tables");
const records = [child, secondChild, parent];
async function mock(p: Page, observations: SourceFKObservation[] = [observation()], override?: (route: Route, url: URL) => Promise<boolean>) {
  const requests: URL[] = [];
  await p.route("**/source/v1/**", async (route) => {
    const url = new URL(route.request().url()); requests.push(url);
    if (url.pathname.endsWith("/session")) return route.fulfill({ json: context });
    expect(url.searchParams.getAll("session")).toEqual([context.session]); expect(url.searchParams.getAll("generation")).toEqual([context.generation]);
    if (override && await override(route, url)) return;
    let data: unknown;
    if (/\/(overview|schema)$/.test(url.pathname)) data = { relations: ["Child", "Parent"].map((name) => ({ name, kind: "table", identity, read_status: "available", reason: null, row_count: null, row_count_status: "not_computed", columns: [column], primary_key: ["id"], foreign_keys: [] })), total: 2, offset: 0, has_more: false, next_offset: null, counts: { tables: 2, views: 0, unsupported_virtual_or_shadow: 0 } };
    else if (url.pathname.endsWith("/rows")) { const name = url.searchParams.get("table"); const rows = records.filter((r) => r.name === name); data = { name, kind: "table", identity, columns: [column], rows, offset: 0, returned: rows.length, has_more: false, next_offset: null, ordering: "verified_primary_key", lineage: null }; }
    else if (url.pathname.endsWith("/record")) data = records.find((r) => r.record_id === url.searchParams.get("id"));
    else if (url.pathname.endsWith("/references")) {
      const record = url.searchParams.get("record"), offset = Number(url.searchParams.get("offset")), limit = Number(url.searchParams.get("limit"));
      const all = observations.filter((o) => o.child_record_id === record);
      data = { record_id: record, direction: "outgoing", total: all.length, observations: all.slice(offset, offset + limit), offset, has_more: offset + limit < all.length, next_offset: offset + limit < all.length ? offset + limit : null };
    } else if (url.pathname.endsWith("/reference")) data = observations.find((o) => o.child_record_id === url.searchParams.get("record") && o.declaration.declaration_id === url.searchParams.get("fk"));
    else throw new Error(`Unexpected source request ${url.pathname}`);
    await route.fulfill({ json: { context, data } });
  });
  return requests;
}
// Explicit placement unless a test asks otherwise: these flows predate direct
// placement becoming the default (owner decision O1).
async function start(p: Page, search = "?placement=explicit") {
  await p.goto(`/source${search}`); await tables(p).getByRole("button", { name: "Child table", exact: true }).click();
  await tables(p).getByRole("button", { name: "Inspect row 1", exact: true }).click();
  await openSourceReferences(p); await expect(reader(p).getByRole("button", { name: "inspect FK 0 reference", exact: true })).toBeVisible();
}
for (const motion of ["reduce", "no-preference"] as const) {
  test.describe(`FK request ownership ${motion}`, () => {
    test.use({ reducedMotion: motion });
    test("paging preserves constraint totals, fetches only requested pages, and zero is quiet", async ({ page }) => {
      const requests = await mock(page, Array.from({ length: 12 }, (_, i) => observation(child, parent, i)));
      await start(page);
      expect(requests.filter((u) => u.pathname.endsWith("/references"))).toHaveLength(1);
      await expect(reader(page).locator(".source-outgoing article")).toHaveCount(10);
      await expect(reader(page)).toContainText("references · 12 declared");
      await reader(page).getByRole("button", { name: "Next references" }).press("Enter");
      await expect(reader(page).locator(".source-outgoing article")).toHaveCount(2);
      await expect(reader(page).getByRole("button", { name: "Next references" })).toBeFocused();
      expect(requests.filter((u) => u.pathname.endsWith("/references")).map((u) => u.searchParams.get("offset"))).toEqual(["0", "10"]);
      await openSourceReferences(page); await reader(page).getByRole("button", { name: "inspect FK 11 reference" }).press("Enter");
      await reader(page).getByRole("button", { name: "Back", exact: true }).press("Enter");
      await expect(reader(page).locator(".source-outgoing article")).toHaveCount(2);
      await tables(page).getByRole("button", { name: "Inspect row 2", exact: true }).click();
      await expect(reader(page)).toContainText("none declared");
      await expect(page.locator(".source-canvas > .source-layer:not(.source-schema) canvas")).toHaveCount(0);
    });

    test("all eight statuses retain child values and only resolved addressable evidence offers placement", async ({ page }) => {
      const statuses: SourceFKObservation["status"][] = ["resolved", "resolved_unaddressable", "null_reference", "dangling", "ambiguous", "invalid_declaration", "unsupported", "budget_exceeded"];
      const observations = statuses.map((status, i) => ({ ...observation(child, parent, i), status, reason: status === "resolved" ? null : `fixture_${status}`,
        parent: status === "resolved" ? observation().parent : status === "resolved_unaddressable" ? { ...observation().parent!, record_id: null, identity: { ...identity, status: "no_declared_key" as const } } : null }));
      await mock(page, observations); await start(page);
      for (let i = 0; i < statuses.length; i++) {
        await openSourceReferences(page); await reader(page).getByRole("button", { name: `inspect FK ${i} reference`, exact: true }).click();
        await expect(reader(page).locator("[data-reference-status]")).toHaveAttribute("data-reference-status", statuses[i]);
        await expect(reader(page)).toContainText('"010"'); await expect(reader(page)).toContainText("SQLite TEXT");
        await expect(reader(page).getByRole("button", { name: /^(show|reveal) connection$/ })).toHaveCount(i === 0 ? 1 : 0);
        await expect(reader(page).getByRole("button", { name: "open referenced record" })).toHaveCount(i === 0 ? 1 : 0);
        await reader(page).getByRole("button", { name: "Back", exact: true }).click();
      }
      await expect(page.locator(".source-canvas > .source-layer:not(.source-schema) canvas")).toHaveCount(0);
    });

    for (const operation of ["references", "reference", "parent"] as const) {
      test(`late cancellation-resistant ${operation} cannot replace the current Reader or grow the field`, async ({ page }) => {
        const started = deferred(), release = deferred(), complete = deferred(); let hold = true;
        await page.addInitScript(() => { const fetch = window.fetch.bind(window); window.fetch = (input, init) => fetch(input, { ...init, signal: undefined }); });
        await mock(page, [observation(), observation(secondChild)], async (route, url) => {
          if (!hold || !(operation === "parent" ? url.pathname.endsWith("/record") && url.searchParams.get("id") === parent.record_id : url.pathname.endsWith(`/${operation}`) && url.searchParams.get("record") === child.record_id)) return false;
          hold = false; started.resolve(); await release.promise;
          const data = operation === "parent" ? parent : operation === "reference" ? observation() : { record_id: child.record_id, direction: "outgoing", observations: [observation()], total: 1, offset: 0, has_more: false, next_offset: null };
          try { await route.fulfill({ json: { context, data } }); } finally { complete.resolve(); }
          return true;
        });
        await page.goto("/source?placement=explicit"); await tables(page).getByRole("button", { name: "Child table", exact: true }).click();
        await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
        if (operation !== "references") { await openSourceReferences(page); await reader(page).getByRole("button", { name: "inspect FK 0 reference" }).click(); }
        if (operation === "parent") await reader(page).getByRole("button", { name: "open referenced record" }).click();
        await started.promise;
        await tables(page).getByRole("button", { name: "Inspect row 2", exact: true }).click();
        await expect(reader(page).locator("h2")).toHaveAccessibleName("Child, id=2");
        release.resolve(); await complete.promise;
        await expect(reader(page).locator("h2")).toHaveAccessibleName("Child, id=2");
        await expect(reader(page).locator(".source-outgoing article")).toHaveCount(1);
        await expect(page.locator(".source-canvas > .source-layer:not(.source-schema) canvas")).toHaveCount(0);
      });
    }

    test("hiding during a pending repeat cannot be undone by a late parent read", async ({ page }) => {
      let delayed = false; const started = deferred(), release = deferred(), complete = deferred();
      await page.addInitScript(() => { const fetch = window.fetch.bind(window); window.fetch = (input, init) => fetch(input, { ...init, signal: undefined }); });
      await mock(page, [observation()], async (route, url) => {
        if (!delayed || !url.pathname.endsWith("/record") || url.searchParams.get("id") !== parent.record_id) return false;
        started.resolve(); await release.promise;
        try { await route.fulfill({ json: { context, data: parent } }); } finally { complete.resolve(); }
        return true;
      });
      await start(page); await openSourceReferences(page); await reader(page).getByRole("button", { name: "inspect FK 0 reference" }).click();
      await reader(page).getByRole("button", { name: /^(show|reveal) connection$/ }).click();
      await expect(page.locator("[data-field-reference]")).toHaveCount(1);
      delayed = true;
      await reader(page).getByRole("button", { name: /^(show|reveal) connection$/ }).click(); await started.promise;
      await reader(page).getByRole("button", { name: "hide connection" }).click();
      release.resolve(); await complete.promise;
      await expect(page.locator("[data-field-reference]")).toHaveCount(0);
      await expect(page.locator("[data-field-record]")).toHaveText(["Child 1", "Parent 10"]);
    });

    for (const cancelBy of ["cancel", "remove"] as const) {
      test(`${cancelBy} while a new connection's parent read ignores cancellation cannot place anything later`, async ({ page }) => {
        const started = deferred(), release = deferred(), complete = deferred();
        await page.addInitScript(() => { const fetch = window.fetch.bind(window); window.fetch = (input, init) => fetch(input, { ...init, signal: undefined }); });
        await mock(page, [observation()], async (route, url) => {
          if (!url.pathname.endsWith("/record") || url.searchParams.get("id") !== parent.record_id) return false;
          started.resolve(); await release.promise;
          try { await route.fulfill({ json: { context, data: parent } }); } finally { complete.resolve(); }
          return true;
        });
        await start(page);
        if (cancelBy === "remove") await reader(page).locator('[data-placement="show"]').click();
        await openSourceReferences(page); await reader(page).getByRole("button", { name: "inspect FK 0 reference" }).click();
        await reader(page).getByRole("button", { name: /^(show|reveal) connection$/ }).click(); await started.promise;
        if (cancelBy === "cancel") {
          await reader(page).getByRole("button", { name: "cancel placement" }).press("Enter");
          await expect(reader(page).getByRole("button", { name: /^(show|reveal) connection$/ })).toBeFocused();
        }
        else await page.getByRole("button", { name: "remove Child 1 from canvas", exact: true }).press("Enter");
        release.resolve(); await complete.promise;
        await expect(page.locator("[data-field-reference]")).toHaveCount(0);
        await expect(page.locator("[data-field-record]")).toHaveCount(0);
        await expect(reader(page).getByRole("button", { name: /^(show|reveal) connection$/ })).toBeEnabled();
      });
    }

    test("canvas observation placement waits for its exact child record read", async ({ page }) => {
      let delayChild = false; const started = deferred(), release = deferred();
      await mock(page, [observation()], async (route, url) => {
        if (!delayChild || !url.pathname.endsWith("/record") || url.searchParams.get("id") !== child.record_id) return false;
        started.resolve(); await release.promise;
        await route.fulfill({ json: { context, data: child } }); return true;
      });
      await start(page);
      await openSourceReferences(page); await reader(page).getByRole("button", { name: "inspect FK 0 reference" }).click();
      await reader(page).getByRole("button", { name: /^(show|reveal) connection$/ }).click();
      await expect(page.locator("[data-field-reference]")).toHaveCount(1);
      // Move the Reader away, then select the line with a delayed new child read.
      await choose(page, "Parent");
      delayChild = true;
      await page.locator("[data-field-reference]").press("Enter"); await started.promise;
      await expect(reader(page)).toContainText("loading child record…");
      await expect(reader(page).getByRole("button", { name: /^(show|reveal) connection$/ })).toBeDisabled();
      release.resolve();
      await expect(reader(page).getByRole("button", { name: /^(show|reveal) connection$/ })).toBeEnabled();
      await expect(page.locator("[data-field-record]")).toHaveCount(2);
    });

    test("failed parent read is visible and retains the existing investigation", async ({ page }) => {
      await mock(page, [observation()], async (route, url) => {
        if (!url.pathname.endsWith("/record") || url.searchParams.get("id") !== parent.record_id) return false;
        await route.fulfill({ status: 404, json: { error: "source_record_not_found" } }); return true;
      });
      await start(page); await reader(page).locator('[data-placement="show"]').click();
      await openSourceReferences(page); await reader(page).getByRole("button", { name: "inspect FK 0 reference" }).click();
      await reader(page).getByRole("button", { name: /^(show|reveal) connection$/ }).click();
      await expect(reader(page).getByRole("alert")).toContainText("source_record_not_found");
      await expect(page.locator("[data-field-record]")).toHaveCount(1); await expect(page.locator("[data-field-reference]")).toHaveCount(0);
    });
  });
}

for (const corruption of ["session", "generation", "source_namespace", "capture_digest", "capture_version", "projection_version", "captured_at", "time_basis", "sqlite_version", "child", "declaration", "observation", "grounding"] as const) {
  test(`exact observation refuses ${corruption} mismatch and clears standing material`, async ({ page }) => {
    await mock(page, [observation()], async (route, url) => {
      if (!url.pathname.endsWith("/reference")) return false;
      const data = observation(), envelope = { ...context };
      if (corruption === "child") data.child_record_id = "wrong";
      else if (corruption === "declaration") data.declaration.declaration_id = "wrong";
      else if (corruption === "observation") data.observation_id = "wrong";
      else if (corruption === "grounding") data.grounding = { ...data.grounding, capture_digest: "wrong" };
      else Object.assign(envelope, { [corruption]: "wrong" });
      await route.fulfill({ json: { context: envelope, data } }); return true;
    });
    await start(page); await reader(page).locator('[data-placement="show"]').click();
    await openSourceReferences(page); await reader(page).getByRole("button", { name: "inspect FK 0 reference" }).click();
    await expect(page.getByRole("heading", { name: "source reads stopped" })).toBeVisible();
    await expect(page.locator(".source-canvas > .source-layer:not(.source-schema) canvas")).toHaveCount(0);
  });
}

test("placed records carry no status line under their Reader actions", async ({ page }) => {
  await mock(page); await start(page);
  await reader(page).locator('[data-placement="show"]').click();
  await expect(page.locator("[data-field-record]")).toHaveCount(1);
  await expect(reader(page).locator(".source-placement [role=status]")).toHaveCount(0);
  await openSourceReferences(page); await reader(page).getByRole("button", { name: "inspect FK 0 reference" }).click();
  await reader(page).getByRole("button", { name: "show connection" }).click();
  await reader(page).getByRole("button", { name: "open referenced record" }).click();
  await expect(reader(page).locator('[data-placement="show"]')).toHaveText("reveal");
  await expect(reader(page).locator(".source-placement [role=status]")).toHaveCount(0);
});

test.describe("direct placement, the default (O1)", () => {
  test("selecting a row places it and inspecting a resolved reference shows it", async ({ page }) => {
    await mock(page, [observation(), { ...observation(child, parent, 1), status: "dangling", reason: null, parent: null }]);
    await start(page, "");
    await expect(page.locator("[data-field-record]")).toHaveCount(1);
    await expect(reader(page).locator('[data-placement="show"]')).toHaveText("reveal");
    await openSourceReferences(page); await reader(page).getByRole("button", { name: "inspect FK 1 reference", exact: true }).click();
    await expect(reader(page).locator("[data-reference-status]")).toHaveAttribute("data-reference-status", "dangling");
    await expect(page.locator("[data-field-reference]")).toHaveCount(0);
    await reader(page).getByRole("button", { name: "Back", exact: true }).click();
    await openSourceReferences(page); await reader(page).getByRole("button", { name: "inspect FK 0 reference", exact: true }).click();
    await expect(reader(page).getByRole("button", { name: "hide connection" })).toBeVisible();
    await expect(page.locator("[data-field-record]")).toHaveCount(2); await expect(page.locator("[data-field-reference]")).toHaveCount(1);
    await reader(page).getByRole("button", { name: "hide connection" }).click();
    await expect(page.locator("[data-field-reference]")).toHaveCount(0);
    await expect(reader(page).getByRole("button", { name: "show connection" })).toBeVisible();
    await expect(page.locator("[data-field-record]")).toHaveText(["Child 1", "Parent 10"]);
  });

  test("?placement=explicit turns it off", async ({ page }) => {
    await mock(page); await start(page, "?placement=explicit");
    await openSourceReferences(page); await reader(page).getByRole("button", { name: "inspect FK 0 reference", exact: true }).click();
    await expect(reader(page).getByRole("button", { name: "show connection" })).toBeVisible();
    await expect(page.locator(".source-canvas > .source-layer:not(.source-schema) canvas")).toHaveCount(0);
  });
});

test.describe("individual canvas membership", () => {
  const names = (p: Page) => p.locator("[data-field-record]");
  test("hiding a connection keeps both records, reads nothing and can be shown again unchanged", async ({ page }) => {
    const requests = await mock(page); await start(page);
    await openSourceReferences(page); await reader(page).getByRole("button", { name: "inspect FK 0 reference" }).click();
    await reader(page).getByRole("button", { name: "show connection" }).click();
    await expect(names(page)).toHaveText(["Child 1", "Parent 10"]);
    const ids = await names(page).evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-field-record")));
    const hide = reader(page).getByRole("button", { name: "hide connection", exact: true });
    await expect(hide).toHaveAttribute("title", "hide connection on canvas · the recorded reference is unchanged");
    await expect(page.getByRole("button", { name: /^hide connection Child 1 · .+ → Parent 10$/ })).toHaveAttribute("title", /recorded reference is unchanged/);
    const reads = requests.length;
    await hide.click();
    await expect(page.locator("[data-field-reference]")).toHaveCount(0);
    await expect(names(page)).toHaveText(["Child 1", "Parent 10"]);
    await expect(reader(page).locator("[data-reference-status]")).toHaveText("resolved");
    expect(requests.length).toBe(reads);
    await reader(page).getByRole("button", { name: "show connection" }).click();
    await expect(page.locator("[data-field-reference]")).toHaveCount(1);
    expect(await names(page).evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-field-record")))).toEqual(ids);
    // The list's × on a connection hides it too, and only it.
    await page.getByRole("button", { name: /^hide connection Child 1 · .+ → Parent 10$/ }).press("Enter");
    await expect(page.locator("[data-field-reference]")).toHaveCount(0);
    await expect(names(page)).toHaveText(["Child 1", "Parent 10"]);
    await expect(page.getByRole("button", { name: /keep on canvas|retract/ })).toHaveCount(0);
  });

  test("removing a shared parent or one child removes only that record and its connections", async ({ page }) => {
    await mock(page, [observation(), observation(secondChild)]); await start(page);
    await openSourceReferences(page); await reader(page).getByRole("button", { name: "inspect FK 0 reference" }).click();
    await reader(page).getByRole("button", { name: "show connection" }).click();
    await tables(page).getByRole("button", { name: "Inspect row 2", exact: true }).click();
    await openSourceReferences(page); await reader(page).getByRole("button", { name: "inspect FK 0 reference" }).click();
    await reader(page).getByRole("button", { name: "show connection" }).click();
    await expect(names(page)).toHaveText(["Child 1", "Parent 10", "Child 2"]);
    await expect(page.locator("[data-field-reference]")).toHaveCount(2);
    await page.getByRole("button", { name: "remove Parent 10 from canvas", exact: true }).press("Enter");
    await expect(names(page)).toHaveText(["Child 1", "Child 2"]);
    await expect(page.locator("[data-field-reference]")).toHaveCount(0);
    // Showing again places the parent anew; then removing one child keeps the other's connection.
    await reader(page).getByRole("button", { name: "show connection" }).click();
    await expect(names(page)).toHaveText(["Child 1", "Child 2", "Parent 10"]);
    await page.getByRole("button", { name: "remove Child 1 from canvas", exact: true }).press("Enter");
    await expect(names(page)).toHaveText(["Child 2", "Parent 10"]);
    await expect(page.locator("[data-field-reference]")).toHaveCount(1);
    await expect(reader(page).getByRole("button", { name: "hide connection" })).toBeVisible();
  });

  test("a previously visited endpoint keeps its mark, and closing the Reader removes nothing", async ({ page }) => {
    await mock(page); await page.goto("/source?placement=explicit"); await choose(page, "Parent");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await reader(page).getByRole("button", { name: "show on canvas", exact: true }).click();
    const visited = await names(page).getAttribute("data-field-record");
    await choose(page, "Child");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await openSourceReferences(page); await reader(page).getByRole("button", { name: "inspect FK 0 reference" }).click();
    await reader(page).getByRole("button", { name: "show connection" }).click();
    await expect(names(page)).toHaveText(["Parent 10", "Child 1"]);
    await expect(names(page).first()).toHaveAttribute("data-field-record", visited!);
    await reader(page).getByRole("button", { name: "hide connection" }).click();
    await reader(page).getByRole("button", { name: "open referenced record" }).click();
    await expect(reader(page).locator('[data-placement="show"]')).toHaveText("reveal");
    await reader(page).locator('[data-placement="show"]').click();
    await reader(page).getByRole("button", { name: "close", exact: true }).first().click();
    await expect(names(page)).toHaveText(["Parent 10", "Child 1"]);
    await expect(names(page).first()).toHaveAttribute("data-field-record", visited!);
  });
});

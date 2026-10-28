import { chooseSourceTable as choose, preciseSourceLookup, settleSourceDocks } from "./source-navigation";
/** Mocked HTTP boundary tests, separate from source-live.spec.ts. */
import { test, expect, type Page, type Route } from "@playwright/test";
import type { SourceCatalogue, SourceContext, SourceRecord, SourceRows } from "../src/api/source";

const context: SourceContext = {
  session: "ses1_a/+ %Ω", generation: "gen1_b/+ %Ω", source_namespace: "src1_fixture",
  capture_digest: "a".repeat(64), capture_version: "sqlite_capture_v1", captured_at: "2026-10-17T10:00:00Z",
  time_basis: "capture_observation_not_producer_commit", sqlite_version: "3.51.1", projection_version: "sqlite_source_v1", idle_ttl_seconds: 3600,
  capabilities: { schema: true, row_windows: true, verified_pk_records: true, outgoing_fk_observations: true,
    incoming_fk_observations: false, conceptual_readings: false, browser_refresh: false, query_mappings: false, keyless_record_handles: false, view_record_handles: false },
};
const identity = { status: "verified" as const, key_columns: ["id"], verified_rows: 2, reason: null };
const column = { name: "id", declared_type: "INTEGER", pk_order: 1, notnull: false, default_sql: null, generated: null };
const catalogue: SourceCatalogue = {
  relations: ["Alpha", "Beta"].map((name) => ({ name, kind: "table", identity, read_status: "available", reason: null,
    row_count: null, row_count_status: "not_computed", columns: [column], primary_key: ["id"], foreign_keys: [] })),
  total: 2, offset: 0, has_more: false, next_offset: null, counts: { tables: 2, views: 0, unsupported_virtual_or_shadow: 0 },
};
const rows = (name: string): SourceRows => ({ name, kind: "table", columns: [column], identity, offset: 0, returned: 2, has_more: false, next_offset: null,
  ordering: "verified_primary_key", lineage: null, rows: ["9007199254740992", "9007199254740993"].map((exact) => ({ record_id: `sr1:${name}/${exact} %Ω`, key: [{ column: "id", storage_class: "integer", exact }], cells: [{ column: "id", storage_class: "integer", exact }] })) });
function record(name: string, id: string): SourceRecord {
  const row = rows(name).rows.find((row) => row.record_id === id)!;
  return { ...row, record_id: id, name, kind: "source_record", schema: "main", columns: [column], identity,
    grounding: { ...context, schema: "main", table: name, key: row.key, basis: "stored_row_verified_declared_pk" }, actions: { outgoing_references: true, incoming_references: false } };
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };

async function mock(page: Page, override?: (route: Route, url: URL) => Promise<boolean>) {
  const requests: URL[] = [];
  await page.route("**/source/v1/**", async (route) => {
    const url = new URL(route.request().url()); requests.push(url);
    if (override && await override(route, url)) return;
    if (url.pathname.endsWith("/session")) return route.fulfill({ json: context });
    expect(url.searchParams.getAll("session")).toEqual([context.session]);
    expect(url.searchParams.getAll("generation")).toEqual([context.generation]);
    const name = url.searchParams.get("table") ?? "Alpha";
    if (url.pathname.endsWith("/references")) return route.fulfill({ json: { context, data: {
      record_id: url.searchParams.get("record"), direction: "outgoing", total: 0, observations: [],
      offset: Number(url.searchParams.get("offset")), has_more: false, next_offset: null,
    } } });
    const data = url.pathname.endsWith("/rows") ? rows(name)
      : url.pathname.endsWith("/record") ? record(url.searchParams.get("id")!.includes("Beta") ? "Beta" : "Alpha", url.searchParams.get("id")!) : catalogue;
    await route.fulfill({ json: { context, data } });
  });
  return requests;
}
const tables = (page: Page) => page.locator("#source-tables");
const reader = (page: Page) => page.locator("#source-reader > .motion-swap > .motion-swap__is");

test("client encodes the fixed context and registered handles exactly once on every read", async ({ page }) => {
  const requests = await mock(page);
  await page.goto("/source");
  await choose(page, "Alpha");
  await tables(page).getByRole("button", { name: "Inspect row 2", exact: true }).click();
  await expect(reader(page).locator(".source-cells code")).toHaveText("9007199254740993");
  expect(requests.find((url) => url.pathname.endsWith("/record"))?.searchParams.get("id")).toBe("sr1:Alpha/9007199254740993 %Ω");
  await expect(reader(page).locator("section.source-outgoing")).toContainText("none declared");
  expect(new Set(requests.map((url) => url.pathname))).toEqual(new Set(["/source/v1/session", "/source/v1/overview", "/source/v1/schema", "/source/v1/rows", "/source/v1/record", "/source/v1/references"]));
  expect(requests.find((url) => url.pathname.endsWith("/session"))?.search).toBe("");
});

for (const operation of ["rows", "record"] as const) {
  test(`late ${operation} response cannot replace a newer table or row selection`, async ({ page }) => {
    const started = deferred(), release = deferred(), completed = deferred();
    // Exercise ownership rejection as well as transport cancellation: this
    // record transport deliberately ignores AbortSignal.
    if (operation === "record") await page.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.fetch = (input, init) => original(input, String(input).startsWith("/source/v1/record") ? { ...init, signal: undefined } : init);
    });
    await mock(page, async (route, url) => {
      if (!url.pathname.endsWith(`/${operation}`) || (operation === "rows" ? url.searchParams.get("table") !== "Alpha" : !url.searchParams.get("id")!.includes("9007199254740992"))) return false;
      started.resolve(); await release.promise;
      try { await route.fulfill({ json: { context, data: operation === "rows" ? rows("Alpha") : record("Alpha", url.searchParams.get("id")!) } }); }
      finally { completed.resolve(); }
      return true;
    });
    await page.goto("/source");
    await choose(page, "Alpha");
    if (operation === "record") await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await started.promise;
    if (operation === "rows") await choose(page, "Beta");
    else await tables(page).getByRole("button", { name: "Inspect row 2", exact: true }).click();
    await expect(reader(page).locator("h2")).toContainText(operation === "rows" ? "Beta" : "Alpha");
    if (operation === "record") await expect(reader(page).locator(".source-cells code")).toHaveText("9007199254740993");
    release.resolve(); await completed.promise;
    if (operation === "rows") {
      await expect(tables(page).locator(".motion-swap__is .source-table-heading h2")).toHaveText("Beta");
      await expect(reader(page).locator("h2")).toHaveAccessibleName(/^Beta\s*, table$/);
    } else await expect(reader(page).locator(".source-cells code")).toHaveText("9007199254740993");
  });
}

test("switching table while an exact record is pending clears the previous reader", async ({ page }) => {
  const started = deferred(), release = deferred(), completed = deferred();
  await mock(page, async (route, url) => {
    if (!url.pathname.endsWith("/record")) return false;
    started.resolve(); await release.promise;
    try { await route.fulfill({ json: { context, data: record("Alpha", url.searchParams.get("id")!) } }); } finally { completed.resolve(); }
    return true;
  });
  await page.goto("/source"); await choose(page, "Alpha");
  await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
  await started.promise; await choose(page, "Beta");
  release.resolve(); await completed.promise;
  await expect(reader(page).locator("h2")).toHaveAccessibleName(/^Beta\s*, table$/);
  await expect(reader(page).locator(".source-cells")).toHaveCount(0);
});

for (const field of ["generation", "session", "capture_digest", "source_namespace", "projection_version"] as const) {
  test(`a mismatched response ${field} stops the workspace`, async ({ page }) => {
    const requests = await mock(page, async (route, url) => {
      if (!url.pathname.endsWith("/rows")) return false;
      await route.fulfill({ json: { context: { ...context, [field]: "different" }, data: rows("Alpha") } }); return true;
    });
    await page.goto("/source");
    await expect(tables(page).getByRole("button", { name: "Alpha table", exact: true })).toBeVisible();
    const bootstraps = requests.filter((url) => url.pathname.endsWith("/session")).length;
    await choose(page, "Alpha");
    await expect(page.getByRole("alert")).toContainText("source_context_mismatch");
    await expect(page.getByRole("heading", { name: "source reads stopped" })).toBeVisible();
    await expect(page.locator("#source-reader")).toHaveCount(0);
    expect(requests.filter((url) => url.pathname.endsWith("/session"))).toHaveLength(bootstraps);
  });
}

for (const [status, code, message] of [
  [410, "source_session_missing_or_expired", "This source session has ended"],
  [503, "source_capture_missing", "The private capture of the file is missing, changed or unreadable"],
  [422, "unsupported_source_operation", "not supported"],
  [500, "source_server_failure", "The source service could not complete this read"],
] as const) {
  test(`bootstrap ${status} is explicit and never falls back to World`, async ({ page }) => {
    const world: string[] = [];
    await page.route("**/world/**", (route) => { if (new URL(route.request().url()).pathname.startsWith("/world/")) { world.push(route.request().url()); return route.abort(); } return route.continue(); });
    await page.route("**/source/v1/session", (route) => route.fulfill({ status, json: { error: code } }));
    await page.goto("/source");
    await expect(page.getByRole("alert")).toContainText(message);
    await expect(page.getByRole("alert")).toContainText(code);
    expect(world).toEqual([]);
  });
}

test("disconnected source and invalid JSON are explicit errors", async ({ page }) => {
  await page.route("**/source/v1/session", (route) => route.abort("connectionrefused"));
  await page.goto("/source");
  await expect(page.getByRole("alert")).toContainText("The source service did not answer");
  await page.unroute("**/source/v1/session");
  await page.route("**/source/v1/session", (route) => route.fulfill({ body: "not JSON", contentType: "text/plain" }));
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("source_invalid_response");
});

test("a failed exact-record read shows its error and never the prior record", async ({ page }) => {
  await mock(page, async (route, url) => {
    if (!url.pathname.endsWith("/record") || !url.searchParams.get("id")!.includes("9007199254740993")) return false;
    await route.fulfill({ status: 404, json: { error: "source_record_not_found_in_generation" } }); return true;
  });
  await page.goto("/source"); await choose(page, "Alpha");
  await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
  await expect(reader(page).locator(".source-cells code")).toHaveText("9007199254740992");
  await tables(page).getByRole("button", { name: "Inspect row 2", exact: true }).click();
  await expect(reader(page).getByRole("alert")).toContainText("source_record_not_found_in_generation");
  await expect(reader(page).locator(".source-cells")).toHaveCount(0);
});

test("catalogue paging uses schema pages and leaves unknown row counts unknown", async ({ page }) => {
  await mock(page, async (route, url) => {
    if (!url.pathname.endsWith("/schema")) return false;
    const offset = Number(url.searchParams.get("offset"));
    const relations = Array.from({ length: offset ? 1 : 50 }, (_, i) => ({ ...catalogue.relations[0], name: `Table${offset + i}` }));
    await route.fulfill({ json: { context, data: { ...catalogue, relations, total: 51, offset, has_more: offset === 0, next_offset: offset ? null : 50 } } }); return true;
  });
  await page.goto("/source");
  await expect(tables(page)).toContainText("1–50 of 51");
  await tables(page).getByRole("button", { name: "next tables" }).click();
  await expect(tables(page).getByRole("button", { name: "Table50 table", exact: true })).toBeVisible();
  await expect(tables(page).getByRole("button", { name: "next tables" })).toBeDisabled();
  await expect(tables(page)).toContainText("source details");
  await tables(page).getByRole("button", { name: "previous tables" }).click();
  await expect(tables(page)).toContainText("1–50 of 51");
});

test("explicit source startup opens the main URL without any World requests", async ({ page }) => {
  test.skip(process.env.KI_SOURCE_ENTRY !== "1", "Use playwright.source.config.ts to configure source startup");
  await mock(page);
  let worldReads = 0;
  await page.route("**/world/**", (route) => { if (new URL(route.request().url()).pathname.startsWith("/world/")) { worldReads++; return route.abort(); } return route.continue(); });
  await page.goto("/");
  await expect(tables(page).getByRole("button", { name: "Alpha table", exact: true })).toBeVisible();
  expect(worldReads).toBe(0);
});

test("entry choices preserve World-only and original routes", async ({ page }) => {
  await page.goto("/icon-preview");
  const choices = await page.evaluate(async () => {
    const { inspectorEntry } = await import(/* @vite-ignore */ "/src/entry.ts");
    return [inspectorEntry("/"), inspectorEntry("/", "source"), inspectorEntry("/world", "source"), inspectorEntry("/sqlite", "source"), inspectorEntry("/icon-preview", "source"), inspectorEntry("/source"), inspectorEntry("/", "typo")];
  });
  expect(choices).toEqual(["world", "source", "world", "sqlite", "icons", "source", "invalid"]);
});

test("an oversized window can be reduced without changing source context", async ({ page }) => {
  const requests = await mock(page, async (route, url) => {
    if (!url.pathname.endsWith("/rows")) return false;
    if (url.searchParams.get("limit") === "50") await route.fulfill({ status: 413, json: { error: "source_page_budget_exceeded" } });
    else await route.fulfill({ json: { context, data: { ...rows("Alpha"), rows: rows("Alpha").rows.slice(0, 1), returned: 1 } } });
    return true;
  });
  await page.goto("/source"); await choose(page, "Alpha");
  await expect(tables(page).getByRole("alert")).toContainText("Choose fewer rows per page");
  const initialWindows = requests.filter((url) => url.pathname.endsWith("/rows"));
  expect(initialWindows.length).toBeGreaterThan(0);
  for (const url of initialWindows) expect(url.searchParams.get("limit")).toBe("50");
  await tables(page).getByRole("combobox", { name: "rows per page" }).selectOption("1");
  await expect(tables(page).getByRole("button", { name: "Inspect row 1", exact: true })).toBeVisible();
  await expect(tables(page).getByRole("alert")).toHaveCount(0);
  const windows = requests.filter((url) => url.pathname.endsWith("/rows"));
  expect(windows.slice(initialWindows.length).map((url) => url.searchParams.get("limit"))).toEqual(["1"]);
  for (const url of windows) {
    expect(url.searchParams.get("session")).toBe(context.session);
    expect(url.searchParams.get("generation")).toBe(context.generation);
  }
});

test("the explicit World route does not probe source capability", async ({ page }) => {
  const sourceReads: string[] = [];
  await page.route("**/source/v1/**", (route) => { sourceReads.push(route.request().url()); return route.abort(); });
  await page.route("**/world/**", (route) => new URL(route.request().url()).pathname.startsWith("/world/")
    ? route.fulfill({ status: 503, json: { error: "intentionally_unavailable_world_fixture" } }) : route.continue());
  await page.goto(process.env.KI_SOURCE_ENTRY === "1" ? "/world" : "/");
  await expect(page.locator("main.product-shell.world")).toBeVisible();
  await expect(page.locator(".source-workspace")).toHaveCount(0);
  expect(sourceReads).toEqual([]);
});

test("unsupported catalogue metadata remains unavailable rather than an invented negative", async ({ page }) => {
  const requests = await mock(page, async (route, url) => {
    if (!url.pathname.endsWith("/schema")) return false;
    await route.fulfill({ json: { context, data: { ...catalogue, relations: [{ name: "Unknown", kind: "virtual", read_status: "unsupported", reason: "unsupported_virtual_source", row_count: null, row_count_status: "not_computed", identity: { ...identity, status: "unsupported", key_columns: [], verified_rows: null, reason: "unsupported_virtual_source" } }] } } });
    return true;
  });
  await page.goto("/source");
  await tables(page).getByRole("button", { name: "Unknown virtual · unsupported", exact: true }).click();
  await expect(reader(page)).toContainText("key · metadata unavailable");
  await expect(reader(page)).toContainText("reference metadata unavailable");
  await expect(reader(page)).toContainText("column metadata unavailable");
  await expect(reader(page)).not.toContainText("key · none declared");
  await expect(reader(page)).not.toContainText("none declared");
  expect(requests.some((url) => url.pathname.endsWith("/rows"))).toBe(false);
});

test("closing the Reader returns to a visible Tables target even before selection or with Tables closed", async ({ page }) => {
  await mock(page); await page.goto("/source");
  await expect(tables(page).getByRole("button", { name: "Alpha table", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "reader", exact: true }).press("Enter");
  await reader(page).getByRole("button", { name: "close", exact: true }).press("Enter");
  await expect(tables(page).getByRole("heading", { name: "tables", exact: true })).toBeFocused();
  await choose(page, "Alpha");
  await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
  await expect(reader(page).locator(".source-cells code")).toHaveText("9007199254740992");
  await tables(page).getByRole("button", { name: "close", exact: true }).click();
  await reader(page).getByRole("button", { name: "close", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "tables", exact: true })).toBeFocused();
});

test("an exact record payload from another table is refused even with a matching envelope", async ({ page }) => {
  await mock(page, async (route, url) => {
    if (!url.pathname.endsWith("/record")) return false;
    await route.fulfill({ json: { context, data: { ...record("Alpha", url.searchParams.get("id")!), name: "Beta" } } });
    return true;
  });
  await page.goto("/source"); await choose(page, "Alpha");
  await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("source_context_mismatch");
  await expect(page.getByRole("heading", { name: "source reads stopped" })).toBeVisible();
});

type SourceMotionFrame = {
  outgoing: { title: string; caption: string; values: string[]; scrollTop: number; openDetails: number }[];
  live: { title: string; caption: string; values: string[] } | null;
  focusInOutgoing: boolean;
  outgoingHits: number;
};
type SourceProbe = { frames: SourceMotionFrame[]; actions: number; stop: () => void };
type ProbeWindow = Window & { __sourceMotionProbe?: SourceProbe };

async function probeSourceMotion(page: Page, panel: "reader" | "tables") {
  await page.evaluate((panel) => {
    const host = document.querySelector(`#source-${panel}`)!;
    const frames: SourceMotionFrame[] = [];
    let running = true;
    const probe: SourceProbe = { frames, actions: 0, stop: () => {
      running = false;
      for (const name of ["pointerdown", "click", "keydown"]) document.removeEventListener(name, event, true);
    } };
    const event = (event: Event) => { if ((event.target as Element)?.closest?.(".motion-swap__was")) probe.actions++; };
    for (const name of ["pointerdown", "click", "keydown"]) document.addEventListener(name, event, true);
    const subject = (node: Element) => ({
      title: node.querySelector("h2")?.childNodes[0]?.textContent ?? "",
      caption: node.querySelector(".world-reader__heading > p")?.textContent ?? "",
      values: Array.from(node.querySelectorAll(".source-cells code")).map((value) => value.textContent ?? ""),
    });
    const frame = () => {
      if (!running) return;
      const outgoing = Array.from(host.querySelectorAll(".motion-swap__was"));
      const live = host.querySelector(".motion-swap__is");
      let outgoingHits = 0;
      for (const old of outgoing) {
        if (!old.hasAttribute("inert") || old.getAttribute("aria-hidden") !== "true") throw new Error("Outgoing source view is operable");
        for (const control of old.querySelectorAll("button, summary, select")) {
          const box = control.getBoundingClientRect();
          if (!box.width || !box.height || box.left < 0 || box.right > innerWidth || box.top < 0 || box.bottom > innerHeight) continue;
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          if (hit?.closest(".motion-swap__was")) outgoingHits++;
        }
      }
      frames.push({
        outgoing: outgoing.map((node) => ({ ...subject(node), scrollTop: node.querySelector(".source-reader-body")?.scrollTop ?? 0, openDetails: node.querySelectorAll("details[open]").length })),
        live: live ? subject(live) : null,
        focusInOutgoing: Boolean(document.activeElement?.closest(".motion-swap__was")), outgoingHits,
      });
      requestAnimationFrame(frame);
    };
    (window as ProbeWindow).__sourceMotionProbe?.stop();
    (window as ProbeWindow).__sourceMotionProbe = probe;
    requestAnimationFrame(frame);
  }, panel);
}

async function sourceFrames(page: Page) {
  return page.evaluate(() => (window as ProbeWindow).__sourceMotionProbe?.frames ?? []);
}
async function finishSourceMotion(page: Page) {
  await expect(page.locator("#source-reader .motion-swap__was, #source-tables .motion-swap__was")).toHaveCount(0);
  await expect.poll(() => reader(page).evaluate((node) => getComputedStyle(node).opacity)).toBe("1");
  return page.evaluate(() => {
    const probe = (window as ProbeWindow).__sourceMotionProbe!;
    probe.stop();
    return { frames: probe.frames, actions: probe.actions };
  });
}

for (const motion of ["reduce", "no-preference"] as const) {
  test.describe(`source transitions: ${motion}`, () => {
    test.use({ reducedMotion: motion });

    test("record snapshots retain their own key, exact values, disclosures and viewport without restarting reads", async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 700 });
      const requests = await mock(page);
      await page.goto("/source"); await choose(page, "Alpha");
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
      await expect(reader(page).locator(".source-cells code")).toHaveText("9007199254740992");
      await reader(page).getByText("identity details", { exact: true }).click();
      await reader(page).getByText("source details", { exact: true }).click();
      await expect(reader(page).locator("dt").filter({ hasText: /^idle expiry$/ }).locator("+ dd")).toHaveText("3600 seconds");
      await expect(reader(page).locator("details[open]")).toHaveCount(2);
      await reader(page).locator(".source-reader-body").evaluate((node) => { node.scrollTop = node.scrollHeight; });
      await expect.poll(() => reader(page).locator(".source-reader-body").evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
      await probeSourceMotion(page, "reader");
      await tables(page).getByRole("button", { name: "Inspect row 2", exact: true }).click();
      await expect(reader(page).locator(".source-cells code")).toHaveText("9007199254740993");
      const result = await finishSourceMotion(page);
      const departing = result.frames.flatMap((frame) => frame.outgoing);
      if (motion === "no-preference") {
        expect(departing.length).toBeGreaterThan(0);
        for (const snapshot of departing) {
          expect(snapshot.caption).toBe("id=9007199254740992");
          expect(snapshot.values).toEqual(["9007199254740992"]);
          expect(snapshot.openDetails).toBe(2);
          expect(snapshot.scrollTop).toBeGreaterThan(0);
        }
      }
      for (const frame of result.frames) {
        if (frame.live?.caption === "id=9007199254740993" && frame.live.values.length) expect(frame.live.values).toEqual(["9007199254740993"]);
        expect(frame.focusInOutgoing).toBe(false); expect(frame.outgoingHits).toBe(0);
      }
      expect(result.actions).toBe(0);
      expect(requests.filter((url) => url.pathname.endsWith("/record")).map((url) => url.searchParams.get("id"))).toEqual([
        "sr1:Alpha/9007199254740992 %Ω", "sr1:Alpha/9007199254740993 %Ω",
      ]);
      await expect(reader(page).locator("details[open]")).toHaveCount(0);
      expect(await reader(page).locator(".source-reader-body").evaluate((node) => node.scrollTop)).toBe(0);
    });

    test("table replacement keeps outgoing controls inert and keyboard focus in the live subject", async ({ page }) => {
      const requests = await mock(page);
      await page.goto("/source"); await choose(page, "Alpha");
      await expect(tables(page).getByRole("button", { name: "Inspect row 1", exact: true })).toBeVisible();
      await probeSourceMotion(page, "tables");
      await tables(page).locator("[data-catalogue]").press("Enter");
      await tables(page).getByRole("button", { name: "Beta table", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(reader(page).locator("h2")).toBeFocused();
      await page.keyboard.press("Tab");
      const result = await finishSourceMotion(page);
      if (motion === "no-preference") expect(result.frames.some((frame) => frame.outgoing.some((old) => old.title === "Alpha"))).toBe(true);
      for (const frame of result.frames) {
        expect(frame.focusInOutgoing).toBe(false); expect(frame.outgoingHits).toBe(0);
      }
      expect(result.actions).toBe(0);
      expect(requests.filter((url) => url.pathname.endsWith("/rows")).map((url) => url.searchParams.get("table"))).toEqual(["Alpha", "Beta"]);
      await expect(reader(page).locator("h2")).toHaveAccessibleName(/^Beta\s*, table$/);
    });

    test("rapid record navigation rejects an old response even when fetch ignores cancellation", async ({ page }) => {
      const reached = deferred(), release = deferred(), completed = deferred();
      await page.addInitScript(() => {
        const original = window.fetch.bind(window);
        window.fetch = (input, init) => original(input, String(input).startsWith("/source/v1/record") ? { ...init, signal: undefined } : init);
      });
      const requests = await mock(page, async (route, url) => {
        if (!url.pathname.endsWith("/record") || !url.searchParams.get("id")!.includes("9007199254740992")) return false;
        reached.resolve(); await release.promise;
        try { await route.fulfill({ json: { context, data: record("Alpha", url.searchParams.get("id")!) } }); } finally { completed.resolve(); }
        return true;
      });
      await page.goto("/source"); await choose(page, "Alpha");
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
      await reached.promise;
      await tables(page).getByRole("button", { name: "Inspect row 2", exact: true }).click();
      await expect(reader(page).locator(".source-cells code")).toHaveText("9007199254740993");
      release.resolve(); await completed.promise;
      await expect(page.locator("#source-reader .motion-swap__was")).toHaveCount(0);
      await expect(reader(page).locator(".world-reader__heading > p")).toHaveText("id=9007199254740993");
      await expect(reader(page).locator(".source-cells code")).toHaveText("9007199254740993");
      expect(requests.filter((url) => url.pathname.endsWith("/record"))).toHaveLength(2);
    });

    test("expiry discards live and outgoing source content and never reboots the context", async ({ page }) => {
      const reached = deferred(), release = deferred();
      const requests = await mock(page, async (route, url) => {
        if (!url.pathname.endsWith("/record") || !url.searchParams.get("id")!.includes("9007199254740993")) return false;
        reached.resolve(); await release.promise;
        await route.fulfill({ status: 410, json: { error: "source_session_missing_or_expired" } }); return true;
      });
      await page.goto("/source"); await choose(page, "Alpha");
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
      await expect(reader(page).locator(".source-cells code")).toHaveText("9007199254740992");
      const bootstraps = requests.filter((url) => url.pathname.endsWith("/session")).length;
      await tables(page).getByRole("button", { name: "Inspect row 2", exact: true }).click();
      await reached.promise;
      if (motion === "no-preference") await expect(page.locator("#source-reader .motion-swap__was .source-cells")).toHaveCount(1);
      release.resolve();
      await expect(page.getByRole("alert")).toContainText("expired");
      await expect(page.locator(".source-cells, .motion-swap__was, #source-reader, #source-tables")).toHaveCount(0);
      expect(requests.filter((url) => url.pathname.endsWith("/session"))).toHaveLength(bootstraps);
    });

    test("duplicate keyless rows remain separate window selections, including after a new window", async ({ page }) => {
      const requests = await mock(page, async (route, url) => {
        if (url.pathname.endsWith("/schema")) {
          await route.fulfill({ json: { context, data: { ...catalogue, relations: [{ ...catalogue.relations[0], identity: { ...identity, status: "no_declared_key", key_columns: [], verified_rows: null }, primary_key: [] }] } } }); return true;
        }
        if (!url.pathname.endsWith("/rows")) return false;
        await route.fulfill({ json: { context, data: { ...rows("Alpha"), identity: { ...identity, status: "no_declared_key", key_columns: [], verified_rows: null }, rows: rows("Alpha").rows.map((row) => ({ ...row, record_id: null, key: [], cells: [{ column: "id", storage_class: "text", exact: "duplicate" }] })) } } }); return true;
      });
      await page.goto("/source"); await choose(page, "Alpha");
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
      await expect(reader(page).locator(".world-reader__heading > p")).toHaveText("row 1 · this page only");
      await tables(page).getByRole("button", { name: "Inspect row 2", exact: true }).click();
      await expect(reader(page).locator(".world-reader__heading > p")).toHaveText("row 2 · this page only");
      await expect(reader(page)).toContainText("No registered source handle");
      await tables(page).getByRole("combobox", { name: "rows per page" }).selectOption("1");
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
      await expect(reader(page).locator(".world-reader__heading > p")).toHaveText("row 1 · this page only");
      await expect(reader(page).locator(".source-cells code")).toHaveText('"duplicate"');
      expect(requests.some((url) => url.pathname.endsWith("/record"))).toBe(false);
    });

    test("rows retain deliberate stillness while theme and subject transitions use the shared spine", async ({ page }) => {
      await mock(page); await page.goto("/source?placement=explicit"); await choose(page, "Alpha");
      await expect(tables(page).getByRole("button", { name: "Inspect row 1", exact: true })).toBeVisible();
      const rowMotion = await tables(page).getByRole("row").nth(1).evaluate((node) => ({ rule: node.getAttribute("data-still"), transform: getComputedStyle(node).transform, duration: getComputedStyle(node).transitionDuration }));
      expect(rowMotion).toEqual({ rule: "rowsNeverFly", transform: "none", duration: "0s" });
      // The appearance switch is in the product bar, which the schema room (the
      // empty canvas) hides as World's does: one record takes the canvas first.
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
      await reader(page).getByRole("button", { name: "show on canvas", exact: true }).click();
      await expect(page.locator("[data-field-record]")).toHaveCount(1);
      await page.getByRole("button", { name: "Use dark appearance" }).click();
      await expect(page.locator("main.source-workspace")).toHaveClass(/is-dark/);
      const paletteAnimations = await page.locator("main.source-workspace").evaluate((node) => node.getAnimations().filter((animation) => "transitionProperty" in animation && /canvas|ink|panel|rule/.test((animation as CSSTransition).transitionProperty)).length);
      // Ordinary appearance follows World; source also reduces palette motion.
      if (motion === "no-preference") expect(paletteAnimations).toBeGreaterThan(0);
      else expect(await page.locator("main.source-workspace").evaluate((node) => getComputedStyle(node).transitionDuration)).toBe("0.001s");
      const durations = await reader(page).evaluate((node) => ({ own: getComputedStyle(node).transitionDuration, spine: getComputedStyle(node).getPropertyValue("--motion-emit-duration").trim() }));
      expect(durations.spine).toBeTruthy();
      expect(durations.own).toBe(motion === "reduce" ? "0.001s" : `${Number.parseFloat(durations.spine) / 1000}s`);
      // The switch placed nothing.
      await expect(page.locator("[data-field-record]")).toHaveCount(1);
    });
  });
}

for (const motion of ["reduce", "no-preference"] as const) {
  test(`source transitions: ${motion} rapid Alpha → Beta → Alpha keeps the latest window`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: motion });
    await page.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.fetch = (input, init) => original(input, String(input).startsWith("/source/v1/rows") ? { ...init, signal: undefined } : init);
    });
    const reached = deferred(), release = deferred(), completed = deferred();
    let first = true;
    const requests = await mock(page, async (route, url) => {
      if (!first || !url.pathname.endsWith("/rows") || url.searchParams.get("table") !== "Alpha") return false;
      first = false; reached.resolve(); await release.promise;
      try { await route.fulfill({ json: { context, data: { ...rows("Alpha"), rows: [{ record_id: "sr1:old-window", key: [], cells: [{ column: "id", storage_class: "integer", exact: "111" }] }], returned: 1 } } }); }
      finally { completed.resolve(); }
      return true;
    });
    await page.goto("/source"); await choose(page, "Alpha"); await reached.promise;
    await choose(page, "Beta");
    await expect(tables(page).getByRole("button", { name: "Inspect row 2", exact: true })).toBeVisible();
    await choose(page, "Alpha");
    await expect(tables(page).getByRole("button", { name: "Inspect row 2", exact: true })).toBeVisible();
    release.resolve(); await completed.promise;
    await expect(page.locator("#source-tables .motion-swap__was")).toHaveCount(0);
    await expect(tables(page).locator(".motion-swap__is .source-table-heading h2")).toHaveText("Alpha");
    await expect(tables(page).getByRole("cell", { name: "9007199254740993", exact: true })).toBeVisible();
    await expect(tables(page).getByRole("cell", { name: "111", exact: true })).toHaveCount(0);
    expect(requests.filter((url) => url.pathname.endsWith("/rows")).map((url) => url.searchParams.get("table"))).toEqual(["Alpha", "Beta", "Alpha"]);
  });
}

test("a row is selected by clicking anywhere on it, but not by finishing a text selection", async ({ page }) => {
  await mock(page); await page.goto("/source"); await choose(page, "Alpha");
  const value = tables(page).getByRole("row").nth(1).locator("code");
  await expect(value).toHaveText("9007199254740992");
  // Dragging across a value to copy it ends in a click on the row; that is copying, not selecting.
  await expect(page.locator(".motion-swap__was")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await settleSourceDocks(page);
  const box = (await value.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 5 }); await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).not.toBe("");
  await expect(tables(page).getByRole("button", { name: "Inspect row 1", exact: true })).toHaveAttribute("aria-pressed", "false");
  // A plain click on any cell selects the row, exactly as the position control does.
  await tables(page).getByRole("row").nth(2).locator("td").nth(1).click();
  await expect(tables(page).getByRole("button", { name: "Inspect row 2", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(reader(page).locator(".world-reader__heading > p")).toHaveText("id=9007199254740993");
});

for (const motion of ["reduce", "no-preference"] as const) {
  for (const outcome of ["end", "error"] as const) {
    test(`pagination retains keyboard focus through loading and ${outcome} (${motion})`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: motion });
      const started = deferred(), release = deferred();
      const requests = await mock(page, async (route, url) => {
        if (!url.pathname.endsWith("/rows")) return false;
        if (url.searchParams.get("offset") === "0") {
          await route.fulfill({ json: { context, data: { ...rows("Alpha"), has_more: true, next_offset: 50 } } });
        } else {
          started.resolve(); await release.promise;
          if (outcome === "error") await route.fulfill({ status: 500, json: { error: "source_read_failed" } });
          else await route.fulfill({ json: { context, data: { ...rows("Alpha"), offset: 50, returned: 1, rows: rows("Alpha").rows.slice(0, 1) } } });
        }
        return true;
      });
      await page.goto("/source"); await choose(page, "Alpha");
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
      await expect(reader(page).locator(".world-reader__heading > p")).toHaveText("id=9007199254740992");
      const next = tables(page).getByRole("button", { name: "next rows" });
      await next.focus(); await page.keyboard.press("Enter"); await started.promise;
      try {
        await expect(next).toBeFocused();
        await expect(next).toBeDisabled();
        await page.keyboard.press("Enter");
        expect(requests.filter((url) => url.pathname.endsWith("/rows"))).toHaveLength(2);
      } finally { release.resolve(); }
      if (outcome === "error") {
        await expect(tables(page).getByRole("alert")).toContainText("source_read_failed");
        await expect(tables(page).getByRole("status")).toHaveText("page unavailable");
      } else await expect(tables(page)).toContainText("rows 51–51 · end");
      await expect(next).toBeFocused();
      await expect(next).toBeDisabled();
      await page.keyboard.press("Shift+Tab");
      const previous = tables(page).getByRole("button", { name: "previous rows" });
      await expect(previous).toBeFocused();
      await page.keyboard.press("Space");
      await expect(tables(page)).toContainText("rows 1–2 · more available");
      await expect(previous).toBeFocused();
      expect(requests.filter((url) => url.pathname.endsWith("/rows")).map((url) => url.searchParams.get("offset"))).toEqual(["0", "50", "0"]);
      await page.keyboard.press("Escape");
      await expect(page.locator('[data-overlay="source-reader"]')).not.toHaveClass(/is-open/);
      await expect(previous).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.locator('[data-overlay="source-tables"] > .ov__handle')).toBeFocused();
    });
  }

  test(`row positions retain native table/button semantics and keyboard operation (${motion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: motion });
    const requests = await mock(page);
    await page.goto("/source"); await choose(page, "Alpha");
    const rowButtons = tables(page).locator("button[data-row]");
    // No visible number: the key beside it says which row it is (owner decision O6).
    await expect(rowButtons).toHaveText(["", ""]);
    await expect(rowButtons.nth(0)).toHaveAccessibleName("Inspect row 1");
    await expect(rowButtons.nth(1)).toHaveAccessibleName("Inspect row 2");
    await expect(tables(page).getByRole("columnheader", { name: "Window position" })).toBeVisible();
    await expect(tables(page).getByRole("row")).toHaveCount(3);
    expect(await tables(page).locator("tbody tr").evaluateAll((nodes) => nodes.every((node) => !node.hasAttribute("role") && node.querySelector("td > button")?.tagName === "BUTTON"))).toBe(true);
    await rowButtons.nth(0).focus(); await page.keyboard.press("Space");
    await expect(reader(page).getByRole("heading", { name: /^Alpha\s*, id=9007199254740992$/ })).toBeFocused();
    await expect(rowButtons.nth(0)).toHaveAttribute("aria-pressed", "true");
    await reader(page).getByRole("button", { name: "close", exact: true }).press("Enter");
    await expect(rowButtons.nth(0)).toBeFocused();
    await page.keyboard.press("Tab"); await expect(rowButtons.nth(1)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(reader(page).getByRole("heading", { name: /^Alpha\s*, id=9007199254740993$/ })).toBeFocused();
    await expect(rowButtons.nth(1)).toHaveAttribute("aria-pressed", "true");
    expect(requests.filter((url) => url.pathname.endsWith("/record")).map((url) => url.searchParams.get("id"))).toEqual(rows("Alpha").rows.map((row) => row.record_id));
  });
}

function searchRows(url: URL) {
  const base = rows(url.searchParams.get("table") ?? "Alpha");
  return { ...base, rows: base.rows.map((row) => ({ ...row, matched_columns: ["id"] })),
    search: { mode: "literal", text: url.searchParams.get("text"), column: url.searchParams.get("column"), key: null,
      case: url.searchParams.get("case") ?? "ignore" },
    text_comparison: { policy: url.searchParams.get("case") === "match" ? "exact_v1" : "casefold_v1", unicode_version: "15.1.0" },
    completion: "complete", searched_columns: ["id"], excluded_storage_classes: ["null", "blob"] };
}

for (const motion of ["reduce", "no-preference"] as const) {
  for (const change of ["query", "column", "table", "clear"] as const) {
    test(`late search cannot replace ${change} with cancellation-resistant transport (${motion})`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: motion });
      await page.addInitScript(() => {
        const fetch = window.fetch.bind(window);
        window.fetch = (input, init) => fetch(input, String(input).startsWith("/source/v1/search") ? { ...init, signal: undefined } : init);
      });
      const started = deferred(), release = deferred(), completed = deferred();
      const requests = await mock(page, async (route, url) => {
        if (!url.pathname.endsWith("/search")) return false;
        if (url.searchParams.get("text") === "first") {
          started.resolve(); await release.promise;
          try { await route.fulfill({ json: { context, data: { ...searchRows(url), rows: [], returned: 0 } } }); }
          finally { completed.resolve(); }
        } else await route.fulfill({ json: { context, data: searchRows(url) } });
        return true;
      });
      await page.goto("/source"); await choose(page, "Alpha");
      const input = tables(page).getByRole("searchbox", { name: "filter Alpha", exact: true });
      await input.fill("first"); await input.press("Enter"); await started.promise;
      if (change === "table") await choose(page, "Beta");
      else if (change === "clear") await tables(page).getByRole("form", { name: /^filter / }).getByRole("button", { name: "clear" }).click();
      else if (change === "column") { await preciseSourceLookup(page); await tables(page).getByRole("combobox", { name: "search columns" }).selectOption('"id"'); }
      else { await input.fill("second"); await input.press("Enter"); }
      release.resolve(); await completed.promise;
      if (change === "column") {
        await expect(tables(page)).toContainText("press enter to filter");
        await expect(tables(page).getByRole("button", { name: "Inspect row 1", exact: true })).toHaveCount(0);
      } else {
        await expect(tables(page).getByRole("button", { name: "Inspect row 2", exact: true })).toBeVisible();
        await tables(page).getByRole("button", { name: "Inspect row 2", exact: true }).click();
        await expect(reader(page).locator(".source-cells code")).toHaveText("9007199254740993");
        await expect(reader(page).locator("h2")).toContainText(change === "table" ? "Beta" : "Alpha");
      }
      expect(requests.filter((url) => url.pathname.endsWith("/search"))).toHaveLength(change === "query" ? 2 : 1);
      await expect(page.locator(".motion-swap__was button:focus")).toHaveCount(0);
    });
  }
}

for (const failure of ["session", "generation", "capture_digest", "source_namespace", "projection_version", "expired", "budget"] as const) {
  test(`search ${failure} is qualified and context failures stop reads`, async ({ page }) => {
    const requests = await mock(page, async (route, url) => {
      if (!url.pathname.endsWith("/search")) return false;
      if (failure === "expired" || failure === "budget") await route.fulfill({ status: failure === "expired" ? 410 : 422, json: { error: failure === "expired" ? "source_session_missing_or_expired" : "source_query_budget_exceeded" } });
      else await route.fulfill({ json: { context: { ...context, [failure]: "wrong" }, data: searchRows(url) } });
      return true;
    });
    await page.goto("/source"); await choose(page, "Alpha");
    const bootstraps = requests.filter((url) => url.pathname.endsWith("/session")).length;
    await tables(page).getByRole("searchbox").fill("test");
    await tables(page).getByRole("button", { name: "filter", exact: true }).click();
    if (failure === "budget") {
      await expect(tables(page)).toContainText("filter incomplete");
      await expect(tables(page)).not.toContainText("no matches");
      await tables(page).getByRole("form", { name: /^filter / }).getByRole("button", { name: "clear" }).click();
      await expect(tables(page).getByRole("button", { name: "Inspect row 1", exact: true })).toBeVisible();
    } else {
      await expect(page.getByRole("heading", { name: "source reads stopped" })).toBeVisible();
      await expect(page.locator(".source-find")).toHaveCount(0);
    }
    expect(requests.filter((url) => url.pathname.endsWith("/session"))).toHaveLength(bootstraps);
  });
}

test("a pending exact Reader reply cannot survive editing Find", async ({ page }) => {
  const started = deferred(), release = deferred(), completed = deferred();
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = (input, init) => fetch(input, { ...init, signal: undefined });
  });
  await mock(page, async (route, url) => {
    if (url.pathname.endsWith("/search")) { await route.fulfill({ json: { context, data: searchRows(url) } }); return true; }
    if (!url.pathname.endsWith("/record")) return false;
    started.resolve(); await release.promise;
    try { await route.fulfill({ json: { context, data: record("Alpha", url.searchParams.get("id")!) } }); }
    finally { completed.resolve(); }
    return true;
  });
  await page.goto("/source"); await choose(page, "Alpha");
  await tables(page).getByRole("searchbox").fill("test");
  await tables(page).getByRole("button", { name: "filter", exact: true }).click();
  await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
  await started.promise;
  await tables(page).getByRole("searchbox").fill("new draft");
  release.resolve(); await completed.promise;
  await expect(reader(page).locator("h2")).toHaveAccessibleName(/^Alpha\s*, table$/);
  await expect(reader(page).locator(".source-cells")).toHaveCount(0);
});

for (const motion of ["reduce", "no-preference"] as const) {
  test(`editing or clearing Find retains keyboard focus after selecting a result (${motion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: motion });
    await mock(page, async (route, url) => {
      if (!url.pathname.endsWith("/search")) return false;
      await route.fulfill({ json: { context, data: searchRows(url) } }); return true;
    });
    await page.goto("/source"); await choose(page, "Alpha");
    const input = tables(page).getByRole("searchbox");
    await input.fill("test"); await input.press("Enter");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).press("Enter");
    await expect(reader(page).locator("h2")).toBeFocused();
    await input.focus(); await input.press("Backspace");
    await expect(tables(page)).toContainText("press enter to filter");
    await expect(reader(page).locator("h2")).toHaveAccessibleName(/^Alpha\s*, table$/);
    await expect(page.locator(".motion-swap__was")).toHaveCount(0);
    await expect(input).toBeFocused();
    await input.press("Enter");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).press("Enter");
    await expect(reader(page).locator("h2")).toBeFocused();
    const clear = tables(page).getByRole("form", { name: /^filter / }).getByRole("button", { name: "clear" });
    await clear.press("Enter");
    await expect(reader(page).locator("h2")).toHaveAccessibleName(/^Alpha\s*, table$/);
    await expect(page.locator(".motion-swap__was")).toHaveCount(0);
    await expect(clear).toHaveCount(0);
    await expect(input).toBeFocused();
  });
}

test("resuming a table preserves its draft and outgoing table stays inert", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await mock(page);
  await page.goto("/source"); await choose(page, "Alpha");
  await tables(page).getByRole("searchbox").fill("previous query");
  await choose(page, "Alpha");
  await expect(tables(page).getByRole("searchbox")).toHaveValue("previous query");
  await expect(tables(page)).toContainText("press enter to filter");
  await tables(page).getByRole("searchbox").fill("retained draft");
  await tables(page).locator('[data-catalogue]').click();
  const outgoing = tables(page).locator('.source-table-slot > .motion-swap > .motion-swap__was');
  await expect(outgoing.locator('input[type="search"]')).toHaveValue("retained draft");
  await expect(outgoing).toHaveAttribute("inert", "");
  await tables(page).getByRole("button", { name: "Beta table", exact: true }).click();
  await expect(tables(page).getByRole("searchbox")).toHaveValue("");
});

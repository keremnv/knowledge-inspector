import { chooseSourceTable as choose } from "./source-navigation";
/** The incoming page budget and admission overload through the actual
 * SourceHTTPServer, no route mocks. A disposable fixture: one parent row that
 * every child row references through twelve parallel declarations, so every
 * count scans 1.5 million rows, and a one-row table to browse cheaply. */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveSource } from "./source-serve";
import { sourceList as list, sourceReader as reader, sourceTable as tables } from "./canvas-parity";

const incoming = (p: Page) => reader(p).locator(".source-incoming");
const meta = (p: Page) => incoming(p).locator(".gm__list li .gm__list-meta");
async function fixture(use: (db: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "ki-overload-")), db = join(dir, "fixture.sqlite");
  const fks = Array.from({ length: 12 }, () => "FOREIGN KEY(c) REFERENCES parent(id)").join(", ");
  try {
    execFileSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(sys.argv[2]); c.close()", db,
      `CREATE TABLE parent(id INTEGER PRIMARY KEY); INSERT INTO parent VALUES (1);
       CREATE TABLE child(id INTEGER PRIMARY KEY, c INTEGER, ${fks});
       CREATE TABLE other(id INTEGER PRIMARY KEY); INSERT INTO other VALUES (1);
       WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1500000) INSERT INTO child SELECT i, 1 FROM n;`]);
    await use(db);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function openParent(p: Page, origin: string) {
  await p.goto(`${origin}/source?placement=explicit`); await choose(p, "parent");
  await tables(p).getByRole("button", { name: "Inspect row 1", exact: true }).click();
  await expect(incoming(p).locator("h3")).toHaveText("referenced by · 12 declared");
}

test("a spent page budget is named per group, never zero, and every group stays browsable", async ({ page }) => {
  await fixture((db) => serveSource(db, async ({ origin, captureFingerprint }) => {
    const capture = await captureFingerprint();
    const counted = page.waitForResponse((r) => r.url().includes("direction=incoming"));
    await openParent(page, origin);
    const body = await (await counted).json();
    // Each count exhausts its own ordinary budget: the first, its own; the second, the page's rest.
    expect(body.data.groups.map((g: any) => [g.count.status, g.count.reason])).toEqual([
      ["unavailable", "source_query_budget_exceeded"], ["unavailable", "incoming_page_budget_exceeded"],
      ...Array(8).fill(["not_checked", "incoming_page_budget_exceeded"])]);
    await expect(meta(page)).toHaveText(["count unavailable · query limit reached · table", "count unavailable · page limit reached · table",
      ...Array(8).fill("count not checked · page limit reached · table")]);
    // A page of fewer declarations has its own budget.
    await incoming(page).getByRole("button", { name: "next declarations" }).click();
    await expect(meta(page)).toHaveText(["count unavailable · query limit reached · table", "count unavailable · page limit reached · table"]);
    await incoming(page).getByRole("button", { name: "previous declarations" }).click();
    await incoming(page).locator(".gm__list li button").nth(5).click();
    await expect(tables(page).locator("[data-incoming-subject]")).toHaveText("rows referencing parent 1 through c · count not checked · page limit reached");
    await expect(tables(page).getByRole("button", { name: "Inspect row 50", exact: true })).toBeVisible();
    expect(await captureFingerprint()).toEqual(capture);
  }));
});

test("admission overload is a recoverable busy refusal: the field stays and try again reads once", async ({ page }) => {
  // Counts stop on time, not steps: each incoming request holds the reader for about the page's second.
  await fixture((db) => serveSource(db, async ({ origin, requests }) => {
    await openParent(page, origin);
    await reader(page).getByRole("button", { name: "show on canvas", exact: true }).click();
    await expect(list(page).locator("[data-field-record]")).toHaveText(["parent 1"]);
    const context = await (await fetch(`${origin}/source/v1/session`)).json();
    const suffix = `session=${encodeURIComponent(context.session)}&generation=${encodeURIComponent(context.generation)}`;
    const handle = (await (await fetch(`${origin}/source/v1/rows?${suffix}&table=parent&limit=1`)).json()).data.rows[0].record_id;
    // Eight slow requests take the server's eight request threads.
    const holders = Array.from({ length: 8 }, () => fetch(`${origin}/source/v1/references?${suffix}&record=${encodeURIComponent(handle)}&direction=incoming&limit=12`)
      .then(async (r) => [r.status, (await r.json()).error ?? null]));
    await expect.poll(async () => {
      const r = await fetch(`${origin}/source/v1/overview?${suffix}&limit=1`);
      return [r.status, (await r.json()).error, r.headers.get("retry-after")];
    }).toEqual([429, "source_server_busy", "1"]);
    await choose(page, "other");
    await expect(tables(page).getByRole("alert")).toContainText("The source service is busy with another read. Nothing on the canvas changed; try again. details · source_server_busy");
    await expect(page.getByRole("heading", { name: "source reads stopped" })).toHaveCount(0);
    await expect(list(page).locator("[data-field-record]")).toHaveText(["parent 1"]);
    expect(await page.evaluate(() => "__sourceFieldGraph" in window)).toBe(true);
    const settled = await Promise.all(holders);
    // Serialized behind one lock, each holder waits at most the 5 s lock wait.
    expect(settled.every(([status, error]) => status === 200 || (status === 429 && error === "source_reader_busy"))).toBe(true);
    const otherRows = () => requests.filter((url) => url.pathname.endsWith("/rows") && url.searchParams.get("table") === "other").length;
    expect(otherRows()).toBe(1);
    await tables(page).getByRole("button", { name: "try again", exact: true }).click();
    await expect(tables(page).getByRole("button", { name: "Inspect row 1", exact: true })).toBeVisible();
    expect(otherRows()).toBe(2);
    await expect(list(page).locator("[data-field-record]")).toHaveText(["parent 1"]);
  }, { vm_steps: 1e12 }));
});

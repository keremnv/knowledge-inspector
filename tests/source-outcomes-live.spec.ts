/** What a placement run did is said where it was asked for, and stays.
 *
 * Disposable SQLite through the actual SourceHTTPServer. Reader options
 * reproduce the review's budget cases on a small file (PR #60, I1 and I2);
 * route interception only delays or fails one page of records. */
import { test, expect, type Page, type Route } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveSource } from "./source-serve";
import { chooseSourceTable as choose } from "./source-navigation";

const tables = (p: Page) => p.locator("#source-tables .source-table-slot > .motion-swap > .motion-swap__is");
const reader = (p: Page) => p.locator("#source-reader > .motion-swap > .motion-swap__is");
const group = (p: Page, name: string) => reader(p).locator(".source-expand li").filter({ hasText: name });

const SQL = `
CREATE TABLE parent(id INTEGER PRIMARY KEY, name TEXT);
INSERT INTO parent VALUES (1, 'first'), (2, 'second');
CREATE TABLE note(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id), body TEXT);
INSERT INTO note(parent_id, body) VALUES (1, 'a'), (1, 'b'), (1, 'c'), (2, 'd');
CREATE TABLE item(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
`;

async function fixture(sql: string, use: (db: string) => Promise<void>, items = 0) {
  const dir = await mkdtemp(join(tmpdir(), "ki-outcomes-")), db = join(dir, "fixture.sqlite");
  try {
    execFileSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(sys.argv[2]); n=int(sys.argv[3]); n and c.executemany('INSERT INTO item(parent_id) VALUES (?)', [(1,)]*n); c.commit(); c.close()", db, sql, String(items)]);
    await use(db);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function openParent(page: Page, origin: string, row = 1) {
  await page.goto(`${origin}/source`);
  await choose(page, "parent");
  await tables(page).getByRole("button", { name: `Inspect row ${row}`, exact: true }).click();
  await expect(reader(page).locator("h2")).toHaveAccessibleName(new RegExp(`id=${row}$`));
}

test("an expansion whose rows cannot be handed out says so in the Reader, with the dock closed", async ({ page }) => {
  // Room for three record handles: the two parents take two, the group's three rows do not fit (review I2: comments · 3).
  await fixture(SQL, async (db) => serveSource(db, async ({ origin, captureFingerprint }) => {
    const before = await captureFingerprint();
    await openParent(page, origin);
    await tables(page).getByRole("button", { name: "close" }).first().click();
    const notes = group(page, "note · parent_id");
    await notes.getByRole("button", { name: /note · parent_id, 3 rows, place on the canvas/ }).click();
    const outcome = notes.locator("[data-outcome]");
    await expect(outcome).toHaveAttribute("data-outcome", "nothing");
    await expect(outcome).toHaveAttribute("role", "status");
    await expect(outcome).toContainText("nothing placed · 3 rows without a record identity · not placed");
    await expect(outcome).toContainText("handed out as many records as it can hold");
    await expect(outcome).toContainText("identity_registry_budget_exceeded");
    await expect(outcome).toBeInViewport();
    // Still there once the run is long over.
    await page.waitForTimeout(1500);
    await expect(outcome).toBeVisible();
    expect(await captureFingerprint()).toEqual(before);
  }, { key_rows: 3 }));
});

test("once the session can hand out no more records, a group says so before the click and its rows stay readable", async ({ page }) => {
  // Room for two record handles: the two parents fill it.
  await fixture(SQL, async (db) => serveSource(db, async ({ origin, captureFingerprint }) => {
    const before = await captureFingerprint();
    await openParent(page, origin);
    const notes = group(page, "note · parent_id");
    await expect(notes.locator("[data-outcome]")).toHaveCount(0);
    await expect(notes.getByRole("button", { name: /cannot be placed: this session's record limit is reached/ })).toHaveAttribute("aria-disabled", "true");
    await expect(notes.locator("[data-expand-limit]")).toContainText("note rows cannot be placed");
    await expect(notes.locator("[data-expand-limit]")).toContainText("they can be read under \"referenced by\"");
    // Browsing the rows stays available.
    await reader(page).locator(".source-incoming").getByRole("button", { name: /note · parent_id, 3 rows, open in tables/ }).click();
    await expect(tables(page).locator("[data-incoming-subject]")).toContainText("3 rows referencing");
    await expect(tables(page).getByRole("button", { name: "add all" })).toBeDisabled();
    await expect(tables(page).locator("[data-placement-limit]")).toContainText("rows of note cannot be placed");
    expect(await captureFingerprint()).toEqual(before);
  }, { key_rows: 2 }));
});

test("a failure after the first page reports what was placed and why it stopped (partial success)", async ({ page }) => {
  await fixture(SQL, async (db) => serveSource(db, async ({ origin }) => {
    await page.route("**/source/v1/records?*", (route: Route) => new URL(route.request().url()).searchParams.get("offset") === "100"
      ? route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "source_query_budget_exceeded" }) })
      : route.continue());
    await openParent(page, origin);
    const items = group(page, "item · parent_id");
    await items.getByRole("button", { name: /item · parent_id, 150 rows, place on the canvas/ }).click();
    const outcome = items.locator("[data-outcome]");
    await expect(outcome).toHaveAttribute("data-outcome", "failed");
    await expect(outcome).toHaveAttribute("role", "alert");
    await expect(outcome).toContainText("could not finish · placed 100");
    await expect(outcome).toContainText("Reading the next rows did not finish within the query limit.");
    await expect(outcome).toContainText("source_query_budget_exceeded");
    // Nothing is shown as success, and retrying replaces the result.
    await page.unroute("**/source/v1/records?*");
    await items.getByRole("button", { name: /item · parent_id, take off the canvas/ }).click();
    await expect(outcome).toHaveCount(0);
    await items.getByRole("button", { name: /item · parent_id, 150 rows, place on the canvas/ }).click();
    await expect(items.locator("[data-outcome]")).toHaveAttribute("data-outcome", "complete");
    await expect(items.locator("[data-outcome]")).toHaveText("placed 150");
  }), 150);
});

test("stopping a run says it stopped and how much it placed", async ({ page }) => {
  await fixture(SQL, async (db) => serveSource(db, async ({ origin }) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/source/v1/records?*", async (route: Route) => {
      if (new URL(route.request().url()).searchParams.get("offset") === "100") await held;
      await route.continue().catch(() => {});
    });
    await openParent(page, origin);
    const items = group(page, "item · parent_id");
    await items.getByRole("button", { name: /item · parent_id, 250 rows, place on the canvas/ }).click();
    // The first page is on the canvas and the run is waiting for the second.
    await expect(items.getByRole("button", { name: /item · parent_id/ })).toHaveAttribute("aria-busy", "true");
    await expect(tables(page).locator(".source-bulk__actions button[aria-busy]").first()).toHaveText("adding… 100");
    await tables(page).getByRole("button", { name: "stop" }).click();
    release();
    const outcome = items.locator("[data-outcome]");
    await expect(outcome).toHaveAttribute("data-outcome", "stopped");
    await expect(outcome).toHaveText("stopped · placed 100");
  }), 250);
});

test("an expansion of records already on the canvas says so", async ({ page }) => {
  await fixture(SQL, async (db) => serveSource(db, async ({ origin }) => {
    await openParent(page, origin);
    await choose(page, "note");
    for (const row of [1, 2]) await tables(page).getByRole("button", { name: `Inspect row ${row}`, exact: true }).click();
    await choose(page, "parent");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    const notes = group(page, "note · parent_id");
    await notes.getByRole("button", { name: /note · parent_id, 3 rows, place on the canvas/ }).click();
    await expect(notes.locator("[data-outcome]")).toHaveText("placed 1 · 2 already on the canvas");
  }));
});

test("a file with no primary or foreign keys says what that means on its first screen", async ({ page }) => {
  await fixture("CREATE TABLE player(id TEXT, name TEXT); CREATE TABLE season(player TEXT, year INTEGER); CREATE TABLE item(parent_id INTEGER);", async (db) =>
    serveSource(db, async ({ origin }) => {
      await page.goto(`${origin}/source`);
      const note = page.locator(".source-declared-note");
      await expect(note).toBeVisible();
      await expect(note).toContainText("declares no primary keys and no foreign keys");
      await expect(note).toContainText("cannot be placed on the canvas or followed through declared references");
      await expect(note).toContainText("not whether the data relates");
      await expect(tables(page).locator("[data-declared-note]")).toContainText("declares no primary keys");
    }));
});

test("a file with keys and references shows no declaration note", async ({ page }) => {
  await fixture(SQL, async (db) => serveSource(db, async ({ origin }) => {
    await page.goto(`${origin}/source`);
    await expect(page.locator(".source-schema")).toBeVisible();
    await expect(page.locator("[data-declared-note]")).toHaveCount(0);
  }));
});

test("an invalid declaration is explained in plain words where it is listed", async ({ page }) => {
  await fixture(`CREATE TABLE team(id INTEGER PRIMARY KEY, code INTEGER); INSERT INTO team VALUES (1, 7), (2, 7);
    CREATE TABLE stat(id INTEGER PRIMARY KEY, team_id INTEGER REFERENCES team(id), team_code INTEGER REFERENCES team(code));
    INSERT INTO stat VALUES (1, 1, 7);`, async (db) => serveSource(db, async ({ origin }) => {
    await page.goto(`${origin}/source`);
    await choose(page, "team");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    const limit = reader(page).locator(".source-incoming [data-declaration-limit]");
    await expect(limit).toContainText("This foreign key references columns that do not uniquely identify a parent record.");
    await expect(limit).toContainText("parent_key_not_eligible_unique_constraint");
    await choose(page, "stat");
    await tables(page).getByRole("button", { name: "table info" }).click();
    await expect(reader(page).locator("[data-declaration-limit]").first()).toContainText("invalid declaration");
  }));
});

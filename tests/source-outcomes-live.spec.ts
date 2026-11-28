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
// Keeping a set is asked for in Tables, on the set on show (decision 4); its outcome stays there.
const openSet = async (p: Page, name: RegExp) => { await reader(p).locator(".source-incoming").getByRole("button", { name }).click(); await expect(tables(p).locator("[data-incoming-subject]")).toBeVisible(); };
const keep = (p: Page) => tables(p).locator("[data-keep-all]");
const outcomeOf = (p: Page) => tables(p).locator("[data-outcome]");

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
  await tables(page).locator(`[data-row-position="${row}"]`).click();
  await expect(reader(page).locator("h2")).toHaveAccessibleName(new RegExp(`id=${row}$`));
}

// The review's I2 case (comments · 3, room for three handles) used to be asked
// with the Tables dock closed, from the Reader's "expand through". Keeping a set
// is now asked for on the set in Tables, which reads its rows first: the limit
// is then known, and said, before the click. One case covers both.
for (const keyRows of [2, 3]) test(`once the session can hand out no more records (${keyRows} handles), the set says so before any click and the rows stay readable`, async ({ page }) => {
  await fixture(SQL, async (db) => serveSource(db, async ({ origin, captureFingerprint }) => {
    const before = await captureFingerprint();
    await openParent(page, origin);
    await openSet(page, /^note · parent_id, 3 rows$/);
    await expect(tables(page).locator("[data-incoming-subject]")).toContainText("3 rows referencing");
    await expect(tables(page).locator("tbody tr")).toHaveCount(3);
    // Nothing can be kept: no button, and the cause said once, where the action would be.
    await expect(keep(page)).toHaveCount(0);
    await expect(tables(page).locator("[data-placement-limit]")).toHaveText("this session's record limit is reached");
    await expect(outcomeOf(page)).toHaveCount(0);
    expect(await captureFingerprint()).toEqual(before);
  }, { key_rows: keyRows }));
});

test("a failure after the first page reports how far it got and why it stopped (partial success)", async ({ page }) => {
  await fixture(SQL, async (db) => serveSource(db, async ({ origin }) => {
    await page.route("**/source/v1/records?*", (route: Route) => new URL(route.request().url()).searchParams.get("offset") === "100"
      ? route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "source_query_budget_exceeded" }) })
      : route.continue());
    await openParent(page, origin);
    await openSet(page, /^item · parent_id, 150 rows$/);
    await expect(keep(page)).toHaveText("keep all 150");
    await keep(page).click();
    const outcome = outcomeOf(page);
    await expect(outcome).toHaveAttribute("data-outcome", "failed");
    await expect(outcome).toHaveAttribute("role", "alert");
    await expect(outcome).toContainText("could not finish · 100 of 150 · kept 100");
    await expect(outcome).toContainText("Reading the next rows did not finish within the query limit.");
    await expect(outcome).toContainText("source_query_budget_exceeded");
    // Nothing is shown as success; remove set takes off what it kept, and running again replaces the result.
    await page.unroute("**/source/v1/records?*");
    await tables(page).getByRole("button", { name: "remove set", exact: true }).click();
    await expect(outcome).toHaveCount(0);
    await keep(page).click();
    await expect(outcomeOf(page)).toHaveAttribute("data-outcome", "complete");
    await expect(outcomeOf(page)).toHaveText("kept 150");
  }), 150);
});

test("stopping a run says it stopped and how far it got", async ({ page }) => {
  await fixture(SQL, async (db) => serveSource(db, async ({ origin }) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/source/v1/records?*", async (route: Route) => {
      if (new URL(route.request().url()).searchParams.get("offset") === "100") await held;
      await route.continue().catch(() => {});
    });
    await openParent(page, origin);
    await openSet(page, /^item · parent_id, 250 rows$/);
    await expect(keep(page)).toHaveText("keep all 250");
    await keep(page).click();
    // The first page is on the canvas and the run is waiting for the second.
    await expect(tables(page).locator("[data-keeping]")).toHaveText("keeping… 100 of 250");
    await tables(page).getByRole("button", { name: "stop" }).click();
    release();
    await expect(outcomeOf(page)).toHaveAttribute("data-outcome", "stopped");
    await expect(outcomeOf(page)).toHaveText("stopped · 100 of 250 · kept 100");
  }), 250);
});

test("keeping a set whose records are already on the canvas says so", async ({ page }) => {
  await fixture(SQL, async (db) => serveSource(db, async ({ origin }) => {
    await openParent(page, origin);
    await choose(page, "note");
    for (const row of [1, 2]) await tables(page).locator(`[data-row-position="${row}"]`).click();
    await choose(page, "parent");
    await tables(page).locator('[data-row-position="1"]').click();
    await openSet(page, /^note · parent_id, 3 rows$/);
    await keep(page).click();
    await expect(outcomeOf(page)).toHaveText("kept 1 · 2 already on the canvas");
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
    await tables(page).locator('[data-row-position="1"]').click();
    const limit = reader(page).locator(".source-incoming [data-declaration-limit]");
    await expect(limit).toContainText("This foreign key references columns that do not uniquely identify a parent record.");
    await expect(limit).toContainText("parent_key_not_eligible_unique_constraint");
    await choose(page, "stat");
    await tables(page).getByRole("button", { name: "table info" }).click();
    await expect(reader(page).locator("[data-declaration-limit]").first()).toContainText("invalid declaration");
  }));
});

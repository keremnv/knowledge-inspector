import { openSourceReferences } from "./canvas-parity";
import { chooseSourceTable as choose } from "./source-navigation";
/** Referenced by: real pinned Chinook and disposable SQLite through the actual
 * SourceHTTPServer. The only route interception injects one failed read. */
import { test, expect, type Page, type Response } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveSource } from "./source-serve";
import { UPSTREAM, prepared } from "./chinook-serve";
const tables = (p: Page) => p.locator("#source-tables .source-table-slot > .motion-swap > .motion-swap__is");
const reader = (p: Page) => p.locator("#source-reader > .motion-swap > .motion-swap__is");
const incoming = (p: Page) => reader(p).locator(".source-incoming");
async function shot(p: Page, name: string) {
  if (!process.env.KI_INCOMING_SHOTS) return;
  await mkdir(process.env.KI_INCOMING_SHOTS, { recursive: true });
  await expect(p.locator(".motion-swap__was")).toHaveCount(0);
  await p.screenshot({ path: join(process.env.KI_INCOMING_SHOTS, name) });
}
const isSearch = (response: Response) => new URL(response.url()).pathname === "/source/v1/search";

for (const motion of ["reduce", "no-preference"] as const) {
  test(`referenced by: Album → its Tracks in the Tables dock, same observations, ${motion}`, async ({ page }) => {
    test.skip(!prepared(), "Prepare pinned Chinook");
    await page.emulateMedia({ reducedMotion: motion });
    await serveSource(UPSTREAM, async ({ origin, requests, captureFingerprint }) => {
      const captureBefore = await captureFingerprint();
      await page.goto(`${origin}/source?placement=explicit`); await choose(page, "Album");
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
      await expect(reader(page).locator("h2")).toHaveAccessibleName(/AlbumId=1$/);
      await expect(incoming(page).locator("h3")).toHaveText("referenced by · 1 declared");
      const group = incoming(page).getByRole("button", { name: "Track · AlbumId, 10 rows, open in tables" });
      await expect(group).toContainText("10 · table");
      await shot(page, `album-reader-${motion}.png`);
      const page1 = page.waitForResponse(isSearch);
      await group.press("Enter");
      const rows = await (await page1).json();
      const sent = new URL((await page1).url()).searchParams;
      // The FK is the filter, not a literal or key lookup over cell text.
      expect([sent.get("mode"), sent.get("table"), sent.has("text"), sent.has("column"), sent.has("key")]).toEqual(["reference", "Track", false, false, false]);
      await expect(tables(page).locator("h2")).toHaveText("Track");
      await expect(tables(page).locator("h2")).toBeFocused();
      await expect(tables(page).locator("[data-incoming-subject]")).toHaveText("10 rows referencing Album 1 through AlbumId");
      await expect(tables(page).getByRole("searchbox")).toHaveCount(0);
      await expect(tables(page).locator(".source-pager [role=status]")).toHaveText("matches 1–10 · no more matches");
      await expect(group).toHaveAttribute("aria-pressed", "true");
      // The Reader keeps the parent while its children are listed.
      await expect(reader(page).locator("h2")).toHaveAccessibleName(/AlbumId=1$/);
      await expect(page.locator(".source-canvas > .source-layer:not(.source-schema) canvas")).toHaveCount(0);
      await shot(page, `album-tracks-${motion}.png`);
      // A listed child is an ordinary row: its own outgoing observation is the
      // same observation, resolved to this Album.
      const first = rows.data.rows[0];
      expect(first.observation_id).toMatch(/^so1:[0-9a-f]{64}$/);
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
      await expect(reader(page).locator("h2")).toHaveAccessibleName(/TrackId=1$/);
      const album = reader(page).locator(".source-outgoing article").filter({ hasText: "→ Album" });
      await expect(album.locator("[data-reference-status]")).toHaveAttribute("data-reference-status", "resolved");
      await openSourceReferences(page); await album.getByRole("button", { name: /inspect FK/ }).click();
      await expect(reader(page)).toContainText(first.observation_id);
      // Normal table navigation: the previous table and its selected record return.
      await tables(page).getByRole("button", { name: "back to previous table" }).click();
      await expect(tables(page).locator("h2")).toHaveText("Album");
      await expect(tables(page).getByRole("searchbox")).toHaveValue("");
      await expect(tables(page).getByRole("button", { name: "Inspect row 1", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(reader(page).locator("h2")).toHaveAccessibleName(/AlbumId=1$/);
      await expect(group).toHaveAttribute("aria-pressed", "false");
      // Whole table drops the relationship, and Find returns for ordinary filtering.
      await group.click();
      await expect(tables(page).locator("[data-incoming-subject]")).toBeVisible();
      await tables(page).getByRole("button", { name: "whole table" }).click();
      await expect(tables(page).locator("[data-incoming-subject]")).toHaveCount(0);
      await expect(tables(page).getByRole("searchbox")).toHaveValue("");
      await expect(tables(page).locator(".source-pager [role=status]")).toHaveText("rows 1–50 · more available");
      expect(await captureFingerprint()).toEqual(captureBefore);
      for (const request of requests.filter((r) => !r.pathname.endsWith("/session"))) {
        expect(request.searchParams.get("session")).toBeTruthy(); expect(request.searchParams.get("generation")).toBeTruthy();
      }
      expect(requests.filter((r) => r.searchParams.get("direction") === "incoming").every((r) => r.searchParams.get("limit") === "10")).toBe(true);
    });
  });
}

test("referenced by: exact zero, self-reference and parallel declarations stay distinct", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  await serveSource(UPSTREAM, async ({ origin }) => {
    await page.goto(`${origin}/source`); await choose(page, "Employee");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await expect(incoming(page).getByRole("button", { name: "Employee · ReportsTo, 2 rows, open in tables" })).toBeVisible();
    // Zero is an observed absence in this capture, a note rather than a control.
    await expect(incoming(page).locator("[data-incoming-absent]")).toHaveText("No rows in this capture reference this record through Customer · SupportRepId.");
    await expect(incoming(page).getByRole("button", { name: /Customer/ })).toHaveCount(0);
    await shot(page, "employee-reader.png");
    await incoming(page).getByRole("button", { name: /Employee · ReportsTo/ }).click();
    await expect(tables(page).locator("[data-incoming-subject]")).toHaveText("2 rows referencing Employee 1 through ReportsTo");
    await expect(tables(page).locator("tbody tr td:nth-child(2)")).toHaveText(["2", "6"]);
    await shot(page, "employee-reports.png");
    // Opening a direct report changes the Reader, not the narrowed table.
    await tables(page).getByRole("button", { name: "Inspect row 2", exact: true }).click();
    await expect(reader(page).locator("h2")).toHaveAccessibleName(/EmployeeId=6$/);
    await expect(tables(page).locator("[data-incoming-subject]")).toBeVisible();
    // Track is referenced by two declarations from two tables; both are listed.
    await choose(page, "Track");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await expect(incoming(page).locator(".gm__list button")).toHaveText(["InvoiceLine · TrackId1 · table", "PlaylistTrack · TrackId3 · table"]);
  });
});

const SQL = `CREATE TABLE Parent(id INTEGER PRIMARY KEY, label TEXT); INSERT INTO Parent VALUES (1,'one'),(2,'two');
 CREATE TABLE Big(id INTEGER PRIMARY KEY, p INTEGER REFERENCES Parent(id), pad TEXT);
 CREATE TABLE Keyless(p INTEGER REFERENCES Parent(id), note TEXT); INSERT INTO Keyless VALUES (1,'a'),(1,'b'),(2,'c');
 CREATE TABLE Loose(id INTEGER PRIMARY KEY, g TEXT); INSERT INTO Loose VALUES (1,'x'),(2,'x');
 CREATE TABLE ToLoose(id INTEGER PRIMARY KEY, g TEXT REFERENCES Loose(g)); INSERT INTO ToLoose VALUES (1,'x');
 CREATE TABLE Spare(id INTEGER PRIMARY KEY, p INTEGER REFERENCES Parent(id)); INSERT INTO Spare VALUES (1,2);`;
async function fixture(use: (db: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "ki-incoming-")), db = join(dir, "fixture.sqlite");
  try {
    execFileSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(sys.argv[2]); c.executemany('INSERT INTO Big(p,pad) VALUES (?,?)', [(1,'x'*20)]*30000); c.commit(); c.close()", db, SQL]);
    await use(db);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("referenced by: an unavailable count is not zero, and unaddressable rows stay table-only", async ({ page }) => {
  // A small per-operation step budget: Big's count is refused, the others are exact.
  await fixture((db) => serveSource(db, async ({ origin }) => {
    await page.goto(`${origin}/source?placement=explicit`); await choose(page, "Parent");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    const big = incoming(page).getByRole("button", { name: "Big · p, count unavailable · query limit reached, open in tables" });
    await expect(big).toContainText("count unavailable · query limit reached · table");
    await expect(incoming(page).getByRole("button", { name: "Keyless · p, 2 rows, open in tables" })).toBeVisible();
    await expect(incoming(page).locator("[data-incoming-absent]")).toHaveText("No rows in this capture reference this record through Spare · p.");
    await shot(page, "unavailable-reader.png");
    // The same group can still be browsed: unavailable never meant empty.
    await big.click();
    await expect(tables(page).locator("[data-incoming-subject]")).toHaveText("rows referencing Parent 1 through p · count unavailable · query limit reached");
    await expect(tables(page).locator(".source-pager [role=status]")).toHaveText("matches 1–50 · more available");
    await expect(tables(page).locator(".source-browse__status")).toContainText("key verification incomplete");
    // Keyless children are listed, counted and readable, never addressable.
    await tables(page).getByRole("button", { name: "back to previous table" }).click();
    await incoming(page).getByRole("button", { name: /^Keyless · p/ }).click();
    await expect(tables(page).locator(".source-pager [role=status]")).toHaveText("matches 1–2 · no more matches");
    await expect(tables(page).locator(".source-browse__status")).toContainText("no primary key");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await expect(reader(page)).toContainText("No registered source handle");
    await expect(reader(page).getByRole("button", { name: "show on canvas" })).toHaveCount(0);
    await shot(page, "keyless-row.png");
    // An invalid declaration names the parent table but has no count and no rows.
    await choose(page, "Loose");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    // Plain words first; the exact validation code stays beside them.
    await expect(incoming(page).locator(".source-limitation")).toHaveText("ToLoose · g · This foreign key references columns that do not uniquely identify a parent record. No count, and its rows are not followed. · declaration invalid · parent_key_not_eligible_unique_constraint");
    await expect(incoming(page).getByRole("button")).toHaveCount(0);
  }, { vm_steps: 100_000 }));
});

test("referenced by: a failed incoming read leaves the record and its outgoing references", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  await serveSource(UPSTREAM, async ({ origin }) => {
    await page.route((url) => url.pathname === "/source/v1/references" && url.searchParams.get("direction") === "incoming",
      (route) => route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "source_query_budget_exceeded" }) }));
    await page.goto(`${origin}/source`); await choose(page, "Album");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await expect(incoming(page).getByRole("alert")).toContainText("source_query_budget_exceeded");
    await expect(reader(page).locator(".source-outgoing article")).toHaveCount(1);
    await expect(reader(page).locator(".source-cells")).toContainText("For Those About To Rock");
    await expect(page.getByRole("heading", { name: "source reads stopped" })).toHaveCount(0);
  });
});

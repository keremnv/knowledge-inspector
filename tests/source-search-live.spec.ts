import { chooseSourceTable as choose, preciseSourceLookup } from "./source-navigation";
/** Real SourceHTTPServer/SQLite acceptance; no mocked responses. */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveSource } from "./source-serve";
import { UPSTREAM, prepared } from "./chinook-serve";

const tables = (page: Page) => page.locator("#source-tables .source-table-slot > .motion-swap > .motion-swap__is");
const reader = (page: Page) => page.locator("#source-reader > .motion-swap > .motion-swap__is");
async function find(page: Page, table: string, text: string) {
  await tables(page).getByRole("searchbox", { name: `filter ${table}`, exact: true }).fill(text);
  await tables(page).getByRole("button", { name: "filter", exact: true }).click();
}
async function shot(page: Page, name: string) {
  if (!process.env.KI_SOURCE_SHOTS) return;
  await mkdir(process.env.KI_SOURCE_SHOTS, { recursive: true });
  await expect(page.locator(".motion-swap__was")).toHaveCount(0);
  await expect.poll(() => page.locator(".motion-swap__is").evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).opacity === "1"))).toBe(true);
  await page.screenshot({ path: join(process.env.KI_SOURCE_SHOTS, name) });
}

for (const motion of ["reduce", "no-preference"] as const) {
  test(`Find Chinook name, exact keys, Reader and browse restoration (${motion})`, async ({ page }) => {
    test.skip(!prepared(), "Prepare pinned Chinook first");
    await page.emulateMedia({ reducedMotion: motion });
    await serveSource(UPSTREAM, async ({ origin, requests }) => {
      await page.goto(`${origin}/source?placement=explicit`);
      await choose(page, "Track");
      await tables(page).getByRole("button", { name: "next rows" }).click();
      await expect(tables(page).getByRole("button", { name: "Inspect row 51", exact: true })).toBeVisible();
      const input = tables(page).getByRole("searchbox", { name: "filter Track", exact: true });
      await input.fill("Evil Walks");
      await expect(tables(page)).toContainText("press enter to filter");
      expect(requests.filter((r) => r.pathname.endsWith("/search"))).toHaveLength(0);
      await input.press("Enter");
      await expect(tables(page).getByRole("row").nth(1)).toContainText('"Evil Walks"');
      await expect(tables(page).getByRole("row").nth(1)).toContainText("Name");
      expect(requests.find((r) => r.pathname.endsWith("/search"))?.searchParams.has("column")).toBe(false);
      await expect(input).toBeFocused();
      await shot(page, `find-track-${motion}.png`);
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).press("Enter");
      await expect(reader(page).locator("h2")).toHaveAccessibleName(/^Track\s*, TrackId=10$/);
      await expect(reader(page).locator("h2")).toBeFocused();
      await expect(reader(page)).toContainText('"Evil Walks"');
      await shot(page, `reader-track-${motion}.png`);
      await page.keyboard.press("Escape");
      await expect(tables(page).getByRole("button", { name: "Inspect row 1", exact: true })).toBeFocused();
      await preciseSourceLookup(page);
      await tables(page).getByRole("combobox", { name: "search columns" }).selectOption('"Name"');
      await expect(tables(page)).toContainText("press enter to filter");
      await tables(page).getByRole("button", { name: "filter", exact: true }).click();
      await expect(tables(page).getByRole("row")).toHaveCount(2);
      await tables(page).getByRole("form", { name: /^filter / }).getByRole("button", { name: "clear" }).click();
      await expect(tables(page).getByRole("button", { name: "Inspect row 51", exact: true })).toBeVisible();
      await preciseSourceLookup(page);
      await tables(page).getByRole("combobox", { name: "lookup mode" }).selectOption("primary_key");
      await tables(page).getByRole("textbox", { name: "exact TrackId", exact: true }).fill("10");
      await expect(tables(page).locator(".source-filter-options > small")).toHaveText("exact key");
      await expect(input).toHaveValue("");
      await tables(page).getByRole("button", { name: "filter", exact: true }).click();
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
      await expect(reader(page).locator("h2")).toHaveAccessibleName(/^Track\s*, TrackId=10$/);
      await choose(page, "PlaylistTrack");
      await preciseSourceLookup(page);
      await tables(page).getByRole("combobox", { name: "lookup mode" }).selectOption("primary_key");
      await tables(page).getByRole("textbox", { name: "exact PlaylistId", exact: true }).fill("1");
      await tables(page).getByRole("textbox", { name: "exact TrackId", exact: true }).fill("10");
      await tables(page).getByRole("button", { name: "filter", exact: true }).click();
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
      await expect(reader(page).locator("h2")).toHaveAccessibleName(/^PlaylistTrack\s*, PlaylistId=1; TrackId=10$/);
      await shot(page, `composite-${motion}.png`);
      await expect(page.locator(".source-canvas > .source-layer:not(.source-schema) canvas")).toHaveCount(0);
    });
  });
}

const fixture = `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.executescript("""CREATE TABLE duplicates(id INTEGER PRIMARY KEY, v); INSERT INTO duplicates VALUES(9007199254740992,'same'),(9007199254740993,'same');
CREATE TABLE keyless(v); INSERT INTO keyless VALUES('same'),('same');
CREATE TABLE mixed(id INTEGER PRIMARY KEY, v); INSERT INTO mixed VALUES(1,'10'),(2,10),(3,10.0),(4,NULL),(5,x'3130');
CREATE VIEW computed AS SELECT upper(v) AS label FROM duplicates;
CREATE TABLE strange("__proto__" TEXT PRIMARY KEY, v); INSERT INTO strange VALUES('literal','same');
CREATE TABLE large(v);""")
c.executemany('INSERT INTO large VALUES(?)',[('haystack',)]*10000)
c.commit();c.close()`;

test("real search retains duplicate and mixed rows, local view identities and truthful budget failure", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "ki-find-")), db = join(dir, "source.sqlite");
  execFileSync("python3", ["-c", fixture, db]);
  try {
    await serveSource(db, async ({ origin }) => {
      await page.goto(`${origin}/source`);
      await choose(page, "duplicates"); await find(page, "duplicates", "same");
      await tables(page).getByRole("button", { name: "Inspect row 2", exact: true }).click();
      await expect(reader(page)).toContainText("9007199254740993");
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
      await expect(reader(page)).toContainText("9007199254740992");
      await tables(page).getByRole("combobox", { name: "rows per page" }).selectOption("1");
      await tables(page).getByRole("button", { name: "next rows" }).press("Enter");
      await expect(tables(page).getByRole("button", { name: "Inspect row 2", exact: true })).toBeVisible();
      await expect(tables(page).getByRole("button", { name: "next rows" })).toBeFocused();
      await expect(reader(page).locator(".source-cells")).toHaveCount(0);
      await choose(page, "keyless"); await find(page, "keyless", "same");
      await expect(tables(page).getByRole("row")).toHaveCount(3);
      await tables(page).getByRole("button", { name: "Inspect row 2", exact: true }).click();
      await expect(reader(page)).toContainText("No registered source handle");
      await choose(page, "computed", "view"); await find(page, "computed", "SAME");
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
      await expect(reader(page)).toContainText("computed view output");
      await choose(page, "strange");
      await preciseSourceLookup(page);
      await tables(page).getByRole("combobox", { name: "lookup mode" }).selectOption("primary_key");
      await tables(page).getByRole("textbox", { name: "exact __proto__", exact: true }).fill("literal");
      await tables(page).getByRole("combobox", { name: "__proto__ storage class" }).selectOption("text");
      await tables(page).getByRole("button", { name: "filter", exact: true }).click();
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
      await expect(reader(page).locator("h2")).toHaveAccessibleName(/^strange\s*, __proto__="literal"$/);
      await choose(page, "mixed"); await find(page, "mixed", "10");
      await expect(tables(page).getByRole("row")).toHaveCount(4);
      await find(page, "mixed", "absent");
      await expect(tables(page)).toContainText("no matches");
    });
    await serveSource(db, async ({ origin }) => {
      await page.goto(`${origin}/source`);
      await choose(page, "large"); await find(page, "large", "absent");
      await expect(tables(page).getByRole("alert")).toContainText("source_query_budget_exceeded");
      await expect(tables(page)).toContainText("filter incomplete");
      await expect(tables(page)).not.toContainText("no matches");
      await shot(page, "budget-failure.png");
    }, { vm_steps: 10000 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

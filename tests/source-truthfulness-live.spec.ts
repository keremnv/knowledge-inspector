/** The canvas says what its lines are, and a line is not read as joining a
 * record it only passes beneath: PR #60's real investigations, through the
 * actual SourceHTTPServer.
 *
 * I1 (PKDD financial) and I2 (Stack Exchange) use BIRD mini-dev's copies of
 * those files, located by KI_BIRD_DEV_DATABASES (the `dev_databases`
 * directory); Chinook is the repository's pinned file. Each spec skips, saying
 * why, when its file is not prepared. */
import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { serveSource } from "./source-serve";
import { UPSTREAM, prepared } from "./chinook-serve";
import { canvasRest, closeCanvasDocks, sourceList as list, sourceReader as reader, sourceTable as tables } from "./canvas-parity";
import { chooseSourceTable as choose } from "./source-navigation";

const BIRD = process.env.KI_BIRD_DEV_DATABASES ?? join(homedir(), ".cache/ki-demo-databases/bird-mini-dev/minidev/MINIDEV/dev_databases");
const STACK_EXCHANGE = join(BIRD, "codebase_community/codebase_community.sqlite");
const FINANCIAL = join(BIRD, "financial/financial.sqlite");

const records = (p: Page) => list(p).locator("[data-field-record]");
const connections = (p: Page) => list(p).locator("[data-field-reference]");
const passes = (p: Page) => p.locator(".source-pass [data-pass-through]");

async function follow(p: Page, column: string, table: string) {
  const before = await connections(p).count();
  await reader(p).getByRole("button", { name: `go to ${table} referenced by ${column}` }).click();
  await expect.poll(() => connections(p).count()).toBeGreaterThan(before);
}
async function openMark(p: Page, name: string) {
  await list(p).getByRole("button", { name, exact: true }).press("Enter");
  await expect(reader(p).locator("h2")).toBeVisible();
}
async function expand(p: Page, pattern: RegExp) {
  await reader(p).locator(".source-expand").getByRole("button", { name: pattern }).click();
  await expect(reader(p).locator(".source-expand [data-outcome]").first()).toBeVisible({ timeout: 30000 });
}
async function exactKey(p: Page, table: string, column: string, value: string) {
  await choose(p, table);
  const details = tables(p).locator(".source-filter-options details");
  if (await details.getAttribute("open") === null) await details.locator("summary").click();
  await tables(p).getByRole("combobox", { name: "lookup mode" }).selectOption("primary_key");
  await tables(p).getByRole("textbox", { name: `exact ${column}`, exact: true }).fill(value);
  await tables(p).getByRole("button", { name: "filter", exact: true }).click();
  await tables(p).getByRole("button", { name: "Inspect row 1", exact: true }).click();
  await expect(reader(p).locator("h2")).toHaveAccessibleName(new RegExp(`${column}=${value}$`));
}
/** Every disc and every drawn line, by label, in canvas units. */
async function drawing(p: Page) {
  return p.evaluate(() => {
    const g = (window as any).__sourceFieldGraph;
    const nodes = new Map<string, any>(g.getNodeData().map((n: any) => [n.id, { label: String(n.style.labelText), at: g.getElementPosition(n.id) }]));
    const lines = g.getEdgeData().filter((e: any) => String(e.id).startsWith("source-carrier:"))
      .map((e: any) => ({ reference: String(e.id).slice("source-carrier:".length), ends: [nodes.get(e.source).label, nodes.get(e.target).label] }));
    return { nodes: [...nodes.entries()].map(([id, n]) => ({ id, ...n })), lines };
  });
}

/** PR #60's I2 screenshot positions (CSS px at 1440×900), disc centres. */
const PR60 = [
  ["Hbar", 373, 194], ["emakalic", 598, 162], ["Estimators for linear regres", 512, 297], ["posts 874", 659, 315],
  ["Gary", 967, 283], ["postLinks 2822060", 335, 450], ["When should I use lasso vs r", 525, 450], ["posts 876", 715, 448],
  ["Why does regularizatio", 811, 522], ["postLinks 2689392", 391, 583], ["posts 8480", 659, 583],
  ["postLinks 2545664", 525, 639], ["A statistical model for a s", 451, 736], ["Larry Wang", 642, 736],
] as const;

test("I2: a line passing beneath an unrelated answer is drawn through it, and its selected ends are named", async ({ page }) => {
  test.skip(!existsSync(STACK_EXCHANGE), `Stack Exchange (BIRD codebase_community) not found at ${STACK_EXCHANGE}`);
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await serveSource(STACK_EXCHANGE, async ({ origin }) => {
    // As in INVESTIGATIONS.md I2: the question, its answers and links, their owners and linked posts.
    await page.goto(`${origin}/source`);
    await choose(page, "users");
    await tables(page).getByRole("combobox", { name: /name users records by/ }).selectOption("DisplayName");
    await choose(page, "posts");
    await tables(page).getByRole("combobox", { name: /name posts records by/ }).selectOption("Title");
    const details = tables(page).locator(".source-filter-options details");
    if (await details.getAttribute("open") === null) await details.locator("summary").click();
    await tables(page).getByRole("combobox", { name: "search columns" }).selectOption('"Title"');
    await tables(page).getByRole("searchbox", { name: "filter posts", exact: true }).fill("lasso vs ridge");
    await tables(page).getByRole("searchbox", { name: "filter posts", exact: true }).press("Enter");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await expect(records(page)).toHaveCount(1);
    await expand(page, /^posts · ParentId, 3 rows, place on the canvas$/);
    await expect(records(page)).toHaveCount(4);
    await expand(page, /^postLinks · RelatedPostId, 3 rows, place on the canvas$/);
    await expect(records(page)).toHaveCount(7);
    await follow(page, "OwnerUserId", "users");
    for (const answer of ["posts 874", "posts 876", "posts 8480"]) { await openMark(page, answer); await follow(page, "OwnerUserId", "users"); }
    for (const link of (await records(page).allTextContents()).filter((name) => name.startsWith("postLinks "))) {
      await openMark(page, link); await follow(page, "PostId", "posts");
    }
    await expect(records(page)).toHaveCount(14);
    await expect(connections(page)).toHaveCount(13);
    // The arrangement PR #60 photographed, as a person dragging each disc there
    // would leave it in this tab's remembered canvas (O8.8); the reload reads
    // and verifies every record and connection again from the file.
    await closeCanvasDocks(page);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 400)));
    const arranged = await page.evaluate((targets) => {
      const g = (window as any).__sourceFieldGraph;
      const key = Object.keys(sessionStorage).find((k) => k.startsWith("ki.source.field:"))!;
      const stored = JSON.parse(sessionStorage.getItem(key)!);
      const at = new Map<string, unknown>(stored.positions);
      for (const node of g.getNodeData()) {
        const target = targets.find(([prefix]) => String(node.style.labelText).startsWith(prefix))!;
        const [x, y] = g.getCanvasByClient([target[1], target[2]]);
        at.set(node.id, { x, y });
      }
      stored.positions = [...at];
      return { key, value: JSON.stringify(stored) };
    }, PR60 as unknown as [string, number, number][]);
    await page.addInitScript(({ key, value }) => {
      if (!sessionStorage.getItem("__i2_arranged")) { sessionStorage.setItem(key, value); sessionStorage.setItem("__i2_arranged", "1"); }
    }, arranged);
    await page.reload();
    await expect(page.getByText("restored 14 records from the last visit")).toBeVisible({ timeout: 60_000 });
    await closeCanvasDocks(page);
    await canvasRest(page, "source", 14);

    const drawn = await drawing(page);
    const id = (label: string) => drawn.nodes.find((n) => n.label.startsWith(label))!.id;
    const misread = drawn.lines.find((line) => line.ends.includes("emakalic") && line.ends.includes("posts 876"))!;
    expect(misread).toBeTruthy();
    // The emakalic → 876 line is drawn across 874, which it only passes beneath.
    await expect(passes(page).and(page.locator(`[data-pass-through="${misread.reference}"][data-pass-under="${id("posts 874")}"]`)).first()).toBeAttached();
    // No mark ever lies on a disc its own line joins; every crossing found is a real crossing.
    const marks = await passes(page).evaluateAll((lines) => lines.map((l) => [l.getAttribute("data-pass-through"), l.getAttribute("data-pass-under")]));
    for (const [reference, under] of marks) {
      const line = drawn.lines.find((item) => item.reference === reference)!;
      expect(line.ends).not.toContain(drawn.nodes.find((n) => n.id === under)!.label);
    }
    // Lines that end at 874 (its owner, the question) carry no mark there.
    for (const line of drawn.lines.filter((item) => item.ends.includes("posts 874"))) {
      await expect(page.locator(`[data-pass-through="${line.reference}"][data-pass-under="${id("posts 874")}"]`)).toHaveCount(0);
    }
    // After the restoring reload the canvas still says what its lines are.
    const filter = page.getByRole("region", { name: "Source canvas" }).getByRole("button", { name: "filter", exact: true });
    await filter.click();
    await expect(page.locator(".source-show [data-canvas-connections]")).toContainText("may not be drawn");
    await filter.click();
    // Selected from the keyboard list, by its ends: the Reader names both.
    const name = "posts 876 · OwnerUserId → emakalic";
    await list(page).getByRole("button", { name, exact: true }).press("Enter");
    await expect(reader(page).locator("[data-reference-child]")).toHaveText("from posts · Id=876");
    await expect(reader(page).locator("[data-reference-parent]")).toHaveText(/^→ users · Id=\d+$/);
    await expect(reader(page).locator("[data-reference-parent] button")).toHaveAttribute("title", "emakalic");
    await expect(reader(page).locator("[data-canvas-connections]")).toContainText("Connections on the canvas are references you followed or expanded");
    await expect(page.locator(`.source-pass [data-pass-through="${misread.reference}"][data-selected]`).first()).toBeAttached();
    // Each end is reachable from the keyboard.
    await reader(page).locator("[data-reference-child] button").press("Enter");
    await expect(reader(page).locator("h2")).toHaveAccessibleName(/posts.*Id=876$/);
  });
});

test("I1: records placed separately stay unconnected, and nothing says their references are absent", async ({ page }) => {
  test.skip(!existsSync(FINANCIAL), `PKDD financial (BIRD financial) not found at ${FINANCIAL}`);
  test.setTimeout(180_000);
  await serveSource(FINANCIAL, async ({ origin }) => {
    await page.goto(`${origin}/source`);
    await exactKey(page, "card", "card_id", "186");
    await follow(page, "disp_id", "disp");
    await follow(page, "account_id", "account");
    await expand(page, /^disp · account_id, 2 rows, place on the canvas$/);
    await exactKey(page, "client", "client_id", "1133");
    await exactKey(page, "district", "district_id", "37");
    await expect(records(page)).toHaveText(["card 186", "disp 1133", "account 940", "disp 1134", "client 1133", "district 37"]);
    // Only what was followed or expanded is drawn: the disposition's client and the
    // account's and client's district are recorded, resolve, and are not drawn.
    await expect(connections(page)).toHaveText(["card 186 · disp_id → disp 1133", "disp 1133 · account_id → account 940", "disp 1134 · account_id → account 940"]);
    // The canvas says what its lines are, beside its show keys.
    await page.getByRole("region", { name: "Source canvas" }).getByRole("button", { name: "filter", exact: true }).click();
    const note = page.locator(".source-show [data-canvas-connections]");
    await expect(note).toHaveText("Connections on the canvas are references you followed or expanded. Other recorded references between these records may not be drawn.");
    await expect(page.locator('.source-show [data-layer="source-connections"]')).toHaveAttribute("aria-describedby", await note.getAttribute("id") as string);
    await page.getByRole("region", { name: "Source canvas" }).getByRole("button", { name: "filter", exact: true }).click();
    // And the reference is still there to follow; following it draws it and moves nothing.
    await closeCanvasDocks(page);
    const before = new Map((await drawing(page)).nodes.map((n) => [n.label, n.at.slice(0, 2).map(Math.round).join(",")]));
    await openMark(page, "client 1133");
    await follow(page, "district_id", "district");
    await expect(connections(page).filter({ hasText: "client 1133 · district_id → district 37" })).toHaveCount(1);
    await closeCanvasDocks(page);
    const after = new Map((await drawing(page)).nodes.map((n) => [n.label, n.at.slice(0, 2).map(Math.round).join(",")]));
    expect(after).toEqual(before);
  });
});

test("Chinook: placing, following and hiding are unchanged; a connection is named by its ends; nothing crosses, nothing is marked", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  await serveSource(UPSTREAM, async ({ origin }) => {
    await page.goto(`${origin}/source`);
    await choose(page, "Track");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await follow(page, "AlbumId", "Album");
    await openMark(page, "Track 1");
    await follow(page, "GenreId", "Genre");
    await expect(records(page)).toHaveText(["Track 1", "Album 1", "Genre 1"]);
    await expect(connections(page)).toHaveText(["Track 1 · AlbumId → Album 1", "Track 1 · GenreId → Genre 1"]);
    await closeCanvasDocks(page);
    await canvasRest(page, "source", 3);
    await expect(passes(page)).toHaveCount(0);
    // Hiding a connection keeps both records (O2) and is said by its ends.
    await list(page).getByRole("button", { name: "hide connection Track 1 · GenreId → Genre 1", exact: true }).press("Enter");
    await expect(connections(page)).toHaveText(["Track 1 · AlbumId → Album 1"]);
    await expect(records(page)).toHaveCount(3);
  });
});

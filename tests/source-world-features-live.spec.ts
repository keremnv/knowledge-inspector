import { chooseSourceTable as choose } from "./source-navigation";
/** World's field and table gestures on the Source canvas (owner decision O8),
 * through pinned Chinook and the actual SourceHTTPServer. */
import { test, expect, type Page } from "@playwright/test";
import { serveSource } from "./source-serve";
import { UPSTREAM, prepared } from "./chinook-serve";
import { canvasPoint, canvasRest, canvasState, closeCanvasDocks, sourceList as list, sourceReader as reader, sourceTable as tables, openSourceReferences } from "./canvas-parity";

const records = (p: Page) => list(p).locator("[data-field-record]");
const connections = (p: Page) => list(p).locator("[data-field-reference]");
async function connect(p: Page, parent: string) {
  await openSourceReferences(p); await reader(p).locator(".source-outgoing article").filter({ hasText: `→ ${parent}` }).getByRole("button", { name: /inspect FK/ }).click();
  await reader(p).getByRole("button", { name: /^(show|reveal) connection$/ }).click();
  await expect(reader(p).getByRole("button", { name: "hide connection", exact: true })).toBeVisible();
  await reader(p).getByRole("button", { name: "Back", exact: true }).click();
}
async function trackWithAlbumAndGenre(p: Page, origin: string) {
  await p.goto(`${origin}/source?placement=explicit`); await choose(p, "Track");
  await tables(p).getByRole("button", { name: "Inspect row 1", exact: true }).click();
  await reader(p).getByRole("button", { name: "show on canvas", exact: true }).click();
  await connect(p, "Album"); await connect(p, "Genre");
  await expect(records(p)).toHaveText(["Track 1", "Album 1", "Genre 1"]);
}

test("O8.1 Delete removes the selected record, Backspace hides a selected connection, never while typing", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  await serveSource(UPSTREAM, async ({ origin }) => {
    await trackWithAlbumAndGenre(page, origin);
    await tables(page).getByRole("searchbox").fill("Rock");
    await tables(page).getByRole("searchbox").press("Backspace");
    await expect(records(page)).toHaveCount(3);
    await list(page).getByRole("button", { name: "Album 1", exact: true }).press("Enter");
    await page.keyboard.press("Delete");
    await expect(records(page)).toHaveText(["Track 1", "Genre 1"]);
    await expect(connections(page)).toHaveCount(1);
    await connections(page).first().press("Enter");
    await page.keyboard.press("Backspace");
    await expect(connections(page)).toHaveCount(0);
    await expect(records(page)).toHaveText(["Track 1", "Genre 1"]);
  });
});

test("O8.3 clear takes everything off and ids keep counting", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  await serveSource(UPSTREAM, async ({ origin }) => {
    await page.goto(`${origin}/source?placement=explicit`);
    await expect(tables(page).getByRole("button", { name: "clear", exact: true })).toBeDisabled();
    await choose(page, "Track");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await reader(page).getByRole("button", { name: "show on canvas", exact: true }).click();
    await connect(page, "Album");
    const last = await records(page).last().getAttribute("data-field-record");
    await tables(page).locator("[data-catalogue]").click();
    await tables(page).getByRole("button", { name: "clear", exact: true }).click();
    await expect(list(page)).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__sourceFieldGraph.getNodeData().length)).toBe(0);
    await page.getByRole("button", { name: "Genre table", exact: true }).click();
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await reader(page).getByRole("button", { name: "show on canvas", exact: true }).click();
    const next = await records(page).first().getAttribute("data-field-record");
    expect(Number(next!.split("-")[1])).toBeGreaterThan(Number(last!.split("-")[1]));
  });
});

test("O8.4 right-click takes a marked row, or every row of a table, off the canvas", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  await serveSource(UPSTREAM, async ({ origin }) => {
    await page.goto(`${origin}/source?placement=direct`); await choose(page, "MediaType");
    for (const n of [1, 2, 3]) await tables(page).getByRole("button", { name: `Inspect row ${n}`, exact: true }).click();
    await expect(records(page)).toHaveCount(3);
    const second = tables(page).locator("tbody tr").nth(1);
    await second.click({ button: "right" });
    await expect(second).not.toHaveAttribute("data-present");
    await expect(records(page)).toHaveText(["MediaType 1", "MediaType 3"]);
    await tables(page).locator("[data-catalogue]").click();
    const mediaType = page.getByRole("button", { name: "MediaType table", exact: true });
    await expect(mediaType).toHaveAttribute("title", /Right-click takes every row of MediaType off the canvas/);
    await mediaType.click({ button: "right" });
    await expect(list(page)).toHaveCount(0);
    await expect(mediaType).not.toHaveAttribute("title");
  });
});

test("O8.7 on this disc is paused by the owner: not shown, though the record has connections", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  await serveSource(UPSTREAM, async ({ origin }) => {
    await trackWithAlbumAndGenre(page, origin);
    await expect(connections(page)).toHaveCount(2);
    await expect(reader(page).locator("h2")).toContainText("Track");
    await expect(reader(page).locator(".source-on-canvas")).toHaveCount(0);
  });
});

test("O14 a foreign-key value reaches its record, World's dotted value; the references wait behind a disclosure; find has one frame", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  await serveSource(UPSTREAM, async ({ origin }) => {
    await page.goto(`${origin}/source`); await choose(page, "Track");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    const cells = reader(page).locator(".source-cells");
    // Three resolved references, three dotted values; other values stay text.
    await expect(cells.locator("button.source-reach")).toHaveCount(3);
    const album = cells.getByRole("button", { name: "go to Album referenced by AlbumId", exact: true });
    await expect(album).toHaveAttribute("title", "Album 1");
    expect(await album.evaluate((el) => getComputedStyle(el).textDecorationStyle)).toBe("dotted");
    // The press is the whole value cell, as World's, not the glyphs of "1".
    expect(await album.evaluate((el) => Math.round(el.getBoundingClientRect().width - el.parentElement!.getBoundingClientRect().width))).toBe(0);
    // The declared references: closed, named with their count, the evidence inside.
    const references = reader(page).locator("details.source-references");
    await expect(references).not.toHaveAttribute("open");
    await expect(references.locator(":scope > summary")).toHaveText("references · 3 declared");
    await expect(reader(page).locator("section.source-outgoing article")).toHaveCount(3);
    await expect(reader(page).locator("h3", { hasText: /^references/ })).toHaveCount(0);
    // Reaching: the Reader goes to Album 1, the connection is drawn (direct), Back returns.
    await album.click();
    await expect(reader(page).locator("h2")).toHaveAccessibleName(/^Album\s*, AlbumId=1$/);
    await expect(records(page)).toHaveCount(2);
    await expect(connections(page)).toHaveCount(1);
    await reader(page).getByRole("button", { name: "Back", exact: true }).click();
    await expect(reader(page).locator("h2")).toHaveAccessibleName(/^Track\s*, TrackId=1$/);
    // Opened once, the disclosure stays open from record to record.
    await openSourceReferences(page);
    await album.click();
    await expect(reader(page).locator("details.source-references")).toHaveAttribute("open", "");
    // Find, focused: the cell's own frame in ink, no inner border or outline.
    const finder = page.getByRole("combobox", { name: "Find tables and records" });
    await finder.click();
    expect(await finder.evaluate((el) => [getComputedStyle(el).outlineStyle, getComputedStyle(el).borderTopColor])).toEqual(["none", "rgba(0, 0, 0, 0)"]);
    const cell = page.locator(".instrument__group", { has: finder });
    const ink = await page.locator(".source-workspace").evaluate((el) => { const probe = document.createElement("i"); el.appendChild(probe); probe.style.color = "var(--ink)"; const c = getComputedStyle(probe).color; probe.remove(); return c; });
    expect(await cell.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(ink);
  });
});

test("O8.2 separate pushes apart only what overlaps, and undo puts it back until something else moves", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  await serveSource(UPSTREAM, async ({ origin }) => {
    await page.goto(`${origin}/source?placement=direct`); await choose(page, "Genre");
    for (const n of [1, 2, 3]) await tables(page).getByRole("button", { name: `Inspect row ${n}`, exact: true }).click();
    await closeCanvasDocks(page); await canvasRest(page, "source", 3);
    const ids = await records(page).evaluateAll((buttons) => buttons.map((b) => b.getAttribute("data-field-record")!));
    // Drop the second record onto the first.
    const [a, b] = [await canvasPoint(page, ids[0]), await canvasPoint(page, ids[1])];
    await page.mouse.move(b.x, b.y); await page.mouse.down(); await page.waitForTimeout(150);
    await page.mouse.move(a.x + 6, a.y + 4, { steps: 12 }); await page.mouse.up();
    await canvasRest(page, "source", 3);
    const at = async () => new Map<string, number[]>((await canvasState(page)).nodes.map((n: any) => [n.id, n.at.slice(0, 2)]));
    const overlapped = await at();
    const gap = (m: Map<string, number[]>, x: string, y: string) => Math.hypot(m.get(x)![0] - m.get(y)![0], m.get(x)![1] - m.get(y)![1]);
    expect(gap(overlapped, ids[0], ids[1])).toBeLessThan(20);
    await page.getByRole("button", { name: "separate", exact: true }).click();
    await canvasRest(page, "source", 3);
    const separated = await at();
    expect(gap(separated, ids[0], ids[1])).toBeGreaterThan(80);
    // The third record overlapped nothing and did not move.
    expect(separated.get(ids[2])).toEqual(overlapped.get(ids[2]));
    await page.getByRole("button", { name: "undo separate", exact: true }).click();
    await canvasRest(page, "source", 3);
    expect(await at()).toEqual(overlapped);
    await expect(page.getByRole("button", { name: "undo separate", exact: true })).toHaveCount(0);
    // Undo is offered only until something else changes the canvas.
    await page.getByRole("button", { name: "separate", exact: true }).click();
    await expect(page.getByRole("button", { name: "undo separate", exact: true })).toBeVisible();
    await page.mouse.move(5, 5);
    const c = await canvasPoint(page, ids[2]);
    await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.waitForTimeout(150);
    await page.mouse.move(c.x + 60, c.y + 40, { steps: 8 }); await page.mouse.up();
    await expect(page.getByRole("button", { name: "undo separate", exact: true })).toHaveCount(0);
  });
});

test("O8.6 headers sort by the database, cycle ascending, descending, off, and unsort resets", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  await serveSource(UPSTREAM, async ({ origin, requests }) => {
    await page.goto(`${origin}/source`); await choose(page, "Genre");
    const firstName = () => tables(page).locator("tbody tr").first().locator("td").nth(2);
    await expect(firstName()).toHaveText('"Rock"');
    const header = tables(page).getByRole("columnheader", { name: "Name" });
    await header.getByRole("button").click();
    await expect(header).toHaveAttribute("aria-sort", "ascending");
    await expect(firstName()).toHaveText('"Alternative"');
    await header.getByRole("button").click();
    await expect(header).toHaveAttribute("aria-sort", "descending");
    await expect(firstName()).toHaveText('"World"');
    expect(requests.some((u) => u.pathname.endsWith("/rows") && u.searchParams.get("order") === "Name" && u.searchParams.get("desc") === "1")).toBe(true);
    await tables(page).getByRole("button", { name: "unsort", exact: true }).click();
    await expect(header).not.toHaveAttribute("aria-sort");
    await expect(firstName()).toHaveText('"Rock"');
  });
});

test("O8.5 add all places the rows on the page shown and no more, clear takes the table off", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  await serveSource(UPSTREAM, async ({ origin, requests }) => {
    await page.goto(`${origin}/source`); await choose(page, "MediaType");
    const footer = tables(page).locator(".source-bulk__actions");
    await footer.getByRole("button", { name: "add all", exact: true }).click();
    await expect(records(page)).toHaveCount(5);
    // The run is brought into view where it starts, as one placement is.
    await canvasRest(page, "source", 5);
    const first = await canvasPoint(page, (await records(page).first().getAttribute("data-field-record"))!);
    const insets = JSON.parse((await page.locator(".source-canvas").getAttribute("data-camera-insets"))!), view = page.viewportSize()!;
    expect(first.x).toBeGreaterThan(insets.left); expect(first.x).toBeLessThan(view.width - insets.right);
    expect(first.y).toBeGreaterThan(insets.top); expect(first.y).toBeLessThan(view.height - insets.bottom);
    await expect(tables(page).locator("tbody tr[data-present]")).toHaveCount(5);
    await footer.getByRole("button", { name: "clear", exact: true }).click();
    await expect(list(page)).toHaveCount(0);
    // Page-limited by the owner: 10 rows shown, 10 added; the next page adds its 10.
    await choose(page, "Track");
    await tables(page).getByRole("combobox", { name: "rows per page" }).selectOption("10");
    await expect(tables(page).locator("tbody tr")).toHaveCount(10);
    await footer.getByRole("button", { name: "add all", exact: true }).click();
    await expect(records(page)).toHaveCount(10);
    await expect(tables(page).locator("tbody tr[data-present]")).toHaveCount(10);
    await tables(page).getByRole("button", { name: "next rows", exact: true }).click();
    await expect(tables(page).locator("tbody tr[data-present]")).toHaveCount(0);
    await footer.getByRole("button", { name: "add all", exact: true }).click();
    await expect(records(page)).toHaveCount(20);
    await expect(tables(page).locator("tbody tr[data-present]")).toHaveCount(10);
    await expect(records(page).nth(10)).toHaveText("Track 11");
    await page.waitForTimeout(500);
    expect(await records(page).count()).toBe(20);
    const windows = requests.filter((u) => u.pathname.endsWith("/records") && u.searchParams.get("table") === "Track");
    expect(windows.map((u) => [u.searchParams.get("offset"), u.searchParams.get("limit")])).toEqual([["0", "10"], ["10", "10"]]);
  });
});

test("O8.9 expand through places a group with its connections, take off takes back only what it introduced", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  await serveSource(UPSTREAM, async ({ origin }) => {
    await page.goto(`${origin}/source`); await choose(page, "Album");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    const line = reader(page).locator(".source-expand").getByRole("button", { name: /^Track · AlbumId, 10 rows, place on the canvas$/ });
    await line.click();
    await expect(records(page)).toHaveCount(11);
    await expect(connections(page)).toHaveCount(10);
    await expect(reader(page).locator(".source-expand [data-expand-state]")).toHaveText("take off");
    // Open one member individually: it stays when the group is taken back.
    await list(page).getByRole("button", { name: "Track 6", exact: true }).press("Enter");
    await reader(page).getByRole("button", { name: "reveal", exact: true }).click();
    await list(page).getByRole("button", { name: "Album 1", exact: true }).press("Enter");
    await reader(page).locator(".source-expand").getByRole("button", { name: /take off the canvas$/ }).click();
    await expect(records(page)).toHaveText(["Album 1", "Track 6"]);
    await expect(connections(page)).toHaveCount(0);
    // add all in the narrowed table is the same expansion, limited to the page shown (O8.5).
    await reader(page).locator(".source-incoming").getByRole("button", { name: /^Track · AlbumId, 10 rows, open in tables$/ }).click();
    await tables(page).getByRole("combobox", { name: "rows per page" }).selectOption("1");
    await expect(tables(page).locator("tbody tr")).toHaveCount(1);
    const addAll = tables(page).locator(".source-bulk__actions").getByRole("button", { name: "add all", exact: true });
    await addAll.click();
    await expect(connections(page)).toHaveCount(1);
    await tables(page).getByRole("button", { name: "next rows", exact: true }).click();
    await addAll.click();
    await expect(connections(page)).toHaveCount(2);
    await page.waitForTimeout(500);
    await expect(connections(page)).toHaveCount(2);
    await expect(reader(page).locator(".source-expand [data-expand-state]")).toHaveText("take off");
  });
});

test("O8.6 the catalogue searches by name and filters by placement; add all is offered only where rows can be placed", async ({ page }) => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "ki-catalogue-")), db = join(dir, "fixture.sqlite");
  execFileSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(sys.argv[2]); c.close()", db,
    `CREATE TABLE keyed(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO keyed VALUES (1,'a'),(2,'b');
     CREATE TABLE keyless(name TEXT); INSERT INTO keyless VALUES ('x'),('y');
     CREATE VIEW keyed_view AS SELECT name FROM keyed;`]);
  try {
    await serveSource(db, async ({ origin }) => {
      await page.goto(`${origin}/source`);
      const shown = () => page.locator("#source-tables .source-table-list .table__row > span:first-child");
      await expect(shown()).toHaveText(["keyed", "keyed_view", "keyless"]);
      await page.getByRole("searchbox", { name: "Search tables" }).fill("KEYED");
      await expect(shown()).toHaveText(["keyed", "keyed_view"]);
      await page.getByRole("searchbox", { name: "Search tables" }).fill("");
      await page.getByRole("combobox", { name: "Canvas placement" }).selectOption("placeable");
      await expect(shown()).toHaveText(["keyed"]);
      await page.getByRole("combobox", { name: "Canvas placement" }).selectOption("other");
      await expect(shown()).toHaveText(["keyed_view", "keyless"]);
      await expect(page.locator("#source-tables .source-placement-filter [role=status]")).toHaveText("2 of 3");
      await page.getByRole("combobox", { name: "Canvas placement" }).selectOption("all");
      await choose(page, "keyless");
      await expect(tables(page).locator(".source-bulk__actions").getByRole("button", { name: "add all", exact: true })).toBeDisabled();
      await choose(page, "keyed");
      await tables(page).locator(".source-bulk__actions").getByRole("button", { name: "add all", exact: true }).click();
      await expect(records(page)).toHaveCount(2);
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("O8.8 the canvas and camera come back for the same capture, re-verified, and losses are said", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  await serveSource(UPSTREAM, async ({ origin }) => {
    await trackWithAlbumAndGenre(page, origin);
    await closeCanvasDocks(page); await canvasRest(page, "source", 3);
    const marks = await records(page).evaluateAll((buttons) => buttons.map((b) => b.getAttribute("data-field-record")!));
    const at = async () => new Map<string, number[]>((await canvasState(page)).nodes.map((n: any) => [n.id, n.at.slice(0, 2)]));
    // Move one record and the camera, then let both settle into the store.
    const genre = await canvasPoint(page, marks[2]);
    await page.mouse.move(genre.x, genre.y); await page.mouse.down(); await page.waitForTimeout(150);
    await page.mouse.move(genre.x + 90, genre.y + 60, { steps: 10 }); await page.mouse.up();
    await page.mouse.move(400, 300); await page.mouse.wheel(0, -240);
    await canvasRest(page, "source", 3); await page.waitForTimeout(700);
    const before = await at(), zoom = (await canvasState(page)).zoom;
    const centre = await page.evaluate(() => (window as any).__sourceFieldGraph.getViewportCenter());
    await page.reload();
    await expect(page.locator(".source-restore")).toHaveText("restored 3 records from the last visit");
    await canvasRest(page, "source", 3);
    expect(await records(page).evaluateAll((buttons) => buttons.map((b) => b.getAttribute("data-field-record")))).toEqual(marks);
    expect(await at()).toEqual(before);
    await expect(connections(page)).toHaveCount(2);
    expect(Math.abs((await canvasState(page)).zoom - zoom)).toBeLessThan(0.01);
    const back = await page.evaluate(() => (window as any).__sourceFieldGraph.getViewportCenter());
    expect(back[0]).toBeCloseTo(centre[0], 1);
    expect(back[1]).toBeCloseTo(centre[1], 1);
    // A later generation of the same capture: handles are stale, keys find the records; a key that is gone is said.
    await page.evaluate(() => {
      const key = Object.keys(sessionStorage).find((k) => k.startsWith("ki.source.field:"))!;
      const stored = JSON.parse(sessionStorage.getItem(key)!);
      stored.generation = "an-earlier-generation";
      stored.records[2].key = [{ column: "GenreId", storage_class: "integer", exact: "999" }];
      sessionStorage.setItem(key, JSON.stringify(stored));
    });
    await page.reload();
    await expect(page.locator(".source-restore")).toHaveText("restored 2 records from the last visit · 1 not found in this capture · 1 connection not restored");
    await expect(records(page)).toHaveText(["Track 1", "Album 1"]);
    await expect(connections(page)).toHaveCount(1);
    // Clearing forgets what was kept.
    await page.locator("#source-tables").getByRole("button", { name: "clear", exact: true }).click();
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.locator(".source-restore")).toHaveCount(0);
    await expect(list(page)).toHaveCount(0);
  });
});

test("O8.11/O10/O11 find asks as you type, lists tables then records ignoring case, opens either, and continues", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  await serveSource(UPSTREAM, async ({ origin, requests }) => {
    await page.goto(`${origin}/source`);
    const finder = page.getByRole("combobox", { name: "Find tables and records" });
    const options = page.getByRole("listbox", { name: "found tables and records" }).getByRole("option");
    const finds = () => requests.filter((u) => u.pathname.endsWith("/find"));
    // Typing asks once, a beat after the last keystroke: no Enter, no request per letter.
    await finder.pressSequentially("evil walks", { delay: 20 });
    await expect(options.first()).toContainText(/^Track \d+/);
    await expect(options.first()).toContainText('Name "Evil Walks"');   // ignores case
    expect(finds().map((u) => u.searchParams.get("text"))).toEqual(["evil walks"]);
    await finder.press("Enter");
    await expect(reader(page).locator("h2")).toHaveAccessibleName(/^Track\s*, TrackId=\d+$/);
    await expect(records(page)).toHaveCount(1); // direct placement places it
    // Tables come first, by name, and open in the Tables dock.
    await finder.fill("playlist");
    await expect(options.nth(0)).toHaveText(/^Playlist\s*table$/);
    await expect(options.nth(1)).toHaveText(/^PlaylistTrack\s*table$/);
    await finder.press("Enter");
    await expect(tables(page).locator(".source-table-heading")).toContainText("Playlist");
    // A broad search pages: "more results" continues without repeating anything.
    await finder.fill("rock");
    await expect(options.last()).toHaveText(/more results|the search stopped early · continue/);
    const first = await options.count();
    await options.last().dispatchEvent("mousedown");
    await expect.poll(() => options.count()).toBeGreaterThan(first);
    const labels = await options.allTextContents();
    const hits = labels.filter((label) => !/more results|continue/.test(label));
    expect(new Set(hits).size).toBe(hits.length);
    expect(finds().every((u) => !u.searchParams.has("case"))).toBe(true);
  });
});

test("O8.10 the filter hides connections or a table's records from the drawing only, and is kept", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  await serveSource(UPSTREAM, async ({ origin }) => {
    await trackWithAlbumAndGenre(page, origin);
    await closeCanvasDocks(page); await canvasRest(page, "source", 3);
    const drawn = async () => { const s = await canvasState(page); return [s.nodes.length, s.edges.filter((e: any) => !e.id.startsWith("source-")).length]; };
    expect(await drawn()).toEqual([3, 2]);
    await page.getByRole("button", { name: "filter", exact: true }).click();
    const filter = page.getByRole("group", { name: "Filter" });
    await filter.getByRole("button", { name: "connections", exact: true }).click();
    await expect.poll(drawn).toEqual([3, 0]);
    await filter.getByRole("button", { name: "Genre", exact: true }).click();
    await expect(filter.getByRole("button", { name: "Genre", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect.poll(drawn).toEqual([2, 0]);
    await expect(records(page)).toHaveCount(3); // still on the canvas, only not drawn
    await page.waitForTimeout(400);
    await page.reload();
    await expect(page.locator(".source-restore")).toContainText("restored 3 records");
    await canvasRest(page, "source", 2);
    expect(await drawn()).toEqual([2, 0]);
    await page.getByRole("button", { name: "filter", exact: true }).click();
    await page.getByRole("group", { name: "Filter" }).getByRole("button", { name: "connections", exact: true }).click();
    await page.getByRole("group", { name: "Filter" }).getByRole("button", { name: "Genre", exact: true }).click();
    await expect.poll(drawn).toEqual([3, 2]);
    // The summary closes what it pinned, though the pointer is still on it.
    const summary = page.getByRole("button", { name: "filter", exact: true });
    await summary.click();
    await expect(summary).toHaveAttribute("aria-expanded", "false");
  });
});

test("O8.12 the schema is the empty canvas's screen, as World's vocabulary: every table and declared FK, a chosen table opens", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  await serveSource(UPSTREAM, async ({ origin }) => {
    await page.goto(`${origin}/source`);
    const schema = page.locator(".source-schema");
    // Nothing to press: an empty canvas shows the schema (World's default screen).
    await expect(schema).not.toHaveClass(/is-parked/);
    await expect(page.getByRole("button", { name: "schema", exact: true })).toHaveCount(0);
    await expect(page.locator(".product-shell__top")).toBeHidden();
    // Chinook: eleven tables, eleven declarations, one of them Employee to itself.
    await expect(schema).toHaveAttribute("data-schema-tables", "11");
    await expect(schema).toHaveAttribute("data-schema-references", "11");
    await canvasRest(page, "schema", 11);
    expect(await page.evaluate(() => (window as any).__sourceSchemaGraph.getNodeData().map((n: any) => n.style.labelText).sort()))
      .toEqual(["Album", "Artist", "Customer", "Employee", "Genre", "Invoice", "InvoiceLine", "MediaType", "Playlist", "PlaylistTrack", "Track"]);
    await closeCanvasDocks(page, "schema");
    const at = await canvasPoint(page, "table:Album", false, "schema");
    await page.mouse.click(at.x, at.y);
    await expect(tables(page).locator(".source-table-heading")).toContainText("Album");
    // Read-only: Delete takes nothing off a schema.
    await page.keyboard.press("Delete");
    expect(await page.evaluate(() => (window as any).__sourceSchemaGraph.getNodeData().length)).toBe(11);
    // The first record placed takes the canvas; the schema waits behind its button.
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await expect(records(page)).toHaveCount(1);
    await expect(schema).toHaveClass(/is-parked/);
    await expect(page.locator(".product-shell__top")).toBeVisible();
    const enter = page.getByRole("button", { name: "schema", exact: true });
    await enter.click();
    await expect(schema).not.toHaveClass(/is-parked/);
    // World's way out: "clear", or Escape.
    await page.getByRole("group", { name: "Clear focus" }).getByRole("button", { name: "clear", exact: true }).click();
    await expect(schema).toHaveClass(/is-parked/);
    await enter.click();
    await expect(schema).not.toHaveClass(/is-parked/);
    // Escape closes an open dock first, then leaves the room.
    await closeCanvasDocks(page, "schema");
    await page.locator(".source-canvas").focus();
    await page.keyboard.press("Escape");
    await expect(schema).toHaveClass(/is-parked/);
    await page.locator('.ov__handle[aria-controls="source-tables"]').click();
    // The last record leaving brings the schema back.
    await page.locator("#source-tables").getByRole("button", { name: "clear", exact: true }).last().click();
    await expect(records(page)).toHaveCount(0);
    await expect(schema).not.toHaveClass(/is-parked/);
  });
});

test("O12 the schema looks like World's: a fixed alphabetical ring, fitted, inverted, names on until World's toggle turns them off", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  await serveSource(UPSTREAM, async ({ origin }) => {
    await page.goto(`${origin}/source`);
    const shell = page.locator(".source-workspace");
    const tokens = () => shell.evaluate((el) => {
      // Resolved, so #000000 and rgb(0, 0, 0) compare equal.
      const probe = document.createElement("i"); el.appendChild(probe);
      const resolve = (name: string) => { const raw = getComputedStyle(el).getPropertyValue(name).trim(); if (!raw) return ""; probe.style.color = raw; return getComputedStyle(probe).color; };
      const values = [resolve("--matter-canvas"), resolve("--focus-field")]; probe.remove(); return values;
    });
    await canvasRest(page, "schema", 11);
    // World's focus room: the field takes the inverted palette.
    const [canvas, field] = await tokens();
    expect(field).not.toBe(""); expect(canvas).toBe(field);
    const geometry = () => page.evaluate(() => {
      const g = (window as any).__sourceSchemaGraph;
      return g.getNodeData().map((n: any) => { const at = g.getElementPosition(n.id), v = g.getViewportByCanvas(at); return { name: n.style.labelText, x: at[0], y: at[1], vx: v[0], vy: v[1] }; });
    });
    const nodes = await geometry();
    // A ring about its centre, alphabetical clockwise from twelve o'clock, as World's.
    const radii = nodes.map((n: any) => Math.hypot(n.x, n.y));
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(1.5);
    const clockwise = [...nodes].sort((a: any, b: any) => ((Math.atan2(a.y, a.x) + Math.PI / 2 + 4 * Math.PI) % (2 * Math.PI)) - ((Math.atan2(b.y, b.x) + Math.PI / 2 + 4 * Math.PI) % (2 * Math.PI)));
    expect(clockwise.map((n: any) => n.name)).toEqual(["Album", "Artist", "Customer", "Employee", "Genre", "Invoice", "InvoiceLine", "MediaType", "Playlist", "PlaylistTrack", "Track"]);
    // Fitted: every table in view.
    const view = page.viewportSize()!;
    for (const n of nodes) { expect(n.vx).toBeGreaterThan(0); expect(n.vx).toBeLessThan(view.width); expect(n.vy).toBeGreaterThan(0); expect(n.vy).toBeLessThan(view.height); }
    // Names are on by default (the owner, 2026-10-25); World's toggle turns them off, and that is kept.
    const named = () => page.evaluate(() => (window as any).__sourceSchemaGraph.getEdgeData().filter((e: any) => e.id.startsWith("declaration:") && e.style.labelOpacity === 1).length);
    await expect.poll(named).toBeGreaterThanOrEqual(10);
    await page.getByRole("button", { name: "filter", exact: true }).click();
    const names = page.getByRole("group", { name: "Filter" }).getByRole("button", { name: "names", exact: true });
    await expect(names).toHaveAttribute("aria-pressed", "true");
    await names.click();
    await expect(names).toHaveAttribute("aria-pressed", "false");
    await expect.poll(named).toBe(0);
    // Wheel away, then a double-click on empty canvas frames the ring again.
    await page.mouse.move(view.width - 120, 120); await page.mouse.wheel(0, -900);
    await expect.poll(async () => (await geometry()).some((n: any) => n.vx < 0 || n.vx > view.width || n.vy < 0 || n.vy > view.height)).toBe(true);
    await page.mouse.dblclick(view.width - 120, 120);
    await expect.poll(async () => (await geometry()).every((n: any) => n.vx > 0 && n.vx < view.width && n.vy > 0 && n.vy < view.height)).toBe(true);
    await page.waitForTimeout(400);
    await page.reload();
    await canvasRest(page, "schema", 11);
    await page.waitForTimeout(300);
    expect(await named()).toBe(0);
    // A placed record takes the canvas, and the field its own palette back.
    await choose(page, "Genre");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await expect(records(page)).toHaveCount(1);
    await expect.poll(async () => (await tokens())[1]).toBe("");
  });
});

test("O11 the table filter ignores case by default, and precise lookup can match it", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  await serveSource(UPSTREAM, async ({ origin, requests }) => {
    await page.goto(`${origin}/source`); await choose(page, "Genre");
    const filter = tables(page).getByRole("form", { name: "filter Genre" });
    await expect(filter.locator(".source-filter-options small")).toHaveText("ignores case");
    await filter.getByRole("searchbox").fill("rock");
    await filter.getByRole("searchbox").press("Enter");
    await expect(tables(page).locator("tbody tr")).toHaveCount(2);
    await expect(tables(page).locator("tbody")).toContainText('"Rock And Roll"');
    await filter.locator("summary", { hasText: "precise lookup" }).click();
    await filter.getByRole("checkbox", { name: "match case" }).check();
    await expect(filter.locator(".source-filter-options small")).toHaveText("matches case");
    await filter.getByRole("button", { name: "filter", exact: true }).click();
    await expect(tables(page).locator("tbody tr")).toHaveCount(0);
    const searches = requests.filter((u) => u.pathname.endsWith("/search"));
    expect(searches.map((u) => u.searchParams.get("case"))).toEqual([null, "match"]);
  });
});

test("O17 a record is named by the column its table's header names it by, or by its key as Track 1; the Reader keeps the exact key", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  await serveSource(UPSTREAM, async ({ origin, requests }) => {
    await page.goto(`${origin}/source`); await choose(page, "Track");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await canvasRest(page, "source", 1);
    const discs = async () => (await canvasState(page)).nodes.map((n: any) => n.style.labelText.replace(/\s+/g, " "));
    expect(await discs()).toEqual(["Track 1"]);
    await expect(records(page)).toHaveText(["Track 1"]);
    await expect(reader(page).locator("h2")).toHaveAccessibleName(/^Track\s*, TrackId=1$/);
    // Chosen in the table's header, from its columns, never inferred; said to be the person's.
    const picker = tables(page).getByRole("combobox", { name: "name Track records by" });
    await expect(picker).toHaveValue("");
    const reads = requests.length;
    await picker.selectOption("Name");
    await expect.poll(discs).toEqual(["For Those About To Rock (We Salute You)"]);
    await expect(records(page)).toHaveText(["For Those About To Rock (We Salute You)"]);
    expect(requests.slice(reads).filter((u) => u.pathname.endsWith("/record"))).toHaveLength(0); // named from the read in hand
    await expect(tables(page).locator("thead th .source-named")).toHaveCount(1);
    await expect(tables(page).getByRole("columnheader", { name: /^Name/ }).locator(".source-named")).toHaveText("name");
    await expect(tables(page).locator(".source-naming")).toHaveAttribute("title", /named by Name on the canvas: your choice/);
    await expect(reader(page).locator("h2")).toHaveAccessibleName(/^Track\s*, TrackId=1$/);
    // An empty value falls back to the key: Track 2 has no Composer.
    await picker.selectOption("Composer");
    await tables(page).getByRole("button", { name: "Inspect row 2", exact: true }).click();
    await expect(records(page)).toHaveText(["Angus Young, Malcolm Young, Brian Johnson", "Track 2"]);
    // Find calls a record by the same name.
    await picker.selectOption("Name");
    const finder = page.getByRole("combobox", { name: "Find tables and records" });
    await finder.fill("evil walks");
    await expect(page.getByRole("listbox", { name: "found tables and records" }).getByRole("option").first().locator(".nodefind__label")).toHaveText("Evil Walks");
    await finder.fill("");
    // A composite key keeps its column names.
    await choose(page, "PlaylistTrack");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await expect(records(page).last()).toHaveText(/^PlaylistTrack PlaylistId=\d+; TrackId=\d+$/);
    // The choice is kept for this capture.
    await page.waitForTimeout(400);
    await page.reload();
    await expect(records(page)).toHaveText(["For Those About To Rock (We Salute You)", "Balls to the Wall", /^PlaylistTrack PlaylistId=\d+; TrackId=\d+$/]);
  });
});

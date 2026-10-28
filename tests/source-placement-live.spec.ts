import { chooseSourceTable as choose } from "./source-navigation";
/** Real SourceHTTPServer/SQLite record placement acceptance; no mocked responses.
 * Every serveSource call fingerprints the producer before and after. */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveSource } from "./source-serve";
import { UPSTREAM, prepared } from "./chinook-serve";

type Mark = { id: string; x: number; y: number; sx: number; sy: number; label: string; size: number; opacity: number };

const tables = (page: Page) => page.locator("#source-tables .source-table-slot > .motion-swap > .motion-swap__is");
const reader = (page: Page) => page.locator("#source-reader > .motion-swap > .motion-swap__is");
const fieldList = (page: Page) => page.getByRole("region", { name: "Records on canvas" });

/** The field as drawn: model position, viewport position and lifecycle pose. */
async function marks(page: Page): Promise<Mark[]> {
  return page.evaluate(() => {
    const graph = (window as unknown as { __sourceFieldGraph?: { getNodeData: () => { id: string; style: Record<string, unknown> }[]; getElementPosition: (id: string) => number[]; getViewportByCanvas: (p: number[]) => number[] } }).__sourceFieldGraph;
    if (!graph) return [];
    const host = document.querySelector(".source-canvas .world__surface canvas")!.getBoundingClientRect();
    return graph.getNodeData().map((node) => {
      const at = graph.getViewportByCanvas(graph.getElementPosition(node.id));
      return { id: node.id, x: node.style.x as number, y: node.style.y as number, sx: at[0] + host.left, sy: at[1] + host.top,
        label: node.style.labelText as string, size: node.style.size as number, opacity: node.style.opacity as number };
    });
  });
}
/** Synchronize on the renderer's lifecycle, not on a sleep: every mark at rest. */
async function settled(page: Page, count: number) {
  await expect.poll(async () => {
    const drawn = await marks(page);
    return drawn.length === count && drawn.every((mark) => mark.size === 90 && mark.opacity === 1) ? drawn.length : -1;
  }).toBe(count);
  await expect(fieldList(page).getByRole("button", { name: /^remove / })).toHaveCount(count);
  await steady(page);
  return marks(page);
}
/**
 * The rendered state at rest: camera, marks and docks unchanged over a run of
 * animation frames. A reveal flight or a dock slide is still motion.
 */
async function steady(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const graph = (window as unknown as { __sourceFieldGraph?: { getZoom: () => number; getCanvas: () => { getCamera: () => { getPosition: () => number[] } }; getNodeData: () => { id: string; style: Record<string, unknown> }[] } }).__sourceFieldGraph;
    const snapshot = () => JSON.stringify([
      graph ? [graph.getZoom(), graph.getCanvas().getCamera().getPosition(), graph.getNodeData().map((node) => [node.id, node.style.x, node.style.y, node.style.size, node.style.opacity])] : null,
      [...document.querySelectorAll(".ov__body, .ov__handle")].map((element) => { const box = element.getBoundingClientRect(); return [box.left, box.right]; }),
    ]);
    let last = snapshot(), still = 0;
    const started = performance.now();
    const tick = () => {
      const now = snapshot();
      still = now === last ? still + 1 : 0;
      last = now;
      if (still >= 12) return resolve();
      if (performance.now() - started > 8000) return reject(new Error("render did not come to rest"));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}
async function findTrack(page: Page, text: string) {
  await tables(page).getByRole("searchbox", { name: "filter Track", exact: true }).fill(text);
  await tables(page).getByRole("button", { name: "filter", exact: true }).click();
}
async function shot(page: Page, name: string) {
  if (!process.env.KI_SOURCE_SHOTS) return;
  await mkdir(process.env.KI_SOURCE_SHOTS, { recursive: true });
  await expect(page.locator(".motion-swap__was")).toHaveCount(0);
  await page.screenshot({ path: join(process.env.KI_SOURCE_SHOTS, name) });
}
/** Docks as rendered and the canvas they actually leave. */
async function geometry(page: Page) {
  await steady(page);
  return page.evaluate(() => {
    const dock = (id: string) => {
      const root = document.querySelector(`[data-overlay="${id}"]`)!;
      const body = root.querySelector(".ov__body")!.getBoundingClientRect();
      const handle = root.querySelector(".ov__handle")!.getBoundingClientRect();
      return { open: root.classList.contains("is-open"), left: body.left, right: body.right, width: body.width, handleLeft: handle.left, handleRight: handle.right };
    };
    const tablesDock = dock("source-tables"), readerDock = dock("source-reader");
    const stage = document.querySelector(".source-stage")!.getBoundingClientRect();
    const region = document.querySelector<HTMLElement>(".source-canvas")!;
    const left = tablesDock.open ? Math.max(tablesDock.right, 0) : Math.max(tablesDock.handleRight, 0);
    const right = readerDock.open ? Math.min(readerDock.left, stage.right) : Math.min(readerDock.handleLeft, stage.right);
    return { stage: stage.width, tables: tablesDock, reader: readerDock, left, right, unobscured: right - left,
      reported: Number(region.dataset.unobscured), camera: JSON.parse(region.dataset.cameraInsets!) as { left: number; right: number } };
  });
}

for (const motion of ["reduce", "no-preference"] as const) {
  test(`J1-A: Evil Walks is placed, inspected and removed back to the quiet field (${motion})`, async ({ page }) => {
    test.skip(!prepared(), "Prepare pinned Chinook first");
    await page.emulateMedia({ reducedMotion: motion });
    await serveSource(UPSTREAM, async ({ origin, requests }) => {
      await page.goto(`${origin}/source?placement=explicit`);
      // The empty canvas shows the schema, as World's default screen shows its vocabulary (O12).
      await expect(page.locator(".source-schema")).toHaveAttribute("data-schema-tables", "11");
      await expect(page.locator(".source-schema")).not.toHaveClass(/is-parked/);
      await expect(page.locator(".source-canvas > .source-layer:not(.source-schema) canvas")).toHaveCount(0);
      await choose(page, "Track");
      await findTrack(page, "Evil Walks");
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
      await expect(reader(page).locator("h2")).toHaveAccessibleName(/^Track\s*, TrackId=10$/);
      await expect(page.locator(".source-canvas > .source-layer:not(.source-schema) canvas")).toHaveCount(0);
      await reader(page).locator('[data-placement="show"]').click();
      const [mark] = await settled(page, 1);
      expect(mark.label).toBe("Track 10");
      // The Reader subject is unchanged by placement, and the mark is its selection.
      await expect(reader(page).locator("h2")).toHaveAccessibleName(/^Track\s*, TrackId=10$/);
      await expect(reader(page).locator('[data-placement="show"]')).toHaveText("reveal");
      await expect(fieldList(page).getByRole("button", { name: "Track 10", exact: true })).toHaveAttribute("aria-pressed", "true");
      // Composed at readable scale in the middle of the canvas the docks leave.
      const room = await geometry(page);
      expect(await page.evaluate(() => (window as unknown as { __sourceFieldGraph: { getZoom: () => number } }).__sourceFieldGraph.getZoom())).toBe(1);
      expect(Math.abs(mark.sx - (room.left + room.right) / 2)).toBeLessThan(4);
      await shot(page, `first-placement-${motion}.png`);
      // Another Reader subject, then the mark itself reopens the grounded record.
      await tables(page).locator("[data-table-info]").click();
      await expect(reader(page).locator("h2")).toHaveAccessibleName(/^Track\s*, table$/);
      await page.mouse.click(mark.sx, mark.sy);
      await expect(reader(page).locator("h2")).toHaveAccessibleName(/^Track\s*, TrackId=10$/);
      await expect(reader(page)).toContainText('"Evil Walks"');
      const recordReads = requests.filter((url) => url.pathname.endsWith("/record"));
      expect(new Set(recordReads.map((url) => url.searchParams.get("id"))).size).toBe(1);
      expect(recordReads.every((url) => url.searchParams.get("generation") === recordReads[0].searchParams.get("generation"))).toBe(true);
      // A right press on the mark removes it; the quiet field returns.
      await page.mouse.click(mark.sx, mark.sy, { button: "right" });
      await expect.poll(async () => (await marks(page)).length).toBe(0);
      await expect(page.getByRole("region", { name: "Source canvas" })).not.toContainText("choose a table to inspect");
      await expect(fieldList(page)).toHaveCount(0);
      await expect(reader(page)).toContainText('"Evil Walks"');
      await expect(reader(page).getByRole("button", { name: "remove" })).toHaveCount(0);
      // Only reads were made, and only of this capture.
      expect(requests.every((url) => ["/source/v1/session", "/source/v1/overview", "/source/v1/schema", "/source/v1/rows", "/source/v1/search", "/source/v1/record", "/source/v1/references"].includes(url.pathname))).toBe(true);
    });
  });
}

for (const motion of ["reduce", "no-preference"] as const) {
  test(`J1-B: two records keep separate identities, dragged and standing positions (${motion})`, async ({ page }) => {
    test.skip(!prepared(), "Prepare pinned Chinook first");
    await page.emulateMedia({ reducedMotion: motion });
    await serveSource(UPSTREAM, async ({ origin }) => {
      await page.goto(`${origin}/source`);
      await choose(page, "Track");
      await tables(page).getByRole("button", { name: "Inspect row 10", exact: true }).click();
      await reader(page).locator('[data-placement="show"]').click();
      const [ten] = await settled(page, 1);
      // Drag Track 10 by hand; the drop is where it stays.
      await page.mouse.move(ten.sx, ten.sy);
      await page.mouse.down();
      await page.mouse.move(ten.sx - 70, ten.sy + 40, { steps: 6 });
      await page.mouse.move(ten.sx - 140, ten.sy + 80, { steps: 6 });
      await page.mouse.up();
      await expect.poll(async () => { const [mark] = await marks(page); return [mark.x, mark.y]; }).toEqual([ten.x - 140, ten.y + 80]);
      const dragged = (await marks(page))[0];
      // Show again: idempotent, nothing moves, no duplicate.
      await reader(page).locator('[data-placement="show"]').click();
      await settled(page, 1);
      expect((await marks(page))[0]).toMatchObject({ x: dragged.x, y: dragged.y });
      await tables(page).getByRole("button", { name: "Inspect row 11", exact: true }).click();
      await expect(reader(page).locator("h2")).toHaveAccessibleName(/TrackId=11$/);
      await reader(page).locator('[data-placement="show"]').click();
      const both = await settled(page, 2);
      const [a, b] = both;
      expect(a.label).toBe("Track 10");
      expect(b.label).toBe("Track 11");
      expect(a).toMatchObject({ x: dragged.x, y: dragged.y });
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(104);
      const room = await geometry(page);
      for (const mark of both) {
        expect(mark.sx).toBeGreaterThan(room.left + 45);
        expect(mark.sx).toBeLessThan(room.right - 45);
      }
      await shot(page, `two-records-${motion}.png`);
      // Browsing elsewhere — another table, a search, a page — places and moves nothing.
      await choose(page, "Album");
      await tables(page).getByRole("button", { name: "next rows" }).click();
      await choose(page, "Track");
      await findTrack(page, "Snowballed");
      await expect(tables(page).getByRole("row")).toHaveCount(2);
      expect(await marks(page)).toEqual(both);
      // Closing and reopening a dock is not new matter: the field stays put.
      await page.locator("#source-tables").getByRole("button", { name: "close" }).click();
      await expect(page.locator('[data-overlay="source-tables"]')).not.toHaveClass(/is-open/);
      expect(await marks(page)).toEqual(both);
      await page.locator('[data-overlay="source-tables"] > .ov__handle').click();
      await expect(page.locator('[data-overlay="source-tables"]')).toHaveClass(/is-open/);
      expect(await marks(page)).toEqual(both);
      // Pan and zoom move the camera, never the records.
      const empty = { x: (room.left + room.right) / 2, y: 140 };
      await page.mouse.move(empty.x, empty.y);
      await page.mouse.down();
      await page.mouse.move(empty.x + 50, empty.y + 30, { steps: 5 });
      await page.mouse.up();
      await page.mouse.wheel(0, -240);
      await expect.poll(async () => (await marks(page))[0].sx).not.toBe(both[0].sx);
      expect((await marks(page)).map(({ id, x, y }) => ({ id, x, y }))).toEqual(both.map(({ id, x, y }) => ({ id, x, y })));
      // The keyboard list opens each record's Reader by its own handle.
      await fieldList(page).getByRole("button", { name: "Track 10", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(reader(page).locator("h2")).toBeFocused();
      await expect(reader(page).locator("h2")).toHaveAccessibleName(/TrackId=10$/);
      await expect(reader(page)).toContainText('"Evil Walks"');
      await page.keyboard.press("Escape");
      await expect(fieldList(page).getByRole("button", { name: "Track 10", exact: true })).toBeFocused();
    });
  });
}

const fixture = `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.executescript("""CREATE TABLE keyless(v); INSERT INTO keyless VALUES('same'),('same');
CREATE TABLE weak(a,b,PRIMARY KEY(a,b)); INSERT INTO weak VALUES(NULL,1),(NULL,1);
CREATE TABLE big(id INTEGER PRIMARY KEY, v); CREATE TABLE small(id INTEGER PRIMARY KEY, v);
INSERT INTO small VALUES(1,'one'),(2,'one');
CREATE VIEW computed AS SELECT upper(v) AS label FROM small;""")
c.executemany('INSERT INTO big VALUES(?,?)',[(i,'x') for i in range(1,11)])
c.commit();c.close()`;

test("J1-C: keyless, invalid-key, budget-exceeded and view rows stay inspectable but are never placeable", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "ki-place-")), db = join(dir, "source.sqlite");
  execFileSync("python3", ["-c", fixture, db]);
  try {
    await serveSource(db, async ({ origin }) => {
      await page.goto(`${origin}/source`);
      for (const [name, kind, qualification] of [
        ["keyless", "table", "no primary key"],
        ["weak", "table", "primary key contains NULL"],
        ["big", "table", "key verification incomplete"],
        ["computed", "view", "computed view output"],
      ] as const) {
        await choose(page, name, kind);
        await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
        await expect(reader(page)).toContainText(qualification);
        await expect(reader(page).locator('[data-placement="show"]')).toHaveCount(0);
      }
      await choose(page, "big");
      await expect(tables(page)).toContainText("key verification incomplete");
      // Positive control under the same budget: a verified record is placeable.
      await choose(page, "small");
      await tables(page).getByRole("button", { name: "Inspect row 2", exact: true }).click();
      await reader(page).locator('[data-placement="show"]').click();
      const [mark] = await settled(page, 1);
      expect(mark.label).toBe("small 2");
    }, { verify_rows: 3 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const width of [1440, 1000, 900] as const) {
  for (const stored of [false, true]) {
    test(`J1-D: ${width}px${stored ? " with saved 720px docks" : ""} keeps 320px of agreed canvas`, async ({ page }) => {
      test.skip(!prepared(), "Prepare pinned Chinook first");
      await page.setViewportSize({ width, height: 900 });
      if (stored) await page.addInitScript(() => { localStorage.setItem("ki.source.tables.width", "720"); localStorage.setItem("ki.source.reader.width", "720"); });
      await serveSource(UPSTREAM, async ({ origin }) => {
        await page.goto(`${origin}/source`);
        await choose(page, "Track");
        await tables(page).getByRole("button", { name: "Inspect row 10", exact: true }).click();
        await reader(page).locator('[data-placement="show"]').click();
        const [mark] = await settled(page, 1);
        await expect(page.locator(".ov.is-open")).toHaveCount(2);
        const room = await geometry(page);
        expect(room.tables.open && room.reader.open).toBe(true);
        expect(room.unobscured).toBeGreaterThanOrEqual(320);
        expect(Math.round(room.unobscured)).toBe(room.reported);
        expect(room.camera.left).toBe(Math.round(room.tables.right) + 48);
        expect(room.camera.right).toBe(Math.round(width - room.reader.left) + 48);
        expect(room.tables.width).toBeGreaterThanOrEqual(280);
        expect(room.reader.width).toBeGreaterThanOrEqual(280);
        // The mark is inside the remainder, at readable scale, and answers the pointer.
        expect(mark.sx - 45).toBeGreaterThanOrEqual(room.left);
        expect(mark.sx + 45).toBeLessThanOrEqual(room.right);
        await page.mouse.click(mark.sx, mark.sy, { button: "right" });
        await expect.poll(async () => (await marks(page)).length).toBe(0);
        if (stored) expect(await page.evaluate(() => [localStorage.getItem("ki.source.tables.width"), localStorage.getItem("ki.source.reader.width")])).toEqual(["720", "720"]);
        if (width === 900 && !stored) await shot(page, "responsive-900-docks.png");
      });
    });
  }
}

test("J1-D: viewport transitions, keyboard space and the compact single-dock arrangement", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook first");
  await page.setViewportSize({ width: 1440, height: 900 });
  await serveSource(UPSTREAM, async ({ origin }) => {
    await page.goto(`${origin}/source`);
    await choose(page, "Track");
    await tables(page).getByRole("button", { name: "Inspect row 10", exact: true }).click();
    await reader(page).locator('[data-placement="show"]').click();
    const [placed] = await settled(page, 1);
    for (const width of [900, 1000, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(async () => (await geometry(page)).reported).toBe(width === 1440 ? 640 : 320);
      const room = await geometry(page);
      expect(room.unobscured).toBeGreaterThanOrEqual(320);
      expect(Math.round(room.unobscured)).toBe(room.reported);
      // A resize is not new matter: the record keeps its place in the field.
      expect((await marks(page))[0]).toMatchObject({ x: placed.x, y: placed.y });
      // Explicit travel from the list reveals it within what the docks leave.
      await fieldList(page).getByRole("button", { name: "Track 10", exact: true }).press("Enter");
      await steady(page);
      const [shown] = await marks(page);
      expect(shown.sx - 45).toBeGreaterThanOrEqual(room.left);
      expect(shown.sx + 45).toBeLessThanOrEqual(room.right);
    }
    // Keyboard: closing the Reader from its own control gives its width to the canvas.
    await page.setViewportSize({ width: 900, height: 900 });
    await expect.poll(async () => (await geometry(page)).reported).toBe(320);
    await reader(page).locator('[data-placement="show"]').focus();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-overlay="source-reader"]')).not.toHaveClass(/is-open/);
    // The remaining dock returns to its preferred width; the camera agrees.
    // The closed Reader's tab is flush to the edge: it covers its 34px, no float.
    await expect.poll(async () => (await geometry(page)).reported).toBe(900 - 420 - 34);
    expect((await geometry(page)).camera.right).toBe(34 + 48);
    const tab = await page.locator('[data-overlay="source-reader"] > .ov__handle').boundingBox();
    expect(Math.round(tab!.x + tab!.width)).toBe(900);
    // Compact: one dock at a time. The other keeps its subject behind its handle.
    await page.setViewportSize({ width: 760, height: 900 });
    await page.locator('[data-overlay="source-reader"] > .ov__handle').focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-overlay="source-reader"]')).toHaveClass(/is-open/);
    await expect(page.locator('[data-overlay="source-tables"]')).not.toHaveClass(/is-open/);
    let room = await geometry(page);
    expect(room.unobscured).toBeGreaterThanOrEqual(320);
    expect(Math.round(room.unobscured)).toBe(room.reported);
    await expect(reader(page).locator("h2")).toHaveAccessibleName(/TrackId=10$/);
    // Travel from the list reveals the record inside the compact remainder.
    await fieldList(page).getByRole("button", { name: "Track 10", exact: true }).press("Enter");
    room = await geometry(page);
    const [compact] = await marks(page);
    expect(compact.sx - 45).toBeGreaterThanOrEqual(room.left);
    expect(compact.sx + 45).toBeLessThanOrEqual(room.right);
    await shot(page, "compact-760-reader.png");
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-overlay="source-tables"]')).toHaveClass(/is-open/);
    await expect(page.locator('[data-overlay="source-reader"]')).not.toHaveClass(/is-open/);
    // The Tables dock returns with its own subject; the Reader keeps its record.
    await expect(tables(page).locator(".source-table-heading h2")).toHaveText("Track");
    await page.locator('[data-overlay="source-reader"] > .ov__handle').click();
    await expect(reader(page).locator("h2")).toHaveAccessibleName(/TrackId=10$/);
    await page.keyboard.press("Escape");
    room = await geometry(page);
    expect(room.unobscured).toBeGreaterThanOrEqual(320);
    expect((await marks(page))[0]).toMatchObject({ x: placed.x, y: placed.y });
  });
});

test("J1-F: an expired capture clears the field and the producer is untouched", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook first");
  await serveSource(UPSTREAM, async ({ origin, commands, requests }) => {
    await page.goto(`${origin}/source`);
    await choose(page, "Track");
    await tables(page).getByRole("button", { name: "Inspect row 10", exact: true }).click();
    await reader(page).locator('[data-placement="show"]').click();
    await settled(page, 1);
    const sessions = requests.filter((url) => url.pathname.endsWith("/session")).length;
    await commands("retire");
    await tables(page).getByRole("button", { name: "Inspect row 11", exact: true }).click();
    await expect(page.getByRole("heading", { name: "source reads stopped" })).toBeVisible();
    await expect(page.locator(".source-canvas > .source-layer:not(.source-schema) canvas")).toHaveCount(0);
    await expect(fieldList(page)).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Source canvas" })).not.toContainText("choose a table to inspect");
    expect(requests.filter((url) => url.pathname.endsWith("/session"))).toHaveLength(sessions);
  });
});

test("J1: ordinary and reduced motion come to rest in the same field and camera", async ({ browser }) => {
  test.skip(!prepared(), "Prepare pinned Chinook first");
  await serveSource(UPSTREAM, async ({ origin }) => {
    const rests: Mark[][] = [];
    for (const reducedMotion of ["reduce", "no-preference"] as const) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion });
      await page.goto(`${origin}/source`);
      await choose(page, "Track");
      for (const row of [10, 11]) {
        await tables(page).getByRole("button", { name: `Inspect row ${row}`, exact: true }).click();
        await reader(page).locator('[data-placement="show"]').click();
        await settled(page, row === 10 ? 1 : 2);
      }
      const [ten, eleven] = await marks(page);
      await page.mouse.move(ten.sx, ten.sy);
      await page.mouse.down();
      // G6's installed canvas requires >100 ms and >10 px before dragstart.
      // Holding the press establishes that input gesture before moving it.
      await page.waitForTimeout(150);
      await page.mouse.move(ten.sx - 100, ten.sy + 60, { steps: 6 });
      await page.mouse.up();
      await steady(page);
      const [moved, untouched] = await marks(page);
      expect(moved.sx - ten.sx).toBeCloseTo(-100, 0);
      expect(moved.sy - ten.sy).toBeCloseTo(60, 0);
      expect(untouched).toEqual(eleven);
      rests.push((await marks(page)).map((mark) => ({ ...mark, sx: Math.round(mark.sx), sy: Math.round(mark.sy) })));
      await page.close();
    }
    expect(rests[1]).toEqual(rests[0]);
  });
});

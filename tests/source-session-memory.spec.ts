/** Source exploration belongs to the tab; World retains its own local memory. */
import { test, expect } from "@playwright/test";
import { serveSource } from "./source-serve";
import { UPSTREAM, prepared } from "./chinook-serve";
import { canvasRest } from "./canvas-parity";

const camera = (page: import("@playwright/test").Page) => page.evaluate(() => {
  const graph = (window as any).__sourceSchemaGraph;
  return { zoom: graph.getZoom(), centre: graph.getViewportCenter() as number[] };
});

test("Source removes only its obsolete exploration entries at this origin, and keeps new state in this tab", async ({ page, context }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  const legacyCamera = `worldir.camera:field:source:src1_old:${"a".repeat(64)}`;
  const obsolete = ["ki.source.field:old", "ki.source.naming:old", "ki.source.show:old", `${legacyCamera}:1`, `${legacyCamera}:schema:1`];
  const retained = ["other-app:value", "ki.source.tables.width", "ki.source.reader.width", "worldir.field:review:1", "worldir.camera:field:review:1", "worldir.camera:schema:review:1"];
  await page.addInitScript(({ obsolete, retained }) => {
    for (const key of [...obsolete, ...retained]) localStorage.setItem(key, "keep-unless-obsolete");
  }, { obsolete, retained });
  await serveSource(UPSTREAM, async ({ origin }) => {
    await page.goto(`${origin}/source`);
    await expect(page.locator(".source-schema")).toHaveAttribute("data-schema-tables", "11");
    const local = await page.evaluate(() => ({ ...localStorage }));
    for (const key of obsolete) expect(local[key]).toBeUndefined();
    for (const key of retained) expect(local[key]).toBe("keep-unless-obsolete");
    await page.locator("#source-tables").getByRole("button", { name: "Track table", exact: true }).click();
    await page.locator("#source-tables").getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await expect(page.locator("[data-field-record]")).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("ki.source.field:")).length)).toBe(1);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => /^ki\.source\.(field|naming|show):/.test(key)))).toEqual([]);
    // A separately opened tab shares the origin's preferences, but no exploration.
    const other = await context.newPage();
    try {
      await other.goto(`${origin}/source`);
      await expect(other.locator(".source-schema")).toHaveAttribute("data-schema-tables", "11");
      await expect(other.locator("[data-field-record]")).toHaveCount(0);
    } finally { await other.close(); }
  });
});

test("the schema camera restores its zoom and centre on refresh from sessionStorage", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  await serveSource(UPSTREAM, async ({ origin }) => {
    await page.goto(`${origin}/source`);
    await canvasRest(page, "schema", 11);
    const initial = await camera(page);
    await page.mouse.move(1200, 150);
    await page.mouse.wheel(0, -240);
    await expect.poll(async () => (await camera(page)).zoom).not.toBe(initial.zoom);
    await page.mouse.down();
    await page.mouse.move(1140, 220, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(700);
    const before = await camera(page);
    const saved = await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("worldir.camera:") && key.endsWith(":schema:1")));
    expect(saved).toHaveLength(1);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("worldir.camera:field:source:")))).toEqual([]);
    await page.reload();
    await canvasRest(page, "schema", 11);
    const after = await camera(page);
    expect(after.zoom).toBeCloseTo(before.zoom, 3);
    expect(after.centre[0]).toBeCloseTo(before.centre[0], 1);
    expect(after.centre[1]).toBeCloseTo(before.centre[1], 1);
  });
});

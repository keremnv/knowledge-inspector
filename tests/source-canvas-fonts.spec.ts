/** Plates drawn before the web font loads are measured again when it arrives,
 * through the actual Source adapter. The font files are held back by route
 * interception until after the first draw; nothing else redraws the field. */
import { test, expect, type Page } from "@playwright/test";
import { serveSource } from "./source-serve";
import { UPSTREAM, prepared } from "./chinook-serve";
import { chooseSourceTable as choose } from "./source-navigation";
import { closeCanvasDocks, sourceReader as reader, sourceTable as tables, openSourceReferences } from "./canvas-parity";

/** G's measured width of each shown name, and the width of the same text in the face loaded now. */
async function widths(page: Page) {
  return page.evaluate(() => {
    const graph = (window as any).__sourceFieldGraph;
    const measure = document.createElement("canvas").getContext("2d")!;
    return graph.getEdgeData().filter((e: any) => e.style.labelOpacity === 1 && e.style.labelText).map((e: any) => {
      const text = graph.context.element.getElement(e.id).getShape("label").getShape("text");
      measure.font = `${e.style.labelFontWeight} ${e.style.labelFontSize}px ${e.style.labelFontFamily}`;
      return { text: e.style.labelText, drawn: text.parsedStyle.metrics.lineWidths[0], now: measure.measureText(e.style.labelText).width,
        // The face's own status: `check` answers true while a fallback can render.
        loaded: [...document.fonts].some((face) => face.family === "Jost" && face.weight === String(e.style.labelFontWeight) && face.status === "loaded") };
    });
  });
}

test("plates drawn in a fallback face are measured again when the web font arrives", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\.woff2?(\?|$)/, async (route) => { await held; await route.continue(); });
  await serveSource(UPSTREAM, async ({ origin }) => {
    await page.goto(`${origin}/source?placement=explicit`, { waitUntil: "domcontentloaded" });
    await choose(page, "Track");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await reader(page).getByRole("button", { name: "show on canvas", exact: true }).click();
    await openSourceReferences(page); await reader(page).locator(".source-outgoing article").filter({ hasText: "→ Album" }).getByRole("button", { name: /inspect FK/ }).click();
    await reader(page).getByRole("button", { name: "show connection", exact: true }).click();
    await expect(reader(page).getByRole("button", { name: "hide connection", exact: true })).toBeVisible();
    await expect.poll(async () => (await widths(page)).length).toBe(1);
    const fallback = (await widths(page))[0];
    expect(fallback.loaded).toBe(false);
    release();
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(async () => {
      const [name] = await widths(page);
      return name.loaded && Math.abs(name.drawn - name.now) < 0.01;
    }).toBe(true);
    // The fallback really was a different measure, or this proves nothing here.
    const [arrived] = await widths(page);
    expect(Math.abs(fallback.drawn - arrived.now)).toBeGreaterThan(0.05);
    await closeCanvasDocks(page);
  });
});

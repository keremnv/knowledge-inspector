import { openSourceReferences } from "./canvas-parity";
import { test, expect, type Page } from "@playwright/test";
import { chooseSourceTable as choose, settleSourceDocks } from "./source-navigation";
import { serveSource } from "./source-serve";
import { prepared, UPSTREAM, serve as serveReading } from "./chinook-serve";

const reader = (page: Page) => page.locator("#source-reader > .motion-swap > .motion-swap__is");
const tables = (page: Page) => page.locator("#source-tables .source-table-slot > .motion-swap > .motion-swap__is");
const disclosure = (page: Page, label: string) => reader(page).locator("details").filter({ has: page.locator("summary", { hasText: new RegExp(`^${label}$`) }) });

async function settled(page: Page) {
  await expect(page.locator(".motion-swap__was")).toHaveCount(0);
  await settleSourceDocks(page);
}

for (const width of [1440, 900]) for (const colorScheme of ["light", "dark"] as const) {
  test(`one disclosure treatment in Source and World: ${width} ${colorScheme}`, async ({ browser }) => {
    test.skip(!prepared(), "Prepare pinned Chinook");
    const source = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme, reducedMotion: "reduce" });
    const world = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme, reducedMotion: "reduce" });
    const computed = (page: Page, selector: string) => page.locator(selector).evaluate((el) => {
      const style = getComputedStyle(el);
      return Object.fromEntries(["fontFamily", "fontSize", "fontWeight", "lineHeight", "color", "cursor", "display", "listStyleType", "outlineStyle", "outlineWidth", "outlineColor"]
        .map((property) => [property, style.getPropertyValue(property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`))]));
    });
    try {
      await serveSource(UPSTREAM, async ({ origin }) => {
        await serveReading(UPSTREAM, "examples/chinook/declaration.json", async (readingOrigin) => {
          // As World below leaves its vocabulary by placing a referent, Source
          // leaves its schema room (the empty canvas, O12) by placing a record.
          await source.goto(`${origin}/source`); await choose(source, "Genre");
          await source.locator("#source-tables").getByRole("button", { name: "Inspect row 1", exact: true }).click();
          await expect(source.locator("[data-field-record]")).toHaveCount(1);
          await expect(source.locator(".source-workspace")).not.toHaveClass(/is-schema/);
          await choose(source, "Artist"); await settled(source);
          await world.goto(`${readingOrigin}/world`);
          const find = world.getByRole("combobox", { name: "Find a referent or field occurrence" });
          await find.fill("track:10"); await expect(world.getByRole("option").first()).toBeVisible(); await find.press("Enter");
          const original = world.locator("#world-reader .motion-swap__is .world__source-metadata");
          await expect(original).toHaveClass(/reader-disclosure/);
          // A referent leaves World's vocabulary-focus palette. Compare the
          // ordinary Reader after that existing transition, not an RGB tween.
          await expect(world.locator(".product-shell")).not.toHaveClass(/is-focus/);
          await world.evaluate(async () => {
            await document.fonts.ready;
            await Promise.all(document.querySelector(".product-shell")!.getAnimations().map((animation) => animation.finished.catch(() => {})));
          });
          const sourceSummary = "#source-reader .motion-swap__is .source-reader-body > details:first-of-type > summary";
          const worldSummary = "#world-reader .motion-swap__is .reader-disclosure > summary";
          expect(await computed(source, sourceSummary)).toEqual(await computed(world, worldSummary));
          await disclosure(source, "schema details").locator("summary").press("Enter");
          const sourceFocus = await computed(source, sourceSummary);
          await original.locator("summary").press("Enter");
          expect(sourceFocus).toEqual(await computed(world, worldSummary));
          expect(await original.locator("summary").evaluate((el) => el.matches(":focus-visible"))).toBe(true);
          await expect(original).toHaveAttribute("open", "");
          await expect(source.locator("#source-reader .reader-metadata").first()).toContainText("verified");
          await expect(original).toContainText("Track:TrackId=10");
        });
      });
    } finally { await source.close(); await world.close(); }
  });
}

for (const width of [1440, 900]) for (const colorScheme of ["light", "dark"] as const) {
  for (const reducedMotion of ["reduce", "no-preference"] as const) {
    test(`Reader hierarchy and native disclosure continuity: ${width} ${colorScheme} ${reducedMotion}`, async ({ browser }) => {
      test.skip(!prepared(), "Prepare pinned Chinook");
      const page = await browser.newPage({ viewport: { width, height: 800 }, colorScheme, reducedMotion });
      try {
        await serveSource(UPSTREAM, async ({ origin }) => {
          await page.goto(`${origin}/source`);
          await choose(page, "Artist");
          await settled(page);
          await expect(reader(page).locator(".source-columns dt")).toHaveText(["ArtistId", "Name"]);
          await expect(reader(page).locator(".source-table-key")).toHaveCount(0);
          await expect(reader(page).locator(".source-columns code")).toHaveText(["INTEGER", "NVARCHAR(120)"]);
          await expect(reader(page).locator("details[open]")).toHaveCount(0);
          const colors = await reader(page).evaluate((root) => ({
            primary: getComputedStyle(root.querySelector("h2")!).color,
            names: [...root.querySelectorAll(".source-columns dt")].map((el) => getComputedStyle(el).color),
            types: [...root.querySelectorAll(".source-column-type")].map((el) => getComputedStyle(el).color),
            summary: getComputedStyle(root.querySelector("summary")!).color,
          }));
          expect(colors.names).toEqual([colors.primary, colors.primary]);
          expect(colors.types).toEqual([colors.summary, colors.summary]);
          expect(colors.summary).not.toBe(colors.primary);

          const schema = disclosure(page, "schema details"), summary = schema.locator("summary");
          await summary.focus(); await page.keyboard.press("Enter");
          await expect(schema).toHaveAttribute("open", "");
          await expect(summary).toBeFocused();
          expect(await summary.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");
          await expect(schema.locator(".reader-metadata").first()).toContainText("verified");
          await expect(schema).toContainText("NOT NULL");
          await expect(schema).toContainText("default SQL");
          await expect(reader(page).getByText("INTEGER", { exact: true })).toHaveCount(1);
          await expect(reader(page).locator("details details")).toHaveCount(0);
          await page.keyboard.press("Space");
          await expect(schema).not.toHaveAttribute("open");
          await summary.hover();
          expect(await summary.evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");

          await choose(page, "Track");
          await tables(page).getByRole("button", { name: "Inspect row 10", exact: true }).press("Enter");
          await expect(reader(page).locator(".source-cells")).toContainText('"Evil Walks"');
          await reader(page).locator('[data-placement="show"]').click();
          const identity = disclosure(page, "identity details");
          await identity.locator("summary").click();
          await disclosure(page, "source details").locator("summary").click();
          await reader(page).locator(".source-reader-body").evaluate((el) => { el.scrollTop = el.scrollHeight; });
          await expect.poll(() => reader(page).locator(".source-reader-body").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
          await openSourceReferences(page);
          const inspectAlbum = reader(page).locator(".source-outgoing article").filter({ hasText: "→ Album" }).getByRole("button", { name: /inspect FK/ });
          await inspectAlbum.scrollIntoViewIfNeeded();
          const scroll = await reader(page).locator(".source-reader-body").evaluate((el) => el.scrollTop);
          await inspectAlbum.click();
          await expect(reader(page).locator("[data-reference-status]")).toHaveText("resolved");
          // Text may arrive before the incoming motion layer is visible.
          // Native keyboard disclosure actions require a focusable subject.
          await expect(disclosure(page, "reference details").locator("summary")).toBeVisible();
          await disclosure(page, "reference details").locator("summary").press("Space");
          await expect(reader(page).locator(".source-reference-pairs")).toBeVisible();
          await reader(page).getByRole("button", { name: "open referenced record", exact: true }).click();
          await expect(reader(page).locator("h2")).toHaveAccessibleName("Album, AlbumId=1");
          await reader(page).getByRole("button", { name: "Back", exact: true }).press("Enter");
          await expect(disclosure(page, "reference details")).toHaveAttribute("open", "");
          await reader(page).getByRole("button", { name: "Back", exact: true }).press("Enter");
          await settled(page);
          await expect(reader(page).locator("h2")).toHaveAccessibleName("Track, TrackId=10");
          await expect(identity).toHaveAttribute("open", "");
          await expect(disclosure(page, "source details")).toHaveAttribute("open", "");
          expect(Math.abs(await reader(page).locator(".source-reader-body").evaluate((el) => el.scrollTop) - scroll)).toBeLessThan(2);
          await reader(page).getByRole("button", { name: "close", exact: true }).press("Enter");
          await expect(tables(page).getByRole("button", { name: "Inspect row 10", exact: true })).toBeFocused();
          await tables(page).getByRole("button", { name: "Inspect row 10", exact: true }).press("Enter");
          await expect(reader(page).locator("h2")).toBeFocused();
          await expect(identity).toHaveAttribute("open", "");
        });
      } finally { await page.close(); }
    });
  }
}

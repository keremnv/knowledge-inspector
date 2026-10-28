import { openSourceReferences } from "./canvas-parity";
/** Gate actual adapter responses; no payload is fabricated. These checks keep
 * navigation restoration separate from an already active reading viewport. */
import { test, expect, type Page } from "@playwright/test";
import { prepared, UPSTREAM } from "./chinook-serve";
import { chooseSourceTable, settleSourceDocks } from "./source-navigation";
import { serveSource } from "./source-serve";

const reader = (page: Page) => page.locator("#source-reader > .motion-swap > .motion-swap__is");
const body = (page: Page) => reader(page).locator(".source-reader-body");
const details = (page: Page, label: string) => reader(page).locator("details").filter({ has: page.locator("summary", { hasText: new RegExp(`^${label}$`) }) });
const back = (page: Page) => reader(page).getByRole("button", { name: "Back", exact: true });

async function holdNext(page: Page, endpoint: string) {
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const received = new Promise<void>((resolve) => { arrived = resolve; });
  await page.route(`**/source/v1/${endpoint}?*`, async (route) => {
    const response = await route.fetch();
    arrived();
    await held;
    await route.fulfill({ response });
  }, { times: 1 });
  return { received, release };
}

async function track(page: Page, origin: string) {
  await page.goto(`${origin}/source?placement=explicit`);
  await chooseSourceTable(page, "Track");
  await page.locator('#source-tables .motion-swap__is').getByRole("button", { name: "Inspect row 10", exact: true }).press("Enter");
  await expect(reader(page).locator(".source-outgoing")).toContainText("→ Album");
  await expect(page.locator(".motion-swap__was")).toHaveCount(0);
  await settleSourceDocks(page);
}
async function inspectAlbum(page: Page) {
  await openSourceReferences(page); await reader(page).locator(".source-outgoing article").filter({ hasText: "→ Album" }).getByRole("button", { name: /inspect FK/ }).click();
  await expect(reader(page).locator("[data-reference-status]")).toHaveText("resolved");
  await expect(page.locator(".motion-swap__was")).toHaveCount(0);
}
async function viewport(page: Page) {
  return body(page).evaluate((el) => ({
    top: el.scrollTop,
    open: Array.from(el.querySelectorAll("details")).map((node) => [node.querySelector("summary")!.textContent, node.open]),
  }));
}

for (const reducedMotion of ["reduce", "no-preference"] as const) {
  test(`Delayed references preserve the visible evidence anchor: ${reducedMotion}`, async ({ browser }) => {
    test.skip(!prepared(), "Prepare pinned Chinook");
    const page = await browser.newPage({ viewport: { width: 1440, height: 600 }, reducedMotion });
    let release: (() => void) | undefined;
    try {
      await serveSource(UPSTREAM, async ({ origin }) => {
        await page.goto(`${origin}/source`);
        await chooseSourceTable(page, "Track");
        const references = await holdNext(page, "references"); release = references.release;
        await page.getByRole("button", { name: "Inspect row 10", exact: true }).press("Enter");
        await references.received;
        const anchor = details(page, "identity details").locator("summary");
        await anchor.press("Enter");
        await details(page, "source details").locator("summary").press("Enter");
        const painted = () => page.evaluate(() => new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await body(page).hover();
        await page.mouse.wheel(0, (await anchor.boundingBox())!.y - (await body(page).boundingBox())!.y);
        await expect.poll(() => body(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        await painted();
        const before = (await anchor.boundingBox())!.y;
        references.release();
        await expect(reader(page).locator(".source-outgoing")).toContainText("→ Album");
        await painted();
        expect(Math.abs((await anchor.boundingBox())!.y - before)).toBeLessThan(2);
        await expect(details(page, "identity details")).toHaveAttribute("open", "");
        await expect(details(page, "source details")).toHaveAttribute("open", "");
      });
    } finally { release?.(); await page.close(); }
  });

  for (const resumeReading of [false, true]) {
    test(`Back waits for actual record and reference content${resumeReading ? ", unless reading resumes" : ""}: ${reducedMotion}`, async ({ browser }) => {
      test.skip(!prepared(), "Prepare pinned Chinook");
      const page = await browser.newPage({ viewport: { width: 900, height: 800 }, reducedMotion });
      const releases: (() => void)[] = [];
      try {
        await serveSource(UPSTREAM, async ({ origin }) => {
          await track(page, origin);
          await openSourceReferences(page);
          await details(page, "identity details").locator("summary").press("Enter");
          await details(page, "source details").locator("summary").press("Space");
          const inspect = reader(page).locator(".source-outgoing article").filter({ hasText: "→ Album" }).getByRole("button", { name: /inspect FK/ });
          await inspect.scrollIntoViewIfNeeded();
          const saved = await viewport(page);
          expect(saved.top).toBeGreaterThan(0);
          // Table info leaves the row handle, so Back must read it again. A
          // reference-to-child return can legitimately reuse its current read.
          await page.locator('#source-tables .motion-swap__is [data-table-info]').click();
          await expect(reader(page).locator(".source-columns")).toContainText("TrackId");
          await expect(page.locator(".motion-swap__was")).toHaveCount(0);

          const record = await holdNext(page, "record"), references = await holdNext(page, "references");
          releases.push(record.release, references.release);
          await back(page).press("Enter");
          await record.received;
          await expect(reader(page).getByRole("status")).toHaveText("loading…");
          await expect(reader(page).locator("details")).toHaveCount(0);
          await expect(reader(page).locator("h2")).toBeFocused();
          record.release();
          await references.received;
          await expect(reader(page).locator(".source-cells")).toContainText('"Evil Walks"');
          await expect(reader(page).locator(".source-outgoing").getByRole("status")).toHaveText("loading…");
          // Do not consume the saved state against partially loaded content.
          await expect(details(page, "identity details")).not.toHaveAttribute("open");
          if (resumeReading) {
            // New interaction takes precedence over the older saved viewport.
            await details(page, "identity details").locator("summary").press("Enter");
            await expect(details(page, "identity details")).toHaveAttribute("open", "");
          }
          references.release();
          await expect(details(page, "identity details")).toHaveAttribute("open", "");
          if (resumeReading) {
            await expect(reader(page).locator(".source-outgoing")).toContainText("→ Album");
            await expect(details(page, "source details")).not.toHaveAttribute("open");
            await expect(details(page, "identity details").locator("summary")).toBeFocused();
          } else {
            await expect(details(page, "source details")).toHaveAttribute("open", "");
            await expect.poll(() => viewport(page)).toEqual(saved);
            await expect(reader(page).locator("h2")).toBeFocused();
          }
        });
      } finally { releases.forEach((release) => release()); await page.close(); }
    });
  }

  test(`An async placement completion preserves active reading: ${reducedMotion}`, async ({ browser }) => {
    test.skip(!prepared(), "Prepare pinned Chinook");
    const page = await browser.newPage({ viewport: { width: 1440, height: 800 }, reducedMotion });
    let release: (() => void) | undefined;
    try {
      await serveSource(UPSTREAM, async ({ origin }) => {
        await track(page, origin);
        await inspectAlbum(page);
        const parent = await holdNext(page, "record"); release = parent.release;
        await reader(page).getByRole("button", { name: "show connection", exact: true }).click();
        await parent.received;
        const reference = details(page, "reference details"), summary = reference.locator("summary");
        await summary.press("Enter");
        await expect(reference).toHaveAttribute("open", "");
        await details(page, "source details").locator("summary").press("Space");
        // Wheel is a real user scroll, without moving focus from the summary.
        await summary.focus();
        await body(page).hover();
        await page.mouse.wheel(0, 280);
        await expect.poll(() => body(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        const saved = await viewport(page);
        const anchorY = (await summary.boundingBox())!.y;
        await expect(summary).toBeFocused();
        parent.release();
        await expect(reader(page).getByRole("button", { name: "hide connection", exact: true })).toBeVisible();
        // The loading notice above the evidence disappears. Native anchoring
        // changes scrollTop to keep the evidence in place; test what is read.
        await expect.poll(async () => Math.abs((await summary.boundingBox())!.y - anchorY)).toBeLessThan(2);
        expect((await viewport(page)).open).toEqual(saved.open);
        await expect(summary).toBeFocused();
        await expect(reference).toHaveAttribute("open", "");
        const completed = await viewport(page);
        // An unrelated theme update must also leave the live disclosure alone.
        await page.emulateMedia({ colorScheme: "dark" });
        await expect(page.locator(".source-workspace")).toHaveClass(/is-dark/);
        await expect.poll(() => viewport(page)).toEqual(completed);
        await expect(summary).toBeFocused();
      });
    } finally { release?.(); await page.close(); }
  });
}

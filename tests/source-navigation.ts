import { expect, type Page } from "@playwright/test";

/** The catalogue and the table are successive subjects in one dock. */
export async function chooseSourceTable(page: Page, name: string, kind = "table") {
  const catalogue = page.locator('#source-tables .source-table-slot > .motion-swap > .motion-swap__is [data-catalogue]');
  const target = page.getByRole("button", { name: `${name} ${kind}`, exact: true });
  await expect.poll(async () => await catalogue.isVisible() || await target.isVisible()).toBe(true);
  if (await catalogue.isVisible()) await catalogue.click();
  await target.click();
}
export async function preciseSourceLookup(page: Page) {
  const details = page.locator('#source-tables .source-table-slot > .motion-swap > .motion-swap__is .source-filter-options details');
  if (!await details.getAttribute("open").then((value) => value !== null)) await details.locator('summary').click();
}

/** Wait for the existing dock motion to finish before measuring its geometry. */
export async function settleSourceDocks(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    let last = "", still = 0, frames = 0;
    const tick = () => {
      const current = JSON.stringify([...document.querySelectorAll('.ov__body, .ov__handle')].map((el) => {
        const b = el.getBoundingClientRect(); return [b.left, b.right, b.width];
      }));
      still = current === last ? still + 1 : 0; last = current;
      if (still >= 12) return resolve();
      if (++frames > 600) return reject(new Error('source docks did not settle'));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}

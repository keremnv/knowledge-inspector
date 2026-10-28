import { chooseSourceTable as choose } from "./source-navigation";
/** The table panel says what is on the canvas, as World's did: an ink rule in
 * the row's margin for a placed record, and in the catalogue for a table whose
 * every row is placed. Pinned Chinook through the actual SourceHTTPServer. */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { serveSource } from "./source-serve";
import { UPSTREAM, prepared } from "./chinook-serve";
import { sourceList as list, sourceReader as reader, sourceTable as tables } from "./canvas-parity";

const row = (p: Page, n: number) => tables(p).locator("tbody tr").nth(n - 1);
const catalogue = (p: Page, name: string) => p.locator("#source-tables .source-table-list").getByRole("button", { name: `${name} table`, exact: true });
const rule = (target: Locator) => target.evaluate((el) => getComputedStyle(el).boxShadow);
const fill = (target: Locator) => target.evaluate((el) => getComputedStyle(el).backgroundColor);

test("a placed record's row carries the margin rule; numbers are gone; selection is a tint", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  await serveSource(UPSTREAM, async ({ origin }) => {
    await page.goto(`${origin}/source?placement=explicit`); await choose(page, "MediaType");
    await expect(tables(page).locator("tbody tr")).toHaveCount(5);
    // The row control keeps its name for keyboard and assistive use, without the repeated number.
    await expect(tables(page).getByRole("button", { name: "Inspect row 2", exact: true })).toHaveText("");
    const quiet = await fill(row(page, 1));
    await tables(page).getByRole("button", { name: "Inspect row 2", exact: true }).click();
    await expect(row(page, 2)).toHaveClass(/is-selected/);
    expect(await rule(row(page, 2))).toBe("none");
    expect(await fill(row(page, 2))).not.toBe(quiet);
    await reader(page).getByRole("button", { name: "show on canvas", exact: true }).click();
    await expect(row(page, 2)).toHaveAttribute("data-present");
    expect(await rule(row(page, 2))).toContain("3px 0px 0px 0px");
    await expect(row(page, 2)).toContainText("on canvas");
    // Selecting another row moves the tint, not the rule.
    await tables(page).getByRole("button", { name: "Inspect row 3", exact: true }).click();
    expect(await rule(row(page, 3))).toBe("none");
    expect(await rule(row(page, 2))).toContain("3px 0px 0px 0px");
    expect(await fill(row(page, 2))).toBe(quiet);
  });
});

test("a catalogue table carries the rule only while every one of its rows is placed", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  await serveSource(UPSTREAM, async ({ origin }) => {
    await page.goto(`${origin}/source?placement=direct`); await choose(page, "MediaType");
    for (let n = 1; n <= 4; n++) {
      await tables(page).getByRole("button", { name: `Inspect row ${n}`, exact: true }).click();
      await expect(row(page, n)).toHaveAttribute("data-present");
    }
    await tables(page).locator("[data-catalogue]").click();
    await expect(catalogue(page, "MediaType")).not.toHaveAttribute("data-present");
    await catalogue(page, "MediaType").click();
    await tables(page).getByRole("button", { name: "Inspect row 5", exact: true }).click();
    await expect(row(page, 5)).toHaveAttribute("data-present");
    await tables(page).locator("[data-catalogue]").click();
    await expect(catalogue(page, "MediaType")).toHaveAttribute("data-present");
    expect(await rule(catalogue(page, "MediaType"))).toContain("3px 0px 0px 0px");
    // The open table is told by a tint, so the two never read as one mark.
    expect(await rule(catalogue(page, "Genre"))).toBe("none");
    // Remove one record: the table is no longer whole on the canvas.
    await list(page).getByRole("button", { name: "remove MediaType 3 from canvas", exact: true }).press("Enter");
    await expect(catalogue(page, "MediaType")).not.toHaveAttribute("data-present");
    await catalogue(page, "MediaType").click();
    await expect(row(page, 3)).not.toHaveAttribute("data-present");
    await expect(row(page, 2)).toHaveAttribute("data-present");
  });
});

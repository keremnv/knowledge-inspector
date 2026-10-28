import { chooseSourceTable as choose } from "./source-navigation";
/** Individual canvas membership over pinned Chinook and the actual
 * SourceHTTPServer, no route mocks. A record placed or reached individually
 * stands until removed; hiding a connection and removing a record change only
 * the display, and never read or write the source. */
import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { serveSource } from "./source-serve";
import { UPSTREAM, prepared } from "./chinook-serve";
import { canvasRest, canvasState, sourceList as list, sourceReader as reader, sourceTable as tables, openSourceReferences } from "./canvas-parity";

const incoming = (p: Page) => reader(p).locator(".source-incoming");
async function shot(p: Page, name: string) {
  if (!process.env.KI_MEMBERSHIP_SHOTS) return;
  await mkdir(process.env.KI_MEMBERSHIP_SHOTS, { recursive: true });
  await expect(p.locator(".motion-swap__was")).toHaveCount(0);
  await p.screenshot({ path: join(process.env.KI_MEMBERSHIP_SHOTS, name) });
}
/** Placed records by list name, with the element id their mark is drawn under. */
async function marks(p: Page) {
  return list(p).locator("[data-field-record]").evaluateAll((buttons) =>
    buttons.map((button) => [button.textContent, button.getAttribute("data-field-record")]));
}
async function at(p: Page) {
  return new Map((await canvasState(p)).nodes.map((node: any) => [node.id, node.at.slice(0, 2)]));
}
async function connect(p: Page, parent: string) {
  await openSourceReferences(p); await reader(p).locator(".source-outgoing article").filter({ hasText: `→ ${parent}` }).getByRole("button", { name: /inspect FK/ }).click();
  await reader(p).getByRole("button", { name: /^(show|reveal) connection$/ }).click();
  await expect(reader(p).getByRole("button", { name: "hide connection", exact: true })).toBeVisible();
}

for (const motion of ["reduce", "no-preference"] as const) {
  test(`visited, shared and reached records stand through hiding and removal (${motion})`, async ({ page }) => {
    test.skip(!prepared(), "Prepare pinned Chinook");
    await page.emulateMedia({ reducedMotion: motion });
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await serveSource(UPSTREAM, async ({ origin, requests, captureFingerprint }) => {
      const capture = await captureFingerprint();
      await page.goto(`${origin}/source?placement=explicit`); await choose(page, "Album");
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
      await reader(page).getByRole("button", { name: "show on canvas", exact: true }).click();
      await canvasRest(page, "source", 1);
      const [[, album]] = await marks(page);
      const visited = (await at(page)).get(album);
      // Through referenced by: the Tracks of Album 1, two of them connected back.
      await incoming(page).getByRole("button", { name: /^Track · AlbumId, 10 rows/ }).click();
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
      await connect(page, "Album");
      await reader(page).getByRole("button", { name: "Back", exact: true }).click();
      await connect(page, "Genre");
      await tables(page).getByRole("button", { name: "Inspect row 2", exact: true }).click();
      await connect(page, "Album");
      await canvasRest(page, "source", 4);
      expect(await marks(page)).toEqual([["Album 1", album], ["Track 1", "record-2"],
        ["Genre 1", "record-4"], ["Track 6", "record-6"]]);
      await expect(list(page).locator("[data-field-reference]")).toHaveCount(3);
      const standing = await at(page);
      expect(standing.get(album)).toEqual(visited);
      // The shared parent is one mark: both Track connections end at it.
      expect((await canvasState(page)).edges.filter((edge: any) => !edge.id.startsWith("source-")).map((edge: any) => edge.target).sort())
        .toEqual([album, album, "record-4"]);
      await shot(page, `connected-${motion}.png`);
      const reads = requests.length;

      // Hide one connection to the shared parent: every record stays, unmoved.
      await list(page).locator("[data-field-reference]").first().press("Enter");
      await expect(reader(page).locator("[data-reference-status]")).toHaveText("resolved");
      await reader(page).getByRole("button", { name: "hide connection", exact: true }).click();
      await canvasRest(page, "source", 4);
      await expect(list(page).locator("[data-field-reference]")).toHaveCount(2);
      expect(await at(page)).toEqual(standing);
      await expect(reader(page).getByRole("button", { name: "show connection", exact: true })).toBeVisible();
      await expect(reader(page).locator("[data-reference-status]")).toHaveText("resolved");
      await shot(page, `hidden-${motion}.png`);

      // Remove the shared parent: Track 6 stays although its only connection went with it.
      await list(page).getByRole("button", { name: "remove Album 1 from canvas", exact: true }).press("Enter");
      await canvasRest(page, "source", 3);
      expect((await marks(page)).map(([name]) => name)).toEqual(["Track 1", "Genre 1", "Track 6"]);
      await expect(list(page).locator("[data-field-reference]")).toHaveCount(1);
      // Remove Track 1: Genre 1, reached only through it, stays.
      await list(page).getByRole("button", { name: "remove Track 1 from canvas", exact: true }).press("Enter");
      await canvasRest(page, "source", 2);
      expect(await marks(page)).toEqual([["Genre 1", "record-4"], ["Track 6", "record-6"]]);
      await expect(list(page).locator("[data-field-reference]")).toHaveCount(0);
      expect(await at(page)).toEqual(new Map([["record-4", standing.get("record-4")], ["record-6", standing.get("record-6")]]));
      expect(requests.length).toBe(reads + 2); // the selected reference and its child record; hiding and removal read nothing
      await shot(page, `removed-${motion}.png`);

      // Reopening a standing record reveals it; nothing is added or moved.
      await list(page).getByRole("button", { name: "Genre 1", exact: true }).press("Enter");
      await expect(reader(page).locator('[data-placement="show"]')).toHaveText("reveal");
      await reader(page).locator('[data-placement="show"]').click();
      await reader(page).getByRole("button", { name: "close", exact: true }).first().click();
      await canvasRest(page, "source", 2);
      expect((await marks(page)).map(([, id]) => id)).toEqual(["record-4", "record-6"]);
      await expect(page.getByRole("button", { name: "keep on canvas" })).toHaveCount(0);
      expect(await captureFingerprint()).toEqual(capture);
      expect(errors).toEqual([]);
    });
  });
}

test("direct placement trial: a reselected row and a reopened endpoint are never duplicated", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  await serveSource(UPSTREAM, async ({ origin }) => {
    await page.goto(`${origin}/source?placement=direct`); await choose(page, "Track");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await canvasRest(page, "source", 1);
    await openSourceReferences(page); await reader(page).locator(".source-outgoing article").filter({ hasText: "→ Album" }).getByRole("button", { name: /inspect FK/ }).click();
    await canvasRest(page, "source", 2);
    await expect(list(page).locator("[data-field-reference]")).toHaveCount(1);
    const before = await at(page);
    await reader(page).getByRole("button", { name: "hide connection", exact: true }).click();
    await expect(list(page).locator("[data-field-reference]")).toHaveCount(0);
    await reader(page).getByRole("button", { name: "open referenced record", exact: true }).click();
    await expect(reader(page).locator('[data-placement="show"]')).toHaveText("reveal");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await canvasRest(page, "source", 2);
    expect((await marks(page)).map(([name]) => name)).toEqual(["Track 1", "Album 1"]);
    expect(await at(page)).toEqual(before);
  });
});

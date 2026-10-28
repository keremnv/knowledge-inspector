/**
 * Chinook, live: the real v1.4.5 file through both real adapters and the
 * actual pages. No route mocking. Skips unless the demo data is prepared:
 *
 *   python3 examples/chinook/prepare.py --view-copy
 *
 * Each worker serves the upstream file (structure + reading) and the demo's
 * view copy (structure + view reading) behind a same-origin proxy, the way
 * Vite proxies them in the demo, and checks at teardown that neither file
 * changed. KI_CHINOOK_SHOTS=<dir> also saves the walkthrough screenshots.
 */
import { test as base, expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { prepared, serve, UPSTREAM, UPSTREAM_SHA256, VIEW_COPY } from "./chinook-serve";

const SHOTS = process.env.KI_CHINOOK_SHOTS;

const test = base.extend<{}, { chinook: string; chinookView: string }>({
  chinook: [async ({}, use) => {
    await serve(UPSTREAM, "examples/chinook/declaration.json", use);
  }, { scope: "worker" }],
  chinookView: [async ({}, use) => {
    await serve(VIEW_COPY, "examples/chinook/declaration-view.json", use);
  }, { scope: "worker" }],
});

test.skip(!prepared(), "run examples/chinook/prepare.py --view-copy first");

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

const reader = (page: Page) => page.locator(".node-reader .motion-swap__is");
const activeTable = (page: Page, name: string) => page.locator(`.motion-swap__is section[aria-label="${name}"]`);

async function openRelation(page: Page, name: string) {
  await activeTable(page, "world relations").locator(".table__row").filter({ has: page.locator(`[title="${name}"]`) }).click();
  await expect(activeTable(page, `${name} extension`).locator(".table__row[data-loaded]").first()).toBeVisible();
}

/**
 * A relation-table row by its first cell's raw value — the cell's title —
 * never by position. The cell itself shows the id without its namespace.
 */
const rowOf = (page: Page, relation: string, first: string) =>
  activeTable(page, `${relation} extension`).locator(".table__row[data-loaded]").filter({
    has: page.locator(`span:first-child[title="${first}"]`),
  });

test("structure: Chinook as stored, keys verified, links table-level", async ({ page, chinook }) => {
  await page.goto(`${chinook}/sqlite`);
  await expect(page.getByText("11 tables · 0 views")).toBeVisible();
  await expect(page.getByText(`SHA-256 ${UPSTREAM_SHA256.slice(0, 12)}`)).toBeVisible();
  await shot(page, "01-structure-catalogue");

  await page.getByRole("button", { name: /^Track/ }).click();
  await expect(page.getByRole("heading", { name: "Track", exact: true })).toBeVisible();
  for (const [from, to] of [["MediaTypeId", "MediaType"], ["GenreId", "Genre"], ["AlbumId", "Album"]]) {
    await expect(page.getByRole("button", { name: `${from} → ${to} (${from})` })).toHaveAttribute(
      "title", `Open table ${to} (table-level; does not follow to the referenced record)`);
  }
  await expect(page.getByText("Record keys verified for structural navigation. Row order: declared key.")).toBeVisible();
  // Track 2 as stored: no composer, a REAL price.
  const second = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "Balls to the Wall", exact: true }) }).first();
  await expect(second.getByRole("cell")).toHaveText(["2", "Balls to the Wall", "2", "2", "1", "NULL", "342562", "5510424", "0.99"]);
  await shot(page, "02-structure-track");

  // The joining table's identity is its declared composite key, verified.
  await page.getByRole("button", { name: /^PlaylistTrack/ }).click();
  await expect(page.getByRole("heading", { name: "PlaylistTrack", exact: true })).toBeVisible();
  await expect(page.getByText("PlaylistId + TrackId")).toBeVisible();
  await expect(page.getByText("1–50 of 8715")).toBeVisible();
  await shot(page, "03-structure-playlisttrack");

  await page.getByRole("button", { name: /^InvoiceLine/ }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("51–100 of 2240")).toBeVisible();
  await shot(page, "04-structure-invoiceline-page-2");
  // A foreign key opens its table, from the top: not the referenced record.
  await page.getByRole("button", { name: "TrackId → Track (TrackId)" }).click();
  await expect(page.getByRole("heading", { name: "Track", exact: true })).toBeVisible();
  await expect(page.getByRole("row").nth(1).getByRole("cell").first()).toHaveText("1");
});

test("reading: attributed to the reader, grounded in stored rows", async ({ page, chinook }) => {
  await page.goto(chinook);
  const overview = await page.evaluate(async () => (await fetch("/world/overview").then((r) => r.json())) as {
    world_id: string; reading: { declaration_digest: string };
  });
  // The revision is the generic adapter's default, so a verified reading does not print it;
  // the API still reports 1, and the World's identity is unchanged.
  await expect(page.locator(".product-shell__workspace")).toHaveText(overview.world_id);
  const attribution = page.locator("details.world-reading");
  await attribution.locator("summary").first().click();
  await expect(attribution).toContainText(overview.reading.declaration_digest);
  await expect(attribution).toContainText("Written for the Knowledge Inspector demonstration, not by the database's author");
  await expect(attribution).toContainText("not semantic correctness, human authorship or producer endorsement");
  await shot(page, "10-reading-attribution");

  await openRelation(page, "track_on_album");
  await rowOf(page, "track_on_album", "track:10").click();
  await expect(reader(page).locator("h2")).toHaveText("track_on_album");
  for (const [role, value] of [["track", "Evil Walks"], ["album", "For Those About To Rock We Salute You"],
    ["composer", "Angus Young, Malcolm Young, Brian Johnson"], ["milliseconds", "263497"], ["unit_price", "0.99"]]) {
    await expect(reader(page).locator(".world__roles li").filter({ has: page.locator("b", { hasText: new RegExp(`^${role}$`) }) })).toContainText(value);
  }
  await expect(reader(page)).toContainText("row TrackId=10 in Track");
  // Nothing undeclared is shown as a status: no origin or stance chip, and
  // the origins note says unstated rather than inventing one.
  await expect(reader(page).locator(".node-reader__kind")).toHaveCount(0);
  await expect(reader(page).locator(".world__note", { hasText: "origins · unstated" })).toBeVisible();
  const relation = reader(page).locator("details.world-attribution");
  await relation.locator("summary").click();
  await expect(relation).toContainText("No construction origin declared.");
  await expect(relation).toContainText("No occurrence state declared.");
  await expect(relation).toContainText("Declared role composer → source column Composer (scalar).");
  await shot(page, "11-reading-track-10");

  // Traversal follows the declared reference, to the album's own reading.
  await reader(page).locator(".world__roles button").filter({ hasText: "For Those About To Rock" }).click();
  await expect(reader(page).locator("h2")).toHaveText("For Those About To Rock We Salute You");
  await expect(reader(page)).toContainText("album:1");
  const expand = reader(page).locator(".gm__list button").filter({ hasText: "track_on_album" }).first();
  await expand.click();
  await expect(expand).toContainText("take off");
  await shot(page, "12-reading-album-1-expanded");
});

test("view copy: the demo's view is a view, read as defined, not stored", async ({ page, chinookView }) => {
  await page.goto(`${chinookView}/sqlite`);
  await expect(page.getByText("11 tables · 1 view")).toBeVisible();
  await page.getByRole("button", { name: /^InvoiceLineCustomer/ }).click();
  await expect(page.getByText("Table-only records: no durable per-row identity is inferred.", { exact: false })).toBeVisible();
  await shot(page, "20-view-structure");

  await page.goto(chinookView);
  await openRelation(page, "invoice_line_with_recorded_customer");
  await rowOf(page, "invoice_line_with_recorded_customer", "invoice:1").first().click();
  await expect(reader(page)).toContainText("output of view InvoiceLineCustomer for InvoiceLineId=1 — defined, not stored");
  await reader(page).getByText("Source metadata").click();
  await expect(reader(page)).toContainText("NOT part of");
  await expect(reader(page)).toContainText("JOIN Invoice AS invoice ON invoice.InvoiceId = line.InvoiceId");
  await expect(reader(page)).toContainText("not recorded");
  await shot(page, "21-view-reading-grounding");
});

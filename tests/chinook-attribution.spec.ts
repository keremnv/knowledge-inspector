/**
 * Chinook, live: evidence attribution on the real v1.4.5 file through the
 * real adapters and pages. No route mocking. Skips unless the demo data is
 * prepared (`python3 examples/chinook/prepare.py --view-copy`); each worker
 * checks at teardown that neither file changed.
 *
 * KI_ATTRIBUTION_SHOTS=<dir> saves the walkthrough screenshots.
 */
import { test as base, expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { prepared, serve, UPSTREAM, VIEW_COPY } from "./chinook-serve";

const SHOTS = process.env.KI_ATTRIBUTION_SHOTS;

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
  if (!SHOTS) return;
  await page.waitForTimeout(800); // let panel transitions settle
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

const reader = (page: Page) => page.locator(".node-reader .motion-swap__is");
const occurrences = (page: Page) => reader(page).locator(".world-occurrence");
const occurrence = (page: Page, id: string) =>
  reader(page).locator(`.world-occurrence[data-assertion-id="${id}"]`);
const scalar = (page: Page, id: string, role: string) =>
  occurrence(page, id).locator(".world__roles li")
    .filter({ has: page.locator("b").filter({ hasText: new RegExp(`^${role}$`) }) }).locator(":scope > span");
const api = <T = any>(page: Page, path: string) =>
  page.evaluate((p) => fetch(p).then((r) => r.json()), path) as Promise<T>;

async function open(page: Page, query: string, id: string) {
  // The finder is the empty field's door: start each subject from an empty field.
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  await page.getByRole("combobox").fill(query);
  const option = page.getByRole("option").filter({
    has: page.locator(".nodefind__anchor").filter({ hasText: new RegExp(`^${id}$`) }),
  });
  await expect(option).toBeVisible();
  await option.click();
  await expect(reader(page).locator("h2")).toBeVisible();
}

// Direct SQL, taken from the file with `PRAGMA query_only` and immutable=1:
//   SELECT TrackId, Composer, Milliseconds, UnitPrice FROM Track WHERE AlbumId = 1 ORDER BY TrackId
const ALBUM_1_TRACKS: [number, string, number, number][] = [1, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((id, i) => [
  id,
  "Angus Young, Malcolm Young, Brian Johnson",
  [343719, 205662, 233926, 210834, 203102, 263497, 199836, 263288, 205688, 270863][i],
  0.99,
]);

test("A: album:1 lists its ten track occurrences; none of their values is the album's", async ({ page, chinook }) => {
  await page.goto(chinook);
  await open(page, "album:1", "album:1");
  await expect(reader(page).locator("h2")).toHaveText("For Those About To Rock We Salute You");
  // The album's own source row, and nothing about tracks, in the identity header.
  await expect(reader(page).locator(".world-reader__brow")).toContainText("row AlbumId=1 in Album");
  await expect(reader(page).locator(".world-reader__brow")).not.toContainText("Angus Young");
  await expect(reader(page).locator(".world-reader__facts .world__roles")).toHaveCount(0);

  await expect(occurrences(page)).toHaveCount(10);
  const section = reader(page).locator('section[aria-label="track_on_album occurrences mentioning For Those About To Rock We Salute You"]');
  await expect(section).toContainText("10 of 10 occurrences shown.");
  await expect(reader(page)).toContainText("not recorded as properties of For Those About To Rock We Salute You");
  for (const [trackId, composer, milliseconds, price] of ALBUM_1_TRACKS) {
    const id = `track_on_album:${trackId}`;
    await expect(occurrence(page, id).locator("button")).toHaveText(id);
    await expect(occurrence(page, id).locator(".world-occurrence__meta")).toHaveText("this referent as album");
    await expect(scalar(page, id, "composer")).toHaveText(composer);
    await expect(scalar(page, id, "milliseconds")).toHaveText(String(milliseconds));
    await expect(scalar(page, id, "unit_price")).toHaveText(String(price));
    await expect(occurrence(page, id).locator(".world__roles li")).toHaveCount(3);
  }
  // 30 scalar values in all, across 10 occurrences: never 30 "album fields".
  await expect(reader(page).locator(".world-occurrence .world__roles li")).toHaveCount(30);
  // The API agrees field-for-field with the page, and every field names its occurrence.
  const referent = await api(page, "/world/referent?id=album:1");
  const fields = referent.fields.filter((f: { relation: string }) => f.relation === "track_on_album");
  expect(fields).toHaveLength(30);
  expect(new Set(fields.map((f: { assertion_id: string }) => f.assertion_id)).size).toBe(10);
  expect(fields.every((f: { referent_roles: string[] }) => f.referent_roles.join() === "album")).toBe(true);
  await shot(page, "after-album-1");
});

test("B: track:10 and track_on_album:10 are different things with different grounding", async ({ page, chinook }) => {
  await page.goto(chinook);
  await open(page, "track:10", "track:10");
  await expect(reader(page).locator("h2")).toHaveText("Evil Walks");
  await expect(reader(page).locator(".world-reader__brow")).toContainText("row TrackId=10 in Track");
  // Its two occurrences: the catalogue listing and one invoice line.
  await expect(occurrences(page)).toHaveCount(2);
  const listing = occurrence(page, "track_on_album:10");
  await expect(listing.locator(".world-occurrence__meta")).toHaveText("this referent as track");
  await expect(scalar(page, "track_on_album:10", "composer")).toHaveText("Angus Young, Malcolm Young, Brian Johnson");
  await expect(scalar(page, "track_on_album:10", "milliseconds")).toHaveText("263497");
  await expect(scalar(page, "track_on_album:10", "unit_price")).toHaveText("0.99");
  // The invoice line's price and quantity are the line's, listed under its own id.
  await expect(occurrence(page, "invoice_line_track:5").locator(".world-occurrence__meta")).toHaveText("this referent as track");
  await expect(scalar(page, "invoice_line_track:5", "quantity")).toHaveText("1");
  await shot(page, "after-track-10");

  const referent = await api(page, "/world/referent?id=track:10");
  const occurrenceReader = await api(page, "/world/assertion?id=track_on_album:10");
  expect(referent.id).toBe("track:10");
  expect(occurrenceReader.assertion_id).toBe("track_on_album:10");
  expect(referent.id).not.toBe(occurrenceReader.assertion_id);
  // The referent's grounding is its own row; the occurrence's adds how it was read.
  expect(referent.grounding[0].detail).toEqual({ source: "Track", key: { TrackId: 10 } });
  const detail = occurrenceReader.grounding[0].detail;
  expect(detail.key).toEqual({ TrackId: 10 });
  expect(detail.reference_participants.album).toMatchObject({ column: "AlbumId", value: 1, storage_class: "integer" });
  expect(detail.scalar_storage).toEqual({ Composer: "text", Milliseconds: "integer", UnitPrice: "real" });

  // Opening the occurrence reads the occurrence, and returns to the referent.
  await listing.getByRole("button", { name: "Open occurrence track_on_album:10" }).click();
  await expect(reader(page).locator("h2")).toHaveText("track_on_album");
  await expect(reader(page)).toContainText("row TrackId=10 in Track");
  await reader(page).getByRole("button", { name: /back/i }).click();
  await expect(reader(page).locator("h2")).toHaveText("Evil Walks");
});

test("C: an invoice line's values are the line's; a customer reference is not payment", async ({ page, chinookView }) => {
  await page.goto(chinookView);
  await open(page, "customer:2", "customer:2");
  await expect(reader(page).locator(".world-reader__brow")).toContainText("row CustomerId=2 in Customer");
  // Customer 2: 7 invoices, 38 invoice lines (direct SQL), all within the preview bound.
  await expect(occurrences(page)).toHaveCount(38);
  await expect(reader(page)).toContainText("38 of 38 occurrences shown.");
  await expect(reader(page).locator(".world-occurrence .world__roles li")).toHaveCount(76);
  await expect(occurrence(page, "invoice_line_with_recorded_customer:1").locator(".world-occurrence__meta"))
    .toHaveText("this referent as customer");
  await expect(scalar(page, "invoice_line_with_recorded_customer:1", "unit_price")).toHaveText("0.99");
  await expect(scalar(page, "invoice_line_with_recorded_customer:1", "quantity")).toHaveText("1");
  // Nothing in the reader turns the customer reference into a transaction claim.
  await expect(reader(page)).not.toContainText(/paid|payment received|purchased|bought|endorse/i);
  await shot(page, "after-customer-2");
  // The view's occurrences are defined, not stored, and say so.
  await occurrence(page, "invoice_line_with_recorded_customer:1")
    .getByRole("button", { name: "Open occurrence invoice_line_with_recorded_customer:1" }).click();
  await expect(reader(page)).toContainText("output of view InvoiceLineCustomer for InvoiceLineId=1 — defined, not stored");
  await reader(page).getByText("Source metadata").click();
  await expect(reader(page)).toContainText("lineage (source-reported)");
  await expect(reader(page)).toContainText("not recorded");
});

test("F: the reading says which label columns the reader declared and which are defaults", async ({ page, chinook }) => {
  await page.goto(chinook);
  const overview = await api(page, "/world/overview");
  const entities = Object.fromEntries(overview.reading.entities.map((e: { kind: string }) => [e.kind, e]));
  for (const kind of ["artist", "album", "track"]) {
    expect(entities[kind].label_column_source).toBe("declared");
  }
  expect(entities.invoice).toMatchObject({ label_column: "InvoiceId", label_column_source: "adapter_default" });
  // The declaration digest and World identity are untouched by the disclosure.
  expect(overview.reading.declaration_digest).toBe("06e00058e119869b92667a6c8526b00ed2daaec3cae5a605062f88d7c3a7d4f5");
  expect(overview.world_id).toMatch(/^chinook:[0-9a-f]{12}\+06e00058e119$/);

  // Visible on the dock before anything is opened, beside the names it qualifies.
  await expect(page.locator(".world-reading > summary"))
    .toHaveText("Reading attribution · reader-declared interpretation");
  await page.getByText("Reading attribution", { exact: true }).click();
  const body = page.locator(".world-reading__body");
  await expect(body.locator("li").filter({ hasText: "Declared namespace album" }))
    .toContainText("display-label column: Title (declared by the reader)");
  await expect(body.locator("li").filter({ hasText: "Declared namespace invoice" }))
    .toContainText("display-label column: InvoiceId (adapter default");
  await expect(body.locator("li").filter({ hasText: "Declared namespace invoice" }))
    .not.toContainText("declared by the reader");
  await shot(page, "after-reading-attribution");
  // Labels are what they were: an invoice's is its key, as text.
  expect((await api(page, "/world/labels?ids=invoice:1,album:1")).labels)
    .toEqual({ "invoice:1": "1", "album:1": "For Those About To Rock We Salute You" });
});

test("H: Chinook's column types are described, and the values are exactly as stored", async ({ page, chinook }) => {
  await page.goto(chinook);
  const { relations } = await api(page, "/world/schema");
  const role = (relation: string, name: string) =>
    relations.find((r: { name: string }) => r.name === relation).roles.find((r: { name: string }) => r.name === name);
  expect(role("track_on_album", "unit_price")).toMatchObject({
    type: "NUMERIC", type_basis: "sqlite_affinity", declared_type: "NUMERIC(10,2)", referent: false });
  expect(role("track_on_album", "milliseconds")).toMatchObject({ type: "INTEGER", declared_type: "INTEGER" });
  expect(role("track_on_album", "composer")).toMatchObject({ type: "TEXT", declared_type: "NVARCHAR(220)" });
  expect(role("invoice_line_track", "unit_price")).toMatchObject({ type: "NUMERIC", declared_type: "NUMERIC(10,2)" });
  expect(role("invoice_line_track", "quantity")).toMatchObject({ type: "INTEGER" });
  // A NUMERIC column holds what was stored: here, a REAL, served as the number 0.99.
  const found = await api(page, "/world/assertion?id=track_on_album:2");
  expect(found.values.unit_price).toBe(0.99);
  expect(found.values.composer).toBeNull();
  expect(found.grounding[0].detail.scalar_storage).toEqual({ Composer: "null", Milliseconds: "integer", UnitPrice: "real" });

  // The relation reader prints the declared type and SQLite's affinity, never "text" for a NUMERIC column.
  // A binary relation is drawn as its name on a filament; the label is the click target.
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__worldVocabulary))).toBe(true);
  await page.waitForTimeout(800);
  await page.mouse.click(728, 327);
  await expect(reader(page).locator("h2")).toHaveText("track_on_album");
  const type = (name: string) => reader(page).locator(".world__roles li")
    .filter({ has: page.locator("b").filter({ hasText: new RegExp(`^${name}$`) }) }).locator("span");
  await expect(type("unit_price")).toHaveText("declared NUMERIC(10,2) · numeric affinity");
  await expect(type("milliseconds")).toHaveText("declared INTEGER · integer affinity");
  await expect(type("composer")).toHaveText("declared NVARCHAR(220) · text affinity");
  await shot(page, "after-relation-track_on_album");
});

test("I: an album is not offered an expansion through a relation it is not in", async ({ page, chinook }) => {
  await page.goto(chinook);
  await open(page, "album:1", "album:1");
  const expand = reader(page).locator("section").filter({ has: page.getByRole("heading", { name: "expand through" }) });
  await expect(expand.getByRole("button", { name: /^album_listed_under_artist\s*1$/ })).toBeVisible();
  await expect(expand.getByRole("button", { name: /^track_on_album\s*10$/ })).toBeVisible();
  await expect(expand.getByRole("button", { name: /invoice_line_track/ })).toHaveCount(0);
  await expect(expand).toContainText("No recorded occurrences in this reading mention this referent: invoice_line_track.");
  // The API still reports the zero as a zero.
  const referent = await api(page, "/world/referent?id=album:1");
  expect(Object.fromEntries(referent.relations.map((r: { name: string; count: number }) => [r.name, r.count])))
    .toEqual({ album_listed_under_artist: 1, invoice_line_track: 0, track_on_album: 10 });
  await shot(page, "after-album-1-expand");
  // A track with exactly one invoice line is offered it, once.
  await open(page, "track:10", "track:10");
  await expect(reader(page).getByRole("button", { name: /^invoice_line_track\s*1$/ })).toBeVisible();
  await expect(reader(page).getByRole("button", { name: /^album_listed_under_artist/ })).toHaveCount(0);
});

import { chooseSourceTable as choose, settleSourceDocks } from "./source-navigation";
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveSource, fingerprint } from "./source-serve";
import { UPSTREAM, UPSTREAM_SHA256, VIEW_COPY, prepared } from "./chinook-serve";

const tables = (page: Page) => page.locator("#source-tables");
const reader = (page: Page) => page.locator("#source-reader > .motion-swap > .motion-swap__is");


async function captureSettledSource(page: Page, filename: string) {
  // Capture the completed presentation, never a transient double exposure.
  await expect(page.locator(".motion-swap__was")).toHaveCount(0);
  await expect.poll(() => page.locator(".motion-swap__is").evaluateAll((nodes) =>
    nodes.every((node) => getComputedStyle(node).opacity === "1"))).toBe(true);
  await page.screenshot({ path: join(process.env.KI_SOURCE_SHOTS!, filename) });
}

for (const motion of ["reduce", "no-preference"] as const) {
  test(`J0: declaration-free Chinook through real HTTP, ${motion} motion`, async ({ page }) => {
    test.skip(!prepared(), "Run python3 examples/chinook/prepare.py --view-copy");
    await page.emulateMedia({ reducedMotion: motion });
    expect((await fingerprint(UPSTREAM)).sha256).toBe(UPSTREAM_SHA256);
    await serveSource(UPSTREAM, async ({ origin, requests }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}${process.env.KI_SOURCE_ENTRY === "1" ? "/" : "/source"}?placement=explicit`);
      await expect(tables(page).getByText("11 tables · 0 views")).toBeVisible();
      // The empty canvas shows the schema, as World's default screen shows its vocabulary (O12).
      await expect(page.locator(".source-schema")).toHaveAttribute("data-schema-tables", "11");
      await expect(page.locator(".source-canvas > .source-layer:not(.source-schema) canvas")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /show on canvas/ })).toHaveCount(0);
      if (process.env.KI_SOURCE_SHOTS && motion === "reduce") {
        await mkdir(process.env.KI_SOURCE_SHOTS, { recursive: true });
        await captureSettledSource(page, "cold-start.png");
      }
      const track = tables(page).getByRole("button", { name: "Track table", exact: true });
      await track.focus();
      await page.keyboard.press("Enter");
      await expect(reader(page).locator("h2")).toBeFocused();
      await expect(reader(page).locator(".source-columns dt").first()).toContainText("TrackId");
      for (const text of ["MediaTypeId → MediaType.MediaTypeId", "GenreId → Genre.GenreId", "AlbumId → Album.AlbumId"]) {
        await expect(reader(page).getByText(text, { exact: true })).toBeVisible();
      }
      await expect(tables(page).getByRole("button", { name: "Inspect row 10", exact: true })).toBeVisible();
      if (process.env.KI_SOURCE_SHOTS && motion === "reduce") await captureSettledSource(page, "track-schema.png");
      const row = tables(page).getByRole("row").filter({ has: page.getByRole("button", { name: "Inspect row 10", exact: true }) });
      await expect(row).toContainText('"Evil Walks"');
      await tables(page).getByRole("button", { name: "Inspect row 10", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(reader(page).locator("h2")).toBeFocused();
      await expect(reader(page).locator(".source-cells").getByText('"Evil Walks"', { exact: true })).toBeVisible();
      // The caption is a separate phrase to assistive technology, not a run-on.
      await expect(reader(page).locator("h2")).toHaveAccessibleName(/^Track\s*, TrackId=10$/);
      // The table owns the dock; its catalogue no longer takes row space.
      await expect(page.locator(".source-catalogue")).toHaveCount(0);
      expect(await page.locator(".source-row-scroll").evaluate((node) => node.clientHeight)).toBeGreaterThan(600);
      await reader(page).getByText("identity details", { exact: true }).click();
      await expect(reader(page)).toContainText("not independent factual verification");
      await expect(reader(page).locator("code").filter({ hasText: /^sr1:/ })).toBeVisible();
      await reader(page).getByText("value details", { exact: true }).click();
      await expect(reader(page).getByText(/binary64 bits/)).toBeVisible();
      // Resize follows the existing dock keyboard convention and retains focus.
      const divider = page.getByRole("separator", { name: "Resize reader" });
      await divider.focus();
      const width = Number(await divider.getAttribute("aria-valuenow"));
      await page.keyboard.press("ArrowLeft");
      await expect.poll(async () => Number(await divider.getAttribute("aria-valuenow"))).toBeGreaterThan(width);
      await expect(divider).toBeFocused();
      await choose(page, "Album");
      await expect(reader(page)).not.toContainText("Evil Walks");
      await expect(tables(page).getByRole("row").first()).toContainText("AlbumId");
      await choose(page, "Track");
      await expect(reader(page)).not.toContainText("Evil Walks");
      await expect(tables(page).getByRole("button", { name: "Inspect row 10", exact: true })).toHaveAttribute("aria-pressed", "false");
      await tables(page).getByRole("button", { name: "Inspect row 10", exact: true }).click();
      await expect(reader(page)).toContainText("Evil Walks");
      await choose(page, "PlaylistTrack");
      await expect(reader(page).getByText("key · PlaylistId + TrackId", { exact: true })).toBeVisible();
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
      await expect(reader(page).locator(".source-cells dt")).toHaveText(["PlaylistIdkey", "TrackIdkey"]);
      await expect(reader(page).locator(".world-reader__heading > p")).toHaveText("PlaylistId=1; TrackId=1");
      // Closing the reader from the keyboard returns to the selected row.
      await reader(page).getByRole("button", { name: "close", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(tables(page).getByRole("button", { name: "Inspect row 1", exact: true })).toBeFocused();
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).press("Enter");
      await expect(reader(page).locator("h2")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(tables(page).getByRole("button", { name: "Inspect row 1", exact: true })).toBeFocused();
      const reads = requests.filter((url) => !url.pathname.endsWith("/session"));
      expect(reads.length).toBeGreaterThan(10);
      const session = reads[0].searchParams.get("session");
      const generation = reads[0].searchParams.get("generation");
      expect(session).toMatch(/^ses1_/);
      expect(generation).toBeTruthy();
      for (const url of reads) {
        expect(url.searchParams.getAll("session")).toEqual([session]);
        expect(url.searchParams.getAll("generation")).toEqual([generation]);
      }
      expect(requests.some((url) => url.pathname.endsWith("/record"))).toBe(true);
      expect(requests.some((url) => url.pathname.endsWith("/references"))).toBe(true);
      expect(requests.some((url) => /reference$|refresh/.test(url.pathname))).toBe(false);
      expect(errors).toEqual([]);
      if (process.env.KI_SOURCE_SHOTS) {
        await mkdir(process.env.KI_SOURCE_SHOTS, { recursive: true });
        await choose(page, "Track");
        await tables(page).getByRole("button", { name: "Inspect row 10", exact: true }).click();
        await expect(reader(page)).toContainText("Evil Walks");
        await captureSettledSource(page, `j0-${motion}.png`);
      }
    });
  });
}

const DDL = `
CREATE TABLE Empty(id INTEGER PRIMARY KEY);
CREATE TABLE Keyless(v);
INSERT INTO Keyless VALUES(NULL),(''),('NULL'),(9223372036854775807),(0.1),(x'00ff'),('same'),('same');
CREATE TABLE Generated(id INTEGER PRIMARY KEY, v INTEGER, twice INTEGER GENERATED ALWAYS AS(v*2) VIRTUAL, label TEXT GENERATED ALWAYS AS('item-'||id) STORED);
INSERT INTO Generated(id,v) VALUES(1,3);
CREATE TABLE BlobKey(k BLOB PRIMARY KEY); INSERT INTO BlobKey VALUES(x'31');
CREATE TABLE Nullable(k TEXT PRIMARY KEY); INSERT INTO Nullable VALUES(NULL);
CREATE TABLE Paged(id INTEGER PRIMARY KEY); WITH RECURSIVE n(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<51) INSERT INTO Paged SELECT i FROM n;
CREATE VIEW Computed AS SELECT v FROM Keyless;
`;

async function fixture(use: (db: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "ki-source-ui-"));
  const db = join(directory, "fixture.sqlite");
  try {
    execFileSync("python3", ["-c", "import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); d.executescript(sys.argv[2]); d.commit(); d.close()", db, DDL]);
    await use(db);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("real fixture: empty, keyless, mixed values, generated columns, invalid and unsupported identities, pagination", async ({ page }) => {
  await fixture(async (db) => serveSource(db, async ({ origin, requests }) => {
    await page.goto(`${origin}/source`);
    await choose(page, "Empty");
    await expect(tables(page)).toContainText("no rows on this page");
    await expect(tables(page).getByRole("button", { name: "next rows" })).toBeDisabled();
    await choose(page, "Keyless");
    await expect(tables(page)).toContainText("no primary key");
    for (const [index, text] of [[1, "NULL"], [2, '""'], [3, '"NULL"'], [4, "9223372036854775807"], [5, "0.1"], [6, "BLOB · 2 bytes · preview only"]] as const) {
      await tables(page).getByRole("button", { name: `Inspect row ${index}`, exact: true }).click();
      await expect(reader(page).locator(".source-cells code").first()).toHaveText(text);
      await expect(reader(page)).toContainText("No registered source handle");
    }
    await expect(reader(page)).toContainText("not a complete recoverable value");
    expect(requests.filter((url) => url.pathname.endsWith("/record"))).toHaveLength(0);
    await tables(page).getByRole("button", { name: "Inspect row 5", exact: true }).click();
    await expect(reader(page)).toContainText("3fb999999999999a");
    await choose(page, "Generated");
    await expect(reader(page)).toContainText("generated VIRTUAL");
    await expect(reader(page)).toContainText("generated STORED");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await expect(reader(page)).toContainText('"item-1"');
    await choose(page, "BlobKey");
    await expect(tables(page)).toContainText("key type unsupported");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await expect(reader(page)).toContainText("No registered source handle");
    await choose(page, "Nullable");
    await expect(tables(page)).toContainText("primary key contains NULL");
    await choose(page, "Paged");
    await expect(tables(page)).toContainText("rows 1–50 · more available");
    await tables(page).getByRole("button", { name: "next rows" }).focus();
    await page.keyboard.press("Enter");
    await expect(tables(page)).toContainText("rows 51–51 · end");
    await expect(tables(page).getByRole("button", { name: "next rows" })).toBeDisabled();
    await expect(tables(page).getByRole("button", { name: "next rows" })).toBeFocused();
    await expect(page.locator("body")).not.toBeFocused();
    await tables(page).getByRole("button", { name: "previous rows" }).click();
    await expect(tables(page)).toContainText("rows 1–50 · more available");
    await choose(page, "Computed", "view");
    await expect(reader(page)).toContainText("computed view output");
    await reader(page).getByText("schema details", { exact: true }).click();
    await expect(reader(page).locator("pre")).toContainText("CREATE VIEW Computed AS SELECT v FROM Keyless");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await expect(reader(page)).toContainText("this page only");
  }));
});

test("real fixture: verification budget preserves readable table-window rows", async ({ page }) => {
  await fixture(async (db) => serveSource(db, async ({ origin }) => {
    await page.goto(`${origin}/source`);
    await choose(page, "Paged");
    await expect(tables(page)).toContainText("key verification incomplete");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await expect(reader(page)).toContainText("No registered source handle");
  }, { verify_rows: 1 }));
});

for (const command of ["retire", "delete", "damage"]) {
  test(`real HTTP: ${command} stops reads without a new session or producer fallback`, async ({ page }) => {
    await fixture(async (db) => serveSource(db, async ({ origin, commands, requests }) => {
      await page.goto(`${origin}/source`);
      await choose(page, "Paged");
      await expect(tables(page)).toContainText("rows 1–50");
      await commands(command);
      const bootstraps = requests.filter((url) => url.pathname.endsWith("/session")).length;
      await tables(page).getByRole("button", { name: "next rows" }).click();
      await expect(page.getByRole("heading", { name: "source reads stopped" })).toBeVisible();
      await expect(page.getByRole("alert")).toContainText(command === "retire" ? "This source session has ended" : "The private capture of the file is missing, changed or unreadable");
      await expect(page.locator("#source-reader")).toHaveCount(0);
      expect(requests.filter((url) => url.pathname.endsWith("/session"))).toHaveLength(bootstraps);
    }));
  });
}

test("real Chinook view copy stays computed and table-only", async ({ page }) => {
  test.skip(!prepared(), "Run python3 examples/chinook/prepare.py --view-copy");
  await serveSource(VIEW_COPY, async ({ origin }) => {
    await page.goto(`${origin}/source`);
    await tables(page).getByRole("button", { name: "InvoiceLineCustomer view", exact: true }).click();
    await expect(tables(page)).toContainText("computed view output");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await expect(reader(page)).toContainText("this page only");
  });
});

test("source docks remain usable on a narrow dark desktop", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.emulateMedia({ colorScheme: "dark" });
  await fixture(async (db) => serveSource(db, async ({ origin }) => {
    await page.goto(`${origin}/source`);
    await choose(page, "Generated");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await expect(reader(page)).toContainText('"item-1"');
    await settleSourceDocks(page);
    const boxes = await page.locator(".ov.is-open .ov__body").evaluateAll((nodes) => nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width };
    }));
    expect(boxes).toHaveLength(2);
    expect(boxes[0].right).toBeLessThanOrEqual(boxes[1].left);
    for (const box of boxes) { expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(900); expect(box.width).toBeGreaterThan(250); }
    await expect(page.locator("main.source-workspace")).toHaveClass(/is-dark/);
    await reader(page).getByRole("button", { name: "close", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(tables(page).getByRole("button", { name: "Inspect row 1", exact: true })).toBeFocused();
  }));
});

for (const motion of ["reduce", "no-preference"] as const) {
  test(`real HTTP source transitions never restart outgoing row/record reads (${motion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: motion });
    await fixture(async (db) => serveSource(db, async ({ origin, requests }) => {
      await page.goto(`${origin}/source`);
      for (const table of ["Generated", "Paged", "Generated"]) {
        await choose(page, table);
        await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
        await expect(reader(page).locator(".world-reader__heading > p")).toHaveText("id=1");
        await expect(reader(page).locator(".source-cells code").first()).toHaveText("1");
        await expect(page.locator(".motion-swap__was")).toHaveCount(0);
      }
      const reads = requests.filter((url) => url.pathname.endsWith("/record")).map((url) => url.searchParams.get("id"));
      expect(reads).toHaveLength(3);
      expect(reads[0]).toBe(reads[2]); expect(reads[0]).not.toBe(reads[1]);
      expect(requests.filter((url) => url.pathname.endsWith("/rows")).map((url) => url.searchParams.get("table"))).toEqual(["Generated", "Paged", "Generated"]);
    }));
  });
}

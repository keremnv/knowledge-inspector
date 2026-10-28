import { openSourceReferences } from "./canvas-parity";
/** Product-correction acceptance on the real captured-source adapter. */
import { test, expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serveSource } from "./source-serve";
import { UPSTREAM, prepared } from "./chinook-serve";
import { chooseSourceTable, settleSourceDocks } from "./source-navigation";

const tables = (p: Page) => p.locator('#source-tables .source-table-slot > .motion-swap > .motion-swap__is');
const reader = (p: Page) => p.locator('#source-reader > .motion-swap > .motion-swap__is');
const field = (p: Page) => p.locator('.source-field-list');
async function shot(p: Page, name: string) {
  if (!process.env.KI_UX_SHOTS) return;
  await mkdir(process.env.KI_UX_SHOTS, { recursive: true });
  await expect(p.locator('.motion-swap__was')).toHaveCount(0);
  await p.evaluate(() => document.fonts.ready);
  await settleSourceDocks(p);
  await p.screenshot({ path: join(process.env.KI_UX_SHOTS, `${name}.png`) });
}
for (const motion of ["reduce", "no-preference"] as const) {
  for (const width of [1440, 1000, 900]) {
    test(`simple investigation, Back and independent retention at ${width}px (${motion})`, async ({ page }) => {
      test.skip(!prepared(), "Prepare pinned Chinook first");
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ reducedMotion: motion });
      await serveSource(UPSTREAM, async ({ origin, requests }) => {
        await page.goto(`${origin}/source?placement=explicit`);
        await expect(tables(page).getByRole('heading', { name: 'tables', exact: true })).toBeVisible();
        await expect(page.locator('[data-overlay="source-reader"]')).not.toHaveClass(/is-open/);
        await expect(page.getByPlaceholder('find...')).toHaveCount(0);
        const bootstraps = requests.filter((url) => url.pathname.endsWith('/session')).length;
        await shot(page, `${width}-opening-${motion}`);
        await chooseSourceTable(page, 'Track');
        await expect(tables(page).getByRole('searchbox', { name: 'filter Track', exact: true })).toBeVisible();
        await expect(page.locator('.source-catalogue')).toHaveCount(0);
        await expect(tables(page).getByRole('combobox', { name: 'lookup mode' })).toHaveCount(0);
        await expect(reader(page).locator('.source-columns')).toContainText('NVARCHAR(200)');
        await shot(page, `${width}-schema-${motion}`);
        const input = tables(page).getByRole('searchbox');
        await input.fill('Evil Walks'); await input.press('Enter');
        await tables(page).getByRole('button', { name: 'Inspect row 1', exact: true }).press('Enter');
        await expect(reader(page).locator('h2')).toHaveAccessibleName(/^Track\s*, TrackId=10$/);
        await expect(reader(page).locator('h2')).toBeFocused();
        await expect(reader(page).locator('.source-cells')).toContainText('Evil Walks');
        await expect(reader(page).getByRole('heading', { name: 'Recorded key' })).toHaveCount(0);
        await expect(reader(page).getByText('Declared primary key verified for source addressing in this capture.')).not.toBeVisible();
        await settleSourceDocks(page);
        const geometry = await page.locator('.source-row-scroll').evaluate((el) => {
          const box = el.getBoundingClientRect();
          const t = document.querySelector('[data-overlay="source-tables"] .ov__body')!.getBoundingClientRect();
          const r = document.querySelector('[data-overlay="source-reader"] .ov__body')!.getBoundingClientRect();
          return { rowHeight: box.height, rowTop: box.top, tablesWidth: t.width, readerWidth: r.width, canvasWidth: r.left - t.right };
        });
        expect(geometry.rowHeight).toBeGreaterThan(650);
        expect(geometry.canvasWidth).toBeGreaterThanOrEqual(319);
        await shot(page, `${width}-record-${motion}`);
        await tables(page).locator('[data-table-info]').press('Enter');
        await expect(reader(page).locator('h2')).toHaveAccessibleName(/^Track\s*, table$/);
        await reader(page).getByRole('button', { name: 'Back', exact: true }).press('Enter');
        await expect(reader(page).locator('h2')).toHaveAccessibleName(/^Track\s*, TrackId=10$/);
        await reader(page).getByRole('button', { name: 'show on canvas', exact: true }).press('Enter');
        await expect(field(page).locator('[data-field-record]')).toHaveCount(1);
        const album = reader(page).locator('.source-outgoing article').filter({ hasText: '→ Album' });
        await openSourceReferences(page); await album.getByRole('button', { name: /inspect FK/ }).press('Enter');
        await expect(reader(page).locator('[data-reference-status]')).toHaveText('resolved');
        await expect(reader(page).getByText('reference details', { exact: true })).toBeVisible();
        await expect(reader(page).locator('.source-reference-pairs')).not.toBeVisible();
        await shot(page, `${width}-reference-${motion}`);
        await reader(page).getByRole('button', { name: 'show connection', exact: true }).press('Enter');
        await expect(field(page).locator('[data-field-reference]')).toHaveCount(1);
        await expect(field(page).locator('[data-field-record]')).toHaveCount(2);
        await reader(page).getByRole('button', { name: 'open referenced record' }).press('Enter');
        await expect(reader(page).locator('h2')).toHaveAccessibleName(/^Album\s*, AlbumId=1$/);
        await expect(reader(page).getByRole('button', { name: 'reveal', exact: true })).toBeVisible();
        await reader(page).getByRole('button', { name: 'Back', exact: true }).press('Enter');
        await reader(page).getByRole('button', { name: 'hide connection' }).press('Enter');
        await expect(field(page).locator('[data-field-reference]')).toHaveCount(0);
        await expect(field(page).locator('[data-field-record]')).toHaveText(['Track 10', 'Album 1']);
        await reader(page).getByRole('button', { name: 'Back', exact: true }).press('Enter');
        await expect(reader(page).locator('h2')).toHaveAccessibleName(/^Track\s*, TrackId=10$/);
        await tables(page).locator('[data-catalogue]').press('Enter');
        await expect(tables(page).getByRole('button', { name: 'resume Track' })).toBeVisible();
        await expect(reader(page).locator('h2')).toHaveAccessibleName(/^Track\s*, TrackId=10$/);
        await tables(page).getByRole('button', { name: 'Album table', exact: true }).press('Enter');
        await expect(tables(page).locator('h2')).toHaveText('Album');
        await tables(page).getByRole('button', { name: 'back to previous table' }).press('Enter');
        await expect(input).toHaveValue('Evil Walks');
        await expect(tables(page).getByRole('button', { name: 'Inspect row 1', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await expect(reader(page).locator('h2')).toHaveAccessibleName(/^Track\s*, TrackId=10$/);
        await expect(field(page).locator('[data-field-record]')).toHaveCount(2);
        await shot(page, `${width}-back-${motion}`);
        if (process.env.KI_UX_SHOTS) await writeFile(join(process.env.KI_UX_SHOTS, `${width}-geometry-${motion}.json`), JSON.stringify(geometry, null, 2));
        const filters = requests.filter((url) => url.pathname.endsWith('/search'));
        expect(filters.length).toBeGreaterThan(0);
        expect(filters.every((url) => url.searchParams.get('table') === 'Track' && url.searchParams.get('text') === 'Evil Walks')).toBe(true);
        expect(requests.filter((url) => url.pathname.endsWith('/session'))).toHaveLength(bootstraps);
      });
    });
  }
}

// Same keyless / nullable / BLOB-key cases as source-live, and the dangling
// constraint from source-references-live, through the actual SQLite adapter.
for (const width of [1440, 1000, 900]) {
  test(`exceptional rows and dangling references stay explicit at ${width}px`, async ({ page }) => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { execFileSync } = await import('node:child_process');
    const dir = await mkdtemp(join(tmpdir(), 'ki-ux-exceptions-')), db = join(dir, 'source.sqlite');
    execFileSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.executescript("""
CREATE TABLE Keyless(v); INSERT INTO Keyless VALUES(''),(NULL),('NULL');
CREATE TABLE Nullable(k TEXT PRIMARY KEY); INSERT INTO Nullable VALUES(NULL);
CREATE TABLE BlobKey(k BLOB PRIMARY KEY); INSERT INTO BlobKey VALUES(x'31');
CREATE TABLE Parent(id INTEGER PRIMARY KEY);
CREATE TABLE Dangling(id INTEGER PRIMARY KEY,p REFERENCES Parent(id)); INSERT INTO Dangling VALUES(1,999);
""");c.close()`, db]);
    try {
      await page.setViewportSize({ width, height: 1000 });
      await serveSource(db, async ({ origin, requests }) => {
        await page.goto(`${origin}/source?placement=explicit`);
        for (const [table, limitation] of [['Keyless','no primary key'],['Nullable','primary key contains NULL'],['BlobKey','key type unsupported']]) {
          await chooseSourceTable(page, table);
          await tables(page).getByRole('button', { name: 'Inspect row 1', exact: true }).press('Enter');
          await expect(reader(page).locator('.source-placement--unavailable')).toContainText(limitation);
          await expect(reader(page).locator('[data-placement="show"]')).toHaveCount(0);
          await expect(reader(page).locator('.source-cells')).toBeVisible();
          await expect(reader(page).getByText('identity details', { exact: true })).toBeVisible();
          await shot(page, `${width}-fixture-${table}`);
          if (table === 'Keyless') {
            await tables(page).locator('[data-table-info]').click();
            await chooseSourceTable(page, 'Nullable');
            await tables(page).getByRole('button', { name: 'back to previous table' }).click();
            await expect(tables(page).locator('h2')).toHaveText('Keyless');
            await expect(reader(page).locator('.source-cells')).toHaveCount(0);
            await expect(reader(page).getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
          }
        }
        expect(requests.some((url) => url.pathname.endsWith('/record'))).toBe(false);
        await chooseSourceTable(page, 'Dangling');
        await tables(page).getByRole('button', { name: 'Inspect row 1', exact: true }).press('Enter');
        await openSourceReferences(page); await reader(page).getByRole('button', { name: 'inspect FK 0 reference' }).press('Enter');
        await expect(reader(page).locator('[data-reference-status]')).toHaveText('no matching record in this capture');
        await expect(reader(page).getByRole('button', { name: 'open referenced record' })).toHaveCount(0);
        await expect(reader(page).getByRole('button', { name: 'show connection' })).toHaveCount(0);
        await expect(reader(page).getByText('reference details', { exact: true })).toBeVisible();
        await shot(page, `${width}-fixture-Dangling`);
        await expect(page.locator('.source-canvas > .source-layer:not(.source-schema) canvas')).toHaveCount(0);
      });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

// Below the desktop widths, keyboard travel must reveal the destination dock.
for (const motion of ["reduce", "no-preference"] as const) {
  test(`compact catalogue travel and resume keep live focus (${motion})`, async ({ page }) => {
    test.skip(!prepared(), "Prepare pinned Chinook first");
    await page.setViewportSize({ width: 760, height: 1000 });
    await page.emulateMedia({ reducedMotion: motion });
    await serveSource(UPSTREAM, async ({ origin }) => {
      await page.goto(`${origin}/source?placement=explicit`);
      await tables(page).getByRole('button', { name: 'Track table', exact: true }).press('Enter');
      await expect(reader(page).locator('h2')).toBeFocused();
      await expect(reader(page).locator('h2')).toBeInViewport();
      await page.keyboard.press('Escape');
      await expect(tables(page).locator('h2')).toBeFocused();
      await tables(page).locator('[data-catalogue]').press('Enter');
      await tables(page).getByRole('button', { name: 'resume Track' }).press('Enter');
      await expect(tables(page).locator('h2')).toBeFocused();
      await tables(page).locator('[data-catalogue]').press('Enter');
      await tables(page).getByRole('button', { name: 'Track table', exact: true }).press('Enter');
      await expect(tables(page).locator('h2')).toBeFocused();
      await tables(page).getByRole('button', { name: 'Inspect row 10', exact: true }).press('Enter');
      await expect(reader(page).locator('h2')).toHaveAccessibleName(/^Track\s*, TrackId=10$/);
      await expect(reader(page).locator('h2')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(tables(page).getByRole('button', { name: 'Inspect row 10', exact: true })).toBeFocused();
      await tables(page).locator('[data-catalogue]').press('Enter');
      await tables(page).getByRole('button', { name: 'Album table', exact: true }).press('Enter');
      await expect(reader(page).locator('h2')).toBeFocused();
      await page.keyboard.press('Escape');
      await tables(page).getByRole('button', { name: 'back to previous table' }).press('Enter');
      await expect(tables(page).locator('h2')).toHaveText('Track');
      await expect(tables(page).locator('h2')).toBeFocused();
      await expect(tables(page).getByRole('button', { name: 'Inspect row 10', exact: true })).toHaveAttribute('aria-pressed', 'true');
    });
  });
}

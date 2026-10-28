/** Thin UI drivers and read-only renderer observations. Domain identities are
 * never translated between Source records and declared Reading referents. */
import { expect, type Page } from '@playwright/test';
import { chooseSourceTable } from './source-navigation';
export type CanvasContext = 'source' | 'world' | 'schema';
export const sourceReader = (page: Page) => page.locator('#source-reader > .motion-swap > .motion-swap__is');
export const sourceTable = (page: Page) => page.locator('#source-tables .source-table-slot > .motion-swap > .motion-swap__is');
export const sourceList = (page: Page) => page.locator('.source-field-list');

export async function canvasState(page: Page, context: CanvasContext = 'source') {
  return page.evaluate((context) => {
    const g = (window as any)[({ source: '__sourceFieldGraph', world: '__worldFieldGraph', schema: '__sourceSchemaGraph' } as Record<string, string>)[context]];
    if (!g) return { nodes: [], edges: [], zoom: 1, camera: [], contact: null };
    const path = (id: string) => g.context.element.getElement(id)?.getShape('key')?.attributes?.d;
    return {
      nodes: g.getNodeData().map((n: any) => ({ id: n.id, type: n.type, at: g.getElementPosition(n.id), style: n.style })),
      edges: g.getEdgeData().map((e: any) => ({ id: e.id, source: e.source, target: e.target, type: e.type, style: e.style, path: path(e.id) })),
      zoom: g.getZoom(), camera: g.getCanvas().getCamera().getPosition(),
      contact: document.querySelector('[data-contact-phase]')?.getAttribute('data-contact-phase'),
    };
  }, context);
}
export async function canvasRest(page: Page, context: CanvasContext = 'source', count?: number) {
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(async () => {
    const s = await canvasState(page, context);
    return (count === undefined || s.nodes.length === count) && s.nodes.length > 0 &&
      s.nodes.every((n: any) => n.style.size === 90 && n.style.opacity === 1 && n.at.every(Number.isFinite));
  }).toBe(true);
  await expect(page.locator('.motion-swap__was')).toHaveCount(0);
  await page.evaluate((context) => new Promise<void>((resolve, reject) => {
    let last = '', still = 0;
    const start = performance.now();
    const tick = () => {
      const g = (window as any)[({ source: '__sourceFieldGraph', world: '__worldFieldGraph', schema: '__sourceSchemaGraph' } as Record<string, string>)[context]];
      const snapshot = JSON.stringify([g?.getZoom(), g?.getCanvas().getCamera().getPosition(),
        g?.getNodeData().map((n: any) => [n.id, n.style.x, n.style.y, n.style.size, n.style.opacity]),
        g?.getEdgeData().map((e: any) => [e.id, e.style.labelOpacity, e.style.labelOffsetX, e.style.labelOffsetY,
          g.context.element.getElement(e.id)?.getShape('key')?.attributes?.d]),
        [...document.querySelectorAll('.ov__body,.ov__handle,.ants__mark')].map((el) => {
          const b = el.getBoundingClientRect(); return [b.x, b.y, b.width, b.height];
        })]);
      still = snapshot === last ? still + 1 : 0; last = snapshot;
      if (still >= 10) return resolve();
      if (performance.now() - start > 10000) return reject(Error('Canvas/camera/docks did not settle'));
      requestAnimationFrame(tick);
    }; requestAnimationFrame(tick);
  }), context);
}
export async function canvasPoint(page: Page, id: string, label = false, context: CanvasContext = 'source') {
  return page.evaluate(({ id, label, context }) => {
    const g = (window as any)[({ source: '__sourceFieldGraph', world: '__worldFieldGraph', schema: '__sourceSchemaGraph' } as Record<string, string>)[context]];
    let at = g.getElementPosition(id);
    if (label) {
      const box = g.context.element.getElement(id).getShape('label').getRenderBounds();
      at = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2];
    }
    const client = g.getClientByCanvas(at);
    return { x: client[0], y: client[1] };
  }, { id, label, context });
}
export async function closeCanvasDocks(page: Page, context: CanvasContext = 'source') {
  for (const panel of ['reader', 'tables']) {
    const overlay = page.locator(`[data-overlay="${context === 'world' ? 'world' : 'source'}-${panel}"]`);
    if (await overlay.evaluate((el) => el.classList.contains('is-open'))) {
      await overlay.locator('.motion-swap__is').getByRole('button', { name: 'close', exact: true }).first().click();
    }
  }
  await canvasRest(page, context);
}
/**
 * Start the next visit with no remembered canvas (O8.8 keeps one per capture).
 * The leaving page may still have a debounced write pending, so it is also
 * stopped from writing Source keys again before it goes.
 */
export async function forgetSourceCanvas(page: Page, origin: string) {
  if (!page.url().startsWith(origin)) return;
  await page.evaluate(() => {
    const ours = (key: string) => /^ki\.source\.(field|naming|show):|^worldir\.camera:field:source:/.test(key);
    for (const key of Object.keys(sessionStorage)) if (ours(key)) sessionStorage.removeItem(key);
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) { if (!ours(String(key))) set.call(this, key, value); };
  });
}
export async function sourceRecord(page: Page, origin: string, table: string, row = 1, query = '') {
  await forgetSourceCanvas(page, origin);
  await page.goto(`${origin}/source${query}`);
  await chooseSourceTable(page, table);
  await sourceTable(page).getByRole('button', { name: `Inspect row ${row}`, exact: true }).press('Enter');
  await sourceReader(page).locator('[data-placement="show"]').click();
  await canvasRest(page, 'source', 1);
}
export async function showSourceReference(page: Page, index: number) {
  await openSourceReferences(page); await sourceReader(page).locator('.source-outgoing article').nth(index).getByRole('button', { name: /inspect FK/ }).click();
  await sourceReader(page).locator('[data-reference-show]').click();
  await expect(sourceReader(page).getByRole('button', { name: 'hide connection', exact: true })).toBeVisible();
}

export class SourceCanvasDriver {
  readonly context = 'source' as const;
  readonly recordId = 'record-1';
  constructor(readonly page: Page, readonly origin: string) {}
  reader() { return sourceReader(this.page); }
  // Named by Name, as World names a track (O17: chosen in the table's header).
  async place() { await sourceRecord(this.page, this.origin, 'Track', 10); await nameRecordsBy(this.page, 'Track', 'Name'); }
  async connect() {
    await openSourceReferences(this.page);
    await this.reader().locator('.source-outgoing article').filter({ hasText: '→ Album' }).getByRole('button', { name: /inspect FK/ }).click();
    await this.reader().locator('[data-reference-show]').click();
    await canvasRest(this.page, this.context, 2);
  }
  async selectRecord() { await sourceList(this.page).getByRole('button', { name: 'Evil Walks', exact: true }).press('Enter'); }
  async hideConnection() { await this.reader().getByRole('button', { name: 'hide connection', exact: true }).click(); }
}
export class ReadingCanvasDriver {
  readonly context = 'world' as const;
  readonly recordId = 'track:10';
  constructor(readonly page: Page, readonly origin: string) {}
  reader() { return this.page.locator('#world-reader .motion-swap__is'); }
  async place() {
    await this.page.goto(`${this.origin}/world`);
    const finder = this.page.getByRole('combobox', { name: 'Find a referent or field occurrence' });
    await finder.fill(this.recordId);
    await expect(this.page.getByRole('option').first()).toBeVisible(); await finder.press('Enter');
    await canvasRest(this.page, this.context, 1);
  }
  async connect() {
    await this.reader().locator('.gm__list button').filter({ hasText: 'track_on_album' }).first().click();
    await canvasRest(this.page, this.context, 2);
  }
  async selectRecord() {
    const finder = this.page.getByRole('combobox', { name: 'Find a referent or field occurrence' });
    await finder.fill(this.recordId);
    await expect(this.page.getByRole('option').first()).toBeVisible(); await finder.press('Enter');
  }
}
/**
 * The Reader's declared references wait behind a closed disclosure (the owner
 * hid the section, O14): open it before reaching into it. Stays open once open.
 */
export async function openSourceReferences(page: Page) {
  // The live Reader only, as `sourceReader` scopes it: a loose descendant match
  // also finds the copy a swap keeps for its exit.
  const disclosure = sourceReader(page).locator('details.source-references');
  // Retried as one step: a Reader mid-swap can hand the check one element and
  // the click the next.
  await expect(async () => {
    if (!(await disclosure.evaluate((el) => (el as HTMLDetailsElement).open))) await disclosure.locator(':scope > summary').click();
    await expect(disclosure).toHaveAttribute('open', '', { timeout: 1000 });
  }).toPass({ timeout: 10_000 });
}

/** Name a table's records by one of its columns, from the table's header (O17). */
export async function nameRecordsBy(page: Page, table: string, column: string) {
  await sourceTable(page).getByRole('combobox', { name: `name ${table} records by` }).selectOption(column);
}

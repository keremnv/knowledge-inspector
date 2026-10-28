import { test as base, expect, type Page, type Locator } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepared, serve, UPSTREAM } from './chinook-serve';
import { FixtureWorld } from './keyboard-world';

const test = base.extend<{}, { chinook: string }>({
  chinook: [async ({}, use) => { await serve(UPSTREAM, 'examples/chinook/declaration.json', use); }, { scope: 'worker' }],
});
const reader = (page: Page) => page.locator('#world-reader .motion-swap__is');
const table = (page: Page) => page.locator('#world-tables .motion-swap__is');
const finder = (page: Page) => page.getByRole('combobox', { name: 'Find a referent or field occurrence' });

async function active(page: Page) {
  return page.evaluate(() => {
    const e = document.activeElement as HTMLElement;
    const s = getComputedStyle(e), box = e.getBoundingClientRect();
    let visible = box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
    for (let p: HTMLElement | null = e; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (p.inert || cs.visibility === 'hidden' || Number(cs.opacity) === 0) visible = false;
    }
    const hit = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, box.x + box.width / 2)), Math.max(0, Math.min(innerHeight - 1, box.y + box.height / 2)));
    return { tag: e.tagName, role: e.getAttribute('role'), name: e.getAttribute('aria-label') || e.textContent?.trim() || e.getAttribute('placeholder'), visible,
      covered: !!hit && hit !== e && !e.contains(hit), tabIndex: e.tabIndex, outline: s.outline, focusVisible: e.matches(':focus-visible'),
      inert: !!e.closest('[inert], .motion-swap__was, .is-parked'), expanded: e.getAttribute('aria-expanded'),
      after: { border: getComputedStyle(e, '::after').borderInlineStartWidth, background: getComputedStyle(e, '::after').backgroundColor } };
  });
}

/** Reach controls with actual Tab, including the reverse journey. Never focus()
 * a target to make a keyboard assertion pass. */
async function tabTo(page: Page, target: Locator, reverse = false) {
  for (let i = 0; i < 160; i++) {
    if (await target.evaluateAll((els) => els.includes(document.activeElement!))) {
      await expect.poll(async () => (await active(page)).visible).toBe(true);
      const current = await active(page);
      expect(current.inert).toBe(false);
      expect(current.covered, JSON.stringify(current)).toBe(false);
      if (await target.evaluateAll(els => els.some(e => e.classList.contains('node-reader__link')))) {
        expect(current.outline).toMatch(/solid 1px/);
      }
      return;
    }
    await page.keyboard.press(reverse ? 'Shift+Tab' : 'Tab');
    const current = await active(page);
    expect(current.tag).not.toBe('CANVAS');
    expect(current.inert).toBe(false);
  }
  throw new Error(`Tab did not reach ${target}`);
}
async function activate(page: Page, target: Locator, key = 'Enter') {
  await tabTo(page, target);
  await page.keyboard.press(key);
}
async function seed(page: Page, query: string) {
  await tabTo(page, finder(page));
  await page.keyboard.type(query);
  await expect(page.getByRole('option').first()).toBeVisible();
  const controls = await finder(page).getAttribute('aria-controls');
  await expect(page.locator(`[id="${controls}"]`)).toHaveAttribute('role', 'listbox');
  const option = await finder(page).getAttribute('aria-activedescendant');
  await expect(page.locator(`[id="${option}"]`)).toHaveAttribute('role', 'option');
  await page.keyboard.press('Enter');
  await expect(reader(page).locator('h2')).toBeFocused();
}
async function shot(page: Page, name: string) {
  if (!process.env.KI_FOCUS_SHOTS) return;
  const dir = process.env.KI_FOCUS_SHOTS;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

test('ordinary fixture: ordered focus, combobox, travel, Back, Close, removal and clear', async ({ page }) => {
  const world = new FixtureWorld();
  await page.route('**/world/**', route => world.respond(route));
  await page.goto('/');
  await expect(page.locator('canvas')).toHaveCount(4);
  await expect(page.locator('.world')).toHaveClass(/is-focus/);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('separator', { name: 'Resize Tables' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(table(page).getByRole('button', { name: 'world', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('separator', { name: 'Resize Tables' })).toBeFocused();
  await tabTo(page, finder(page));
  await page.keyboard.type('Entity');
  await expect(page.getByRole('option')).toHaveCount(4);
  await page.keyboard.press('ArrowDown');
  let id = await finder(page).getAttribute('aria-activedescendant');
  await expect(page.locator(`[id="${id}"]`)).toContainText('Entity 1');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Escape');
  await expect(finder(page)).toBeFocused();
  await expect(finder(page)).toHaveAttribute('aria-expanded', 'false');
  await seed(page, 'entity:0');
  await expect(reader(page).locator('h2')).toHaveText('Entity 0');
  const expand = reader(page).locator('.gm__list button').filter({ hasText: 'property' }).first();
  await activate(page, expand, ' ');
  await expect(expand).toContainText('take off');
  const occurrence = reader(page).locator('button').filter({ hasText: 'assertion:0' }).first();
  await activate(page, occurrence);
  await expect(reader(page).locator('h2')).toHaveText('property');
  await expect(reader(page).locator('h2')).toBeFocused();
  await activate(page, reader(page).getByRole('button', { name: 'Back', exact: true }));
  await expect(reader(page).locator('h2')).toHaveText('Entity 0');
  await expect(reader(page).locator('h2')).toBeFocused();
  await activate(page, reader(page).getByRole('button', { name: 'close', exact: true }));
  await expect(finder(page)).toBeFocused();
  await seed(page, 'entity:0');
  await activate(page, reader(page).getByRole('button', { name: 'Take off the field', exact: true }));
  await expect(finder(page)).toBeFocused();
  await activate(page, table(page).getByRole('button', { name: 'clear', exact: true }));
  await expect(page.locator('.world')).toHaveClass(/is-unfielded/);
  await expect(page.locator('[tabindex="1"]')).toHaveCount(0);
});

for (const theme of ['light', 'dark'] as const) for (const width of [1440, 900]) {
  test(`Chinook ${theme} ${width}: keyboard field, transitions, resize and lifecycle`, async ({ page, chinook }) => {
    test.skip(!prepared(), 'prepare Chinook first');
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(chinook);
    await expect(page.locator('canvas')).toHaveCount(4);
    // Vocabulary is intentionally inverted; the appearance control changes the
    // field's theme. Toggle to the requested field theme when necessary.
    if (await page.locator('.world').getAttribute('data-mode') !== theme) {
      await activate(page, page.getByRole('button', { name: /Use .* appearance/ }));
    }
    await seed(page, 'track:10');
    await expect(reader(page).locator('h2')).toHaveText('Evil Walks');
    await shot(page, `reader-${theme}-${width}`);
    await activate(page, reader(page).locator('.gm__list button').filter({ hasText: 'track_on_album' }).first());
    const preview = reader(page).getByRole('button', { name: 'Open occurrence track_on_album:10', exact: true });
    await activate(page, preview);
    await expect(reader(page).locator('h2')).toHaveText('track_on_album');
    await expect(reader(page)).toContainText('row TrackId=10 in Track');
    const album = reader(page).locator('.world__roles button').filter({ hasText: 'For Those About To Rock' });
    await activate(page, album);
    await expect(reader(page).locator('h2')).toHaveText('For Those About To Rock We Salute You');
    const expand = reader(page).locator('.gm__list button').filter({ hasText: 'track_on_album' }).first();
    await activate(page, expand);
    await expect(expand).toContainText('take off');
    await activate(page, expand);
    await expect(expand).not.toContainText('take off');
    await activate(page, reader(page).getByRole('button', { name: 'Back', exact: true }));
    await expect(reader(page).locator('h2')).toHaveText('track_on_album');

    const divider = page.getByRole('separator', { name: 'Resize World reader' });
    await tabTo(page, divider, true);
    const pane = page.locator('#world-reader');
    const initial = (await pane.boundingBox())!.width;
    await page.keyboard.press('End');
    const minimum = Number(await divider.getAttribute('aria-valuemin'));
    await expect.poll(async () => Math.round((await pane.boundingBox())!.width)).toBe(minimum);
    await page.keyboard.press('ArrowLeft');
    const keyed = (await pane.boundingBox())!.width;
    expect(keyed).toBe(minimum + 16);
    await expect(divider).toHaveAttribute('aria-valuenow', String(keyed));
    await page.keyboard.press('Shift+ArrowLeft');
    expect((await pane.boundingBox())!.width).toBe(keyed + 48);
    await page.keyboard.press('ArrowRight');
    expect((await pane.boundingBox())!.width).toBe(keyed + 32);
    const focus = await active(page);
    expect(focus.focusVisible).toBe(true);
    expect(focus.after.border).toBe('2px');
    await shot(page, `divider-${theme}-${width}`);
    await page.keyboard.press('Home');
    await expect.poll(async () => Math.round((await pane.boundingBox())!.width)).toBe(Number(await divider.getAttribute('aria-valuemax')));
    await page.keyboard.press('End');
    const box = (await divider.boundingBox())!;
    // Pointer starts on the same constrained real width as the key did.
    await page.mouse.move(box.x + 6, box.y + 200);
    await page.mouse.down(); await page.mouse.move(box.x - 10, box.y + 200); await page.mouse.up();
    await expect.poll(async () => (await pane.boundingBox())!.width).toBe(keyed);
    const pointerStyle = await divider.evaluate(e => ({ focused: e.matches(':focus-visible'), border: getComputedStyle(e, '::after').borderInlineStartWidth }));
    // A pointer drag must not manufacture a new focus outline. A preceding
    // keyboard focus may remain, according to the browser's modality rules.
    expect(pointerStyle.border).toBe(pointerStyle.focused ? '2px' : '0px');
    await divider.dblclick({ position: { x: 6, y: 200 } });
    await expect.poll(async () => (await pane.boundingBox())!.width).toBe(Math.min(420, Number(await divider.getAttribute('aria-valuemax'))));
    expect(initial).toBeGreaterThan(0);
    await expect(page.locator('canvas[tabindex="1"]')).toHaveCount(0);
    const before = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.includes('field')));
    await activate(page, page.getByRole('button', { name: 'vocabulary', exact: true }));
    await expect(page.locator('.world')).toHaveClass(/is-focus/);
    await expect(finder(page)).toHaveCount(0);
    await activate(page, page.getByRole('group', { name: 'Clear focus', exact: true }).getByRole('button', { name: 'clear', exact: true }));
    await expect(page.locator('.world')).not.toHaveClass(/is-focus/);
    expect(await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.includes('field')))).toEqual(before);
    await page.reload();
    await expect(page.locator('canvas')).toHaveCount(8);
    await page.keyboard.press('Tab');
    expect((await active(page)).tag).not.toBe('CANVAS');
    await expect(page.locator('[tabindex="1"]')).toHaveCount(0);

    const cdp = await page.context().newCDPSession(page);
    const ax = (await cdp.send('Accessibility.getFullAXTree')).nodes;
    expect(ax.filter(n => n.role?.value === 'separator').every(n => !!n.name?.value)).toBe(true);
    if (process.env.KI_FOCUS_SHOTS) await writeFile(join(process.env.KI_FOCUS_SHOTS, `ax-${theme}-${width}.json`), JSON.stringify(ax.filter(n => !n.ignored), null, 2));
  });
}

test('Chinook tables: keyboard activation, search, subject replacement and Close', async ({ page, chinook }) => {
  await page.goto(chinook);
  const row = table(page).locator('.table__row').filter({ has: page.locator('[title="track_on_album"]') });
  await tabTo(page, row);
  await expect(table(page).locator('[aria-label="world relations"]')).toBeVisible();
  await page.keyboard.press(' ');
  await expect(table(page).locator('[data-focus-subject]')).toBeFocused();
  const search = table(page).getByRole('searchbox', { name: 'Search table values' });
  await tabTo(page, search);
  await page.keyboard.type('track:10');
  const tuple = table(page).locator('.table__row[data-loaded]').filter({ has: page.locator('span:first-child[title="track:10"]') });
  await expect(tuple).toBeVisible();
  await tabTo(page, tuple);
  await expect(page.locator('#world-reader')).toHaveAttribute('aria-hidden', 'true');
  await page.keyboard.press('Enter');
  await expect(reader(page).locator('h2')).toBeFocused();
  await expect(reader(page)).toContainText('row TrackId=10 in Track');
  await activate(page, table(page).getByRole('button', { name: 'world', exact: true }));
  await expect(table(page).getByRole('button', { name: 'world', exact: true })).toBeFocused();
  await activate(page, table(page).locator('.table__row').filter({ has: page.locator('[title="album_listed_under_artist"]') }));
  await expect(table(page).locator('[data-focus-subject]')).toHaveText('album_listed_under_artist');
  await expect(table(page).locator('[data-focus-subject]')).toBeFocused();
  await activate(page, table(page).getByRole('button', { name: 'close', exact: true }));
  await expect(page.getByRole('button', { name: 'Tables', exact: true })).toBeFocused();
  await expect(page.locator('#world-tables')).toHaveAttribute('inert', '');
});

test('Chinook structure: natural Tab order, catalogue, pagination, FK scope and horizontal scroll', async ({ page, chinook }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto(`${chinook}/sqlite`);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: /Back to explorer/ })).toBeFocused();
  await activate(page, page.getByRole('button', { name: /^Track/ }));
  await expect(page.getByRole('heading', { name: 'Track', exact: true })).toBeVisible();
  const scroll = page.getByRole('region', { name: 'SQLite rows' });
  await tabTo(page, scroll);
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => scroll.evaluate(e => e.scrollLeft)).toBeGreaterThan(0);
  await activate(page, page.getByRole('button', { name: 'Next', exact: true }));
  await expect(page.getByText('51–100 of 3503')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeFocused();
  await expect.poll(async () => (await active(page)).visible).toBe(true);
  await activate(page, page.getByRole('button', { name: 'AlbumId → Album (AlbumId)', exact: true }));
  await expect(page.getByRole('heading', { name: 'Album', exact: true })).toBeVisible();
  await tabTo(page, page.getByRole('textbox', { name: 'Find a table or view' }));
  await page.keyboard.type('PlaylistTrack');
  await activate(page, page.getByRole('button', { name: /^PlaylistTrack/ }));
  await expect(page.getByText('1–50 of 8715')).toBeVisible();
  await shot(page, 'structural-keyboard-narrow');
});

test('a temporarily squeezed reader never saves a below-minimum desktop preference', async ({ page }) => {
  const world = new FixtureWorld();
  await page.route('**/world/**', route => world.respond(route));
  await page.goto('/');
  await seed(page, 'entity:0');
  await page.setViewportSize({ width: 390, height: 844 });
  const divider = page.getByRole('separator', { name: 'Resize World reader' });
  await tabTo(page, divider, true);
  await page.keyboard.press('End');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(async () => (await page.locator('#world-reader').boundingBox())!.width).toBeGreaterThanOrEqual(300);
  await expect.poll(async () => Number(await divider.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(300);
  await page.reload();
  await seed(page, 'entity:0');
  expect((await page.locator('#world-reader').boundingBox())!.width).toBeGreaterThanOrEqual(300);
});

test('delayed reader travel recovers focus within its outgoing subject and respects travel elsewhere', async ({ page }) => {
  const world = new FixtureWorld(); world.hub = true;
  await page.route('**/world/**', route => world.respond(route));
  try {
    await page.goto('/'); await seed(page, 'entity:0');
    await activate(page, reader(page).locator('.gm__list button').first());
    for (const [id, leave] of [['assertion:0', false], ['assertion:1', true]] as const) {
      const gate = world.block('assertion');
      await activate(page, reader(page).getByRole('button', { name: `Open occurrence ${id}`, exact: true }));
      await gate.requested;
      if (leave) await tabTo(page, finder(page));
      else {
        await page.keyboard.press('Tab');
        expect(await reader(page).evaluate(e => e.contains(document.activeElement))).toBe(true);
      }
      gate.release();
      await expect(reader(page).locator('h2')).toHaveText('property');
      await expect(leave ? finder(page) : reader(page).locator('h2')).toBeFocused();
      await activate(page, reader(page).getByRole('button', { name: 'Back', exact: true }));
      await expect(reader(page).locator('h2')).toHaveText('Entity 0');
    }
  } finally { world.releaseAll(); }
});

test('native scrolling keeps focus while virtual rows page beyond the first 200', async ({ page }) => {
  const world = new FixtureWorld(); world.count = 250;
  const reads: string[] = [];
  await page.route('**/world/**', route => {
    reads.push(route.request().url());
    return world.respond(route);
  });
  await page.goto('/');
  await activate(page, table(page).locator('.table__row').first());
  const rows = page.getByRole('region', { name: 'property rows', exact: true });
  await tabTo(page, rows);
  expect((await active(page)).outline).toMatch(/solid 1px/);
  await page.keyboard.press('Tab');
  expect((await active(page)).role).toBe('button');
  await page.keyboard.press('PageDown');
  await expect(rows).toBeFocused();
  await page.keyboard.press('End');
  await expect(rows).toBeFocused();
  const last = rows.locator('.table__row[data-loaded]').filter({ has: page.locator('span:first-child[title="entity:249"]') });
  await expect(last).toBeVisible();
  expect(reads.some(url => new URL(url).searchParams.get('offset') === '200')).toBe(true);
  await tabTo(page, last);
  await expect(page.locator('#world-reader')).toHaveAttribute('aria-hidden', 'true');
  await page.keyboard.press('Enter');
  await expect(reader(page).locator('h2')).toBeFocused();
  await expect(reader(page)).toContainText('value-249');
  expect(reads.some(url => new URL(url).searchParams.get('id') === 'assertion:249')).toBe(true);
});

test('ordinary Purpose frontier rows activate with Enter and Space, never with Tab alone', async ({ page }) => {
  const world = new FixtureWorld();
  await page.route('**/world/**', route => world.respond(route));
  await page.route('**/world/demand', route => route.fulfill({ json: { demand: {
    purpose: { statement: 'Fixture purpose' }, rule: null, demanded: 1,
    obligations: [{ relation: 'property', values: { item: 'entity:0', peer: 'entity:1', value: 'needed' },
      demanded_by: { name: 'fixture', revision: 1 }, state: 'UNRESOLVED', assertion_id: null,
      reason: 'Missing fixture tuple' }],
  } } }));
  await page.goto('/');
  await activate(page, table(page).getByRole('button', { name: 'purpose frontier', exact: true }));
  const row = table(page).locator('.table__row');
  await tabTo(page, row);
  await expect(row).toHaveAttribute('role', 'button');
  await expect(page.locator('#world-reader')).toHaveAttribute('aria-hidden', 'true');
  expect((await active(page)).outline).toMatch(/solid 1px/);
  for (const key of ['Enter', ' ']) {
    await activate(page, row, key);
    await expect(reader(page).locator('h2')).toBeFocused();
    await expect(reader(page)).toContainText('needed');
    await expect(reader(page)).toContainText('Missing fixture tuple');
    await activate(page, reader(page).getByRole('button', { name: 'close', exact: true }));
  }
});

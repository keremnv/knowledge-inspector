/** Real-adapter equivalence: shared DOM recipes, measured styles and behavior. */
import { test, expect, type Locator } from '@playwright/test';
import { serve, UPSTREAM, prepared } from './chinook-serve';
import { serveSource } from './source-serve';

async function recipe(locator: Locator) {
  return locator.evaluate(el => {
    const css = getComputedStyle(el);
    return Object.fromEntries(['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'padding', 'color', 'backgroundColor', 'borderWidth', 'borderColor', 'borderRadius', 'outlineWidth', 'outlineOffset', 'boxSizing', 'minHeight'].map(key => [key, css[key as keyof CSSStyleDeclaration]]));
  });
}
for (const width of [1440, 1000, 900]) for (const theme of ['light', 'dark'] as const) {
  test(`canonical controls, table and Reader at ${width}px in ${theme}`, async ({ browser }) => {
    test.skip(!prepared(), 'Prepare pinned Chinook first');
    await serve(UPSTREAM, 'examples/chinook/declaration.json', async worldOrigin => {
      await serveSource(UPSTREAM, async ({ origin }) => {
        const world = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce' });
        const source = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce' });
        try {
          await world.goto(`${worldOrigin}/world`); await source.goto(`${origin}/source`);
          const wt = world.locator('#world-tables .motion-swap__is'), st = source.locator('#source-tables .source-table-slot > .motion-swap > .motion-swap__is');
          const wr = world.locator('#world-reader .motion-swap__is'), sr = source.locator('#source-reader > .motion-swap > .motion-swap__is');
          await wt.locator('.table__row').filter({ hasText: 'track_on_album' }).click();
          await st.getByRole('button', { name: 'Track table', exact: true }).press('Enter');
          await expect(st.locator('[data-row]').first()).toBeVisible();
          const find = world.getByRole('combobox', { name: 'Find a referent or field occurrence' });
          await find.fill('track:10'); await world.getByRole('option').first().waitFor(); await find.press('Enter');
          await st.getByRole('button', { name: 'Inspect row 10', exact: true }).press('Enter');
          await expect(wr.locator('h2')).toHaveText('Evil Walks'); await expect(sr.locator('h2')).toHaveAccessibleName('Track, TrackId=10');
          await Promise.all([world.evaluate(() => document.fonts.ready), source.evaluate(() => document.fonts.ready)]);
          const worldClose = wt.getByRole('button', { name: 'close', exact: true }), sourceClose = st.getByRole('button', { name: 'close', exact: true });
          for (const state of ['rest', 'hover', 'focus'] as const) {
            for (const [page, close] of [[world, worldClose], [source, sourceClose]] as const) {
              await page.mouse.move(width / 2, 80); await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
              if (state === 'hover') await close.hover();
              if (state === 'focus') { await close.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); }
            }
            await expect.poll(async () => JSON.stringify(await recipe(sourceClose)) === JSON.stringify(await recipe(worldClose))).toBe(true);
            expect((await sourceClose.boundingBox())!.height).toBe((await worldClose.boundingBox())!.height);
            expect((await sourceClose.boundingBox())!.width).toBe((await worldClose.boundingBox())!.width);
          }
          // Synthetic long-title stress probe on the actual header nodes;
          // restore the recorded names before continuing the real-data flow.
          const longTitle = 'a recorded table name that is much longer than the available dock width '.repeat(4);
          const titles = [wt.locator('.table__said b'), st.locator('.table__said h2')];
          const saved = await Promise.all(titles.map(title => title.textContent()));
          const heights = await Promise.all([worldClose, sourceClose].map(close => close.boundingBox().then(box => box!.height)));
          for (const title of titles) await title.evaluate((el, text) => { el.textContent = text; }, longTitle);
          for (const [index, close] of [worldClose, sourceClose].entries()) {
            await expect(close).toBeVisible(); expect((await close.boundingBox())!.height).toBe(heights[index]);
          }
          for (const [index, title] of titles.entries()) await title.evaluate((el, text) => { el.textContent = text; }, saved[index]);
          expect(await recipe(st.getByRole('searchbox'))).toEqual(await recipe(wt.locator('.table__search input')));
          expect((await st.locator('tbody tr').first().boundingBox())!.height).toBe((await wt.locator('.table__row[data-loaded]').first().boundingBox())!.height);
          await expect(world.locator('.motion-swap__was')).toHaveCount(0); await expect(source.locator('.motion-swap__was')).toHaveCount(0);
          // World carries a Reading qualifier below this header, so the shared
          // :not(:last-child) rule deliberately tightens its bottom padding.
          const sh = await recipe(sr.locator('.world-reader__header')), wh = await recipe(wr.locator('.world-reader__header'));
          delete sh.padding; delete wh.padding; expect(sh).toEqual(wh);
          expect(await recipe(sr.locator('.world-reader__content'))).toEqual(await recipe(wr.locator('.world-reader__content')));
          expect(await recipe(sr.locator('.panel__close'))).toEqual(await recipe(wr.locator('.panel__close')));
          expect(await recipe(sr.locator('[data-placement="show"]'))).toEqual(await recipe(wr.locator('.world-reader__actions button').first()));
          // Synthetic disabled-state probe on the actual shared action nodes;
          // loading/cancellation semantics are exercised by the FK fixtures.
          const actions = [wr.locator('.world-reader__actions button').first(), sr.locator('[data-placement="show"]')];
          for (const action of actions) await action.evaluate(el => { (el as HTMLButtonElement).disabled = true; });
          expect(await recipe(actions[0])).toEqual(await recipe(actions[1]));
          for (const action of actions) await expect(action).toBeDisabled();
          expect(await actions[0].evaluate(el => getComputedStyle(el).opacity)).toBe('0.42');
          expect(await actions[1].evaluate(el => getComputedStyle(el).opacity)).toBe('0.42');
          for (const action of actions) await action.evaluate(el => { (el as HTMLButtonElement).disabled = false; });

          const filter = st.getByRole('searchbox');
          await filter.fill('Evil Walks'); await filter.press('Enter'); await expect(st.locator('tbody tr')).toHaveCount(1);
          await st.getByRole('button', { name: 'Inspect row 1', exact: true }).press('Enter');
          await expect(sr.locator('h2')).toHaveAccessibleName('Track, TrackId=10');
          await filter.focus();
          await filter.press('Escape'); await expect(filter).toHaveValue(''); await expect(filter).toBeFocused();
          await expect(source.locator('[data-overlay="source-reader"]')).toHaveClass(/is-open/);
          await expect(st.getByRole('button', { name: 'Inspect row 10', exact: true })).toBeVisible();
          await expect(source.locator('.source-quiet')).toHaveCount(0);
        } finally { await world.close(); await source.close(); }
      });
    });
  });
}

for (const motion of ['reduce', 'no-preference'] as const) test(`instrument recession, hide and keyboard removal (${motion})`, async ({ page }) => {
  test.skip(!prepared(), 'Prepare pinned Chinook first');
  await page.emulateMedia({ reducedMotion: motion });
  await serveSource(UPSTREAM, async ({ origin }) => {
    await page.goto(`${origin}/source?placement=explicit`);
    const st = page.locator('#source-tables .source-table-slot > .motion-swap > .motion-swap__is');
    const sr = page.locator('#source-reader > .motion-swap > .motion-swap__is');
    await st.getByRole('button', { name: 'Track table', exact: true }).press('Enter');
    await st.getByRole('button', { name: 'Inspect row 10', exact: true }).press('Enter');
    await sr.getByRole('button', { name: 'show on canvas', exact: true }).press('Enter');
    const chooser = page.getByRole('region', { name: 'Records on canvas' });
    await expect(chooser.locator('[data-field-record]')).toHaveCount(1);
    await sr.getByRole('button', { name: 'close', exact: true }).click();
    await st.getByRole('button', { name: 'close', exact: true }).click();
    await page.mouse.click(700, 70); await page.mouse.move(700, 300);
    await expect.poll(() => page.locator('.instrument').evaluate(el => getComputedStyle(el).opacity)).toBe('0.72');
    await chooser.locator('[data-field-record]').focus();
    await expect.poll(() => page.locator('.instrument').evaluate(el => getComputedStyle(el).opacity)).toBe('1');
    await page.keyboard.press('.'); await expect(chooser).toBeHidden();
    await page.keyboard.press('Escape'); await expect(chooser).toBeVisible();
    await chooser.locator('[data-field-record]').press('Enter');
    await expect(sr.locator('h2')).toHaveAccessibleName('Track, TrackId=10');
    await chooser.locator('[data-field-remove]').press('Enter');
    await expect(chooser).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Source canvas' })).toBeFocused();
    await expect(page.locator('.source-quiet')).toHaveCount(0);
  });
});

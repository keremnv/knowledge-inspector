/** Interrupted lifecycle/drag and coarse-pointer checks use the shared renderer
 * through Source's real HTTP adapter. No development graph mutation. */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveSource } from './source-serve';
import { VISIBILITY_STRENGTHS_ON } from '../src/world/visibility';
import { canvasState, canvasRest, canvasPoint, closeCanvasDocks, sourceRecord,
  sourceReader, sourceTable, sourceList, showSourceReference, openSourceReferences } from './canvas-parity';

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'ki-canvas-motion-')), db = join(folder, 'fixture.sqlite');
  execFileSync('python3', ['-c', 'import sqlite3,sys; from pathlib import Path; c=sqlite3.connect(sys.argv[1]); c.executescript(Path(sys.argv[2]).read_text()); c.close()', db, 'tests/fixtures/canvas-parity.sql']);
  return { db, dispose: () => rm(folder, { recursive: true, force: true }) };
}
for (const reducedMotion of ['reduce', 'no-preference'] as const) {
  test(`wheel interruption, queued hiding and lost drag release: ${reducedMotion}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion }); const f = await fixture();
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    try {
      await serveSource(f.db, async ({ origin }) => {
        await sourceRecord(page, origin, 'Child');
        await sourceTable(page).getByRole('button', { name: 'close', exact: true }).click();
        await openSourceReferences(page); await sourceReader(page).locator('.source-outgoing article').first().getByRole('button', { name: /inspect FK/ }).click();
        await sourceReader(page).locator('[data-reference-show]').click();
        // Membership is committed before birth/reveal completes. A real wheel
        // gesture now owns the camera, even while material is still arriving.
        await expect(sourceList(page).locator('[data-field-reference]')).toHaveCount(1);
        await page.mouse.move(300, 150); await page.mouse.wheel(0, -180);
        await canvasRest(page, 'source', 2);
        const interrupted = await canvasState(page);
        expect(interrupted.zoom).toBeGreaterThan(1);
        await sourceList(page).locator('[data-field-record]').first().press("Enter");
        await closeCanvasDocks(page);
        const child = (await canvasState(page)).nodes.find((n: any) => n.style.labelText.startsWith('Child'));
        const before = await canvasPoint(page, child.id);
        await page.mouse.move(before.x, before.y); await page.mouse.down(); await page.waitForTimeout(150);
        await page.mouse.move(before.x + 75, before.y + 40, { steps: 8 });
        await expect.poll(async () => (await canvasState(page)).nodes.find((n: any) => n.id === child.id).at[0]).not.toBe(child.at[0]);
        // Keyboard hiding while the pointer still owns a drag queues a newer
        // draw; it must retain this drag's live position when released.
        await sourceList(page).getByRole('button', { name: /^hide connection .* → .*$/ }).press('Enter');
        await expect(sourceList(page).locator('[data-field-reference]')).toHaveCount(0);
        await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        await page.mouse.up(); await canvasRest(page, 'source', 2);
        const after = await canvasPoint(page, child.id), state = await canvasState(page);
        expect(Math.abs(after.x - before.x - 75)).toBeLessThan(1); expect(Math.abs(after.y - before.y - 40)).toBeLessThan(1);
        expect(state.edges).toHaveLength(0); expect(state.contact).toBe('idle');
        // Both endpoints stand. An unrelated redraw cannot resurrect the hidden
        // connection or move either record.
        await page.emulateMedia({ colorScheme: 'dark' }); await canvasRest(page, 'source', 2);
        expect((await canvasState(page)).nodes.map((n: any) => [n.id, n.at])).toEqual(state.nodes.map((n: any) => [n.id, n.at]));
        expect((await canvasState(page)).edges).toHaveLength(0);
        await sourceList(page).locator('[data-field-remove]').first().press('Enter');
        await expect(sourceList(page).locator('[data-field-record]')).toHaveCount(1);
        await expect(sourceList(page).locator('[data-field-record]')).toBeFocused();
        await sourceList(page).locator('[data-field-remove]').press('Enter');
        await expect(sourceList(page)).toHaveCount(0);
        await expect.poll(async () => (await canvasState(page)).nodes.length).toBe(0);
        await expect(page.getByRole('region', { name: 'Source canvas', exact: true })).toBeFocused();
        await expect(page.getByRole('region', { name: 'Source canvas', exact: true })).not.toContainText('choose a table to inspect');
        expect(errors).toEqual([]);
      });
    } finally { await f.dispose(); }
  });

  test(`coarse pointer selects a distinct self plate and preserves long exact identity: ${reducedMotion}`, async ({ browser }) => {
    const f = await fixture();
    const page = await browser.newPage({ viewport: { width: 900, height: 1000 }, reducedMotion, hasTouch: true });
    try {
      await serveSource(f.db, async ({ origin }) => {
        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
        await sourceRecord(page, origin, 'LongUnnamed', 1);
        const long = (await canvasState(page)).nodes[0];
        expect(long.style.labelText).toContain('9007199254740993');
        expect(long.style.labelText).toContain('An exact recorded key');
        expect(long.style.labelTextBaseline).toBe('middle');
        await closeCanvasDocks(page);
        const at = await canvasPoint(page, long.id); await page.touchscreen.tap(at.x, at.y);
        await expect(sourceReader(page).locator('.source-cells')).toContainText('9007199254740993');
        // With no naming choice a record is called by its key (O17); nothing is inferred.
        await sourceRecord(page, origin, 'Track', 1);
        expect((await canvasState(page)).nodes[0].style.labelText).toBe('Track 10');
        await sourceRecord(page, origin, 'SelfLinks');
        for (let i = 0; i < 3; i += 1) {
          await showSourceReference(page, i); await sourceReader(page).getByRole('button', { name: 'Back', exact: true }).click();
        }
        await sourceList(page).locator('[data-field-record]').press('Enter'); await closeCanvasDocks(page);
        const members = (await canvasState(page)).edges.filter((e: any) => e.id.startsWith('reference-') && e.style.labelOpacity === 1);
        expect(members).toHaveLength(3);
        const point = await canvasPoint(page, members[1].id, true);
        await page.touchscreen.tap(point.x, point.y);
        await expect(sourceList(page).locator(`[data-field-reference="${members[1].id}"]`)).toHaveAttribute('aria-pressed', 'true');
        await expect(sourceReader(page).locator('[data-reference-status]')).toHaveText('resolved');
      });
    } finally { await page.close(); await f.dispose(); }
  });

  test(`long crowded labels use hover naming, selection fan and visibility strengths: ${reducedMotion}`, async ({ page }) => {
    const f = await fixture(); await page.emulateMedia({ reducedMotion });
    try {
      await serveSource(f.db, async ({ origin, requests }) => {
        await sourceRecord(page, origin, 'Crowded');
        for (let i = 0; i < 2; i += 1) {
          await showSourceReference(page, i); await sourceReader(page).getByRole('button', { name: 'Back', exact: true }).click();
        }
        await closeCanvasDocks(page);
        const initial = await canvasState(page), parentA = initial.nodes.find((n: any) => n.style.labelText.startsWith('ParentA'));
        const parentB = initial.nodes.find((n: any) => n.style.labelText.startsWith('ParentB'));
        const a = await canvasPoint(page, parentA.id), b = await canvasPoint(page, parentB.id);
        // Give both long names their full canonical station, then arrange
        // the endpoints on the same bearing so those stations truly overlap.
        // Grab exposed upper bodies: a long plate can cover a disc's centre.
        await page.mouse.move(b.x, b.y - 25); await page.mouse.down(); await page.waitForTimeout(150);
        await page.mouse.move(b.x + 134, b.y - 134 - 25, { steps: 15 }); await page.mouse.up(); await canvasRest(page, 'source', 3);
        const movedB = await canvasPoint(page, parentB.id);
        expect(Math.abs(movedB.x - b.x - 134)).toBeLessThan(1);
        expect(Math.abs(movedB.y - b.y + 134)).toBeLessThan(1);
        await page.mouse.move(a.x, a.y - 25); await page.mouse.down(); await page.waitForTimeout(150);
        await page.mouse.move(b.x + 268, b.y - 268 - 25, { steps: 15 }); await page.mouse.up(); await canvasRest(page, 'source', 3);
        const moved = await canvasPoint(page, parentA.id);
        expect(Math.abs(moved.x - b.x - 268)).toBeLessThan(1);
        expect(Math.abs(moved.y - b.y + 268)).toBeLessThan(1);
        await page.mouse.click(720, 80); await page.mouse.move(720, 80);
        const child = initial.nodes.find((n: any) => n.style.labelText.startsWith('Crowded'));
        const c = await canvasPoint(page, child.id), reads = requests.length;
        await page.mouse.move(c.x, c.y); await canvasRest(page, 'source', 3);
        const hovered = await canvasState(page), labels = hovered.edges.filter((e: any) => e.id.startsWith('reference-'));
        expect(labels.every((e: any) => e.style.labelOpacity === 1)).toBe(true);
        expect(labels.every((e: any) => e.style.labelText.length > 40)).toBe(true);
        // Crowded names fade only while crowding is on; off (O16, the original), each keeps full strength.
        expect(labels.some((e: any) => (e.style.labelFillOpacity ?? 1) < 1)).toBe(VISIBILITY_STRENGTHS_ON);
        expect(hovered.edges.filter((e: any) => e.id.startsWith('source-carrier:')).every((e: any) => e.path.length === 2)).toBe(true);
        await sourceList(page).getByRole('button', { name: 'Crowded 1', exact: true }).press('Enter'); await closeCanvasDocks(page);
        const selected = await canvasState(page);
        expect(selected.edges.filter((e: any) => e.id.startsWith('source-carrier:')).some((e: any) => e.path.length === 3)).toBe(true);
        expect(selected.nodes.map((n: any) => [n.id, n.at])).toEqual(hovered.nodes.map((n: any) => [n.id, n.at]));
        expect(requests.slice(reads).every((url) => url.pathname.endsWith('/record') || url.pathname.endsWith('/references'))).toBe(true);
        // Hold the fan owner: the shared solver yields to the hand, then resumes.
        const held = await canvasPoint(page, child.id);
        await page.mouse.move(held.x, held.y); await page.mouse.down(); await page.waitForTimeout(150);
        await page.mouse.move(held.x + 20, held.y + 15, { steps: 4 });
        await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' })));
        await page.mouse.up(); await canvasRest(page, 'source', 3);
        expect((await canvasState(page)).nodes.every((n: any) => n.at.every(Number.isFinite))).toBe(true);
      });
    } finally { await f.dispose(); }
  });
}

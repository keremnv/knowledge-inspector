/** Large groups and directed evidence, through real SQLite and the actual UI. */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveSource } from './source-serve';
import { canvasState, canvasRest, canvasPoint, closeCanvasDocks, sourceRecord,
  sourceReader, sourceList, showSourceReference } from './canvas-parity';

const isMember = (e: any) => !e.id.startsWith('source-carrier:') && !e.id.startsWith('source-summary:');
const visibleMembers = (s: Awaited<ReturnType<typeof canvasState>>) => s.edges.filter((e: any) => isMember(e) && e.style.labelOpacity === 1);
const summaries = (s: Awaited<ReturnType<typeof canvasState>>) => s.edges.filter((e: any) => e.id.startsWith('source-summary:'));

for (const reducedMotion of ['reduce', 'no-preference'] as const) {
  for (const table of ['Child', 'SelfLinks'] as const) {
    test(`canonical count/open/cap and individual ownership: ${table}, ${reducedMotion}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion });
      const folder = await mkdtemp(join(tmpdir(), 'ki-canvas-parallel-')), db = join(folder, 'fixture.sqlite');
      execFileSync('python3', ['-c', 'import sqlite3,sys; from pathlib import Path; c=sqlite3.connect(sys.argv[1]); c.executescript(Path(sys.argv[2]).read_text()); c.close()', db, 'tests/fixtures/canvas-parity.sql']);
      const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
      try {
        await serveSource(db, async ({ origin, requests }) => {
          const count = table === 'Child' ? 8 : 6, nodes = table === 'Child' ? 2 : 1;
          await sourceRecord(page, origin, table);
          for (let index = 0; index < count; index += 1) {
            await showSourceReference(page, index);
            await sourceReader(page).getByRole('button', { name: 'Back', exact: true }).click();
          }
          await sourceList(page).locator('[data-field-record]').first().press('Enter');
          await canvasRest(page, 'source', nodes);
          const initial = await canvasState(page), membership = initial.edges.filter(isMember).map((e: any) => e.id).sort();
          expect(membership).toHaveLength(count);
          expect(initial.edges.filter((e: any) => e.id.startsWith('source-carrier:'))).toHaveLength(1);
          expect(visibleMembers(initial)).toHaveLength(4);
          expect(summaries(initial)[0].style.labelText).toBe(`+${count - 4} more`);
          const positioned = initial.nodes.map((n: any) => [n.id, n.at]);
          if (table === 'SelfLinks') {
            expect(initial.edges.find((e: any) => e.id.startsWith('source-carrier:')).path.some((segment: any) => segment[0] === 'C')).toBe(true);
          }
          await closeCanvasDocks(page);
          // Quiet at rest; endpoint hover names a count without opening it.
          await page.mouse.click(720, 85);
          await page.mouse.move(720, 85);
          await expect.poll(async () => visibleMembers(await canvasState(page)).length).toBe(0);
          const endpoint = initial.nodes[0].id, at = await canvasPoint(page, endpoint);
          const reads = requests.length;
          await page.mouse.move(at.x, at.y);
          await expect.poll(async () => summaries(await canvasState(page))[0].style.labelOpacity).toBe(1);
          const closed = await canvasState(page), countMark = summaries(closed)[0];
          expect(countMark.style.labelText).toBe(`${count} references`);
          expect(visibleMembers(closed)).toHaveLength(0);
          // This is the actual count label's hit region, not a development emit.
          const countPoint = await canvasPoint(page, countMark.id, true);
          await page.mouse.click(countPoint.x, countPoint.y);
          await expect.poll(async () => visibleMembers(await canvasState(page)).length).toBe(4);
          await page.mouse.move(720, 85); await canvasRest(page, 'source', nodes);
          expect(visibleMembers(await canvasState(page))).toHaveLength(4);
          expect(requests).toHaveLength(reads); // Naming/opening never traverses the database.
          // A member beyond the cap gets the final seat when chosen by keyboard.
          const unseated = membership.find((id: string) => !visibleMembers(initial).some((e: any) => e.id === id))!;
          await sourceList(page).locator(`[data-field-reference="${unseated}"]`).press('Enter');
          await expect(sourceReader(page).locator('h2')).toBeFocused();
          await canvasRest(page, 'source', nodes);
          expect(visibleMembers(await canvasState(page)).map((e: any) => e.id)).toContain(unseated);
          expect(visibleMembers(await canvasState(page))).toHaveLength(4);
          await expect(sourceReader(page)).toContainText('so1:');
          // Select a visible sibling by its painted plate; it opens that exact FK.
          await sourceList(page).locator('[data-field-record]').first().press("Enter");
          await closeCanvasDocks(page);
          const shown = visibleMembers(await canvasState(page));
          const picked = shown[1].id, pickAt = await canvasPoint(page, picked, true);
          await page.mouse.click(pickAt.x, pickAt.y);
          await expect(sourceList(page).locator(`[data-field-reference="${picked}"]`)).toHaveAttribute('aria-pressed', 'true');
          await expect(sourceReader(page).locator('[data-reference-status]')).toHaveText('resolved');
          // Hiding one connection cannot remove an unrelated observation or any endpoint.
          await sourceReader(page).getByRole('button', { name: 'hide connection', exact: true }).click();
          await canvasRest(page, 'source', nodes);
          const after = await canvasState(page);
          expect(after.edges.filter(isMember).map((e: any) => e.id).sort()).toEqual(membership.filter((id: string) => id !== picked));
          expect(after.nodes.map((n: any) => [n.id, n.at])).toEqual(positioned);
          await expect(sourceList(page).locator('[data-field-reference]')).toHaveCount(count - 1);
          expect(after.edges.some((e: any) => e.id === picked)).toBe(false);
          // The old label no longer has a reachable region after absorption.
          expect(await page.evaluate(async ({ x, y, id }) => {
            const path = '/src/world/labelPick.ts';
            const { labelUnderPointer } = await import(path);
            return labelUnderPointer((window as any).__sourceFieldGraph, x, y, (candidate: string) => candidate === id);
          }, { ...pickAt, id: picked })).toBeNull();
          if (table === 'Child') {
            // Opposing FK: Parent → Child shares paint but retains its true direction.
            await sourceList(page).getByRole('button', { name: 'Parent 1', exact: true }).press("Enter");
            await showSourceReference(page, 0);
            await expect(sourceReader(page)).toContainText('Parent → Child');
            await expect(sourceReader(page)).toContainText('child_id');
            await canvasRest(page, 'source', nodes);
            const opposing = (await canvasState(page)).edges.filter(isMember).find((e: any) => !membership.includes(e.id))!;
            expect(opposing).toBeTruthy();
            expect((await canvasState(page)).edges.filter((e: any) => e.id.startsWith('source-carrier:'))).toHaveLength(1);
            await sourceReader(page).getByRole('button', { name: 'hide connection', exact: true }).click();
            await canvasRest(page, 'source', nodes);
            expect((await canvasState(page)).edges.filter(isMember).map((e: any) => e.id).sort()).toEqual(membership.filter((id: string) => id !== picked));
          }
          expect(errors).toEqual([]);
        });
      } finally { await rm(folder, { recursive: true, force: true }); }
    });
  }
}

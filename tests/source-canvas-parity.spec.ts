/** The same UI contract runs over each real information context. Renderer
 * observations are read-only; no graph emit, placement or translation shortcut. */
import { test, expect } from '@playwright/test';
import { UPSTREAM, prepared, serve } from './chinook-serve';
import { serveSource } from './source-serve';
import { canvasState, canvasRest, canvasPoint, closeCanvasDocks,
  SourceCanvasDriver, ReadingCanvasDriver } from './canvas-parity';

const glyphKeys = ['size', 'lineWidth', 'labelPlacement', 'labelTextAlign', 'labelTextBaseline', 'labelOffsetY',
  'labelFontFamily', 'labelFontSize', 'labelFontWeight', 'labelLineHeight', 'labelMaxLines', 'labelWordWrapWidth', 'labelTransform', 'labelTransformOrigin'];
for (const reducedMotion of ['reduce', 'no-preference'] as const) {
  for (const width of [900, 1440]) for (const colorScheme of ['light', 'dark'] as const) {
    test(`shared canvas UI/geometry contract: ${width}, ${colorScheme}, ${reducedMotion}`, async ({ browser }) => {
      test.skip(!prepared(), 'Prepare pinned Chinook');
      await serveSource(UPSTREAM, async ({ origin }) => {
        await serve(UPSTREAM, 'examples/chinook/declaration.json', async (readingOrigin) => {
          const glyphs: unknown[] = [];
          for (const Driver of [SourceCanvasDriver, ReadingCanvasDriver]) {
            const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme, reducedMotion });
            const driver = new Driver(page, Driver === SourceCanvasDriver ? origin : readingOrigin);
            const errors: string[] = [], worldReads: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
            page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/world/')) worldReads.push(request.url()); });
            try {
              await driver.place();
              const initial = await canvasState(page, driver.context);
              const node = initial.nodes.find((n: any) => n.id === driver.recordId)!;
              expect(node.style.labelText).toBe('Evil Walks');
              expect(node.type).toBe('circle');
              glyphs.push(Object.fromEntries(glyphKeys.map((key) => [key, node.style[key]])));
              // Compare the real Source output to the real factory, not a token mock.
              expect(await page.evaluate(async ({ id, keys, context }) => {
                const marksPath = '/src/world/marks.ts', dnaPath = '/src/styles/graphDna.ts';
                const { discNode, MARK_DEFAULTS, paintOf } = await import(marksPath);
                const { GRAPH_DNA_THEME } = await import(dnaPath);
                const graph = (window as any)[context === 'source' ? '__sourceFieldGraph' : '__worldFieldGraph'];
                const n = graph.getNodeData(id), dark = document.querySelector('.product-shell')!.classList.contains('is-dark');
                const expected = discNode(id, n.style.x, n.style.y, n.style.labelText, paintOf(GRAPH_DNA_THEME[dark ? 'dark' : 'light'], dark), MARK_DEFAULTS, true);
                return keys.filter((key: string) => JSON.stringify(n.style[key]) !== JSON.stringify(expected.style[key]));
              }, { id: driver.recordId, keys: glyphKeys, context: driver.context })).toEqual([]);
              const handle = await page.evaluateHandle((context) => (window as any)[context === 'source' ? '__sourceFieldGraph' : '__worldFieldGraph'], driver.context);
              await driver.connect();
              const connected = await canvasState(page, driver.context);
              expect(connected.nodes.find((n: any) => n.id === driver.recordId).at).toEqual(node.at);
              expect(connected.edges.every((e: any) => e.type === 'world-filament')).toBe(true);
              expect(connected.edges.filter((e: any) => e.style.lineWidth > 0)).toHaveLength(1);
              expect(connected.edges.every((e: any) => !e.style.endArrow && !e.style.startArrow && !e.style.lineDash)).toBe(true);
              await driver.selectRecord(); await canvasRest(page, driver.context, 2);
              await closeCanvasDocks(page, driver.context);
              // Actual drag, beyond G6's activation threshold, with an observed delta.
              const before = await canvasState(page, driver.context), at = await canvasPoint(page, driver.recordId, false, driver.context);
              await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.waitForTimeout(150);
              await page.mouse.move(at.x - 55, at.y + 35, { steps: 8 });
              await expect.poll(async () => (await canvasState(page, driver.context)).nodes.find((n: any) => n.id === driver.recordId).at[0]).not.toBe(before.nodes.find((n: any) => n.id === driver.recordId).at[0]);
              await page.mouse.up(); await canvasRest(page, driver.context, 2);
              const afterPoint = await canvasPoint(page, driver.recordId, false, driver.context);
              expect(afterPoint.x - at.x).toBeCloseTo(-55, 0); expect(afterPoint.y - at.y).toBeCloseTo(35, 0);
              const dragged = await canvasState(page, driver.context), positions = dragged.nodes.map((n: any) => [n.id, n.at]);
              // A deliberate pan and zoom cannot alter stored world positions.
              await page.mouse.move(width / 2, 110); await page.mouse.down();
              await page.waitForTimeout(150); await page.mouse.move(width / 2 + 35, 135, { steps: 8 }); await page.mouse.up();
              await page.mouse.wheel(0, -180); await canvasRest(page, driver.context, 2);
              const panned = await canvasState(page, driver.context);
              expect(panned.nodes.map((n: any) => [n.id, n.at])).toEqual(positions);
              expect(panned.zoom).toBeGreaterThan(dragged.zoom);
              expect(panned.camera).not.toEqual(dragged.camera);
              // Pointer-select a real plate; the following release must not clear it.
              await driver.selectRecord(); await closeCanvasDocks(page, driver.context);
              const named = (await canvasState(page, driver.context)).edges.find((e: any) => e.style.labelOpacity === 1 && e.style.labelText && e.style.labelBackground);
              const plateAt = await canvasPoint(page, named.id, true, driver.context);
              await page.mouse.click(plateAt.x, plateAt.y);
              await expect(driver.reader().locator('h2')).toBeVisible();
              if (driver.context === 'source') {
                await expect(driver.reader().locator('[data-reference-status]')).toHaveText('resolved');
                await expect(page.locator('.source-field-list [data-field-reference]')).toHaveAttribute('aria-pressed', 'true');
                await driver.reader().getByRole('button', { name: 'open referenced record', exact: true }).press('Enter');
                await expect(driver.reader().locator('h2')).toHaveAccessibleName('Album, AlbumId=1');
                await driver.reader().getByRole('button', { name: 'Back', exact: true }).press('Enter');
                await expect(driver.reader().locator('[data-reference-status]')).toHaveText('resolved');
                await driver.reader().getByRole('button', { name: 'hide connection', exact: true }).click();
                // Hiding takes only the connection: both records stand where they were.
                await canvasRest(page, driver.context, 2);
                const hidden = await canvasState(page, driver.context);
                expect(hidden.edges).toHaveLength(0);
                expect(hidden.nodes.map((n: any) => [n.id, n.at])).toEqual(positions);
              } else {
                await expect(driver.reader()).toContainText('track_on_album');
                await driver.reader().getByRole('button', { name: 'Back', exact: true }).press('Enter');
                await expect(driver.reader().locator('h2')).toHaveText('Evil Walks');
              }
              expect(await handle.evaluate((graph, context) => graph === (window as any)[context === 'source' ? '__sourceFieldGraph' : '__worldFieldGraph'], driver.context)).toBe(true);
              await handle.dispose(); expect(errors).toEqual([]);
              if (driver.context === 'source') expect(worldReads).toEqual([]);
            } finally { await page.close(); }
          }
          expect(glyphs[0]).toEqual(glyphs[1]);
        }, Number(process.env.KI_SOURCE_VITE_PORT ?? 8143));
      });
    });
  }
}

/** The selection box against the plate it is on, in viewport pixels. */
async function plateAndAnts(page: import('@playwright/test').Page, context: 'source' | 'world', id: string) {
  return page.evaluate(({ id, context }) => {
    const graph = (window as any)[context === 'source' ? '__sourceFieldGraph' : '__worldFieldGraph'];
    const host = graph.getCanvas().getContainer().getBoundingClientRect();
    const box = graph.context.element.getElement(id).getShape('label').getShape('background').getBounds();
    const a = graph.getViewportByCanvas(box.min), b = graph.getViewportByCanvas(box.max);
    const ants = document.querySelector('.ants__mark')?.getBoundingClientRect();
    return { plate: [a[0] + host.left, a[1] + host.top, b[0] + host.left, b[1] + host.top],
      ants: ants ? [ants.left, ants.top, ants.right, ants.bottom] : null };
  }, { id, context });
}

/** Each shown plate against its name: the plate at its station, the name lowered
 * by the capital centring this page measures, one line whatever the edge. */
async function plateNames(page: import('@playwright/test').Page, context: 'source' | 'world') {
  return page.evaluate(async ({ context }) => {
    const graph = (window as any)[context === 'source' ? '__sourceFieldGraph' : '__worldFieldGraph'];
    const measure = document.createElement('canvas').getContext('2d')!;
    const centre = (box: any) => (box.min[1] + box.max[1]) / 2;
    return graph.getEdgeData().filter((e: any) => e.style.labelOpacity === 1 && e.style.labelText && e.style.labelBackground).map((e: any) => {
      const label = graph.context.element.getElement(e.id).getShape('label');
      measure.font = `${e.style.labelFontWeight} ${e.style.labelFontSize}px ${e.style.labelFontFamily}`;
      measure.textBaseline = 'middle';
      const capital = measure.measureText('H');
      return { id: e.id, wrap: e.style.labelWordWrap, dy: e.style.labelDy,
        measured: (capital.actualBoundingBoxAscent - capital.actualBoundingBoxDescent) / 2,
        lowered: centre(label.getShape('text').getBounds()) - centre(label.getShape('background').getBounds()) };
    });
  }, { context });
}

// Hovering an endpoint restations a selected bond's name without a draw. The
// box must follow the name: World retraces on its station subjects; Source
// once traced only on selection, so the box stayed at the old station.
for (const reducedMotion of ['reduce', 'no-preference'] as const) {
  test(`a selected plate's box follows its name when hover moves it, and names sit centred: ${reducedMotion}`, async ({ browser }) => {
    test.skip(!prepared(), 'Prepare pinned Chinook');
    await serveSource(UPSTREAM, async ({ origin }) => {
      await serve(UPSTREAM, 'examples/chinook/declaration.json', async (readingOrigin) => {
        for (const Driver of [SourceCanvasDriver, ReadingCanvasDriver]) {
          const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion });
          const driver = new Driver(page, Driver === SourceCanvasDriver ? origin : readingOrigin);
          try {
            await driver.place(); await driver.connect();
            await closeCanvasDocks(page, driver.context);
            let named = (await canvasState(page, driver.context)).edges.find((e: any) => e.style.labelOpacity === 1 && e.style.labelText && e.style.labelBackground);
            // A long bond, so its name has two distinct stations to stand at.
            const [from, to] = await Promise.all([named.source, named.target].map((id: string) => canvasPoint(page, id, false, driver.context)));
            const span = Math.hypot(to.x - from.x, to.y - from.y), reach = 420;
            const goal = { x: Math.min(1380, Math.max(60, from.x + (to.x - from.x) / span * reach)), y: Math.min(940, Math.max(60, from.y + (to.y - from.y) / span * reach)) };
            await page.mouse.move(to.x, to.y); await page.mouse.down(); await page.waitForTimeout(150);
            await page.mouse.move(goal.x, goal.y, { steps: 12 }); await page.mouse.up();
            await canvasRest(page, driver.context, 2);
            named = (await canvasState(page, driver.context)).edges.find((e: any) => e.id === named.id);
            const at = await canvasPoint(page, named.id, true, driver.context);
            await page.mouse.click(at.x, at.y);
            await closeCanvasDocks(page, driver.context);
            await page.mouse.move(5, 995); await canvasRest(page, driver.context, 2);
            const before = await plateAndAnts(page, driver.context, named.id);
            // Names are centred on their capitals; plates do not move to do it.
            const names = await plateNames(page, driver.context);
            expect(names.length).toBeGreaterThan(0);
            for (const name of names) {
              expect(name.wrap, name.id).toBe(false);
              expect(name.dy, name.id).toBeGreaterThan(0.5);
              expect(Math.abs(name.dy - name.measured), name.id).toBeLessThan(0.01);
              expect(Math.abs(name.lowered - name.dy), name.id).toBeLessThan(0.01);
            }
            for (let i = 0; i < 4; i++) expect(Math.abs(before.ants![i] - before.plate[i])).toBeLessThan(1);
            // Hover the endpoint the name is not standing at.
            const centre = [(before.plate[0] + before.plate[2]) / 2, (before.plate[1] + before.plate[3]) / 2];
            const ends = await Promise.all([named.source, named.target].map((id: string) => canvasPoint(page, id, false, driver.context)));
            const far = ends.sort((p, q) => Math.hypot(q.x - centre[0], q.y - centre[1]) - Math.hypot(p.x - centre[0], p.y - centre[1]))[0];
            await page.mouse.move(far.x, far.y, { steps: 5 }); await canvasRest(page, driver.context, 2);
            const after = await plateAndAnts(page, driver.context, named.id);
            // The name really moved, and the box moved with it.
            expect(Math.hypot((after.plate[0] + after.plate[2]) / 2 - centre[0], (after.plate[1] + after.plate[3]) / 2 - centre[1])).toBeGreaterThan(20);
            for (let i = 0; i < 4; i++) expect(Math.abs(after.ants![i] - after.plate[i]), `${driver.context} box edge ${i}`).toBeLessThan(1);
          } finally { await page.close(); }
        }
      }, Number(process.env.KI_SOURCE_VITE_PORT ?? 8143));
    });
  });
}

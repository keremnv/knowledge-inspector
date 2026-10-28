/** KI-010: actual CLI output, actual UI, real disposable unchanged SQLite.
 * Legacy dictionary path is labelled API compatibility evidence, not an
 * external declaration claim. Governed/expedition preservation has its own
 * recorded-contract and real expedition regressions.
 */
import { test as base, expect, type Page } from '@playwright/test';
import type { Graph } from '@antv/g6';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, mkdir } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

type ReadingName = 'a' | 'b' | 'neutral' | 'legacy';
type Sources = { origins: Record<ReadingName, string>; digests: Record<string, string> };
const test = base.extend<{}, { sources: Sources }>({
  sources: [async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'ki-attribution-browser-'));
    const child = spawn('python3', ['-u', 'tests/fixtures/reading_attribution.py', directory,
      ...(process.env.KI_ATTRIBUTION_SERVER_ROOT ? [process.env.KI_ATTRIBUTION_SERVER_ROOT] : [])]);
    const output = createInterface({ input: child.stdout });
    let errors = '';
    child.stderr.on('data', data => { errors += data; });
    const proxies: Server[] = [];
    try {
      const info = await new Promise<{ ports: Record<ReadingName, number>; digests: Record<string, string>; source: string; before: { sha256: string; mtime_ns: number } }>((resolve, reject) => {
        output.once('line', line => { try { resolve(JSON.parse(line)); } catch (error) { reject(error); } });
        child.once('error', reject);
        child.once('exit', code => reject(new Error(`Fixture exited ${code}: ${errors}`)));
      });
      const sourceTime = (await stat(info.source)).mtimeMs;
      const origins = {} as Record<ReadingName, string>;
      for (const [name, port] of Object.entries(info.ports)) {
        const proxy = createServer((incoming, outgoing) => {
          const target = new URL(incoming.url ?? '/', incoming.url?.startsWith('/world/') ? `http://127.0.0.1:${port}` : 'http://127.0.0.1:8143');
          const upstream = request(target, { method: incoming.method, headers: { ...incoming.headers, host: target.host } }, response => {
            outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
          });
          upstream.on('error', error => { outgoing.writeHead(502); outgoing.end(error.message); });
          incoming.pipe(upstream);
        });
        proxies.push(proxy);
        proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
        const address = proxy.address();
        if (!address || typeof address === 'string') throw new Error('Missing proxy port');
        origins[name as ReadingName] = `http://127.0.0.1:${address.port}`;
      }
      await use({ origins, digests: info.digests });
      expect(createHash('sha256').update(await readFile(info.source)).digest('hex')).toBe(info.before.sha256);
      expect((await stat(info.source)).mtimeMs).toBe(sourceTime);
    } finally {
      for (const proxy of proxies) {
        proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve()));
      }
      output.close();
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, 'exit'); child.stdin.end(); await stopped;
      }
      expect(child.exitCode, errors).toBe(0);
      await rm(directory, { recursive: true, force: true });
    }
  }, { scope: 'worker' }],
});

const reader = (page: Page) => page.locator('.node-reader .motion-swap__is');
async function openRow(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Table subject' }).getByRole('button', { name: 'world', exact: true }).click();
  await page.locator('.table__row').filter({ has: page.locator(`[title="${name}"]`) }).click();
  await page.locator(`section[aria-label="${name} extension"] .table__row[data-loaded]`).first().click();
  await expect(reader(page).locator('h2')).toHaveText(name);
}
async function evidence(page: Page, name: string) {
  if (!process.env.KI_ATTRIBUTION_EVIDENCE) return;
  await mkdir(process.env.KI_ATTRIBUTION_EVIDENCE, { recursive: true });
  await page.screenshot({ path: join(process.env.KI_ATTRIBUTION_EVIDENCE, `${name}.png`) });
}

for (const [name, relation, role, origin, state] of [
  ['a', 'step', 'participant', 'SEMANTIC', 'ADOPTED'],
  ['b', 'passage', 'operator', 'MECHANICAL', 'REJECTED'],
] as const) {
  test(`external reading ${name}: reading, relation and occurrence attribution are inspectable`, async ({ page, sources }) => {
    await page.goto(sources.origins[name]);
    // Decode through the real read-plane API, not a mocked descriptor.
    const overview = await page.evaluate(async () => (await import('/src/api/world.ts')).worldApi.overview());
    expect(overview.reading?.declaration_digest).toBe(sources.digests[name]);
    await page.getByText('Reading attribution', { exact: true }).click();
    const reading = page.locator('.world-reading');
    await expect(reading).toContainText('external reader declaration');
    await expect(reading).toContainText(sources.digests[name]);
    await expect(reading).toContainText('Reading note supplied by the declaration: A reader note, not a producer statement.');
    await expect(reading).toContainText('not semantic correctness, human authorship or producer endorsement');
    await expect(reading).toContainText('display-label column: name');
    await reading.getByText('Adapter compatibility values', { exact: true }).click();
    await expect(reading).toContainText('warrant bases and candidate associations are empty compatibility shapes');
    await evidence(page, `reading-${name}`);
    await page.getByText('Reading attribution', { exact: true }).click();
    // Explicit mechanical construction retains its existing SHOW default.
    if (origin === 'MECHANICAL') {
      await page.locator('.world-filter__summary').hover();
      await page.locator('.world-show__filter[data-layer="mechanical"]').click();
    }
    // Relation disclosure reached through the actual schema canvas.
    await expect.poll(() => page.evaluate((rel) =>
      (window as Window & { __worldVocabulary?: Graph }).__worldVocabulary?.getNodeData().some(n => n.id === `rel:${rel}`), relation)).toBe(true);
    await page.evaluate(rel => (window as Window & { __worldVocabulary?: Graph }).__worldVocabulary!.emit('node:click', { target: { id: `rel:${rel}` } }), relation);
    await expect(reader(page).locator('h2')).toHaveText(relation);
    await reader(page).getByText('Relation reading attribution', { exact: true }).click();
    await expect(reader(page)).toContainText(`Relation name ${relation} supplied by reader declaration.`);
    await expect(reader(page)).toContainText('Source: SQLite view v_hop');
    await expect(reader(page)).toContainText(`Declared role ${role} → source column who`);
    await evidence(page, `relation-${name}`);
    await openRow(page, relation);
    // Same raw value retained; declaration attribution is available next to it.
    await expect(reader(page).locator('[data-occurrence-state]')).toHaveAttribute('data-occurrence-state', state);
    const disclosure = reader(page).locator('.world-attribution');
    if (!(await disclosure.evaluate(node => (node as HTMLDetailsElement).open))) await disclosure.locator('summary').click();
    await expect(disclosure).toContainText(`Construction origin supplied by reader declaration: ${origin}.`);
    await expect(disclosure).toContainText(`Occurrence state supplied by reader declaration: ${state}.`);
    await expect(reader(page)).toContainText('output of view v_hop for flow_id=F1, seq=1');
    await expect(disclosure).toContainText('declaration validation does not verify meaning');
    await evidence(page, `occurrence-${name}`);
  });
}

test('same producer rows support different attributed readings through real HTTP', async ({ page, sources }) => {
  await page.goto(sources.origins.a);
  const a = await page.evaluate(async () => ({
    overview: await fetch('/world/overview').then(r => r.json()),
    assertion: await fetch('/world/assertion?id=step:F1/1').then(r => r.json()),
  }));
  await page.goto(sources.origins.b);
  const b = await page.evaluate(async () => ({
    overview: await fetch('/world/overview').then(r => r.json()),
    assertion: await fetch('/world/assertion?id=passage:F1/1').then(r => r.json()),
  }));
  expect(a.overview.world_id).not.toBe(b.overview.world_id);
  expect(a.overview.reading.declaration_digest).not.toBe(b.overview.reading.declaration_digest);
  expect(a.assertion.grounding).toEqual(b.assertion.grounding);
  expect(a.assertion.values.participant).toBe(b.assertion.values.operator);
  expect(a.assertion.values.flow).toBe(b.assertion.values.flow);
  expect(a.assertion.occurrence_state).toBe('ADOPTED');
  expect(b.assertion.occurrence_state).toBe('REJECTED');
});

test('neutral external reading discloses undeclared classification and ordinary navigation', async ({ page, sources }) => {
  await page.goto(sources.origins.neutral);
  await expect(page.getByRole('button', { name: 'obligations', exact: true })).toHaveCount(0);
  await page.getByText('Reading attribution', { exact: true }).click();
  await expect(page.locator('.world-reading')).toContainText(sources.digests.neutral);
  await page.getByText('Reading attribution', { exact: true }).click();
  await openRow(page, 'step');
  await expect(reader(page).locator('[data-occurrence-state]')).toHaveCount(0);
  await expect(reader(page).locator('.node-reader__kind')).toHaveCount(0);
  await reader(page).getByText('Relation reading attribution', { exact: true }).click();
  await expect(reader(page).locator('.world-attribution')).toContainText('No construction origin declared.');
  await expect(reader(page).locator('.world-attribution')).toContainText('No occurrence state declared.');
  await expect(reader(page)).not.toContainText('No candidate');
  await evidence(page, 'neutral-occurrence');
  // Return to the referent through normal role navigation.
  await reader(page).locator('.world__roles').getByRole('button', { name: 'first', exact: true }).click();
  await expect(reader(page).locator('h2')).toHaveText('first');
  await expect(reader(page)).toContainText('step');
});

test('legacy API without attribution loads and never guesses an authoring layer', async ({ page, sources }) => {
  await page.goto(sources.origins.legacy);
  const overview = await page.evaluate(async () => (await import('/src/api/world.ts')).worldApi.overview());
  expect(overview).not.toHaveProperty('reading');
  await expect(page.locator('.world-reading')).toHaveCount(0);
  await openRow(page, 'step');
  await expect(reader(page).locator('.world-attribution')).toHaveCount(0);
  await expect(reader(page)).not.toContainText('reader declaration');
  await expect(reader(page)).toContainText('output of view v_hop');
});

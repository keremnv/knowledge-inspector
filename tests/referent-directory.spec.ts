/** KI-019/020: real disposable SQLite + generic adapter HTTP + browser UI.
 * Only shortDirectory overrides /world/referents to make the latent fallback
 * reachable. Search/labels/reader/expansion use real adapter responses.
 * One search test adds an unrelated category to verify frontend filtering. */
import { test as base, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const test = base.extend<{}, { sourceOrigin: string }>({
  sourceOrigin: [async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'ki-referent-directory-browser-'));
    const path = join(directory, 'source.sqlite');
    const script = `
import json,sys,signal
from pathlib import Path
from http.server import ThreadingHTTPServer
sys.path.insert(0,'adapters/world')
import server as w
from test_referent_directory import build_fixture
p=Path(sys.argv[1]);decl=build_fixture(p)
prepared=w.prepare_world(p,decl)
w.Handler.db_path=prepared.snapshot_path;w.Handler.model=prepared.model
w.Handler.world_id=prepared.world_id;w.Handler.fingerprint=prepared.fingerprint
w.Handler.snapshot_mode=True;w.Handler.db_connect=staticmethod(w.connect_snapshot)
s=ThreadingHTTPServer(('127.0.0.1',0),w.Handler)
signal.signal(signal.SIGTERM,lambda *_:sys.exit(0))
print(json.dumps({'port':s.server_port}),flush=True)
try:s.serve_forever()
finally:s.server_close();prepared.cleanup()
`;
    const child = spawn('python3', ['-u', '-c', script, path]);
    const output = createInterface({ input: child.stdout });
    let errors = '';
    child.stderr.on('data', data => { errors += data; });
    const proxy = createServer();
    try {
      const port = await new Promise<number>((resolve, reject) => {
        output.once('line', line => { try { resolve(JSON.parse(line).port); } catch (error) { reject(error); } });
        child.once('error', reject);
        child.once('exit', code => reject(new Error(`Adapter exited (${code}): ${errors}`)));
      });
      const digest = async () => createHash('sha256').update(await readFile(path)).digest('hex');
      const before = await digest();
      const mtime = (await stat(path)).mtimeMs;
      proxy.on('request', (incoming, outgoing) => {
        const target = new URL(incoming.url ?? '/', incoming.url?.startsWith('/world/')
          ? `http://127.0.0.1:${port}` : 'http://127.0.0.1:8143');
        const upstream = request(target, { method: incoming.method,
          headers: { ...incoming.headers, host: target.host } }, response => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        });
        upstream.on('error', error => { outgoing.writeHead(502); outgoing.end(error.message); });
        incoming.pipe(upstream);
      });
      proxy.listen(0, '127.0.0.1');
      await once(proxy, 'listening');
      const address = proxy.address();
      if (!address || typeof address === 'string') throw new Error('Missing proxy port');
      await use(`http://127.0.0.1:${address.port}`);
      expect(await digest()).toBe(before);
      expect((await stat(path)).mtimeMs).toBe(mtime);
      expect(await readdir(directory)).toEqual(['source.sqlite']);
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
      output.close();
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped;
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, { scope: 'worker' }],
});

const reader = (page: Page) => page.locator('.node-reader .motion-swap__is');
const fieldIds = (page: Page) => page.evaluate(() => {
  const graph = (window as unknown as { __worldFieldGraph?: { getNodeData(): { id: string }[] } }).__worldFieldGraph;
  return graph?.getNodeData().map(node => String(node.id)) ?? [];
});

const option = (page: Page, id: string) => page.getByRole('option').filter({
  has: page.locator('.nodefind__anchor').filter({ hasText: new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
});

async function find(page: Page, query: string, id: string) {
  await page.getByRole('combobox').fill(query);
  await expect(option(page, id)).toBeVisible();
  await option(page, id).click();
  await expect(reader(page).locator('h2')).toBeVisible();
  await expect(reader(page).locator('.world-reader__heading p')).toContainText(id);
}

async function shortDirectory(page: Page) {
  // Generic adapter currently returns all IDs with truncated:false. Override
  // this response only, omitting all but one unrelated ordinary neighbour.
  await page.route('**/world/referents', async route => {
    const response = await route.fetch();
    const body = await response.json();
    expect(body.truncated).toBe(false);
    await route.fulfill({ response, json: {
      ...body, referents: body.referents.filter((r: { id: string }) => r.id === 'flow:F2'), truncated: true,
    } });
  });
}

// A scalar row inside an occurrence's own block: the value is the occurrence's.
const scalar = (page: Page, label: string) => reader(page).locator('.world-occurrence .world__roles li')
  .filter({ has: page.locator('b').filter({ hasText: new RegExp(`^${label}$`) }) });
const occurrence = (page: Page, id: string) =>
  reader(page).locator(`.world-occurrence[data-assertion-id="${id}"]`);
const occurrences = (page: Page) => reader(page).locator('.world-occurrence');

async function openReferentFromTable(page: Page, relation: string, label: string) {
  await page.locator('.table__row').filter({ has: page.locator(`[title="${relation}"]`) }).click();
  await page.locator(`section[aria-label="${relation} extension"] .table__row[data-loaded]`).first().click();
  await expect(reader(page).locator('h2')).toHaveText(relation);
  await reader(page).locator('.world__roles').getByRole('button', { name: label, exact: true }).click();
  await expect(reader(page).locator('h2')).toHaveText(label);
}

// This is an actual user update (expand, retract), with the scalar DOM nodes
// retained. No claim is made that baseline duplicate keys corrupted a reorder.
test('named scalar roles stay in their occurrence, with its id, state and stable nodes across expansion', async ({ page, sourceOrigin }, testInfo) => {
  const warnings: string[] = [];
  page.on('console', message => { if (/same key|unique.*key/i.test(message.text())) warnings.push(message.text()); });
  await page.goto(sourceOrigin);
  await openReferentFromTable(page, 'determination', 'Second flow');
  const block = occurrence(page, 'determination:1');
  await expect(occurrences(page)).toHaveCount(1);
  const basis = scalar(page, 'basis');
  const date = scalar(page, 'date');
  await expect(basis).toHaveCount(1);
  await expect(date).toHaveCount(1);
  await expect(basis.locator('span')).toHaveText('recorded basis');
  await expect(date.locator('span')).toHaveText('2026-01-01');
  // The state belongs to the occurrence's block, not the referent's header.
  await expect(block.locator('[data-occurrence-state]')).toHaveText('recorded');
  await expect(reader(page).locator('.world-reader__header [data-occurrence-state]')).toHaveCount(0);
  // The occurrence is named in visible text, and reachable by name.
  await expect(block.getByRole('button', { name: 'Open occurrence determination:1' })).toHaveText('determination:1');
  await expect(reader(page)).not.toContainText('scalar field preview');
  await expect(reader(page)).toContainText('1 of 1 occurrences shown.');
  const nodes = [await basis.elementHandle(), await date.elementHandle()];
  const expansion = reader(page).getByRole('button', { name: 'network 1', exact: true });
  await expansion.click();
  await expect(reader(page).getByRole('button', { name: 'network take off', exact: true })).toBeVisible();
  for (const node of nodes) expect(await node!.evaluate(el => el.isConnected)).toBe(true);
  await reader(page).getByRole('button', { name: 'network take off', exact: true }).click();
  for (const node of nodes) expect(await node!.evaluate(el => el.isConnected)).toBe(true);
  expect(warnings).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('named-roles.png') });
  await block.getByRole('button', { name: 'Open occurrence determination:1' }).click();
  await expect(reader(page).locator('h2')).toHaveText('determination');
  await expect(reader(page)).toContainText('row id=1 in determination');
  await expect(reader(page).locator('[data-occurrence-state]')).toHaveText('recorded');
  await reader(page).getByRole('button', { name: /back/i }).click();
  await expect(reader(page).locator('h2')).toHaveText('Second flow');
});

test('bounded preview counts occurrences separately from scalar values and keeps full expansion', async ({ page, sourceOrigin }, testInfo) => {
  await page.goto(sourceOrigin);
  await openReferentFromTable(page, 'inspection', 'Many occurrences');
  const section = reader(page).locator('section[aria-label="inspection occurrences mentioning Many occurrences"]');
  await expect(section).toContainText('100 of 105 occurrences shown.');
  await expect(section).toContainText('A bounded preview, not the complete set: expand through this relation to read all occurrences.');
  // 100 occurrences with two scalar roles each: 100 blocks, 200 values.
  await expect(occurrences(page)).toHaveCount(100);
  await expect(reader(page).locator('.world-occurrence .world__roles li')).toHaveCount(200);
  const values = reader(page).locator('.world-occurrence .world__roles li > span');
  await expect(values.nth(0)).toHaveText('0');
  await expect(values.nth(1)).toHaveText('""');
  await expect(values.nth(2)).toHaveText('NULL');
  await expect(values.nth(3)).toHaveText('NULL');
  await expect(values.nth(4)).toHaveText('1.5');
  await expect(values.nth(5)).toHaveText('note 3');
  // Each value row sits in the block of the occurrence that states it.
  await expect(occurrence(page, 'inspection:1').locator('.world__roles li > span')).toHaveText(['0', '""']);
  await expect(occurrence(page, 'inspection:2').locator('.world__roles li > span')).toHaveText(['NULL', 'NULL']);
  await expect(occurrence(page, 'inspection:3').locator('.world__roles li > span')).toHaveText(['1.5', 'note 3']);
  await page.screenshot({ path: testInfo.outputPath('sampling-preview.png') });
  const read = page.waitForResponse(response => response.url().includes('/world/rows?') &&
    new URL(response.url()).searchParams.get('relation') === 'inspection');
  await reader(page).getByRole('button', { name: 'inspection 105', exact: true }).click();
  expect((await (await read).json()).total).toBe(105);
  await expect(reader(page).getByRole('button', { name: 'inspection take off', exact: true })).toBeVisible();
  await expect.poll(async () => (await fieldIds(page)).filter(id => id.startsWith('inspection:')).length).toBe(105);
  await page.getByRole('navigation', { name: 'Table subject' }).getByRole('button', { name: 'world', exact: true }).click();
  await page.locator('.table__row').filter({ has: page.locator('[title="inspection"]') }).click();
  await expect(page.locator('section[aria-label="inspection extension"]')).toContainText('105');
});

test('complete directory finds labels and opaque IDs locally and ordinary navigation still works', async ({ page, sourceOrigin }) => {
  const searches: string[] = [];
  page.on('request', req => { if (req.url().includes('/world/search?')) searches.push(req.url()); });
  await page.goto(sourceOrigin);
  await page.getByRole('combobox').fill('flow,kind:F2');
  await expect(option(page, 'flow,kind:F2')).toContainText('Second flow');
  await page.getByRole('combobox').fill('Second flow');
  await expect(option(page, 'flow,kind:F2')).toContainText('Second flow');
  await option(page, 'flow,kind:F2').click();
  await expect(reader(page).locator('h2')).toHaveText('Second flow');
  await reader(page).getByRole('button', { name: 'Open occurrence determination:1' }).click();
  await expect(reader(page).locator('h2')).toHaveText('determination');
  expect(searches).toEqual([]);
});

for (const query of ['Second flow', 'flow,kind:F2', 'F2']) {
  test(`short directory selects real generic search candidate by ${query}`, async ({ page, sourceOrigin }) => {
    await shortDirectory(page);
    // Add a real-contract unrelated category; preserve every generic result.
    await page.route('**/world/search?**', async route => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, results: [
        ...body.results, { kind: 'assertion', id: 'determination:1', label: 'Irrelevant candidate' },
      ] } });
    });
    await page.goto(sourceOrigin);
    const searched = page.waitForResponse(response => response.url().includes('/world/search?'));
    await page.getByRole('combobox').fill(query);
    const result = await (await searched).json();
    expect(result.results).toContainEqual(expect.objectContaining({ kind: 'referent', id: 'flow,kind:F2', label: 'Second flow' }));
    await expect(option(page, 'flow,kind:F2')).toBeVisible();
    await expect(option(page, 'flow,kind:F2')).toHaveCount(1);
    if (query === 'F2') await expect(option(page, 'flow:F2')).toHaveCount(1);
    await expect(page.getByRole('option').filter({ hasText: 'Irrelevant candidate' })).toHaveCount(0);
    const opened = page.waitForResponse(response => response.url().includes('/world/referent?'));
    await option(page, 'flow,kind:F2').click();
    expect((await (await opened).json()).id).toBe('flow,kind:F2');
    await expect(reader(page).locator('h2')).toHaveText('Second flow');
    await expect.poll(() => fieldIds(page)).toEqual(['flow,kind:F2']);
  });
}

test('short directory expansion looks up multiple intact opaque neighbours', async ({ page, sourceOrigin }) => {
  await shortDirectory(page);
  await page.goto(sourceOrigin);
  await find(page, 'Second flow', 'flow,kind:F2');
  const lookup = page.waitForResponse(response => response.url().includes('/world/labels?'));
  await reader(page).getByRole('button', { name: 'network 1', exact: true }).click();
  const response = await lookup;
  const params = new URL(response.url()).searchParams;
  const reserved = 'flow,kind:key%2C%3F%2F%23%2B%26%25%20%CE%A9';
  expect(params.getAll('id')).toEqual(['flow,kind:F2', reserved, 'Flow,kind:F2']);
  expect(params.has('ids')).toBe(false);
  expect((await response.json()).labels).toEqual({
    'flow,kind:F2': 'Second flow', [reserved]: 'Reserved neighbour', 'Flow,kind:F2': 'Capital flow',
  });
  await expect(reader(page).getByRole('button', { name: 'network take off', exact: true })).toBeVisible();
  await expect.poll(async () => (await fieldIds(page)).filter(id => /^(flow|Flow)/.test(id)).sort())
    .toEqual(['Flow,kind:F2', 'flow,kind:F2', reserved, 'flow:F2'].sort());
  // The real assertion's role links use the fetched labels, and select the
  // canonical neighbour through the ordinary reader navigation path.
  await page.getByRole('navigation', { name: 'Table subject' }).getByRole('button', { name: 'world', exact: true }).click();
  await page.locator('.table__row').filter({ has: page.locator('[title="network"]') }).click();
  await page.locator('section[aria-label="network extension"] .table__row[data-loaded]').first().click();
  await expect(reader(page)).toContainText('Reserved neighbour');
  await expect(reader(page)).toContainText('Ordinary flow');
  await expect(reader(page)).toContainText('Capital flow');
  await reader(page).getByRole('button', { name: 'Reserved neighbour', exact: true }).click();
  await expect(reader(page).locator('h2')).toHaveText('Reserved neighbour');
  await expect(reader(page).locator('.world-reader__heading p')).toContainText(reserved);
});


test('client retains legacy label framing for comma-free opaque IDs', async ({ page, sourceOrigin }) => {
  await page.goto(sourceOrigin);
  const reserved = 'flow:key%2C%3F%2F%23%2B%26%25%20%CE%A9';
  const ids = ['flow:F2', reserved, 'number:1', 'number:01'];
  const lookup = page.waitForResponse(response => response.url().includes('/world/labels?'));
  const labels = await page.evaluate(async ids => {
    const { worldApi } = await import('/src/api/world.ts');
    return worldApi.labels(ids);
  }, ids);
  const params = new URL((await lookup).url()).searchParams;
  expect(params.get('ids')).toBe(ids.join(','));
  expect(params.has('id')).toBe(false);
  expect(labels).toEqual({ 'flow:F2': 'Ordinary flow', [reserved]: 'Ordinary reserved',
    'number:1': 'Number one', 'number:01': null });
});

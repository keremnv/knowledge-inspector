/** KI-004 / assertion portion of KI-018: actual expedition HTTP responses.
 * The legacy fixtures were captured from server.derivation over seed.build
 * in examples/sqlite-demo at f5b2b71ffe9fbb51cd82dd6ceb170dbb5c1aaaa1.
 * Its _demo_run table records the SQL, input counts and output cardinality.
 */
import { test as base, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import legacy from './fixtures/legacy-demo-derivations.json' with { type: 'json' };
import type { WorldAssertion, WorldDerivation } from '../src/api/world';
import type { Graph } from '@antv/g6';

type MetadataWindow = Window & {
  __worldVocabulary?: Graph;
  metadataExecuted?: boolean;
};

const test = base.extend<{}, { sourceOrigin: string }>({
  sourceOrigin: [async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'ki-metadata-browser-'));
    const path = join(directory, 'expedition.sqlite');
    const child = spawn('python3', ['-u', '-c', `
import json,sys
from pathlib import Path
from http.server import ThreadingHTTPServer
from examples.expedition.seed import build
from examples.expedition import server as w
p=build(Path(sys.argv[1]));d=w.connect(p)
try: model=w.Model(d)
finally: d.close()
w.Handler.db_path=p;w.Handler.model=model
w.Handler.world_id='expedition:'+w.file_sha256(p)[:12]
s=ThreadingHTTPServer(('127.0.0.1',0),w.Handler)
print(json.dumps({'port':s.server_port}),flush=True);s.serve_forever()
`, path]);
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
async function openAssertion(page: Page, origin: string, relation: string) {
  await page.goto(origin);
  await page.locator('.table__row').filter({ has: page.locator(`[title="${relation}"]`) }).click();
  await page.locator(`section[aria-label="${relation} extension"] .table__row[data-loaded]`).first().click();
  await expect(reader(page).locator('h2')).toHaveText(relation);
}

test('a real view exposes its supplied SQL, lineage qualification and source details', async ({ page, sourceOrigin }) => {
  await openAssertion(page, sourceOrigin, 'determination');
  const assertion: WorldAssertion = await page.evaluate(() =>
    fetch('/world/assertion?id=determination:1').then(r => r.json()));
  const source = assertion.grounding[0];
  expect(assertion.mode).toBe('BASE');
  expect(source.detail?.derivation_definition).toContain('CREATE VIEW v_determination_adopted');
  expect(source.detail?.lineage).toBe('not recorded');
  await expect(reader(page)).toContainText(source.native_handle!);
  await expect(reader(page)).toContainText(source.native_location!);
  await reader(page).getByText('Source metadata', { exact: true }).click();
  const metadata = reader(page).locator('.world__source-metadata');
  await expect(metadata.locator('code')).toHaveText(source.detail!.derivation_definition as string);
  await expect(metadata).toContainText('lineage (source-reported)');
  await expect(metadata).toContainText('not recorded');
  await expect(metadata).toContainText(source.reference);
  await expect(metadata).toContainText(JSON.stringify(source.detail!.reference_participants, null, 2));
});

test('a real stored-table assertion supplies no SQL or invented lineage qualification', async ({ page, sourceOrigin }) => {
  await openAssertion(page, sourceOrigin, 'collection');
  const assertion: WorldAssertion = await page.evaluate(() =>
    fetch('/world/assertion?id=collection:K-118').then(r => r.json()));
  expect(assertion.grounding[0].detail).not.toHaveProperty('derivation_definition');
  expect(assertion.grounding[0].detail).not.toHaveProperty('lineage');
  await reader(page).getByText('Source metadata', { exact: true }).click();
  await expect(reader(page)).toContainText('row catalog_no=K-118 in specimen');
  await expect(reader(page).locator('code')).toHaveCount(0);
  await expect(reader(page)).not.toContainText('lineage (source-reported)');
  await expect(reader(page)).not.toContainText('SQL definition');
});

test('a real conceptual relation with empty metadata makes no negative computation claim', async ({ page, sourceOrigin }) => {
  await page.goto(sourceOrigin);
  await expect.poll(() => page.evaluate(() => {
    const graph = (window as MetadataWindow).__worldVocabulary;
    return graph?.getNodeData().map((node: { id: string }) => node.id) ?? [];
  })).toContain('rel:determination');
  await page.evaluate(() => (window as MetadataWindow).__worldVocabulary!.emit('node:click', { target: { id: 'rel:determination' } }));
  await reader(page).getByRole('button', { name: 'Dependencies' }).click();
  const panel = page.getByRole('region', { name: 'determination derivation' });
  await expect(panel).toContainText('No input dependency metadata recorded for determination.');
  await expect(panel).toContainText('No dependent relation metadata recorded for determination.');
  await expect(panel).toContainText('No derivation run metadata recorded for determination.');
  await expect(panel).not.toContainText(/not computed|rests on nothing|No derivation in this world reads/);
  await expect(panel.getByRole('button', { name: 'rule', exact: true })).toHaveCount(0);
});

test('missing grounding remains distinct from a supplied source with only a reference', async ({ page, sourceOrigin }) => {
  let supplied = false;
  await page.route('**/world/assertion?**', async route => {
    const response = await route.fetch();
    const assertion = await response.json();
    assertion.grounding = supplied ? [{ kind: 'SOURCE', reference: 'source:reference-only' }] : [];
    await route.fulfill({ json: assertion });
  });
  await openAssertion(page, sourceOrigin, 'collection');
  await expect(reader(page)).toContainText('No source grounding recorded.');
  await expect(reader(page).locator('.world__source-metadata')).toHaveCount(0);
  supplied = true;
  await openAssertion(page, sourceOrigin, 'collection');
  await expect(reader(page)).not.toContainText('No source grounding recorded.');
  await reader(page).getByText('Source metadata', { exact: true }).click();
  await expect(reader(page)).toContainText('source:reference-only');
  await expect(reader(page).getByText('provider', { exact: true })).toHaveCount(0);
});

test('optional source fields preserve explicit empty, null and false values and render text safely', async ({ page, sourceOrigin }) => {
  const text = '<img src=x onerror="window.metadataExecuted=true">';
  await page.route('**/world/assertion?**', async route => {
    const response = await route.fetch();
    const assertion = await response.json();
    Object.assign(assertion.grounding[0], {
      provider: text, source_revision: '', construction_method: 'recorded method',
      construction_origin: 'recorded origin', detail_text: text,
      detail: { derivation_definition: text, lineage: null, enabled: false, count: 0, note: '' },
    });
    await route.fulfill({ json: assertion });
  });
  await openAssertion(page, sourceOrigin, 'collection');
  await reader(page).getByText('Source metadata', { exact: true }).click();
  const metadata = reader(page).locator('.world__source-metadata');
  for (const [label, value] of [
    ['provider', text], ['source revision', '""'], ['construction method', 'recorded method'],
    ['construction origin', 'recorded origin'], ['detail text', text],
    ['lineage (source-reported)', 'null'], ['enabled', 'false'], ['count', '0'], ['note', '""'],
  ]) {
    await expect(metadata.locator('dt').filter({ hasText: new RegExp(`^${label.replace(/[()]/g, '\\$&')}$`) }).locator('+ dd')).toHaveText(value);
  }
  await expect(metadata.locator('code')).toHaveText(text);
  await expect(metadata.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as MetadataWindow).metadataExecuted)).toBeUndefined();
});

for (const [relation, missingRevision] of [
  ['citation_count', false], ['paper', false], ['citation_count', true],
] as const) {
  test(`recorded legacy ${relation} dependencies and run details survive${missingRevision ? ' without a run revision' : ''}`, async ({ page, sourceOrigin }) => {
    const payload = structuredClone(legacy[relation]) as WorldDerivation;
    if (missingRevision) payload.run!.last_run_world_revision = null;
    await page.route('**/world/derivation?**', route => route.fulfill({ json: payload }));
    // Mount the real panel with a captured legacy response, independent of
    // the expedition's BASE schema and unrecorded derivation endpoint.
    await page.goto(sourceOrigin);
    await page.evaluate(async relation => {
      const { default: { createElement } } = await import('/node_modules/.vite/deps/react.js');
      const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js');
      const { DerivationView } = await import('/src/world/DerivationView.tsx');
      const host = document.createElement('div'); document.body.replaceChildren(host);
      const noop = () => {};
      createRoot(host).render(createElement(DerivationView, {
        relation, assertionId: null, present: new Set(), onOpen: noop, onTable: noop, onFocus: noop,
        chrome: { current: 'other', hasFrontier: false, hasGovernedObligations: false,
          onWorld: noop, onFrontier: noop, onGoverned: noop, onClose: noop },
      }));
    }, relation);
    const panel = page.getByRole('region', { name: `${relation} derivation` });
    if (relation === 'citation_count') {
      for (const name of ['cites', 'paper']) await expect(panel.locator('.deriv__tree').getByRole('button', { name, exact: true })).toBeVisible();
      await expect(panel).toContainText(`${missingRevision ? 'revision not recorded' : 'rev 1'} · 8 out`);
      await expect(panel).not.toContainText('never');
      await expect(panel).toContainText('succeeded');
      await expect(panel.locator('.deriv__grid').filter({ hasText: 'cites' })).toContainText('v1 · 12');
      await expect(panel.locator('.deriv__grid').filter({ hasText: 'paper' })).toContainText('v1 · 8');
      await panel.getByRole('button', { name: 'rule', exact: true }).click();
      await expect(panel.locator('.deriv__sql')).toHaveText(payload.run!.sql);
      await expect(panel).not.toContainText('No derivation run metadata recorded');
    } else {
      await expect(panel.locator('.deriv__tree').getByRole('button', { name: 'citation_count', exact: true })).toBeVisible();
    }
  });
}

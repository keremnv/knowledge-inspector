/** KI-005: real generic startup snapshot, HTTP responses, browser and storage.
 * No invented API payloads; construction and stance are declared independently
 * only in this disposable test source. Existing producer files stay untouched. */
import { test as base, expect, type Page } from '@playwright/test';
import type { Graph } from '@antv/g6';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

type CanvasWindow = Window & { __worldVocabulary?: Graph; __worldFieldGraph?: Graph };
type Overview = { world_id: string; revision: number };

const test = base.extend<{}, { sourceOrigin: string }>({
  sourceOrigin: [async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'ki-unstated-browser-'));
    const path = join(directory, 'source.sqlite');
    const child = spawn('python3', ['-u', '-c', `
import json,sys,sqlite3
from pathlib import Path
from http.server import ThreadingHTTPServer
from adapters.world import server as w
p=Path(sys.argv[1]);d=sqlite3.connect(p)
d.executescript('''
CREATE TABLE entity(id TEXT PRIMARY KEY,label TEXT);
INSERT INTO entity VALUES('A','A'),('B','B'),('C','C'),('D','D');
CREATE TABLE event(id INTEGER PRIMARY KEY,a TEXT,b TEXT,c TEXT,note TEXT);
INSERT INTO event VALUES(1,'A','B','C','first'),(2,'A','C','D','second');
CREATE TABLE pair(id INTEGER PRIMARY KEY,a TEXT,b TEXT);
INSERT INTO pair VALUES(1,'A','B'),(2,'A','D');
''');d.commit();d.close()
roles=[{'role':role,'column_name':role,'target_kind':'entity'} for role in ['a','b','c']]
roles.append({'role':'note','column_name':'note','target_kind':None})
relations=[]
for name,origin in [('plain',None),('mechanical','MECHANICAL'),('semantic','SEMANTIC'),('adjudicated','ADJUDICATED'),('proposal',None)]:
 r={'name':name,'source':'event','key_columns':['id'],'roles':roles}
 if origin is not None:r['origin']=origin
 if name=='proposal':r['occurrence_state']='PROPOSED'
 relations.append(r)
relations.append({'name':'pair','source':'pair','key_columns':['id'],'roles':roles[:2]})
decl=w.validate_declaration({'version':1,'world':{'id_prefix':'unstatedtest'},
 'entities':[{'kind':'entity','source':'entity','key_columns':['id'],'label_column':'label'}],
 'relations':relations})
prepared=w.prepare_world(p,decl)
w.Handler.db_path=prepared.snapshot_path;w.Handler.model=prepared.model
w.Handler.world_id=prepared.world_id;w.Handler.fingerprint=prepared.fingerprint
w.Handler.snapshot_mode=True;w.Handler.db_connect=staticmethod(w.connect_snapshot)
s=ThreadingHTTPServer(('127.0.0.1',0),w.Handler)
print(json.dumps({'port':s.server_port}),flush=True)
try:s.serve_forever()
except KeyboardInterrupt:pass
finally:prepared.cleanup()
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
      expect(await readdir(directory)).toEqual(['source.sqlite']);
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
      output.close();
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, 'exit'); child.kill('SIGINT'); await stopped;
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, { scope: 'worker' }],
});

const reader = (page: Page) => page.locator('.node-reader .motion-swap__is');
const originChip = (page: Page) => reader(page).locator('.node-reader__kind:not([data-occurrence-state])');
const ids = (page: Page, room: 'schema' | 'field') => page.evaluate(room => {
  const graph = (window as CanvasWindow)[room === 'schema' ? '__worldVocabulary' : '__worldFieldGraph'];
  return [...(graph?.getNodeData() ?? []), ...(graph?.getEdgeData() ?? [])].map(item => String(item.id));
}, room);
const overview = (page: Page): Promise<Overview> => page.evaluate(() => fetch('/world/overview').then(r => r.json()));
const catalogue = (page: Page, name: string) => page.locator('.table__row').filter({ has: page.locator(`[title="${name}"]`) });

async function toggle(page: Page, layer: string, on: boolean) {
  const button = page.locator(`.world-show__filter[data-layer="${layer}"]`);
  if (await button.getAttribute('aria-pressed') === String(on)) return;
  await page.locator('.world-filter__summary').hover();
  await expect(button).toBeVisible();
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', String(on));
}

async function place(page: Page, relation: string) {
  await page.getByRole('navigation', { name: 'Table subject' }).getByRole('button', { name: 'world', exact: true }).click();
  await catalogue(page, relation).click();
  await page.locator(`section[aria-label="${relation} extension"] .table__row[data-loaded]`).first().click();
  await expect(reader(page).locator('h2')).toHaveText(relation);
  await expect.poll(() => ids(page, 'field')).toContain(`${relation}:1`);
}

async function selectSchema(page: Page, relation: string) {
  await expect.poll(() => ids(page, 'schema')).toContain(`rel:${relation}`);
  await page.evaluate(relation => (window as CanvasWindow).__worldVocabulary!.emit('node:click', { target: { id: `rel:${relation}` } }), relation);
  await expect(reader(page).locator('h2')).toHaveText(relation);
}

async function recordedOrigins(page: Page, world: Overview) {
  return page.evaluate(({ world_id, revision }) => {
    const stored = JSON.parse(localStorage.getItem(`worldir.field:${world_id}:${revision}`)!);
    return [...stored.assertions.map(([, item]: [string, { assertion_id: string; origin: string; origins?: string[] }]) => item), ...stored.bonds]
      .map(({ assertion_id, origin, origins }) => ({ assertion_id, origin, origins }))
      .sort((a, b) => a.assertion_id.localeCompare(b.assertion_id));
  }, world);
}

test('actual undeclared origin is neutral and visible in catalogue, schema and reader by default', async ({ page, sourceOrigin }) => {
  await page.goto(sourceOrigin);
  const data = await page.evaluate(async () => ({
    schema: await fetch('/world/schema').then(r => r.json()),
    rows: await fetch('/world/rows?relation=plain').then(r => r.json()),
    assertion: await fetch('/world/assertion?id=plain:1').then(r => r.json()),
  }));
  expect(data.schema.relations.find((item: { name: string }) => item.name === 'plain').origins).toEqual([]);
  expect(data.rows.rows[0].origin).toBe('UNSTATED');
  expect(data.rows.rows[0]).not.toHaveProperty('origins');
  expect(data.assertion).not.toHaveProperty('occurrence_state');
  await expect(catalogue(page, 'plain').getByTitle('unstated', { exact: true })).toHaveText('unstated');
  await expect.poll(() => ids(page, 'schema')).toContain('rel:plain');
  expect(await ids(page, 'schema')).not.toContain('rel:mechanical');
  for (const relation of ['semantic', 'adjudicated']) await expect.poll(() => ids(page, 'schema')).toContain(`rel:${relation}`);
  await selectSchema(page, 'plain');
  await expect(originChip(page)).toHaveText('unstated');
  const style = await page.evaluate(() => (window as CanvasWindow).__worldVocabulary!.getNodeData('rel:plain').style);
  expect(style?.lineWidth).toBe(0);
  expect(await ids(page, 'schema')).not.toContain('shelf:rel:plain');
  expect(await ids(page, 'schema')).not.toContain('crown:rel:plain');
  await reader(page).getByRole('button', { name: 'Dependencies' }).click();
  const dependencies = page.getByRole('region', { name: 'plain derivation' });
  await expect(dependencies).toContainText('No input dependency metadata recorded for plain.');
  await expect(dependencies).toContainText('No dependent relation metadata recorded for plain.');
  await expect(dependencies).toContainText('No derivation run metadata recorded for plain.');
  await expect(dependencies).not.toContainText(/not computed|rests on nothing/);
  await place(page, 'plain');
  await expect(originChip(page)).toHaveText('unstated');
  await expect(reader(page).locator('[data-occurrence-state]')).toHaveCount(0);
  await reader(page).getByText('Source metadata', { exact: true }).click();
  await expect(reader(page).locator('.world__source-metadata')).toContainText(data.assertion.grounding[0].reference);
  await expect(reader(page).locator('.world__source-metadata')).toContainText('reference_participants');
});

test('recorded origins retain independent schema and working-field filters', async ({ page, sourceOrigin }) => {
  await page.goto(sourceOrigin);
  await expect.poll(() => ids(page, 'schema')).toContain('rel:plain');
  for (const [relation, origin] of [['mechanical', 'mechanical'], ['semantic', 'semantic'], ['adjudicated', 'adjudicated']]) {
    await toggle(page, relation, true);
    await selectSchema(page, relation);
    await expect(catalogue(page, relation).locator(`.table__origin[title="${origin}"]`)).toBeVisible();
  }
  await toggle(page, 'unstated', false);
  await expect.poll(() => ids(page, 'schema')).not.toContain('rel:plain');
  for (const relation of ['mechanical', 'semantic', 'adjudicated']) await expect.poll(() => ids(page, 'schema')).toContain(`rel:${relation}`);
  for (const relation of ['mechanical', 'semantic', 'adjudicated']) {
    await place(page, relation);
    await expect(originChip(page)).toHaveText(relation);
    await toggle(page, relation, false);
    await expect.poll(() => ids(page, 'field')).not.toContain(`${relation}:1`);
    await toggle(page, 'unstated', true);
    expect(await ids(page, 'field')).not.toContain(`${relation}:1`);
    await toggle(page, relation, true);
    await expect.poll(() => ids(page, 'field')).toContain(`${relation}:1`);
  }
});

test('row selection, expansion, stance, restore and SHOW retain unstated metadata for plates and bonds', async ({ page, sourceOrigin }) => {
  await page.goto(sourceOrigin);
  const world = await overview(page);
  await place(page, 'plain');
  await expect(originChip(page)).toHaveText('unstated');
  await reader(page).locator('.world__roles').getByRole('button', { name: 'A', exact: true }).click();
  await expect(reader(page).locator('h2')).toHaveText('A');
  await reader(page).locator('.gm__list button').filter({ hasText: 'plain' }).first().click();
  await expect.poll(() => ids(page, 'field')).toContain('plain:2');
  await reader(page).locator('.gm__list button').filter({ hasText: 'pair' }).first().click();
  await expect.poll(() => ids(page, 'field')).toContain('bond:pair:1');
  await toggle(page, 'unstated', false);
  await expect.poll(() => ids(page, 'field')).not.toContain('plain:1');
  await expect.poll(() => ids(page, 'field')).not.toContain('bond:pair:1');
  // Expansion brings back supplied participants without overriding SHOW.
  await reader(page).locator('.gm__list button').filter({ hasText: 'proposal' }).first().click();
  await expect.poll(async () => (await recordedOrigins(page, world)).map(item => item.assertion_id)).toContain('proposal:1');
  expect(await ids(page, 'field')).not.toContain('proposal:1');
  await toggle(page, 'mechanical', true);
  expect(await ids(page, 'field')).not.toContain('plain:1');
  expect(await ids(page, 'field')).not.toContain('bond:pair:1');
  await toggle(page, 'mechanical', false);
  await toggle(page, 'unstated', true);
  await expect.poll(() => ids(page, 'field')).toContain('proposal:1');
  await page.evaluate(() => (window as CanvasWindow).__worldFieldGraph!.emit('node:click', { target: { id: 'proposal:1' } }));
  await expect(originChip(page)).toHaveText('unstated');
  await expect(reader(page).locator('[data-occurrence-state]')).toHaveText('proposal');
  const before = await recordedOrigins(page, world);
  expect(before).toHaveLength(6);
  expect(before.every(item => item.origin === 'UNSTATED' && item.origins === undefined)).toBe(true);
  await page.reload();
  await expect.poll(() => ids(page, 'field')).toContain('plain:2');
  await expect.poll(() => ids(page, 'field')).toContain('bond:pair:1');
  expect(await recordedOrigins(page, world)).toEqual(before);
  await toggle(page, 'unstated', false);
  await page.reload();
  await expect(page.locator('[data-layer="unstated"]')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => ids(page, 'field')).toContain('entity:A');
  expect(await ids(page, 'field')).not.toContain('plain:1');
  expect(await ids(page, 'field')).not.toContain('bond:pair:1');
  await toggle(page, 'mechanical', true);
  expect(await ids(page, 'field')).not.toContain('plain:1');
  await toggle(page, 'unstated', true);
  await expect.poll(() => ids(page, 'field')).toContain('plain:1');
  await expect.poll(() => ids(page, 'field')).toContain('bond:pair:1');
  expect(await recordedOrigins(page, world)).toEqual(before);
});

test('older SHOW preferences preserve existing choices and gain independent neutral visibility', async ({ page, sourceOrigin }) => {
  await page.goto(sourceOrigin);
  const world = await overview(page);
  await place(page, 'plain');
  const previous = { semantic: false, adjudicated: false, derived: false, mechanical: false, unresolved: true };
  await page.evaluate(({ world_id, show }) => localStorage.setItem(`worldir.show:${world_id}`, JSON.stringify({
    version: 1, world: world_id, show, namedAtRest: false, spreadOnSelect: false, framing: true,
  })), { world_id: world.world_id, show: previous });
  await page.reload();
  await expect.poll(() => ids(page, 'field')).toContain('plain:1');
  for (const [layer, on] of Object.entries(previous)) await expect(page.locator(`[data-layer="${layer}"]`)).toHaveAttribute('aria-pressed', String(on));
  await expect(page.locator('[data-layer="unstated"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(world => JSON.parse(localStorage.getItem(`worldir.show:${world}`)!), world.world_id))
    .toMatchObject({ show: { ...previous, unstated: true }, namedAtRest: false, spreadOnSelect: false, framing: true });
  await toggle(page, 'unstated', false);
  await page.reload();
  await expect(page.locator('[data-layer="unstated"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('[data-layer="mechanical"]')).toHaveAttribute('aria-pressed', 'false');
});

test('mark classification and stored SHOW validation keep absence distinct from recorded values', async ({ page, sourceOrigin }) => {
  await page.goto(sourceOrigin);
  const result = await page.evaluate(async () => {
    const { chipKindOf, isAuthored } = await import('/src/world/marks.ts');
    const { chipKind } = await import('/src/world/schemaGraph.ts');
    const { readShow, writeShow } = await import('/src/world/showMemory.ts');
    const { SHOW_DEFAULT } = await import('/src/world/show.ts');
    const schema = await fetch('/world/schema').then(r => r.json());
    const kinds = schema.relations.map((relation: { name: string }) => [relation.name, chipKind(relation)]);
    const missing = [chipKindOf('UNSTATED'), chipKindOf([]), chipKindOf(undefined)];
    const prefs = { show: { ...SHOW_DEFAULT, unstated: false, mechanical: true }, namedAtRest: false, spreadOnSelect: true, framing: false };
    writeShow('validation', prefs);
    const roundTrip = readShow('validation');
    localStorage.setItem('worldir.show:validation', JSON.stringify({ version: 1, world: 'validation', ...prefs, show: { ...prefs.show, unstated: 'false' } }));
    const invalidCategory = readShow('validation');
    localStorage.setItem('worldir.show:validation', JSON.stringify({ version: 2, world: 'validation', ...prefs }));
    const invalidVersion = readShow('validation');
    return { kinds, missing, neutralAuthored: isAuthored('unstated'), roundTrip, prefs, invalidCategory, invalidVersion };
  });
  expect(Object.fromEntries(result.kinds)).toEqual({ plain: 'unstated', pair: 'unstated', proposal: 'unstated', mechanical: 'mechanical', semantic: 'semantic', adjudicated: 'adjudicated' });
  expect(result.missing).toEqual(['unstated', 'unstated', 'unstated']);
  expect(result.neutralAuthored).toBe(false);
  expect(result.roundTrip).toEqual(result.prefs);
  expect(result.invalidCategory).toBeNull();
  expect(result.invalidVersion).toBeNull();
});

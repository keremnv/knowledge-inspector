/** KI-006: supplied occurrence_state reaches rows, field, rosters and
 * restoration — with neutral relation names, same-origin comparisons,
 * and no state invented where none was supplied. Real generic adapter
 * (relation-wide declarations) plus real expedition adapter evidence. */
import { test as base, expect, type Page } from '@playwright/test';
import type { Graph } from '@antv/g6';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

type CanvasWindow = Window & { __worldVocabulary?: Graph; __worldFieldGraph?: Graph };

async function serve(page_side: string, script: string, arg: string) {
  const child: ChildProcess = spawn('python3', ['-u', '-c', script, arg]);
  const output = createInterface({ input: child.stdout });
  let errors = '';
  child.stderr.on('data', (data) => { errors += data; });
  const proxy: Server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    output.once('line', (line) => { try { resolve(JSON.parse(line).port); } catch (e) { reject(e); } });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Adapter exited (${code}): ${errors}`)));
  });
  proxy.on('request', (incoming, outgoing) => {
    const target = new URL(incoming.url ?? '/', incoming.url?.startsWith('/world/')
      ? `http://127.0.0.1:${port}` : 'http://127.0.0.1:8143');
    const upstream = request(target, { method: incoming.method, headers: { ...incoming.headers, host: target.host } }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on('error', (error) => { outgoing.writeHead(502); outgoing.end(error.message); });
    incoming.pipe(upstream);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('Missing proxy port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async stop() {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      output.close();
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, 'exit'); child.kill('SIGINT'); await stopped;
      }
    },
  };
  void page_side;
}

const GENERIC_SCRIPT = `
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
roles=[{'role':r,'column_name':r,'target_kind':'entity'} for r in ['a','b','c']]
roles.append({'role':'note','column_name':'note','target_kind':None})
def rel(name,source,rs,state=None):
 r={'name':name,'source':source,'key_columns':['id'],'roles':rs}
 if state:r['occurrence_state']=state
 return r
relations=[
 rel('adopted_rec','event',roles,'ADOPTED'), rel('proposed_rec','event',roles,'PROPOSED'),
 rel('rejected_rec','event',roles,'REJECTED'), rel('recorded_pair','pair',roles[:2],'RECORDED'),
 rel('proposed_pair','pair',roles[:2],'PROPOSED'), rel('plain_pair','pair',roles[:2]),
]
decl=w.validate_declaration({'version':1,'world':{'id_prefix':'occurrencetest'},
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
`;

const EXPEDITION_SCRIPT = `
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
`;

type Fixtures = { genericOrigin: string; expeditionOrigin: string };
const test = base.extend<{}, Fixtures>({
  genericOrigin: [async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'ki-occurrence-generic-'));
    const served = await serve('', GENERIC_SCRIPT, join(directory, 'source.sqlite'));
    await use(served.origin);
    await served.stop();
    await rm(directory, { recursive: true, force: true });
  }, { scope: 'worker' }],
  expeditionOrigin: [async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'ki-occurrence-expedition-'));
    const served = await serve('', EXPEDITION_SCRIPT, join(directory, 'expedition.sqlite'));
    await use(served.origin);
    await served.stop();
    await rm(directory, { recursive: true, force: true });
  }, { scope: 'worker' }],
});

const reader = (page: Page) => page.locator('.node-reader .motion-swap__is');
const catalogue = (page: Page, name: string) => page.locator('.table__row').filter({ has: page.locator(`[title="${name}"]`) });
const fieldLabels = (page: Page) => page.evaluate(() => {
  const graph = (window as CanvasWindow).__worldFieldGraph;
  const items = [...(graph?.getNodeData() ?? []), ...(graph?.getEdgeData() ?? [])] as { id: string; style?: { labelText?: string } }[];
  return Object.fromEntries(items.filter((i) => i.style?.labelText).map((i) => [i.id, i.style!.labelText]));
});
const fieldIds = (page: Page) => page.evaluate(() => {
  const graph = (window as CanvasWindow).__worldFieldGraph;
  return [...(graph?.getNodeData() ?? []), ...(graph?.getEdgeData() ?? [])].map((i) => String(i.id));
});

async function openTable(page: Page, relation: string) {
  await page.getByRole('navigation', { name: 'Table subject' }).getByRole('button', { name: 'world', exact: true }).click();
  await catalogue(page, relation).click();
  await expect(page.locator(`section[aria-label="${relation} extension"] .table__row[data-loaded]`).first()).toBeVisible();
}
const tableRows = (page: Page, relation: string) => page.locator(`section[aria-label="${relation} extension"] .table__row[data-loaded]`);

test('generic rows carry supplied states; unstated rows carry none', async ({ page, genericOrigin }) => {
  await page.goto(genericOrigin);
  const states = await page.evaluate(async () => {
    const out: Record<string, unknown> = {};
    for (const name of ['adopted_rec', 'proposed_rec', 'rejected_rec', 'recorded_pair', 'proposed_pair', 'plain_pair']) {
      const rows = await fetch(`/world/rows?relation=${name}`).then((r) => r.json());
      out[name] = rows.rows.map((row: { occurrence_state?: string }) => row.occurrence_state ?? null);
    }
    return out;
  });
  expect(states).toEqual({
    adopted_rec: ['ADOPTED', 'ADOPTED'], proposed_rec: ['PROPOSED', 'PROPOSED'],
    rejected_rec: ['REJECTED', 'REJECTED'], recorded_pair: ['RECORDED', 'RECORDED'],
    proposed_pair: ['PROPOSED', 'PROPOSED'], plain_pair: [null, null],
  });
  for (const [relation, label, state] of [
    ['adopted_rec', 'adopted', 'ADOPTED'], ['proposed_rec', 'proposal', 'PROPOSED'],
    ['rejected_rec', 'rejection', 'REJECTED'],
  ] as const) {
    await openTable(page, relation);
    const stance = tableRows(page, relation).first().locator('.table__stance');
    await expect(stance).toHaveText(label);
    await expect(stance).toHaveAttribute('data-occurrence-state', state);
  }
  await openTable(page, 'proposed_rec');
  await expect(page.locator('section[aria-label="proposed_rec extension"] .table__head')).toContainText('state');
  await openTable(page, 'plain_pair');
  await expect(tableRows(page, 'plain_pair').first().locator('[data-occurrence-state]')).toHaveCount(0);
  await expect(page.locator('section[aria-label="plain_pair extension"] .table__head')).not.toContainText('state');
  // Origin and stance stay independent: same SEMANTIC-free (UNSTATED) origin,
  // different stances, and the reader agrees with the row.
  await openTable(page, 'proposed_rec');
  await tableRows(page, 'proposed_rec').first().click();
  await expect(reader(page).locator('[data-occurrence-state]')).toHaveText('proposal');
  await expect(reader(page).locator('[data-occurrence-state]')).toHaveAttribute('data-occurrence-state', 'PROPOSED');
});

test('plates, parallel bonds, rosters and restoration retain supplied states', async ({ page, genericOrigin }) => {
  await page.goto(genericOrigin);
  const world = await page.evaluate(() => fetch('/world/overview').then((r) => r.json()));
  await openTable(page, 'proposed_rec');
  await tableRows(page, 'proposed_rec').first().click();
  await expect.poll(async () => (await fieldLabels(page))['proposed_rec:1']).toBe('proposed_rec · proposal');
  await openTable(page, 'recorded_pair');
  await tableRows(page, 'recorded_pair').first().click();
  await openTable(page, 'proposed_pair');
  await tableRows(page, 'proposed_pair').first().click();
  await expect.poll(() => fieldIds(page)).toContain('bond:proposed_pair:1');
  const labels = await fieldLabels(page);
  expect(Object.values(labels)).toContain('recorded_pair · recorded');
  expect(Object.values(labels)).toContain('proposed_pair · proposal');
  // Referent roster qualifies the same occurrences.
  await page.evaluate(() => (window as CanvasWindow).__worldFieldGraph!.emit('node:click', { target: { id: 'entity:A' } }));
  await expect(reader(page).locator('h2')).toHaveText('A');
  await expect(reader(page)).toContainText('proposal');
  await expect(reader(page)).toContainText('recorded');
  // Stored field records carry the state; reload restores the same labels.
  const stored = await page.evaluate((id) => JSON.parse(localStorage.getItem(`worldir.field:${id}:1`)!), world.world_id);
  const flat = [...stored.assertions.map(([, a]: [string, { occurrence_state?: string }]) => a), ...stored.bonds];
  expect(flat.every((item) => typeof item.occurrence_state === 'string')).toBe(true);
  await page.reload();
  await expect.poll(async () => (await fieldLabels(page))['proposed_rec:1']).toBe('proposed_rec · proposal');
  // A pre-feature saved record (no state anywhere) restores unqualified.
  const stripped = await page.evaluate((id) => {
    const raw = JSON.parse(localStorage.getItem(`worldir.field:${id}:1`)!);
    for (const [, a] of raw.assertions) delete a.occurrence_state;
    for (const b of raw.bonds) delete b.occurrence_state;
    localStorage.setItem(`worldir.field:${id}:1`, JSON.stringify(raw));
    return raw;
  }, world.world_id);
  expect(stripped.assertions.length + stripped.bonds.length).toBeGreaterThan(0);
  await page.reload();
  await expect.poll(() => fieldIds(page)).toContain('proposed_rec:1');
  expect((await fieldLabels(page))['proposed_rec:1']).toBe('proposed_rec');
});

test('expedition states are visible in rows and on the field before the reader', async ({ page, expeditionOrigin }) => {
  await page.goto(expeditionOrigin);
  const overview = await page.evaluate(() => fetch("/world/overview").then(r => r.json()));
  expect(overview).not.toHaveProperty("reading");
  expect(overview.demand).not.toBeNull();
  await expect(page.locator(".world-reading")).toHaveCount(0);
  const states = await page.evaluate(async () => {
    const out: Record<string, unknown> = {};
    for (const name of ['determination', 'determination_proposed', 'determination_rejected', 'collection']) {
      const rows = await fetch(`/world/rows?relation=${name}`).then((r) => r.json());
      out[name] = rows.rows[0]?.occurrence_state ?? null;
    }
    return out;
  });
  expect(states).toEqual({
    determination: 'ADOPTED', determination_proposed: 'PROPOSED',
    determination_rejected: 'REJECTED', collection: 'RECORDED',
  });
  for (const [relation, label] of [
    ['determination', 'adopted'], ['determination_proposed', 'proposal'],
    ['determination_rejected', 'rejection'], ['collection', 'recorded'],
  ] as const) {
    await openTable(page, relation);
    await expect(tableRows(page, relation).first().locator('.table__stance')).toHaveText(label);
  }
  await openTable(page, 'determination');
  await tableRows(page, 'determination').first().click();
  await expect(reader(page).locator('[data-occurrence-state]')).toHaveText('adopted');
  await expect(reader(page).locator('.world-attribution')).toHaveCount(0);
  await expect(reader(page)).not.toContainText('external reader declaration');
  await expect.poll(async () => (await fieldLabels(page))['determination:1']).toBe('determination · adopted');
});

/**
 * Row-specific mixed states are a legacy/contract capability the generic
 * adapter cannot produce (its declarations are relation-wide). This
 * fixture is labelled as such; it makes no generic-adapter claim.
 */
test('legacy mixed row states stay distinct and unknown values render raw', async ({ page }) => {
  const roles = [
    { name: 'subject', type: 'REFERENT', column: 'subject', referent: true, kinds: ['entity'] },
    { name: 'other', type: 'REFERENT', column: 'other', referent: true, kinds: ['entity'] },
    { name: 'note', type: 'TEXT', column: 'note', referent: false },
  ];
  const states: (string | undefined)[] = ['ADOPTED', 'PROPOSED', 'FROBNICATED', undefined];
  await page.route('**/world/overview', (r) => r.fulfill({ json: { world_id: 'legacy-mixed', revision: 1, relations: 1, referents: 2, assertions: 4, origins: { SEMANTIC: 4 }, stale: [], incomplete: [], demand: null, governed_obligations: null } }));
  await page.route('**/world/schema', (r) => r.fulfill({ json: { relations: [{ name: 'record', description: null, mode: 'BASE', arity: 3, referent_arity: 2, roles, count: 4, stale: false, origins: ['SEMANTIC'], scope: null, completeness: null }] } }));
  await page.route('**/world/referents', (r) => r.fulfill({ json: { referents: [{ id: 'entity:A', label: 'Ark' }, { id: 'entity:B', label: 'Barge' }], total: 2, truncated: false } }));
  await page.route('**/world/rows?**', (r) => r.fulfill({ json: { relation: 'record', mode: 'BASE', stale: false, total: 4, offset: 0, roles, rows: states.map((state, i) => ({ assertion_id: `record:${i + 1}`, origin: 'SEMANTIC', origins: ['SEMANTIC'], ...(state ? { occurrence_state: state } : {}), values: { subject: 'entity:A', other: 'entity:B', note: `n${i}` } })) } }));
  await page.route('**/world/assertion?**', (r) => {
    const id = new URL(r.request().url()).searchParams.get('id') ?? '';
    const state = states[Number(id.split(':')[1]) - 1];
    return r.fulfill({ json: { assertion_id: id, relation: 'record', mode: 'BASE', arity: 3, roles, values: { subject: 'entity:A', other: 'entity:B', note: 'n' }, origin: 'SEMANTIC', origins: ['SEMANTIC'], assertion_state: 'ASSERTED', ...(state ? { occurrence_state: state } : {}), created_revision: 1, relation_stale: false, completeness: null, grounding: [], warrant: { commitment_id: id, relation: 'record', assertion_origin: 'SEMANTIC', recorded_construction_origin: 'SEMANTIC', construction_origins: ['SEMANTIC'], created_revision: 1, bases: [] }, commitment_id: id, candidate_for: [], governing_obligations: [], candidate_assessments: [] } });
  });
  await page.route('**/world/labels?**', (r) => r.fulfill({ json: { labels: { 'entity:A': 'Ark', 'entity:B': 'Barge' } } }));
  await page.route('**/world/referent?**', (r) => r.fulfill({ json: { id: 'entity:A', label: 'Ark', grounding: [], fields: [], relations: [] } }));
  await page.route('**/world/demand', (r) => r.fulfill({ json: { demand: null } }));
  await page.goto('/');
  await openTable(page, 'record');
  const rows = tableRows(page, 'record');
  await expect(rows.nth(0).locator('.table__stance')).toHaveText('adopted');
  await expect(rows.nth(1).locator('.table__stance')).toHaveText('proposal');
  await expect(rows.nth(2).locator('.table__stance')).toHaveText('frobnicated');
  await expect(rows.nth(2).locator('.table__stance')).toHaveAttribute('data-occurrence-state', 'FROBNICATED');
  await expect(rows.nth(3).locator('[data-occurrence-state]')).toHaveCount(0);
  await rows.nth(2).click();
  await expect(reader(page).locator('[data-occurrence-state]')).toHaveText('frobnicated');
});

test('placement, bulk, open and collapse round-trips preserve the supplied state', async ({ page, genericOrigin }) => {
  await page.goto(genericOrigin);
  const result = await page.evaluate(async () => {
    const ws = await import('/src/world/workingSet.ts');
    const roles = [
      { name: 'a', type: 'REFERENT', column: 'a', referent: true },
      { name: 'b', type: 'REFERENT', column: 'b', referent: true },
    ] as never[];
    const labels = new Map([['entity:A', 'A'], ['entity:B', 'B']]);
    const tuple = { assertion_id: 'recorded_pair:1', origin: 'UNSTATED', occurrence_state: 'RECORDED', values: { a: 'entity:A', b: 'entity:B' } } as never;
    const input = { relation: 'recorded_pair', mode: 'BASE', stale: false, completeness: null, roles, labels } as never;
    let set = ws.place(ws.emptySet(), { ...input, tuple });
    const placed = set.bonds[0]?.occurrence_state;
    set = ws.open(set, 'recorded_pair:1');
    const opened = set.assertions.get('recorded_pair:1')?.occurrence_state;
    set = ws.collapse(set, 'recorded_pair:1');
    const folded = set.bonds[0]?.occurrence_state;
    const bulk = ws.placeAll(ws.emptySet(), { ...input, tuples: [tuple] });
    const bulkState = bulk.bonds[0]?.occurrence_state;
    const bare = ws.place(ws.emptySet(), { ...input, tuple: { assertion_id: 'plain_pair:1', origin: 'UNSTATED', values: { a: 'entity:A', b: 'entity:B' } } as never });
    return { placed, opened, folded, bulkState, bare: bare.bonds[0]?.occurrence_state ?? null };
  });
  expect(result).toEqual({ placed: 'RECORDED', opened: 'RECORDED', folded: 'RECORDED', bulkState: 'RECORDED', bare: null });
});

test('parallel bond label geometry measures the qualified visible text', async ({ page }) => {
  // Same neutrally-named legacy fixture as above: three parallel bonds
  // whose only difference is the supplied state.
  const roles = [
    { name: 'subject', type: 'REFERENT', column: 'subject', referent: true, kinds: ['entity'] },
    { name: 'other', type: 'REFERENT', column: 'other', referent: true, kinds: ['entity'] },
    { name: 'note', type: 'TEXT', column: 'note', referent: false },
  ];
  const states = ['ADOPTED', 'REJECTED', 'FROBNICATED'];
  await page.route('**/world/overview', (r) => r.fulfill({ json: { world_id: 'legacy-geometry', revision: 1, relations: 1, referents: 2, assertions: 3, origins: { SEMANTIC: 3 }, stale: [], incomplete: [], demand: null, governed_obligations: null } }));
  await page.route('**/world/schema', (r) => r.fulfill({ json: { relations: [{ name: 'record', description: null, mode: 'BASE', arity: 3, referent_arity: 2, roles, count: 3, stale: false, origins: ['SEMANTIC'], scope: null, completeness: null }] } }));
  await page.route('**/world/referents', (r) => r.fulfill({ json: { referents: [{ id: 'entity:A', label: 'Ark' }, { id: 'entity:B', label: 'Barge' }], total: 2, truncated: false } }));
  await page.route('**/world/rows?**', (r) => r.fulfill({ json: { relation: 'record', mode: 'BASE', stale: false, total: 3, offset: 0, roles, rows: states.map((state, i) => ({ assertion_id: `record:${i + 1}`, origin: 'SEMANTIC', origins: ['SEMANTIC'], occurrence_state: state, values: { subject: 'entity:A', other: 'entity:B', note: `n${i}` } })) } }));
  await page.route('**/world/assertion?**', (r) => {
    const id = new URL(r.request().url()).searchParams.get('id') ?? '';
    const state = states[Number(id.split(':')[1]) - 1];
    return r.fulfill({ json: { assertion_id: id, relation: 'record', mode: 'BASE', arity: 3, roles, values: { subject: 'entity:A', other: 'entity:B', note: 'n' }, origin: 'SEMANTIC', origins: ['SEMANTIC'], assertion_state: 'ASSERTED', occurrence_state: state, created_revision: 1, relation_stale: false, completeness: null, grounding: [], warrant: { commitment_id: id, relation: 'record', assertion_origin: 'SEMANTIC', recorded_construction_origin: 'SEMANTIC', construction_origins: ['SEMANTIC'], created_revision: 1, bases: [] }, commitment_id: id, candidate_for: [], governing_obligations: [], candidate_assessments: [] } });
  });
  await page.route('**/world/labels?**', (r) => r.fulfill({ json: { labels: { 'entity:A': 'Ark', 'entity:B': 'Barge' } } }));
  await page.route('**/world/referent?**', (r) => r.fulfill({ json: { id: 'entity:A', label: 'Ark', grounding: [], fields: [], relations: [] } }));
  await page.route('**/world/demand', (r) => r.fulfill({ json: { demand: null } }));
  await page.goto('/');
  await openTable(page, 'record');
  const rows = tableRows(page, 'record');
  for (let i = 0; i < 3; i += 1) await rows.nth(i).click();
  await expect.poll(() => fieldIds(page)).toContain('bond:record:3');
  const edges = await page.evaluate(() => {
    const graph = (window as CanvasWindow).__worldFieldGraph;
    return (graph?.getEdgeData() ?? [])
      .map((edge) => edge as unknown as { id: string; style?: { labelText?: string; labelBackgroundWidth?: number; labelOffsetY?: number; bondHalf?: number } })
      .filter((edge) => edge.style?.labelText?.startsWith('record'))
      .map((edge) => ({ id: edge.id, text: edge.style!.labelText!, width: edge.style!.labelBackgroundWidth!, offsetY: edge.style!.labelOffsetY!, half: edge.style!.bondHalf! }))
      .sort((a, b) => a.text.localeCompare(b.text));
  });
  expect(edges.map((e) => e.text)).toEqual(['record · adopted', 'record · frobnicated', 'record · rejection']);
  const byText = Object.fromEntries(edges.map((e) => [e.text, e]));
  // Actual background widths follow the visible qualified text, not the
  // bare relation name: longer state, wider plate, wider shared half.
  expect(byText['record · frobnicated'].width).toBeGreaterThan(byText['record · rejection'].width);
  expect(byText['record · rejection'].width).toBeGreaterThan(byText['record · adopted'].width);
  for (const edge of edges) expect(edge.width).toBeGreaterThan(50);
  // Grouped bonds share the widest member's half, derived from the
  // qualified text: it covers the longest label, not the bare name.
  expect(new Set(edges.map((e) => e.half)).size).toBe(1);
  expect(edges[0].half * 2).toBeGreaterThanOrEqual(byText['record · frobnicated'].width - 1);
  expect(edges[0].half).toBeGreaterThan(byText['record · adopted'].width / 2);
  // Parallel labels are stacked, not coincident.
  expect(new Set(edges.map((e) => e.offsetY)).size).toBe(3);
});

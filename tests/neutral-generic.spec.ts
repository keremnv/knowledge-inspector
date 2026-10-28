/** Neutral generic presentation: a real generic World whose declaration
 * supplies no construction origins reads as a relationship visualiser.
 * No origin vocabulary is displayed, no compatibility columns are kept,
 * and saved SHOW preferences cannot hide material behind absent controls.
 * Classified/legacy behaviour stays covered by unstated-origin.spec.ts
 * and show-consistency.spec.ts. */
import { test as base, expect, type Page } from '@playwright/test';
import type { Graph } from '@antv/g6';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

type CanvasWindow = Window & { __worldVocabulary?: Graph; __worldFieldGraph?: Graph };

const test = base.extend<{}, { sourceOrigin: string }>({
  sourceOrigin: [async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'ki-neutral-browser-'));
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
relations=[
 {'name':'plain','source':'event','key_columns':['id'],'roles':roles},
 {'name':'pair','source':'pair','key_columns':['id'],'roles':roles[:2]},
]
decl=w.validate_declaration({'version':1,'world':{'id_prefix':'neutraltest'},
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
const ids = (page: Page, room: 'schema' | 'field') => page.evaluate(room => {
  const graph = (window as CanvasWindow)[room === 'schema' ? '__worldVocabulary' : '__worldFieldGraph'];
  return [...(graph?.getNodeData() ?? []), ...(graph?.getEdgeData() ?? [])].map(item => String(item.id));
}, room);
const catalogue = (page: Page, name: string) => page.locator('.table__row').filter({ has: page.locator(`[title="${name}"]`) });

async function place(page: Page, relation: string) {
  await page.getByRole('navigation', { name: 'Table subject' }).getByRole('button', { name: 'world', exact: true }).click();
  await catalogue(page, relation).click();
  await page.locator(`section[aria-label="${relation} extension"] .table__row[data-loaded]`).first().click();
  await expect(reader(page).locator('h2')).toHaveText(relation);
  await expect.poll(() => ids(page, 'field')).toContain(`${relation}:1`);
}

test('an undeclared generic world displays no origin vocabulary or compatibility columns', async ({ page, sourceOrigin }) => {
  await page.goto(sourceOrigin);
  const data = await page.evaluate(async () => ({
    schema: await fetch('/world/schema').then(r => r.json()),
    rows: await fetch('/world/rows?relation=plain').then(r => r.json()),
  }));
  expect(data.schema.relations.every((item: { origins: string[] }) => item.origins.length === 0)).toBe(true);
  expect(data.rows.rows[0].origin).toBe('UNSTATED');
  // Catalogue: name and count remain; origin/scope/stale columns do not.
  await expect(catalogue(page, 'plain')).toBeVisible();
  await expect(catalogue(page, 'pair')).toBeVisible();
  const table = page.locator('section[aria-label="world relations"]');
  await expect(table.locator('.table__head')).not.toContainText(/construction|scope|stale|mode/);
  await expect(table).not.toContainText(/unstated|semantic|adjudicated|mechanical/);
  // Schema navigation works and relations are present by default.
  await expect.poll(() => ids(page, 'schema')).toContain('rel:plain');
  await expect.poll(() => ids(page, 'schema')).toContain('rel:pair');
  // SHOW menu offers no origin-layer controls for this world.
  await page.locator('.world-filter__summary').hover();
  for (const layer of ['semantic', 'adjudicated', 'derived', 'mechanical', 'unstated']) {
    await expect(page.locator(`.world-show__filter[data-layer="${layer}"]`)).toHaveCount(0);
  }
});

test('readers, grounding and graph navigation stay accessible without an origin chip', async ({ page, sourceOrigin }) => {
  await page.goto(sourceOrigin);
  // Dependencies keep PR #12 neutral wording (checked from the schema,
  // before any placement parks the vocabulary).
  await expect.poll(() => ids(page, 'schema')).toContain('rel:plain');
  await page.evaluate(() => (window as CanvasWindow).__worldVocabulary!.emit('node:click', { target: { id: 'rel:plain' } }));
  await expect(reader(page).locator('h2')).toHaveText('plain');
  await reader(page).getByRole('button', { name: 'Dependencies' }).click();
  const dependencies = page.getByRole('region', { name: 'plain derivation' });
  await expect(dependencies).toContainText('No input dependency metadata recorded for plain.');
  await expect(dependencies).not.toContainText(/not computed|rests on nothing/);
  await place(page, 'plain');
  // No construction-origin chip; no stance chip either (none supplied).
  // The supplied mode stays inspectable in the reader meta even though
  // the neutral catalogue omits its universally-BASE column.
  await expect(reader(page)).toContainText('base · revision 1');
  await expect(reader(page).locator('.node-reader__kind')).toHaveCount(0);
  await expect(reader(page)).toContainText('row id=1 in event');
  await reader(page).getByText('Source metadata', { exact: true }).click();
  await expect(reader(page).locator('.world__source-metadata')).toContainText('event:id=1');
  // Field navigation through a role still works.
  await reader(page).locator('.world__roles').getByRole('button', { name: 'A', exact: true }).click();
  await expect(reader(page).locator('h2')).toHaveText('A');
  await reader(page).locator('.gm__list button').filter({ hasText: 'pair' }).first().click();
  await expect.poll(() => ids(page, 'field')).toContain('bond:pair:1');
});

test('saved SHOW preferences cannot hide neutral material behind absent controls', async ({ page, sourceOrigin }) => {
  await page.goto(sourceOrigin);
  const world = await page.evaluate(() => fetch('/world/overview').then(r => r.json()));
  await place(page, 'plain');
  const hidden = { semantic: false, adjudicated: false, derived: false, mechanical: false, unstated: false, unresolved: false };
  await page.evaluate(({ world_id, show }) => localStorage.setItem(`worldir.show:${world_id}`, JSON.stringify({
    version: 1, world: world_id, show, namedAtRest: true, spreadOnSelect: false, framing: true,
  })), { world_id: world.world_id, show: hidden });
  await page.reload();
  await expect.poll(() => ids(page, 'field')).toContain('plain:1');
  await expect.poll(() => ids(page, 'schema')).toContain('rel:plain');
  await expect(catalogue(page, 'plain')).toBeVisible();
  // The stored record itself is not rewritten by the neutral presentation.
  const stored = await page.evaluate(id => JSON.parse(localStorage.getItem(`worldir.show:${id}`)!), world.world_id);
  expect(stored.show).toEqual(hidden);
});

/**
 * DERIVED mode and demand without recorded construction origins, over a
 * clearly identified legacy/contract fixture: the generic adapter cannot
 * produce either (it serves BASE relations and no demand), so these
 * payloads are mocked routes, not a capability claim about it.
 */
const FIXTURE_ROLES = [
  { name: "subject", type: "REFERENT", column: "subject", referent: true, kinds: ["entity"] },
  { name: "other", type: "REFERENT", column: "other", referent: true, kinds: ["entity"] },
  { name: "note", type: "TEXT", column: "note", referent: false },
];
const FIXTURE_RELATIONS: Record<string, { mode: string; origins: string[] }> = {
  derived_plain: { mode: "DERIVED", origins: [] },
  plain: { mode: "BASE", origins: [] },
};

async function mockFixtureWorld(page: Page, withDemand: boolean, withGoverned = false) {
  await page.route("**/world/overview", (route) =>
    route.fulfill({
      json: {
        world_id: "neutral-fixture",
        revision: 1,
        relations: 2,
        referents: 2,
        assertions: 2,
        origins: {},
        stale: [],
        incomplete: [],
        demand: withDemand
          ? { purpose: { statement: "Fixture demand." }, obligations: 1, demanded: 1 }
          : null,
        governed_obligations: withGoverned ? { count: 1, resolved: 0, unresolved: 1 } : null,
      },
    }),
  );
  await page.route("**/world/schema", (route) =>
    route.fulfill({
      json: {
        relations: Object.entries(FIXTURE_RELATIONS).map(([name, spec]) => ({
          name,
          description: null,
          mode: spec.mode,
          arity: 3,
          referent_arity: 2,
          roles: FIXTURE_ROLES,
          count: 1,
          stale: false,
          origins: spec.origins,
          scope: null,
          completeness: null,
        })),
      },
    }),
  );
  await page.route("**/world/referents", (route) =>
    route.fulfill({
      json: {
        referents: [
          { id: "entity:A", label: "Ark" },
          { id: "entity:B", label: "Barge" },
        ],
        total: 2,
        truncated: false,
      },
    }),
  );
  await page.route("**/world/rows?**", (route) => {
    const relation = new URL(route.request().url()).searchParams.get("relation") ?? "";
    return route.fulfill({
      json: {
        relation,
        mode: FIXTURE_RELATIONS[relation].mode,
        stale: false,
        total: 1,
        offset: 0,
        roles: FIXTURE_ROLES,
        rows: [
          {
            assertion_id: `${relation}:1`,
            origin: "UNSTATED",
            values: { subject: "entity:A", other: "entity:B", note: "held" },
          },
        ],
      },
    });
  });
  await page.route("**/world/assertion?**", (route) => {
    const id = new URL(route.request().url()).searchParams.get("id") ?? "";
    const relation = id.split(":")[0];
    return route.fulfill({
      json: {
        assertion_id: id,
        relation,
        mode: FIXTURE_RELATIONS[relation].mode,
        arity: 3,
        roles: FIXTURE_ROLES,
        values: { subject: "entity:A", other: "entity:B", note: "held" },
        origin: "UNSTATED",
        assertion_state: "ASSERTED",
        created_revision: 1,
        relation_stale: false,
        completeness: null,
        grounding: [],
        warrant: {
          commitment_id: id,
          relation,
          assertion_origin: "UNSTATED",
          recorded_construction_origin: "UNSTATED",
          construction_origins: [],
          created_revision: 1,
          bases: [],
        },
        commitment_id: id,
        candidate_for: [],
        governing_obligations: [],
        candidate_assessments: [],
      },
    });
  });
  await page.route("**/world/labels?**", (route) =>
    route.fulfill({ json: { labels: { "entity:A": "Ark", "entity:B": "Barge" } } }),
  );
  await page.route("**/world/referent?**", (route) =>
    route.fulfill({
      json: { id: "entity:A", label: "Ark", grounding: [], fields: [], relations: [] },
    }),
  );
  await page.route("**/world/obligations", (route) =>
    route.fulfill({
      json: {
        contract: null,
        governance: null,
        obligations: withGoverned
          ? [
              {
                obligation_id: "ob-1",
                question: "Fixture governed question?",
                relation: null,
                values: {},
                reason: null,
                demanded_by: { name: "fixture", revision: 1 },
                state: "UNRESOLVED",
                assertion_id: null,
                record_id: null,
                grounding_ref: null,
                contract_id: "fixture-contract",
                contract_revision: "1",
                candidates: [],
              },
            ]
          : [],
      },
    }),
  );
  await page.route("**/world/demand", (route) =>
    route.fulfill({
      json: {
        demand: withDemand
          ? {
              purpose: { statement: "Fixture demand." },
              rule: null,
              demanded: 1,
              obligations: [
                {
                  relation: "plain",
                  values: { subject: "entity:B", other: "entity:A", note: "missing" },
                  demanded_by: { name: "fixture", revision: 1 },
                  state: "UNRESOLVED",
                  assertion_id: null,
                  reason: "fixture gap",
                },
              ],
            }
          : null,
      },
    }),
  );
}

test('DERIVED without recorded origins offers only the derived control', async ({ page }) => {
  await mockFixtureWorld(page, false);
  await page.goto('/');
  await expect.poll(() => ids(page, 'schema')).toContain('rel:derived_plain');
  await expect.poll(() => ids(page, 'schema')).toContain('rel:plain');
  await page.locator('.world-filter__summary').hover();
  await expect(page.locator('.world-show__filter[data-layer="derived"]')).toBeVisible();
  for (const layer of ['semantic', 'adjudicated', 'mechanical', 'unstated', 'unresolved']) {
    await expect(page.locator(`.world-show__filter[data-layer="${layer}"]`)).toHaveCount(0);
  }
  // The mode column returns because a DERIVED relation supplies it.
  const table = page.locator('section[aria-label="world relations"]');
  await expect(table.locator('.table__head')).toContainText('mode');
  await expect(table.locator('.table__head')).not.toContainText(/construction|scope|stale/);
  // Toggling derived governs DERIVED schema and field together (KI-015),
  // while the BASE relation follows no absent control and stays visible.
  const derived = page.locator('.world-show__filter[data-layer="derived"]');
  await derived.click();
  await expect(derived).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => ids(page, 'schema')).not.toContain('rel:derived_plain');
  await expect.poll(() => ids(page, 'schema')).toContain('rel:plain');
  await derived.click();
  await expect.poll(() => ids(page, 'schema')).toContain('rel:derived_plain');
});

test('DERIVED-only readers show no unstated chip; mode stays in reader metadata', async ({ page }) => {
  await mockFixtureWorld(page, false);
  await page.goto('/');
  // Relation reader, selected from the schema before placement.
  await expect.poll(() => ids(page, 'schema')).toContain('rel:derived_plain');
  await page.evaluate(() => (window as CanvasWindow).__worldVocabulary!.emit('node:click', { target: { id: 'rel:derived_plain' } }));
  await expect(reader(page).locator('h2')).toHaveText('derived_plain');
  await expect(reader(page).locator('.node-reader__kind')).toHaveCount(0);
  await expect(reader(page)).toContainText('derived · 1 tuple');
  // Assertion reader for the same relation.
  await page.getByRole('navigation', { name: 'Table subject' }).getByRole('button', { name: 'world', exact: true }).click();
  await catalogue(page, 'derived_plain').click();
  await page.locator('section[aria-label="derived_plain extension"] .table__row[data-loaded]').first().click();
  await expect(reader(page).locator('h2')).toHaveText('derived_plain');
  await expect.poll(() => ids(page, 'field')).toContain('bond:derived_plain:1');
  await expect(reader(page).locator('.node-reader__kind')).toHaveCount(0);
  await expect(reader(page)).toContainText('derived · revision 1');
});

test('governed obligations without legacy demand offer no unresolved filter', async ({ page }) => {
  await mockFixtureWorld(page, false, true);
  await page.goto('/');
  await expect.poll(() => ids(page, 'schema')).toContain('rel:plain');
  await page.locator('.world-filter__summary').hover();
  await expect(page.locator('.world-show__filter[data-layer="unresolved"]')).toHaveCount(0);
  // The governed interface itself remains accessible through its own table.
  await page.getByRole('button', { name: 'obligations', exact: true }).first().click();
  await expect(page.locator('section[aria-label="governed obligations"]')).toContainText('Fixture governed question?');
});

test('actual demand without recorded origins keeps its unresolved control and saved preference', async ({ page }) => {
  await mockFixtureWorld(page, true);
  await page.goto('/');
  await expect.poll(() => ids(page, 'schema')).toContain('rel:plain');
  await page.locator('.world-filter__summary').hover();
  const unresolved = page.locator('.world-show__filter[data-layer="unresolved"]');
  await expect(unresolved).toBeVisible();
  await expect(unresolved).toHaveAttribute('aria-pressed', 'true');
  for (const layer of ['semantic', 'adjudicated', 'mechanical', 'unstated']) {
    await expect(page.locator(`.world-show__filter[data-layer="${layer}"]`)).toHaveCount(0);
  }
  // The saved preference is honored, not overridden by neutrality.
  await unresolved.click();
  await expect(unresolved).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  await expect.poll(() => ids(page, 'schema')).toContain('rel:plain');
  await page.locator('.world-filter__summary').hover();
  await expect(page.locator('.world-show__filter[data-layer="unresolved"]')).toHaveAttribute('aria-pressed', 'false');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('worldir.show:neutral-fixture')!));
  expect(stored.show.unresolved).toBe(false);
});

/** Evidence attribution: real disposable SQLite + the real generic adapter
 * over HTTP + the real reader. Nothing but the legacy-payload test mocks a
 * route.
 *
 * The invariant: a scalar stated by an occurrence is shown with that
 * occurrence, never as a property of a referent that is merely mentioned in
 * it; an adapter default is not a reader declaration; a zero count is not an
 * expansion; declared types are not runtime values. The fixture is in
 * adapters/world/attribution_fixture.py. */
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

const test = base.extend<{}, { sourceOrigin: string }>({
  sourceOrigin: [async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'ki-attribution-browser-'));
    const path = join(directory, 'source.sqlite');
    const script = `
import json,sys,signal
from pathlib import Path
from http.server import ThreadingHTTPServer
sys.path.insert(0,'adapters/world')
import server as w
from attribution_fixture import build_fixture
p=Path(sys.argv[1]);decl=build_fixture(p)
prepared=w.prepare_world(p,decl,declaration_source='external_file')
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
      // The source is exactly as it was: reading it changed nothing.
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
const occurrence = (page: Page, id: string) =>
  reader(page).locator(`.world-occurrence[data-assertion-id="${id}"]`);
const occurrences = (page: Page) => reader(page).locator('.world-occurrence');
/** The value cell beside a role name inside one occurrence block. */
const scalar = (page: Page, id: string, role: string) =>
  occurrence(page, id).locator('.world__roles li')
    .filter({ has: page.locator('b').filter({ hasText: new RegExp(`^${role}$`) }) }).locator(':scope > span');
const fieldIds = (page: Page) => page.evaluate(() =>
  (window as CanvasWindow).__worldFieldGraph?.getNodeData().map(node => String(node.id)) ?? []);

async function open(page: Page, query: string, id: string) {
  // The finder is the empty field's door: start each subject from an empty field.
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  await page.getByRole('combobox').fill(query);
  const option = page.getByRole('option').filter({
    has: page.locator('.nodefind__anchor').filter({ hasText: new RegExp(`^${id}$`) }),
  });
  await expect(option).toBeVisible();
  await option.click();
  await expect(reader(page).locator('.world-reader__heading p, h2').first()).toBeVisible();
}

test('D: a many-to-many occurrence keeps its scalars; no referent is made their owner', async ({ page, sourceOrigin }) => {
  await page.goto(sourceOrigin);
  await open(page, 'Ben', 'person:2');
  await expect(reader(page).locator('h2')).toHaveText('Ben');
  // Above the rule there is identity only: no scalar rows in the header.
  await expect(reader(page).locator('.world-reader__header ~ .world-reader__facts .world__roles')).toHaveCount(0);
  await expect(reader(page).locator('.world-reader__facts .world__roles')).toHaveCount(0);

  const section = reader(page).locator('section[aria-label="Occurrences mentioning Ben"]');
  await expect(section).toContainText('not recorded as properties of Ben');
  // Three occurrences mention Ben, though two repeat identical scalar values.
  await expect(occurrences(page)).toHaveCount(3);
  await expect(section.locator('.world-occurrence').evaluateAll(
    nodes => nodes.map(node => node.getAttribute('data-assertion-id'))))
    .resolves.toEqual(['assignment:1', 'assignment:2', 'assignment:3']);
  await expect(section).toContainText('3 of 3 occurrences shown.');
  await expect(section).not.toContainText('bounded preview');
  // One occurrence is one block, however many scalar roles it states.
  for (const id of ['assignment:1', 'assignment:2', 'assignment:3']) {
    await expect(occurrence(page, id).locator('.world__roles li')).toHaveCount(8);
  }
  // The role Ben fills is reported, not guessed: helper twice, and both in the third.
  await expect(occurrence(page, 'assignment:1').locator('.world-occurrence__meta')).toHaveText('this referent as helper');
  await expect(occurrence(page, 'assignment:2').locator('.world-occurrence__meta')).toHaveText('this referent as helper');
  await expect(occurrence(page, 'assignment:3').locator('.world-occurrence__meta')).toHaveText('this referent as lead and helper');
  // Same values, different occurrences.
  for (const id of ['assignment:1', 'assignment:2']) {
    await expect(scalar(page, id, 'hours')).toHaveText('8');
    await expect(scalar(page, id, 'rate')).toHaveText('0.99');
  }
  // Null, empty text, zero, text-in-DECIMAL and numbers stay distinct.
  await expect(scalar(page, 'assignment:1', 'note')).toHaveAttribute('data-value-kind', 'null');
  await expect(scalar(page, 'assignment:3', 'note')).toHaveAttribute('data-value-kind', 'empty text');
  await expect(scalar(page, 'assignment:3', 'note')).toHaveText('""');
  await expect(scalar(page, 'assignment:3', 'started')).toHaveText('""');
  await expect(scalar(page, 'assignment:3', 'hours')).toHaveText('0');
  await expect(scalar(page, 'assignment:3', 'hours')).toHaveAttribute('data-value-kind', 'number');
  await expect(scalar(page, 'assignment:3', 'amount')).toHaveText('n/a');
  await expect(scalar(page, 'assignment:3', 'amount')).toHaveAttribute('data-value-kind', 'text');
  await expect(scalar(page, 'assignment:1', 'started')).toHaveText('2024-01-01 00:00:00');
  await expect(scalar(page, 'assignment:1', 'blobby')).toContainText('[BLOB 2 bytes; sha256=');
  // An occurrence's other participants do not become the occurrence's owner.
  await expect(reader(page).locator('.world-reader__header')).not.toContainText('0.99');
});

test('occurrence ids are visible, accessible and open the occurrence; back returns', async ({ page, sourceOrigin }) => {
  await page.goto(sourceOrigin);
  await open(page, 'Ben', 'person:2');
  const opener = reader(page).getByRole('button', { name: 'Open occurrence assignment:3', exact: true });
  await expect(opener).toHaveText('assignment:3');
  // Reachable and operable by keyboard alone.
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(reader(page).locator('h2')).toHaveText('assignment');
  await expect(reader(page)).toContainText('row id=3 in assignment');
  await expect(reader(page).locator('.world__roles li').filter({ hasText: 'lead' })).toContainText('Ben');
  await reader(page).getByRole('button', { name: /back/i }).click();
  await expect(reader(page).locator('h2')).toHaveText('Ben');
  await expect(occurrences(page)).toHaveCount(3);
});

test('E: a bounded preview reports occurrences, not scalars, and expansion still reaches all', async ({ page, sourceOrigin }) => {
  await page.goto(sourceOrigin);
  await open(page, 'Zed', 'person:9');
  const section = reader(page).locator('section[aria-label="ledger occurrences mentioning Zed"]');
  await expect(section).toContainText('100 of 105 occurrences shown.');
  await expect(section).toContainText('A bounded preview, not the complete set');
  await expect(section).not.toContainText('200 of 105');
  // 100 occurrences with two scalar roles: 100 blocks and 200 value rows.
  await expect(occurrences(page)).toHaveCount(100);
  await expect(reader(page).locator('.world-occurrence .world__roles li')).toHaveCount(200);
  // Zero, empty text and null are three different things, and first-seen order is kept.
  await expect(scalar(page, 'ledger:1', 'qty')).toHaveText('0');
  await expect(scalar(page, 'ledger:1', 'qty')).toHaveAttribute('data-value-kind', 'number');
  await expect(scalar(page, 'ledger:1', 'memo')).toHaveText('""');
  await expect(scalar(page, 'ledger:1', 'memo')).toHaveAttribute('data-value-kind', 'empty text');
  await expect(scalar(page, 'ledger:2', 'qty')).toHaveAttribute('data-value-kind', 'null');
  await expect(scalar(page, 'ledger:2', 'memo')).toHaveAttribute('data-value-kind', 'null');
  await expect(occurrence(page, 'ledger:3').locator('.world-occurrence__meta')).toHaveText('this referent as person');
  await expect(occurrence(page, 'ledger:101')).toHaveCount(0);
  // The relation's real count is the expansion's, and full expansion reaches all 105.
  const read = page.waitForResponse(response => response.url().includes('/world/rows?') &&
    new URL(response.url()).searchParams.get('relation') === 'ledger');
  await reader(page).getByRole('button', { name: 'ledger 105', exact: true }).click();
  expect((await (await read).json()).total).toBe(105);
  await expect.poll(async () => (await fieldIds(page)).filter(id => id.startsWith('ledger:')).length).toBe(105);
  // The roster of what now stands on the disc names each occurrence it opens,
  // beside the relation, and its role is the referent's.
  const roster = reader(page).locator('section').filter({ has: page.getByRole('heading', { name: 'on this disc' }) });
  const rows = roster.locator('.gm__list button').filter({ has: page.locator('em') });
  await expect(rows).toHaveCount(8);
  for (const row of await rows.all()) {
    await expect(row.locator('em')).toHaveText(/^ledger:\d+$/);
    await expect(row.locator('.gm__list-name')).toContainText('ledger');
    await expect(row.locator('.gm__list-meta')).toContainText('person');
    await expect(row).toHaveAttribute('title', /^ledger:\d+$/);
  }
  // The rest are reached through the relation's table, narrowed to the
  // occurrences that mention this referent: a mention, not ownership.
  await roster.getByRole('button', { name: /97 more/ }).click();
  const table = page.locator('section[aria-label="ledger extension"]');
  await expect(table).toContainText('105 tuples mentioning Zed');
  await expect(table).not.toContainText('tuples of Zed');
});

test('G: states and origins stay with their own occurrence, never the referent', async ({ page, sourceOrigin }) => {
  await page.goto(sourceOrigin);
  await open(page, 'Ada', 'person:1');
  await expect(reader(page).locator('h2')).toHaveText('Ada');
  // The referent carries no state of its own, however many states mention it.
  await expect(reader(page).locator('.world-reader__header [data-occurrence-state]')).toHaveCount(0);
  await expect(occurrences(page)).toHaveCount(4);
  const adopted = occurrence(page, 'review_adopted:1');
  const rejected = occurrence(page, 'review_rejected:1');
  await expect(adopted.locator('[data-occurrence-state]')).toHaveAttribute('data-occurrence-state', 'ADOPTED');
  await expect(adopted.locator('.world-occurrence__meta')).toHaveText('this referent as person · semantic');
  await expect(rejected.locator('[data-occurrence-state]')).toHaveAttribute('data-occurrence-state', 'REJECTED');
  await expect(rejected.locator('[data-occurrence-state]')).toHaveText('rejection');
  await expect(rejected.locator('.world-occurrence__meta')).toHaveText('this referent as person · mechanical');
  // Neutral occurrences show neither a state nor the UNSTATED placeholder.
  for (const id of ['assignment:1', 'assignment:2']) {
    await expect(occurrence(page, id).locator('[data-occurrence-state]')).toHaveCount(0);
    await expect(occurrence(page, id).locator('.world-occurrence__meta')).toHaveText('this referent as lead');
    await expect(occurrence(page, id)).not.toContainText(/unstated/i);
  }
  await expect(reader(page).locator('[data-occurrence-state]')).toHaveCount(2);
  // The same state is on the occurrence's own reader, not duplicated onto Ada.
  await rejected.getByRole('button', { name: 'Open occurrence review_rejected:1' }).click();
  await expect(reader(page).locator('h2')).toHaveText('review_rejected');
  await expect(reader(page).locator('[data-occurrence-state]')).toHaveAttribute('data-occurrence-state', 'REJECTED');
});

test('I: a relation with no matching occurrence is not offered as an expansion', async ({ page, sourceOrigin }) => {
  await page.goto(sourceOrigin);
  const expand = (name: string) => reader(page).locator('.gm__list button').filter({ hasText: new RegExp(`^${name}\\s*\\d+$`) });
  // Zero.
  await open(page, 'Yan', 'person:8');
  await expect(reader(page).locator('section').filter({ has: page.getByRole('heading', { name: 'expand through' }) })
    .locator('.gm__list button')).toHaveCount(0);
  await expect(reader(page)).toContainText(
    'No recorded occurrences in this reading mention this referent: assignment, ledger, review_adopted, review_rejected.');
  await expect(reader(page).locator('.world-occurrences')).toHaveCount(0);
  // One. (`project:10` has no declared label, so its label is its key.)
  await open(page, 'project:10', 'project:10');
  await expect(expand('assignment')).toHaveText(/assignment\s*1/);
  await expect(reader(page).getByRole('button', { name: /ledger/ })).toHaveCount(0);
  await expect(reader(page)).toContainText('mention this referent: ledger, review_adopted, review_rejected.');
  // Many.
  await open(page, 'Ben', 'person:2');
  await expect(expand('assignment')).toHaveText(/assignment\s*3/);
});

test('F: the reading descriptor and the interface say who chose each label column', async ({ page, sourceOrigin }) => {
  await page.goto(sourceOrigin);
  const overview = await page.evaluate(() => fetch('/world/overview').then(r => r.json()));
  const entities = Object.fromEntries(overview.reading.entities.map((e: { kind: string }) => [e.kind, e]));
  expect(entities.person).toMatchObject({ label_column: 'name', label_column_source: 'declared' });
  expect(entities.project).toMatchObject({ label_column: 'id', label_column_source: 'adapter_default' });
  // The default screen is the vocabulary in focus: the bar recedes there by
  // design, so the qualifier is on the catalogue dock beside the names it
  // qualifies, closed or open.
  const summary = page.locator('.world-reading > summary');
  await expect(summary).toBeVisible();
  await expect(summary).toHaveText('Reading attribution · reader-declared interpretation');
  await expect(page.locator('.world-reading[open]')).toHaveCount(0);
  // It does not touch the world identity: the header still names the same World
  // (revision 1 is the adapter's default, qualified in epistemic-presentation.spec.ts).
  await expect(page.locator('.product-shell__workspace')).toHaveText(overview.world_id);
  await summary.click();
  const body = page.locator('.world-reading__body');
  await expect(body.locator('li').filter({ hasText: 'Declared namespace person' }))
    .toContainText('display-label column: name (declared by the reader)');
  await expect(body.locator('li').filter({ hasText: 'Declared namespace project' }))
    .toContainText('display-label column: id (adapter default (the declaration names none, so the first key column stands in))');
  await expect(body.locator('li').filter({ hasText: 'Declared namespace project' }))
    .not.toContainText('declared by the reader');
  // Where the names are read, one line per panel: referent, occurrence, relation.
  await open(page, 'Ben', 'person:2');
  await expect(reader(page).locator('.world-reader__qualifier')).toHaveText('Reader-declared interpretation');
  await expect(reader(page).locator('.world-reader__qualifier')).toBeVisible();
  // With a field on the canvas the bar returns, and carries it too.
  const badge = page.locator('.world__reading-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('Reader-declared interpretation');
  await expect(badge).toHaveAttribute('title', /external reader declaration/);
  await expect(badge).toHaveAttribute('title', /nothing here establishes producer endorsement/);
  await reader(page).getByRole('button', { name: 'Open occurrence assignment:1' }).click();
  await expect(reader(page).locator('h2')).toHaveText('assignment');
  await expect(reader(page).locator('.world-reader__qualifier')).toHaveText('Reader-declared interpretation');
  await expect(reader(page).locator('.world-reader__qualifier')).toHaveCount(1);
  // Labels and canonical ids are exactly what they were.
  const directory = await page.evaluate(() => fetch('/world/referents').then(r => r.json()));
  expect(directory.referents.filter((r: { id: string }) => r.id.startsWith('project:')))
    .toEqual([{ id: 'project:10', label: '10' }, { id: 'project:20', label: '20' }]);
});

test('no verified descriptor, no reader-authorship qualifier or label provenance', async ({ page, sourceOrigin }) => {
  await page.route('**/world/overview', async route => {
    const response = await route.fetch();
    const { reading: _dropped, ...rest } = await response.json();
    await route.fulfill({ response, json: rest });
  });
  await page.goto(sourceOrigin);
  await expect(page.getByTitle('World identifier and current revision')).toHaveText(/ · rev 1$/);
  await expect(page.locator('.world-reading')).toHaveCount(0);
  await open(page, 'Ben', 'person:2');
  await expect(occurrences(page)).toHaveCount(3);
  await expect(page.locator('.world__reading-badge')).toHaveCount(0);
  await expect(page.locator('.world-reader__qualifier')).toHaveCount(0);
  await expect(page.getByText(/reader-declared interpretation/i)).toHaveCount(0);
  // The grouping of occurrences is the plane's, independent of any attribution.
  await reader(page).getByRole('button', { name: 'Open occurrence assignment:1' }).click();
  await expect(reader(page).locator('.world-reader__qualifier')).toHaveCount(0);
});

test('an older descriptor without label provenance claims none either way', async ({ page, sourceOrigin }) => {
  await page.route('**/world/overview', async route => {
    const response = await route.fetch();
    const body = await response.json();
    for (const entity of body.reading.entities) delete entity.label_column_source;
    await route.fulfill({ response, json: body });
  });
  await page.goto(sourceOrigin);
  await page.getByText('Reading attribution', { exact: true }).click();
  const body = page.locator('.world-reading__body');
  await expect(body).toContainText('provenance of this choice not stated');
  await expect(body).not.toContainText('declared by the reader');
  await expect(body).not.toContainText('adapter default (');
});

test('H: declared type, SQLite affinity and the stored class are shown as three things', async ({ page, sourceOrigin }) => {
  await page.goto(sourceOrigin);
  await expect.poll(() => page.evaluate(() =>
    (window as CanvasWindow).__worldVocabulary?.getNodeData().some(n => n.id === 'rel:assignment'))).toBe(true);
  await page.evaluate(() => (window as CanvasWindow).__worldVocabulary!.emit('node:click', { target: { id: 'rel:assignment' } }));
  await expect(reader(page).locator('h2')).toHaveText('assignment');
  const type = (role: string) => reader(page).locator('.world__roles li')
    .filter({ has: page.locator('b').filter({ hasText: new RegExp(`^${role}$`) }) }).locator(':scope > span');
  await expect(type('hours')).toHaveText('declared INTEGER · integer affinity');
  await expect(type('rate')).toHaveText('declared NUMERIC(10,2) · numeric affinity');
  await expect(type('amount')).toHaveText('declared DECIMAL(10,2) · numeric affinity');
  await expect(type('started')).toHaveText('declared DATETIME · numeric affinity');
  await expect(type('note')).toHaveText('declared TEXT · text affinity');
  await expect(type('extra')).toHaveText('declared REAL · real affinity');
  await expect(type('untyped')).toHaveText('no declared type · blob affinity');
  await expect(type('lead')).toHaveText('person');
  await expect(reader(page).locator('.world-reader__qualifier')).toHaveText('Reader-declared interpretation');
  // No temporal or decimal type is claimed anywhere on the page.
  await expect(reader(page)).not.toContainText(/declared DATETIME · (date|datetime|timestamp)/i);
  // The per-row storage class is in the occurrence's own source metadata.
  await page.evaluate(() => { location.hash = ''; });
  await open(page, 'Ben', 'person:2');
  await reader(page).getByRole('button', { name: 'Open occurrence assignment:3' }).click();
  await reader(page).getByText('Source metadata').click();
  const storage = reader(page).locator('.world__source-metadata dl > div').filter({ hasText: 'scalar_storage' }).locator('pre');
  const parsed = JSON.parse((await storage.innerText()));
  expect(parsed).toMatchObject({ rate: 'integer', amount: 'text', started: 'text', note: 'text', extra: 'real', blobby: 'null', untyped: 'integer' });
});

test('a producer that sends no participation roles still lists occurrences, without a guess', async ({ page, sourceOrigin }) => {
  await page.route('**/world/referent?**', async route => {
    const response = await route.fetch();
    const body = await response.json();
    for (const field of body.fields) delete field.referent_roles;
    // A field whose relation the counts do not list is still an occurrence's.
    body.fields.push({ relation: 'unlisted', role: 'x', value: 7, assertion_id: 'unlisted:1', origin: 'UNSTATED' });
    await route.fulfill({ response, json: body });
  });
  await page.goto(sourceOrigin);
  await open(page, 'Ben', 'person:2');
  await expect(occurrences(page)).toHaveCount(4);
  for (const id of ['assignment:1', 'assignment:3', 'unlisted:1']) {
    await expect(occurrence(page, id).locator('.world-occurrence__meta')).toHaveCount(0);
  }
  await expect(reader(page).locator('section[aria-label="unlisted occurrences mentioning Ben"]'))
    .toContainText('1 occurrences shown.');
});

/** Always-on R-006: disposable SQLite + actual Python HTTP + real Vite UI.
 * A real HTTP proxy connects the two servers; no Playwright route handlers. */
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
    const directory = await mkdtemp(join(tmpdir(), 'ki-canonical-browser-'));
    const path = join(directory, 'source.sqlite');
    const script = `
import json,sys,sqlite3
from pathlib import Path
from http.server import ThreadingHTTPServer
from adapters.world import server as w
p=Path(sys.argv[1]);d=sqlite3.connect(p)
d.executescript('''
CREATE TABLE entity(id TEXT COLLATE NOCASE PRIMARY KEY,label TEXT);
INSERT INTO entity VALUES('ABC','Canonical target');
CREATE TABLE event(id INTEGER PRIMARY KEY,participant TEXT);
INSERT INTO event VALUES(1,'abc'),(2,'AbC');
CREATE TABLE number(id INTEGER PRIMARY KEY);
INSERT INTO number VALUES(1);
CREATE TABLE numeric_event(id INTEGER PRIMARY KEY,participant TEXT);
INSERT INTO numeric_event VALUES(1,'01');
''');d.commit();d.close()
decl=w.validate_declaration({'version':1,'entities':[
 {'kind':'entity','source':'entity','key_columns':['id'],'label_column':'label'},
 {'kind':'number','source':'number','key_columns':['id']}], 'relations':[
 {'name':'event','source':'event','key_columns':['id'],
  'roles':[{'role':'participant','column_name':'participant','target_kind':'entity'}]},
 {'name':'numeric_event','source':'numeric_event','key_columns':['id'],
  'roles':[{'role':'participant','column_name':'participant','target_kind':'number'}]}]})
d=w.connect(p)
try: model=w.Model(d,decl)
finally: d.close()
w.Handler.db_path=p;w.Handler.model=model;w.Handler.world_id=w.build_world_id('canonical',w.file_sha256(p),decl)
s=ThreadingHTTPServer(('127.0.0.1',0),w.Handler)
print(json.dumps({'port':s.server_port}),flush=True);s.serve_forever()
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

for (const [relation, id, alias, label, count, raw] of [
  ['event', 'entity:ABC', 'entity:abc', 'Canonical target', 2, 'abc'],
  ['numeric_event', 'number:1', 'number:01', '1', 1, '01'],
] as const) {
  test(`${relation} projects one canonical disc, label, role target and neighborhood`, async ({ page, sourceOrigin }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(sourceOrigin);
    await page.locator('.table__row').filter({ has: page.locator(`[title="${relation}"]`) }).click();
    const row = page.locator(`section[aria-label="${relation} extension"] .table__row[data-loaded]`).first();
    await expect(row).toBeVisible();
    await expect(row.locator("span[title]").first()).toHaveAttribute("title", id);
    await row.click();
    await expect(reader(page).locator('h2')).toHaveText(relation);
    await expect.poll(() => fieldIds(page)).toContain(id);
    expect(await fieldIds(page)).not.toContain(alias);
    await reader(page).locator('.world__roles').getByRole('button', { name: label, exact: true }).click();
    await expect(reader(page).locator('h2')).toHaveText(label);
    await expect(reader(page)).toContainText(id);
    const data = await page.evaluate(async ({ relation, id, alias }) => {
      const read = async (path: string) => { const r = await fetch(path); return { status: r.status, data: await r.json() }; };
      return {
        detail: await read('/world/referent?id=' + encodeURIComponent(id)),
        occurrence: await read('/world/assertion?id=' + relation + ':1'),
        rows: await read('/world/rows?relation=' + relation + '&subject=' + encodeURIComponent(id)),
        expansion: await read('/world/expand?relation=' + relation + '&id=' + encodeURIComponent(id)),
        alias: await read('/world/referent?id=' + encodeURIComponent(alias)),
      };
    }, { relation, id, alias });
    expect(data.detail.data.relations.find((r: {name: string}) => r.name === relation).count).toBe(count);
    expect(data.rows.data.total).toBe(count);
    expect(data.expansion.data.tuples).toHaveLength(count);
    expect(data.occurrence.data.values.participant).toBe(id);
    expect(data.occurrence.data.grounding[0].detail.reference_participants.participant).toEqual(
      { column: 'participant', value: raw, storage_class: 'text' });
    expect(data.alias.status).toBe(404);
    const expansion = reader(page).locator('.gm__list button').filter({ hasText: relation }).first();
    if (await expansion.getAttribute('class') === 'is-selected') {
      await expansion.click();
      await expect(expansion).not.toContainText('take off');
    }
    await expect(expansion).toContainText(String(count));
    await expansion.click();
    await expect.poll(() => fieldIds(page)).toContain(relation + ':1');
    if (count === 2) await expect.poll(() => fieldIds(page)).toContain(relation + ':2');
    const ids = await fieldIds(page);
    expect(ids.filter(value => value === id)).toHaveLength(1);
    expect(ids).not.toContain(alias);
    expect(errors).toEqual([]);
  });
}

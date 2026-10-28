/** KI-003: real `server.py` startup snapshots through the real Vite UI.
 * Producer mutations stay invisible until an explicit restart reopens the
 * World; saved field state restores only under the identical World identity. */
import { test as base, expect, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

type Control = {
  origin: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  mutate: (sql: string) => void;
};

const freePort = async (): Promise<number> => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('no free port');
  const port = address.port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
};

const test = base.extend<{}, { control: Control }>({
  control: [async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'ki-snapshot-browser-'));
    const dbPath = join(directory, 'source.sqlite');
    const declPath = join(directory, 'declaration.json');
    const built = spawnSync('python3', ['-c', `
import sqlite3, sys
d = sqlite3.connect(sys.argv[1])
d.executescript('''
CREATE TABLE entity(id TEXT COLLATE NOCASE PRIMARY KEY, label TEXT);
INSERT INTO entity VALUES('ABC', 'Canonical target');
CREATE TABLE event(id INTEGER PRIMARY KEY, participant TEXT);
INSERT INTO event VALUES(1, 'abc');
''')
d.commit(); d.close()
`, dbPath]);
    if (built.status !== 0) throw new Error(`fixture failed: ${built.stderr}`);
    await writeFile(declPath, JSON.stringify({
      version: 1,
      world: { id_prefix: 'snaptest' },
      entities: [{ kind: 'entity', source: 'entity', key_columns: ['id'], label_column: 'label' }],
      relations: [{
        name: 'event', source: 'event', key_columns: ['id'],
        roles: [{ role: 'participant', column_name: 'participant', target_kind: 'entity' }],
      }],
    }));

    let child: ChildProcess | null = null;
    let targetPort = 0;
    const proxy: Server = createServer();
    proxy.on('request', (incoming, outgoing) => {
      const target = new URL(incoming.url ?? '/', incoming.url?.startsWith('/world/')
        ? `http://127.0.0.1:${targetPort}` : 'http://127.0.0.1:8143');
      const upstream = request(target, {
        method: incoming.method,
        headers: { ...incoming.headers, host: target.host },
      }, response => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      });
      upstream.on('error', error => { outgoing.writeHead(502); outgoing.end(error.message); });
      incoming.pipe(upstream);
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Missing proxy port');
    const origin = `http://127.0.0.1:${proxyAddress.port}`;

    const start = async () => {
      targetPort = await freePort();
      child = spawn('python3', ['adapters/world/server.py', '--db', dbPath,
        '--declaration', declPath, '--port', String(targetPort)]);
      const output = createInterface({ input: child.stdout! });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('adapter start timeout')), 30000);
        output.on('line', line => {
          if (line.includes('sqlite world:')) { clearTimeout(timer); resolve(); }
        });
        child!.once('exit', code => { clearTimeout(timer); reject(new Error(`adapter exited ${code}`)); });
      });
    };
    const stop = async () => {
      if (!child) return;
      const exited = once(child, 'exit');
      child.kill('SIGINT');
      await exited;
      child = null;
    };
    const mutate = (sql: string) => {
      const result = spawnSync('python3', ['-c', `
import sqlite3, sys
d = sqlite3.connect(sys.argv[1]); d.executescript(sys.argv[2]); d.commit(); d.close()
`, dbPath, sql]);
      if (result.status !== 0) throw new Error(`mutation failed: ${result.stderr}`);
    };

    try {
      await use({ origin, start, stop, mutate });
    } finally {
      await stop();
      proxy.closeAllConnections();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }, { scope: 'worker' }],
});

const fieldIds = (page: Page) => page.evaluate(() => {
  const graph = (window as unknown as {
    __worldFieldGraph?: { getNodeData(): { id: string }[] };
  }).__worldFieldGraph;
  return graph?.getNodeData().map(node => String(node.id)) ?? [];
});

const overview = (page: Page) => page.evaluate(async () => {
  const response = await fetch('/world/overview');
  return response.json() as Promise<{ world_id: string; assertions: number }>;
});

const storedKeys = (page: Page, prefix: string) => page.evaluate(
  (wanted: string) => Object.keys(localStorage).filter(key => key.startsWith(wanted)),
  prefix,
);

test('snapshot reading restores only under the same World identity', async ({ page, control }) => {
  await control.start();
  await page.goto(control.origin);
  const first = await overview(page);
  expect(first.assertions).toBe(1);

  await page.locator('.table__row').filter({ has: page.locator('[title="event"]') }).click();
  const row = page.locator('section[aria-label="event extension"] .table__row[data-loaded]').first();
  await expect(row).toBeVisible();
  await row.click();
  await expect.poll(() => fieldIds(page)).toContain('event:1');
  await expect.poll(() => storedKeys(page, 'worldir.field:'))
    .toEqual([`worldir.field:${first.world_id}:1`]);

  // Identical restart: same World identity, saved field restores verbatim.
  await control.stop();
  await control.start();
  expect((await overview(page)).world_id).toBe(first.world_id);
  await page.reload();
  await expect.poll(() => fieldIds(page)).toContain('event:1');

  // Producer mutation is invisible to the running snapshot (R-007).
  control.mutate("DELETE FROM event; UPDATE entity SET label='changed' WHERE id='ABC';");
  await page.reload();
  const during = await overview(page);
  expect(during.world_id).toBe(first.world_id);
  expect(during.assertions).toBe(1);
  await expect.poll(() => fieldIds(page)).toContain('event:1');

  // Explicit reopen: new identity, new data, no stale restoration.
  await control.stop();
  await control.start();
  const reopened = await overview(page);
  expect(reopened.world_id).not.toBe(first.world_id);
  expect(reopened.assertions).toBe(0);
  await page.reload();
  await expect.poll(() => fieldIds(page)).not.toContain('event:1');
});

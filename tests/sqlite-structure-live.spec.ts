/** KI-013/KI-014 real-adapter integration: disposable SQLite file ->
 * adapters/sqlite/server.py -> HTTP /sqlite/* -> actual /sqlite page.
 * No page.route() mocking. The producer file must stay byte-identical. */
import { test as base, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const DDL = `
CREATE TABLE parent2 (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE parent (a TEXT, b TEXT, code TEXT UNIQUE, PRIMARY KEY (a, b));
CREATE TABLE measure (
  id INTEGER PRIMARY KEY, qty REAL,
  doubled REAL GENERATED ALWAYS AS (qty * 2) VIRTUAL,
  label TEXT GENERATED ALWAYS AS ('item-' || id) STORED,
  big REAL GENERATED ALWAYS AS (CASE WHEN qty > 10 THEN qty END) VIRTUAL
);
INSERT INTO measure VALUES (1, 3), (2, 20);
CREATE TABLE child_single (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent2);
CREATE TABLE child_composite (x TEXT, y TEXT, FOREIGN KEY (x, y) REFERENCES parent);
`;

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Missing probe port");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function run(command: string, args: string[]): Promise<void> {
  const child = spawn(command, args);
  let errors = "";
  child.stderr.on("data", (data) => { errors += data; });
  const [code] = (await once(child, "exit")) as unknown as [number | null];
  if (code !== 0) throw new Error(`${command} failed (${code}): ${errors}`);
}

const test = base.extend<{}, { adapterOrigin: string }>({
  adapterOrigin: [async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "ki-sqlite-live-"));
    const path = join(directory, "structure.sqlite");
    let adapter: ChildProcess | undefined;
    let proxy: Server | undefined;
    try {
      await run("python3", ["-c", "import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); d.executescript(sys.argv[2]); d.commit(); d.close()", path, DDL]);
      const digest = async () => createHash("sha256").update(await readFile(path)).digest("hex");
      const before = await digest();
      const mtime = (await stat(path)).mtimeMs;

      const adapterPort = await freePort();
      adapter = spawn("python3", ["adapters/sqlite/server.py", "--db", path, "--port", String(adapterPort)]);
      let adapterErrors = "";
      adapter.stderr.on("data", (data) => { adapterErrors += data; });
      const lines = createInterface({ input: adapter.stdout });
      await new Promise<void>((resolve, reject) => {
        lines.once("line", () => resolve());
        adapter!.once("error", reject);
        adapter!.once("exit", (code) => reject(new Error(`Adapter exited (${code}): ${adapterErrors}`)));
      });

      proxy = createServer((incoming, outgoing) => {
        const target = new URL(
          incoming.url ?? "/",
          incoming.url?.startsWith("/sqlite/") ? `http://127.0.0.1:${adapterPort}` : "http://127.0.0.1:8143",
        );
        const upstream = request(target, { method: incoming.method, headers: { ...incoming.headers, host: target.host } }, (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        });
        upstream.on("error", (error) => { outgoing.writeHead(502); outgoing.end(error.message); });
        incoming.pipe(upstream);
      });
      proxy.listen(0, "127.0.0.1");
      await once(proxy, "listening");
      const address = proxy.address();
      if (!address || typeof address === "string") throw new Error("Missing proxy port");

      await use(`http://127.0.0.1:${address.port}`);
      expect(await digest()).toBe(before);
      expect((await stat(path)).mtimeMs).toBe(mtime);
    } finally {
      proxy?.closeAllConnections();
      if (proxy) await new Promise<void>((resolve) => proxy!.close(() => resolve()));
      if (adapter && adapter.exitCode === null && adapter.signalCode === null) {
        const stopped = once(adapter, "exit");
        adapter.kill("SIGINT");
        await stopped;
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, { scope: "worker" }],
});

test("real adapter serves generated columns to the structural page", async ({ page, adapterOrigin }) => {
  await page.goto(`${adapterOrigin}/sqlite`);
  const schema = await page.evaluate(async () => (await fetch("/sqlite/schema").then((r) => r.json())) as {
    tables: { name: string; columns: { name: string; generated?: string | null }[] }[];
  });
  const measure = schema.tables.find((t) => t.name === "measure");
  expect(measure?.columns.map((c) => [c.name, c.generated ?? null])).toEqual([
    ["id", null], ["qty", null], ["doubled", "VIRTUAL"], ["label", "STORED"], ["big", "VIRTUAL"],
  ]);

  await page.getByRole("button", { name: /measure/ }).click();
  await expect(page.getByRole("columnheader", { name: "doubled · generated virtual" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "label · generated stored" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "qty", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "item-1" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "item-2" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "6" })).toBeVisible();
});

test("real adapter resolves implicit FK targets and links stay table-level", async ({ page, adapterOrigin }) => {
  await page.goto(`${adapterOrigin}/sqlite`);
  const schema = await page.evaluate(async () => (await fetch("/sqlite/schema").then((r) => r.json())) as {
    tables: { name: string; fks: { from: string; to: string | null; resolved_to?: string | null }[][] }[];
  });
  const single = schema.tables.find((t) => t.name === "child_single")?.fks[0][0];
  expect(single).toMatchObject({ from: "parent_id", to: null, resolved_to: "id" });
  const composite = schema.tables.find((t) => t.name === "child_composite")?.fks[0];
  expect(composite?.map((r) => [r.from, r.to, r.resolved_to ?? null])).toEqual([
    ["x", null, "a"], ["y", null, "b"],
  ]);

  await page.getByRole("button", { name: /child_single/ }).click();
  const fk = page.getByRole("button", { name: /parent_id → parent2/ });
  await expect(fk).toHaveText("parent_id → parent2 (id (implicit target))");
  await expect(fk).toHaveAttribute(
    "title",
    "Open table parent2 (table-level; does not follow to the referenced record)",
  );
  await fk.click();
  await expect(page.getByRole("heading", { name: "parent2", exact: true })).toBeVisible();

  await page.getByRole("button", { name: /child_composite/ }).click();
  const compositeFk = page.getByRole("button", { name: /x \+ y → parent/ });
  await expect(compositeFk).toHaveText("x + y → parent (a (implicit target) + b (implicit target))");
  await compositeFk.click();
  await expect(page.getByRole("heading", { name: "parent", exact: true })).toBeVisible();
});

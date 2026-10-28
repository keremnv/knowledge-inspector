/**
 * A disposable SQLite file behind the real generic adapter, for live specs.
 *
 * `builder` names a module in adapters/world that exposes `build_fixture(path)`
 * and returns a validated declaration (`attribution_fixture`, `scalar_fixture`).
 * The adapter serves /world/*; every other path goes to the dev server. After
 * the worker is done the file is checked to be exactly as it was: bytes, mtime
 * and no journal sidecars. No producer database is involved.
 */
import { expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type Disposable = { origin: string; path: string };

export async function serveDisposable(builder: string, use: (served: Disposable) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), `ki-${builder}-`));
  const path = join(directory, "source.sqlite");
  const script = `
import json,sys,signal,importlib
from pathlib import Path
from http.server import ThreadingHTTPServer
sys.path.insert(0,'adapters/world')
import server as w
p=Path(sys.argv[1]);decl=importlib.import_module(sys.argv[2]).build_fixture(p)
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
  const child = spawn("python3", ["-u", "-c", script, path, builder]);
  const output = createInterface({ input: child.stdout });
  let errors = "";
  child.stderr.on("data", (data) => { errors += data; });
  const proxy = createServer();
  try {
    const port = await new Promise<number>((resolve, reject) => {
      output.once("line", (line) => { try { resolve(JSON.parse(line).port); } catch (error) { reject(error); } });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Adapter exited (${code}): ${errors}`)));
    });
    const digest = async () => createHash("sha256").update(await readFile(path)).digest("hex");
    const before = await digest();
    const mtime = (await stat(path)).mtimeMs;
    proxy.on("request", (incoming, outgoing) => {
      const target = new URL(incoming.url ?? "/", incoming.url?.startsWith("/world/")
        ? `http://127.0.0.1:${port}` : "http://127.0.0.1:8143");
      const upstream = request(target, { method: incoming.method,
        headers: { ...incoming.headers, host: target.host } }, (response) => {
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
    await use({ origin: `http://127.0.0.1:${address.port}`, path });
    // The source is exactly as it was: reading it changed nothing.
    expect(await digest()).toBe(before);
    expect((await stat(path)).mtimeMs).toBe(mtime);
    expect(await readdir(directory)).toEqual(["source.sqlite"]);
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    output.close();
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGTERM");
      await stopped;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

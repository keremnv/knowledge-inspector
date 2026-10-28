/**
 * The real Chinook adapters behind one same-origin proxy, for live specs.
 *
 * Shared by `chinook-live.spec.ts` and `camera-framing.spec.ts`. Each call
 * serves one prepared file through the structural adapter and the world
 * adapter, and checks afterwards that the file — bytes, mtime and journal
 * sidecars — did not change.
 */
import { expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

export const DATA = "examples/chinook/data";
export const UPSTREAM = join(DATA, "Chinook_Sqlite.sqlite");
export const VIEW_COPY = join(DATA, "Chinook_Sqlite.with-view.sqlite");
export const UPSTREAM_SHA256 = "bdf635be69850bd3be09c9a2dbeef7ddfb80036bd3ef3381383cd03b61e4a61a";

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Missing probe port");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

/** Start one adapter and wait for the line it prints once it is serving. */
async function start(args: string[]): Promise<{ child: ChildProcess; port: number }> {
  const port = await freePort();
  const child = spawn("python3", [...args, "--port", String(port)]);
  let errors = "";
  child.stderr?.on("data", (data) => { errors += data; });
  await new Promise<void>((resolve, reject) => {
    createInterface({ input: child.stdout! }).once("line", () => resolve());
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`${args[0]} exited (${code}): ${errors}`)));
  });
  return { child, port };
}

async function fingerprint(path: string) {
  const sidecars = (await readdir(dirname(path))).filter((name) => name.startsWith(`${basename(path)}-`));
  return {
    sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
    mtime: (await stat(path)).mtimeMs,
    sidecars,
  };
}

/** Both rooms on one origin: /sqlite reads to the structural adapter, /world to the reading. */
export async function serve(db: string, declaration: string, use: (origin: string) => Promise<void>, frontendPort = 8143) {
  const before = await fingerprint(db);
  const children: ChildProcess[] = [];
  let proxy: Server | undefined;
  try {
    const structural = await start(["adapters/sqlite/server.py", "--db", db]);
    children.push(structural.child);
    const reading = await start(["adapters/world/server.py", "--db", db, "--declaration", declaration]);
    children.push(reading.child);
    proxy = createServer((incoming, outgoing) => {
      const path = incoming.url ?? "/";
      const port = path.startsWith("/sqlite/schema") || path.startsWith("/sqlite/rows")
        ? structural.port
        : path.startsWith("/world/") ? reading.port : frontendPort;
      const target = new URL(path, `http://127.0.0.1:${port}`);
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
  } finally {
    proxy?.closeAllConnections();
    if (proxy) await new Promise<void>((resolve) => proxy!.close(() => resolve()));
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, "exit");
        child.kill("SIGINT");
        await stopped;
      }
    }
  }
  // Every read in this worker went through these files; none changed them.
  expect(await fingerprint(db)).toEqual(before);
}

/** Whether `prepare.py --view-copy` has been run here. */
export const prepared = () => existsSync(UPSTREAM) && existsSync(VIEW_COPY);

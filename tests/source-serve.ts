/** Actual HTTP source adapter, no route mocks. Operator-only fault injection
 * uses process stdin; every producer's hash, mtime and sidecars are checked. */
import { expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer, request } from "node:http";
import { basename, dirname } from "node:path";
import { createInterface } from "node:readline";

export async function fingerprint(path: string) {
  return {
    sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
    mtimeNs: (await stat(path, { bigint: true })).mtimeNs.toString(),
    sidecars: (await readdir(dirname(path))).filter((name) => name.startsWith(`${basename(path)}-`)).sort(),
  };
}

export async function serveSource(db: string, use: (server: { origin: string; commands: (command: string) => Promise<void>; captureFingerprint: () => Promise<{ sha256: string; mtime_ns: string; sidecars: string[] }>; requests: URL[] }) => Promise<void>, readerOptions = {}) {
  const before = await fingerprint(db);
  const child = spawn("python3", ["-u", "tests/source_fixture.py", db, JSON.stringify(readerOptions)]);
  const lines = createInterface({ input: child.stdout });
  const queue: string[] = [];
  let receive: ((line: string) => void) | undefined;
  lines.on("line", (line) => { if (receive) { const done = receive; receive = undefined; done(line); } else queue.push(line); });
  let errors = "";
  child.stderr.on("data", (data) => { errors += data; });
  const next = () => queue.length ? Promise.resolve(queue.shift()!) : new Promise<string>((resolve, reject) => {
    receive = resolve;
    child.once("exit", (code) => reject(new Error(`Source fixture exited (${code}): ${errors}`)));
    child.once("error", reject);
  });
  let proxy: ReturnType<typeof createServer> | undefined;
  const requests: URL[] = [];
  try {
    const port = Number(await next());
    if (!port) throw new Error(`Invalid adapter port: ${errors}`);
    proxy = createServer((incoming, outgoing) => {
      const path = incoming.url ?? "/";
      const target = new URL(path, path.startsWith("/source/v1/") ? `http://127.0.0.1:${port}` : `http://127.0.0.1:${process.env.KI_SOURCE_VITE_PORT ?? "8143"}`);
      if (path.startsWith("/source/v1/")) requests.push(target);
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
    if (!address || typeof address === "string") throw new Error("Missing source proxy port");
    await use({ origin: `http://127.0.0.1:${address.port}`, requests, captureFingerprint: async () => {
      child.stdin.write("fingerprint\n"); return JSON.parse(await next());
    }, commands: async (command) => {
      child.stdin.write(`${command}\n`);
      expect(await next()).toBe("done");
    } });
  } finally {
    proxy?.closeAllConnections();
    if (proxy) await new Promise<void>((resolve) => proxy!.close(() => resolve()));
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.stdin.end("stop\n");
      await stopped;
    }
    lines.close();
    expect(await fingerprint(db)).toEqual(before);
  }
}

/** `bin/ki open` on real Chinook, with no Vite: run with `npx playwright test -c playwright.app.config.ts`.
 *
 * KI_EXECUTABLE=/path/to/venv/bin/ki runs the same test against an installed
 * wheel instead: from an empty directory outside the checkout, with no
 * PYTHONPATH, and with `node`, `npm`, `npx` and `vite` stubs first on PATH
 * that record any call (scripts/test_installed_wheel.py covers the rest). */
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepared, UPSTREAM } from "./chinook-serve";

const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

async function freePort(): Promise<number> {
  return new Promise((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); }); });
}

const INSTALLED = process.env.KI_EXECUTABLE;

/** An installed `ki` runs away from the checkout, with Node and npm stubbed out. */
function installedEnvironment(tmp: string) {
  const elsewhere = join(tmp, "..", "elsewhere"), stubs = join(tmp, "..", "stubs"), marker = join(tmp, "..", "node-was-called");
  mkdirSync(elsewhere, { recursive: true }); mkdirSync(stubs, { recursive: true });
  for (const name of ["node", "npm", "npx", "vite"]) {
    writeFileSync(join(stubs, name), `#!/bin/sh\necho "${name} $*" >> ${marker}\nexit 127\n`); chmodSync(join(stubs, name), 0o755);
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PYTHON|VIRTUAL_ENV|CONDA)/.test(key)));
  return { cwd: elsewhere, marker, env: { ...env, PATH: `${stubs}:/usr/bin:/bin`, TMPDIR: tmp } };
}

function launch(port: number, tmp: string): Promise<{ child: ChildProcessWithoutNullStreams; url: string; output: () => string }> {
  const child = INSTALLED
    ? spawn(INSTALLED, ["open", resolve(UPSTREAM), "--no-browser", "--port", String(port)], installedEnvironment(tmp))
    : spawn("python3", ["bin/ki", "open", UPSTREAM, "--no-browser", "--port", String(port)], { env: { ...process.env, TMPDIR: tmp } });
  let text = "";
  child.stdout.on("data", (chunk) => { text += chunk; });
  child.stderr.on("data", (chunk) => { text += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const found = text.match(/Knowledge Inspector: (http:\/\/127\.0\.0\.1:\d+\/source)/);
      if (found) { clearInterval(timer); resolve({ child, url: found[1], output: () => text }); }
    }, 100);
    child.on("exit", (code) => { clearInterval(timer); reject(new Error(`ki exited ${code}: ${text}`)); });
  });
}

function stop(child: ChildProcessWithoutNullStreams, signal: "SIGINT" | "SIGTERM" = "SIGINT"): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => { child.once("exit", (code) => resolve(code)); child.kill(signal); });
}

test("bin/ki open: one loopback origin, refresh restores within a launch, a new launch starts empty, stopping releases the capture", async ({ page }) => {
  test.skip(!prepared(), "Prepare pinned Chinook");
  test.skip(!INSTALLED && !existsSync("dist/index.html"), "Build the frontend first: npm run build");
  test.setTimeout(90_000);
  const home = mkdtempSync(join(tmpdir(), "ki-app-e2e-")), tmp = join(home, "tmp");
  mkdirSync(tmp);
  const port = await freePort(), before = digest(UPSTREAM);
  const captures = () => readdirSync(tmp).filter((name) => name.startsWith("knowledge-inspector-source-"));
  const children: ChildProcessWithoutNullStreams[] = [];
  try {
    const first = await launch(port, tmp);
    children.push(first.child);
    expect(first.url).toBe(`http://127.0.0.1:${port}/source`);
    expect(captures()).toHaveLength(1);
    const served: string[] = [];
    page.on("request", (request) => served.push(new URL(request.url()).origin));
    await page.goto(first.url);
    // The empty canvas is the schema (O12): eleven tables, from this one process.
    await expect(page.locator(".source-schema")).toHaveAttribute("data-schema-tables", "11");
    const session = async () => page.evaluate(async () => (await (await fetch("/source/v1/session", { cache: "no-store" })).json()));
    const descriptor = await session(), generation = descriptor.generation;
    expect(descriptor.idle_ttl_seconds).toBeNull();
    const exploration = () => page.evaluate((namespace) => Object.fromEntries(Object.entries(sessionStorage).filter(([key]) => key.includes(namespace))), descriptor.source_namespace);
    // Both Source cameras use tab storage in the built application too.
    await expect(page.locator(".source-schema canvas").first()).toBeVisible();
    await page.waitForTimeout(500);
    const schemaValue = async () => Object.entries(await exploration()).find(([key]) => key.endsWith(":schema:1"))?.[1];
    const initialCamera = await schemaValue();
    await page.mouse.move(800, 200); await page.mouse.wheel(0, -240);
    await expect.poll(schemaValue).not.toBe(initialCamera);
    await page.waitForTimeout(400);
    const schemaCamera = Object.entries(await exploration()).find(([key]) => key.endsWith(":schema:1"));
    await page.reload();
    await expect(page.locator(".source-schema canvas").first()).toBeVisible();
    expect(Object.entries(await exploration()).find(([key]) => key.endsWith(":schema:1"))).toEqual(schemaCamera);
    await page.locator("#source-tables").getByRole("button", { name: "Track table", exact: true }).click();
    await page.locator("#source-tables").getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await expect(page.locator("[data-field-record]")).toHaveCount(1);
    await page.locator("#source-tables").getByRole("combobox", { name: "name Track records by" }).selectOption("Name");
    const reader = page.locator("#source-reader .motion-swap__is");
    await reader.getByText("source details", { exact: true }).click();
    await expect(reader.locator("dt").filter({ hasText: /^idle expiry$/ }).locator("+ dd")).toHaveText("none");
    await page.getByRole("region", { name: "Source canvas", exact: true }).getByRole("button", { name: "filter", exact: true }).click();
    await page.getByRole("group", { name: "Filter" }).getByRole("button", { name: "connections", exact: true }).click();
    await page.getByRole("region", { name: "Source canvas", exact: true }).getByRole("button", { name: "filter", exact: true }).click();
    await page.waitForTimeout(500);
    await page.mouse.move(800, 200); await page.mouse.wheel(0, -240);
    await expect.poll(async () => {
      const value = Object.entries(await exploration()).find(([key]) => key.startsWith("worldir.camera:") && !key.endsWith(":schema:1"))?.[1];
      return value ? JSON.parse(value).zoom : 1;
    }).not.toBe(1);
    const stored = await exploration();
    expect(Object.keys(stored).filter((key) => key.startsWith("ki.source."))).toHaveLength(3);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => /^ki\.source\.(field|naming|show):|^worldir\.camera:field:source:/.test(key)))).toEqual([]);
    // Refresh: the same session, and the canvas comes back (O8.8 within a launch, O20).
    await page.reload();
    await expect(page.locator(".source-restore")).toHaveText("restored 1 record from the last visit");
    await expect(page.locator("[data-field-record]")).toHaveText(["For Those About To Rock (We Salute You)"]);
    expect((await session()).generation).toBe(generation);
    await page.waitForTimeout(500);
    const restored = await exploration();
    expect(Object.keys(restored).sort()).toEqual(Object.keys(stored).sort());
    for (const [key, value] of Object.entries(stored)) {
      if (key.startsWith("worldir.camera:")) {
        const before = JSON.parse(value), after = JSON.parse(restored[key]);
        expect(after).toMatchObject({ version: before.version, world: before.world, revision: before.revision });
        // G6's camera uses float32 coordinates; restoring can round by ~0.00001.
        for (const coordinate of ["zoom", "cx", "cy"]) expect(after[coordinate]).toBeCloseTo(before[coordinate], 3);
      } else expect(restored[key]).toBe(value);
    }
    await page.getByRole("region", { name: "Source canvas", exact: true }).getByRole("button", { name: "filter", exact: true }).click();
    await expect(page.getByRole("group", { name: "Filter" }).getByRole("button", { name: "connections", exact: true })).toHaveAttribute("aria-pressed", "false");
    expect(new Set(served)).toEqual(new Set([`http://127.0.0.1:${port}`]));
    expect(await stop(first.child)).toBe(0);
    expect(first.output()).toContain("stopped; capture released");
    expect(captures()).toEqual([]);
    // A new launch on the same port (so the same browser origin): a new capture namespace, nothing restored.
    const second = await launch(port, tmp);
    children.push(second.child);
    await page.goto(second.url);
    await expect(page.locator(".source-schema")).toHaveAttribute("data-schema-tables", "11");
    await page.waitForTimeout(500);
    await expect(page.locator(".source-restore")).toHaveCount(0);
    await expect(page.locator("[data-field-record]")).toHaveCount(0);
    const fresh = await session();
    expect(fresh.generation).not.toBe(generation);
    expect(fresh.source_namespace).not.toBe(descriptor.source_namespace);
    expect(fresh.idle_ttl_seconds).toBeNull();
    // The same tab still has its old sessionStorage, but this launch reads none of it.
    const freshState = await page.evaluate((namespace) => Object.entries(sessionStorage).filter(([key]) => key.includes(namespace)), fresh.source_namespace);
    expect(freshState.some(([key]) => key.startsWith("ki.source.field:"))).toBe(false);
    // A fresh schema may already have recorded its initial fit. It cannot use
    // the previous launch's deliberately moved camera.
    const fitted = freshState.find(([key]) => key.startsWith("worldir.camera:"));
    if (fitted) {
      const freshCamera = JSON.parse(fitted[1]), previousCamera = JSON.parse(schemaCamera![1]);
      expect(freshCamera.world).toBe(`source:${fresh.source_namespace}:${fresh.capture_digest}:schema`);
      expect(freshCamera.zoom).not.toBeCloseTo(previousCamera.zoom, 3);
    }
    expect(JSON.parse(freshState.find(([key]) => key.startsWith("ki.source.naming:"))![1])).toEqual({});
    expect(JSON.parse(freshState.find(([key]) => key.startsWith("ki.source.show:"))![1])).toMatchObject({ connections: true, hiddenTables: [] });
    await page.locator("#source-tables").getByRole("button", { name: "Track table", exact: true }).click();
    await expect(page.locator("#source-tables").getByRole("combobox", { name: "name Track records by" })).toHaveValue("");
    expect(await stop(second.child, "SIGTERM")).toBe(0);
    expect(captures()).toEqual([]);
    expect(digest(UPSTREAM)).toBe(before);
    if (INSTALLED) expect(existsSync(join(home, "node-was-called"))).toBe(false);
  } finally {
    for (const child of children) await stop(child);
    rmSync(home, { recursive: true, force: true });
  }
});

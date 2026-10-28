#!/usr/bin/env node
/**
 * Runtime benchmark for an installed `ki` wheel, driven through the real UI.
 *
 *   node benchmarks/ui_bench.mjs --ki /path/to/venv/bin/ki --fixtures DIR \
 *        [--chinook PATH] [--out results.json] [--only startup,ops,growth] [--reps N]
 *
 * Nothing here reaches into renderer internals: it clicks the application's own
 * controls, reads the DOM, and samples the browser's own performance APIs.
 * Latency, frame/long-task and memory samples are taken in separate passes so
 * that instrumentation does not contaminate the timings.
 */
import { chromium } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir, cpus, totalmem, release } from "node:os";
import { join, resolve } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "1"]] : acc), []));
const KI = resolve(args.ki ?? "ki"), FIXTURES = resolve(args.fixtures ?? "."), CHINOOK = args.chinook && resolve(args.chinook);
const ONLY = (args.only ?? "startup,tables,ops,growth").split(",");
const REPS = Number(args.reps ?? 10), STARTUP_REPS = Number(args["startup-reps"] ?? 5);
const VIEWPORT = { width: 1440, height: 900 }, DSF = 1;

// ---------- statistics ----------
const sorted = (xs) => [...xs].sort((a, b) => a - b);
const quantile = (xs, q) => { const s = sorted(xs); if (!s.length) return null; const i = (s.length - 1) * q, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
const r1 = (x) => x === null || x === undefined ? null : Math.round(x * 10) / 10;
/** p95 is reported only from 20 or more samples; below that the maximum is the honest tail. */
const summarize = (xs) => ({ n: xs.length, median: r1(quantile(xs, .5)), p95: xs.length >= 20 ? r1(quantile(xs, .95)) : null, min: r1(Math.min(...xs)), max: r1(Math.max(...xs)) });
const fingerprint = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

// ---------- process helpers ----------
function rss(pid) {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const kb = (key) => Number(status.match(new RegExp(`${key}:\\s+(\\d+) kB`))[1]);
  return { rss_mb: r1(kb("VmRSS") / 1024), peak_rss_mb: r1(kb("VmHWM") / 1024) };
}
/** Total RSS of the ki process and any children (the service is one process; this guards against forks). */
function treeRss(pid) {
  let total = 0;
  try {
    const pids = execFileSync("pgrep", ["-P", String(pid)]).toString().split("\n").filter(Boolean).map(Number);
    for (const child of pids) total += rss(child).rss_mb;
  } catch { /* no children */ }
  return r1(rss(pid).rss_mb + total);
}

async function launch(database) {
  const tmp = mkdtempSync(join(tmpdir(), "ki-bench-"));
  const started = performance.now();
  const child = spawn(KI, ["open", database, "--no-browser"], { env: { PATH: "/usr/bin:/bin", TMPDIR: tmp }, cwd: tmp });
  let text = "";
  child.stdout.on("data", (d) => { text += d; }); child.stderr.on("data", (d) => { text += d; });
  const url = await new Promise((ok, fail) => {
    const timer = setInterval(() => { const m = text.match(/Knowledge Inspector: (http:\/\/127\.0\.0\.1:\d+\/source)/); if (m) { clearInterval(timer); ok(m[1]); } }, 5);
    child.on("exit", (code) => { clearInterval(timer); fail(new Error(`ki exited ${code}: ${text}`)); });
  });
  const listenMs = performance.now() - started;
  // The capture is a directory holding one snapshot.sqlite: a full read-only copy of the database.
  const capture = readdirSync(tmp).filter((n) => n.startsWith("knowledge-inspector-source-")).flatMap((n) => readdirSync(join(tmp, n)).map((f) => statSync(join(tmp, n, f)).size));
  return { child, url, listenMs, tmp, captureBytes: capture.reduce((a, b) => a + b, 0),
    async stop() { if (child.exitCode === null) await new Promise((ok) => { child.once("exit", ok); child.kill("SIGINT"); }); rmSync(tmp, { recursive: true, force: true }); } };
}

// ---------- in-page instrumentation ----------
/** Installed before any page script. `click` timing uses the capture-phase event timestamp, so it starts when the input was dispatched. */
const INIT = () => {
  const b = (window.__bench = { t0: 0, seen: {}, frames: null, longtasks: null });
  addEventListener("click", (e) => { b.t0 = e.timeStamp; }, true);
  addEventListener("keydown", (e) => { b.t0 = e.timeStamp; }, true);
  /** Resolve with ms from the last input to when `cond` first held (dom) and to the next painted frame (paint). */
  b.wait = (src, timeout = 30000) => new Promise((resolve, reject) => {
    const cond = new Function(`return (${src})()`);
    let done = false;
    const hit = () => {
      if (done || !cond()) return; done = true; mo.disconnect(); clearInterval(poll);
      const dom = performance.now() - b.t0;
      requestAnimationFrame(() => requestAnimationFrame(() => resolve({ dom, paint: performance.now() - b.t0 })));
    };
    const mo = new MutationObserver(hit); mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    const poll = setInterval(hit, 25);
    setTimeout(() => { if (!done) { done = true; mo.disconnect(); clearInterval(poll); reject(new Error("timeout: " + src)); } }, timeout);
    hit();
  });
  // count of placed records over time, for restore timing
  const note = () => { const n = document.querySelectorAll(".source-field-list [data-field-record]").length; if (n && !(n in b.seen)) b.seen[n] = performance.now(); };
  new MutationObserver(note).observe(document, { subtree: true, childList: true });
  b.startFrames = () => {
    b.frames = []; b.longtasks = [];
    let last = performance.now();
    const tick = (t) => { if (!b.frames) return; b.frames.push(t - last); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    b.observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) b.longtasks.push(e.duration); });
    b.observer.observe({ entryTypes: ["longtask"] });
  };
  b.stopFrames = () => { const out = { frames: b.frames, longtasks: b.longtasks }; b.frames = null; b.observer?.disconnect(); return out; };
};

async function newPage(browser, url) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DSF, reducedMotion: args["reduced-motion"] ? "reduce" : "no-preference" });
  const page = await context.newPage();
  await page.addInitScript(INIT);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const requests = { count: 0, bytes: 0 };
  page.on("response", async (r) => { if (r.url().includes("/source/v1/")) { requests.count++; } });
  await page.goto(url);
  await page.waitForSelector(".source-schema[data-schema-tables]", { state: "attached" });
  return { context, page, errors, requests };
}

const waitFor = (page, fn, timeout) => page.evaluate(([src, t]) => window.__bench.wait(src, t), [typeof fn === "string" ? fn : fn.toString(), timeout]);
const placedCount = () => document.querySelectorAll(".source-field-list [data-field-record]").length;

async function heap(page) {
  const client = await page.context().newCDPSession(page);
  await client.send("HeapProfiler.enable");
  await client.send("HeapProfiler.collectGarbage"); await client.send("HeapProfiler.collectGarbage");
  const usage = await client.send("Runtime.getHeapUsage");
  const metrics = Object.fromEntries((await client.send("Performance.getMetrics").catch(() => ({ metrics: [] }))).metrics.map((m) => [m.name, m.value]));
  await client.detach();
  return { js_heap_used_mb: r1(usage.usedSize / 1048576), js_heap_total_mb: r1(usage.totalSize / 1048576) };
}

async function openTable(page, name) {
  const catalogue = page.locator("#source-tables .source-table-slot > .motion-swap > .motion-swap__is [data-catalogue]");
  const target = page.getByRole("button", { name: `${name} table`, exact: true });
  for (let i = 0; i < 200 && !(await catalogue.isVisible() || await target.isVisible()); i++) await page.waitForTimeout(10);
  if (await catalogue.isVisible()) await catalogue.click();
  await target.click();
}
const backToCatalogue = async (page) => {
  const back = page.getByRole("button", { name: "tables", exact: true });
  if (await back.count()) await back.first().click();
  await page.getByTitle("Clear the canvas").waitFor({ state: "attached" });
};
const clearCanvas = async (page) => { const b = page.getByTitle("Clear the canvas"); if (await b.isDisabled()) return; await b.click(); await waitFor(page, () => document.querySelectorAll(".source-field-list [data-field-record]").length === 0, 15000); };

// ---------- scenario: startup ----------
async function startup(browser, dataset, label) {
  const runs = [];
  for (let i = 0; i < STARTUP_REPS; i++) {
    const before = fingerprint(dataset);
    const server = await launch(dataset);
    const idle = treeRss(server.child.pid);
    const t = performance.now();
    const { context, page, errors } = await newPage(browser, server.url);
    const uiMs = performance.now() - t;
    const nav = await page.evaluate(() => { const n = performance.getEntriesByType("navigation")[0], paint = performance.getEntriesByName("first-contentful-paint")[0]; return { dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd, fcp: paint?.startTime ?? null, transfer: performance.getEntriesByType("resource").reduce((s, r) => s + r.transferSize, 0) }; });
    // Warm: same context, HTTP cache populated, new navigation to the same running service.
    const w = performance.now();
    await page.reload(); await page.waitForSelector(".source-schema[data-schema-tables]", { state: "attached" });
    const warmMs = performance.now() - w;
    const after = treeRss(server.child.pid), peak = rss(server.child.pid).peak_rss_mb;
    runs.push({ listen_ms: r1(server.listenMs), first_ui_ms: r1(uiMs), warm_reload_ui_ms: r1(warmMs), dcl_ms: r1(nav.dcl), fcp_ms: r1(nav.fcp), transfer_kb: r1(nav.transfer / 1024),
      rss_idle_mb: idle, rss_after_ui_mb: after, peak_rss_mb: peak, capture_mb: r1(server.captureBytes / 1048576), page_errors: errors.length });
    await context.close(); await server.stop();
    if (fingerprint(dataset) !== before) throw new Error("input database was modified: " + dataset);
  }
  const col = (k) => runs.map((r) => r[k]);
  return { dataset: label, db_mb: r1(statSync(dataset).size / 1048576), runs,
    first_run: runs[0], summary: Object.fromEntries(["listen_ms", "first_ui_ms", "warm_reload_ui_ms", "fcp_ms", "rss_idle_mb", "rss_after_ui_mb", "peak_rss_mb", "capture_mb"].map((k) => [k, summarize(col(k).slice(1))])) };
}

// ---------- scenario: cold validation versus later navigation ----------
/** The first read of a table verifies every row's identity (cold); later opens reuse that verdict. Service RSS is read around it. */
async function largeTable(browser, dataset, label) {
  const server = await launch(dataset);
  const { context, page, errors } = await newPage(browser, server.url);
  try {
    const before = rss(server.child.pid);
    const rows = `() => !!document.querySelector('button[aria-label="Inspect row 1"]')`;
    const cold = await timed(page, () => openTable(page, "event"), rows);
    const afterCold = rss(server.child.pid);
    const warm = [];
    for (let i = -1; i < 8; i++) {
      await backToCatalogue(page);
      const r = await timed(page, () => openTable(page, "event"), rows);
      if (i >= 0) warm.push(r.dom);
    }
    const afterWarm = rss(server.child.pid);
    return { dataset: label, rows: Number(label.split("-")[1]), first_open_ms: r1(cold.dom), later_open_ms: summarize(warm),
      rss_before_mb: before.rss_mb, rss_after_first_open_mb: afterCold.rss_mb, rss_after_later_opens_mb: afterWarm.rss_mb, peak_rss_mb: afterWarm.peak_rss_mb, page_errors: errors };
  } finally { await context.close(); await server.stop(); }
}

// ---------- scenario: single interactions ----------
async function timed(page, action, cond) {
  await action(); // click sets __bench.t0 in the capture phase
  return waitFor(page, cond, 30000);
}

async function ops(browser, dataset, label, spec) {
  const server = await launch(dataset);
  const { context, page, errors } = await newPage(browser, server.url);
  const samples = Object.fromEntries(spec.names.map((n) => [n, { dom: [], paint: [] }]));
  const record = (name, r, warm) => { if (!warm) { samples[name].dom.push(r.dom); samples[name].paint.push(r.paint); } };
  try {
    for (let rep = -2; rep < REPS; rep++) { // two warm-up repetitions are discarded
      const warm = rep < 0;
      await spec.run({ page, record: (n, r) => record(n, r, warm), timed });
    }
    const idle = treeRss(server.child.pid);
    return { dataset: label, fanout: spec.fanout, reps: REPS, warmup: 2, results: Object.fromEntries(Object.entries(samples).map(([n, s]) => [n, { to_dom_ms: summarize(s.dom), to_paint_ms: summarize(s.paint) }])), rss_mb: idle, page_errors: errors };
  } finally { await context.close(); await server.stop(); }
}

const makeSpec = (fanout) => ({
  fanout,
  names: ["open_table", "inspect_row", "follow_foreign_key", "add_page_of_50_to_canvas", "expand_relationships"],
  async run({ page, record, timed }) {
    const rowsVisible = (k) => `() => !!document.querySelector('button[aria-label="Inspect row ${k}"]')`;
    const count = (n) => `() => document.querySelectorAll(".source-field-list [data-field-record]").length >= ${n}`;
    await backToCatalogue(page);
    await clearCanvas(page);
    record("open_table", await timed(page, async () => { const c = page.locator("#source-tables [data-catalogue]"); await page.getByRole("button", { name: "child table", exact: true }).click(); }, rowsVisible(3)));
    record("inspect_row", await timed(page, () => page.getByRole("button", { name: "Inspect row 3", exact: true }).click(), `() => /id=3/.test(document.querySelector("#source-reader")?.innerText ?? "")`));
    record("follow_foreign_key", await timed(page, () => page.getByRole("button", { name: /go to parent referenced by parent_id/ }).click(), `() => /^\\s*parent/i.test(document.querySelector("#source-reader h2")?.innerText ?? "")`));
    await backToCatalogue(page); await clearCanvas(page);
    await openTable(page, "item");
    await page.getByRole("button", { name: "Inspect row 1", exact: true }).waitFor();
    record("add_page_of_50_to_canvas", await timed(page, () => page.getByRole("button", { name: "add all", exact: true }).click(), count(50)));
    await backToCatalogue(page); await clearCanvas(page);
    await openTable(page, "parent");
    await page.getByRole("button", { name: "Inspect row 1", exact: true }).click();
    const expand = page.getByRole("button", { name: /place on the canvas/ }).first();
    await expand.waitFor();
    // The parent row is already on the canvas (direct placement); the group adds its children.
    record("expand_relationships", await timed(page, () => expand.click(), count(fanout + 1)));
    await backToCatalogue(page); await clearCanvas(page);
  },
});

// ---------- scenario: working-set growth ----------
async function gestures(page) {
  const box = await page.locator(".source-canvas").first().boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(16); }   // zoom in
  for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(16); }    // zoom out
  const sx = box.x + 40, sy = box.y + box.height - 40;                                              // pan from an empty corner
  await page.mouse.move(sx, sy); await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(sx + i * 6, sy - i * 4);
  await page.mouse.up();
  await page.mouse.move(cx, cy); await page.mouse.down();                                            // drag at the centre (may land on a mark or the background)
  for (let i = 1; i <= 30; i++) await page.mouse.move(cx + i * 3, cy + i * 2);
  await page.mouse.up();
  await page.waitForTimeout(500);
}

/** After a bulk placement the canvas keeps working. Wait for a 1 s window with no long task and no slow frame; report how long that took. */
async function mainThreadQuiet(page, limitMs = 60000) {
  return page.evaluate(async (limit) => {
    const long = []; const start = performance.now();
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push({ end: e.startTime + e.duration, d: e.duration }); });
    po.observe({ entryTypes: ["longtask"] });
    let last = performance.now(), slow = start;
    await new Promise((resolve) => {
      const tick = (t) => { if (t - last > 50) slow = t; last = t;
        const quietSince = Math.max(slow, ...long.map((x) => x.end), start);
        if (t - quietSince >= 1000 || t - start > limit) return resolve();
        requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    po.disconnect();
    const lastBusy = Math.max(start, ...long.map((x) => x.end));
    return { settled: performance.now() - start <= limit, busy_ms: Math.round(lastBusy - start), longtasks: long.length, longtask_total_ms: Math.round(long.reduce((a, x) => a + x.d, 0)), longtask_max_ms: Math.round(Math.max(0, ...long.map((x) => x.d))) };
  }, limitMs);
}

async function measureWorkingSet(browser, page, url, requests, nodes, edges, extra = {}) {
  const quiet = await mainThreadQuiet(page);
  const heapAfterLoad = await heap(page);
  // Frame timing and long tasks during a standard pan/zoom/drag script (own pass).
  await page.evaluate(() => window.__bench.startFrames());
  await gestures(page);
  const raw = await page.evaluate(() => window.__bench.stopFrames());
  const f = raw.frames.slice(1);
  const frames = { frames: f.length, median_ms: r1(quantile(f, .5)), p95_ms: r1(quantile(f, .95)), max_ms: r1(Math.max(...f)), over_50ms: f.filter((x) => x > 50).length,
    longtasks: raw.longtasks.length, longtask_total_ms: r1(raw.longtasks.reduce((a, b) => a + b, 0)), longtask_max_ms: r1(Math.max(0, ...raw.longtasks)) };
  const heapAfterGestures = await heap(page);
  // Session restoration: reload, which rereads every placed record from the service.
  const before = requests.count;
  const t = performance.now();
  await page.reload();
  await page.waitForFunction((n) => document.querySelectorAll(".source-field-list [data-field-record]").length >= n, nodes, { timeout: 60000, polling: 10 });
  const restore_ms = performance.now() - t;
  const inPage = await page.evaluate((n) => window.__bench.seen[n] ?? null, nodes);
  return { nodes, edges, ...extra, after_placement_quiet: quiet, frames, heap_after_load: heapAfterLoad, heap_after_gestures: heapAfterGestures, restore: { reload_to_all_records_ms: r1(restore_ms), in_page_ms: r1(inPage), service_requests: requests.count - before } };
}

async function growthOnce(browser) {
  const out = { records_only: [], with_relationships: [] };
  // (a) records only: pages of 50 from `item` (no foreign keys, 0 displayed relationships).
  {
    const server = await launch(join(FIXTURES, "hub-500.sqlite"));
    const { context, page, requests, errors } = await newPage(browser, server.url);
    try {
      await openTable(page, "item");
      await page.getByRole("button", { name: "Inspect row 1", exact: true }).waitFor();
      const checkpoints = [50, 100, 200, 500];
      let placed = 0;
      const steps = [];
      while (placed < 500) {
        await page.getByRole("button", { name: "add all", exact: true }).waitFor({ timeout: 10000 }).catch(async () => { await page.screenshot({ path: process.env.KI_BENCH_DEBUG ?? "/tmp/ki-bench-debug.png" }); throw new Error(`no add-all at ${placed}: ` + (await page.locator("#source-tables").innerText()).slice(-300)); });
        const r = await timed(page, () => page.getByRole("button", { name: "add all", exact: true }).click(), `() => document.querySelectorAll(".source-field-list [data-field-record]").length >= ${placed + 50}`);
        placed += 50; steps.push(r.dom);
        const cp = checkpoints.includes(placed) ? await measureWorkingSet(browser, page, server.url, requests, placed, 0, { last_add_page_ms: r1(r.dom), add_page_ms_all_steps: summarize(steps) }) : null;
        if (cp) { out.records_only.push(cp); await openTable(page, "item"); await page.getByRole("button", { name: "Inspect row 1", exact: true }).waitFor(); }  // a reload closes the table panel
        if (placed < 500) {
          for (let k = cp ? 1 : placed / 50; k <= placed / 50; k++) {
            await page.getByRole("button", { name: "next rows", exact: true }).click();
            await page.getByRole("button", { name: `Inspect row ${k * 50 + 1}`, exact: true }).waitFor();
          }
        }
      }
      out.records_only_errors = errors;
    } finally { await context.close(); await server.stop(); }
  }
  // (b) records with relationships: one parent expanded through N children (N nodes + 1, N edges).
  for (const n of [50, 200, 500]) {
    const server = await launch(join(FIXTURES, `hub-${n}.sqlite`));
    const { context, page, requests, errors } = await newPage(browser, server.url);
    try {
      await openTable(page, "parent");
      await page.getByRole("button", { name: "Inspect row 1", exact: true }).click();
      const expand = page.getByRole("button", { name: /place on the canvas/ }).first();
      await expand.waitFor();
      const r = await timed(page, () => expand.click(), `() => document.querySelectorAll(".source-field-list [data-field-record]").length >= ${n + 1}`);
      out.with_relationships.push(await measureWorkingSet(browser, page, server.url, requests, n + 1, n, { expand_ms: r1(r.dom), expand_to_paint_ms: r1(r.paint) }));
      out.with_relationships.at(-1).page_errors = errors;
    } catch (error) {
      out.with_relationships.push({ nodes: n + 1, edges: n, failed: String(error.message).slice(0, 300) });
    } finally { await context.close(); await server.stop(); }
  }
  return out;
}

const GROWTH_REPS = Number(args["growth-reps"] ?? 3);
async function growth(browser) {
  const runs = [];
  for (let i = 0; i < GROWTH_REPS; i++) runs.push(await growthOnce(browser));
  return { reps: GROWTH_REPS, runs };
}

// ---------- main ----------
const browser = await chromium.launch({ headless: true });
const result = {
  environment: {
    date: new Date().toISOString(), cpu: cpus()[0].model, logical_cpus: cpus().length, ram_gb: r1(totalmem() / 2 ** 30), os: `Linux ${release()}`,
    node: process.version, chromium: browser.version(), headless: true, reduced_motion: !!args["reduced-motion"], viewport: VIEWPORT, device_scale_factor: DSF,
    ki: execFileSync(KI, ["--version"]).toString().trim(), python: execFileSync(join(KI, "..", "python"), ["-c", "import sys,sqlite3;print(sys.version.split()[0], 'sqlite', sqlite3.sqlite_version)"]).toString().trim(),
    gpu_note: "headless Chromium, software rasterisation; frame timings are not representative of a GPU-accelerated desktop",
  },
};
try {
  if (ONLY.includes("startup")) {
    result.startup = [];
    for (const [label, file] of [["hub-50 (16 KB)", join(FIXTURES, "hub-50.sqlite")], ["size-10000", join(FIXTURES, "size-10000.sqlite")], ["size-100000", join(FIXTURES, "size-100000.sqlite")], ["size-1000000", join(FIXTURES, "size-1000000.sqlite")], ...(CHINOOK ? [["Chinook", CHINOOK]] : [])])
      result.startup.push(await startup(browser, file, label));
  }
  if (ONLY.includes("tables")) {
    result.large_table = [];
    for (const n of [10000, 100000, 1000000]) result.large_table.push(await largeTable(browser, join(FIXTURES, `size-${n}.sqlite`), `size-${n}`));
  }
  if (ONLY.includes("ops")) {
    result.ops = [await ops(browser, join(FIXTURES, "hub-200.sqlite"), "hub-200", makeSpec(200)),
      await ops(browser, join(FIXTURES, "size-1000000.sqlite"), "size-1000000", makeSpec(50))];
  }
  if (ONLY.includes("growth")) result.growth = await growth(browser);
} finally { await browser.close(); }
writeFileSync(args.out ?? "ui-bench.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 1).slice(0, 6000));

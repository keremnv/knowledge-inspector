#!/usr/bin/env node
/**
 * CPU profile of one relationship expansion (parent -> N children), through the real UI.
 *
 *   node benchmarks/profile_expand.mjs --ki LAUNCHER --db hub-500.sqlite --children 500 --out profile.json
 *
 * Use a frontend built with `--minify false --sourcemap` so function names are readable
 * (see docs/PERFORMANCE.md). The profile slows execution; it is for attribution, not timing.
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const a = process.argv.slice(2), arg = (k, d) => (a.includes(`--${k}`) ? a[a.indexOf(`--${k}`) + 1] : d);
const KI = arg("ki"), DB = arg("db"), N = Number(arg("children", 500)), OUT = arg("out", "profile.json");
const tmp = mkdtempSync(join(tmpdir(), "ki-prof-"));
const child = spawn(KI, ["open", DB, "--no-browser"], { env: { PATH: "/usr/bin:/bin", TMPDIR: tmp } });
let text = ""; child.stdout.on("data", (d) => { text += d; });
const url = await new Promise((ok) => { const t = setInterval(() => { const m = text.match(/(http:\/\/127\.0\.0\.1:\d+\/source)/); if (m) { clearInterval(t); ok(m[1]); } }, 20); });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url);
await page.waitForSelector(".source-schema[data-schema-tables]", { state: "attached" });
const cat = page.locator("#source-tables [data-catalogue]");
if (await cat.isVisible()) await cat.click();
await page.getByRole("button", { name: "parent table", exact: true }).click();
await page.getByRole("button", { name: "Inspect row 1", exact: true }).click();
const expand = page.getByRole("button", { name: /place on the canvas/ }).first();
await expand.waitFor();
const cdp = await page.context().newCDPSession(page);
await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 500 }); await cdp.send("Profiler.start");
await expand.click();
await page.waitForFunction((n) => document.querySelectorAll(".source-field-list [data-field-record]").length >= n + 1, N, { timeout: 120000 });
await page.waitForTimeout(500);
// let the post-placement work finish before stopping
await page.evaluate(() => new Promise((ok) => { let last = performance.now(), quiet = 0; const tick = (t) => { quiet = t - last > 50 ? 0 : quiet + (t - last); last = t; quiet > 1500 ? ok() : requestAnimationFrame(tick); }; requestAnimationFrame(tick); }));
const { profile } = await cdp.send("Profiler.stop");
writeFileSync(OUT, JSON.stringify(profile));
await browser.close(); child.kill("SIGINT");

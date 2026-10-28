# Performance measurements

Measurements of the existing application, taken to describe it, not to tune it. The application code is unchanged by this work; the only non-benchmark edit is a one-line fix to a stale benchmark script (see [Existing evidence](#existing-evidence)).

- **Baseline commit:** `66290f3cf222d11c8e55b1d8a5a9f875f27a122b`
- **Wheel measured:** `knowledge_inspector-0.1.0-py3-none-any.whl`, SHA-256 `39ef2343328a90f8ab8ed154597ea2d0151d8cf899c386fda0bf8396456c2e24`, built from that commit with `scripts/build_release.py`
- **Raw results:** [`benchmarks/results/`](../benchmarks/results/) (one JSON file per scenario)

## Summary

| Finding | Value | Scope |
|---|---|---|
| Runtime dependencies | **none** beyond Python ≥ 3.11 (standard-library `sqlite3` and `http.server`) | wheel metadata |
| Wheel | **0.91 MB** (911,744 B) | 8 Python modules plus the compiled frontend |
| Frontend shipped | **2.32 MB raw, 0.79 MB gzip** across 16 files; main JS 2.08 MB (616 KB gzip), CSS 81 KB (14 KB gzip) | production build |
| Service memory | **≈28 MB RSS idle, ≈31 MB after the UI loads**, within 2 MB from a 16 KB to a 91 MB database; **peak 45 MB** while verifying a 100,000-row table. This is the Python service only: the browser's memory is not included | whole-process RSS, `/proc` |
| Service start to usable interface | **≈0.65 s** median: service listening in 0.10 s (0.28 s for a 91 MB database), then ≈0.54 s from creating a fresh browser context to the schema view being present (this includes creating the context and fetching 2.1 MB of uncompressed assets); a reload with a warm cache takes ≈0.24 s | headless Chromium, this machine |
| Common interactions | open table ≈ 30–40 ms, inspect row ≈ 70–110 ms, follow a foreign key ≈ 220–240 ms, place a 50-row page ≈ 190 ms (to DOM) | median of 10, two fixtures; the two fixtures differ by up to ±35 %, so differences of that size are noise |
| Records on the canvas, no relationships | 500 records: **21 MB JS heap** (JS heap only, not the renderer process), **0 long tasks during the scripted pan/zoom/drag** in all 3 repetitions, frames at the 60 Hz cap | headless, software rendering |
| Records with relationships | 200 relationships: ≈ 1.5 s to place. **500 relationships: ≈ 10.8 s to place plus ≈ 15 s of further main-thread work**, then 27–29 long tasks (max 0.57 s) during interaction | same |
| Large-table identity verification | 100,000 rows verified in **1.1 s** the first time, **35 ms** thereafter. At 1,000,000 rows the application **refuses** whole-table verification (`too large to verify within its limits`); rows stay browsable, canvas placement is unavailable | existing limits, unchanged |
| Retained Python allocations after identity verification | **0.27 MB vs 55.2 MB** for the current reader against the pre-refactor baseline, 100,000-row generated table (`tracemalloc`) | reproduction of the recorded comparison |

Everything above comes from one run of [`benchmarks/run_all.sh`](../benchmarks/run_all.sh).

## Methodology

**What is driven.** The installed wheel, started with `ki open DATABASE --no-browser` from a clean directory with a minimal `PATH`, and a headless Chromium driven by Playwright through the application's own controls. Nothing writes into renderer internals. Production builds do not expose the renderer handle that the development tests use, so the benchmark observes only the DOM and browser performance APIs.

**Separate passes.** Each measurement type has its own pass so instrumentation never inflates another:

| Pass | Instrument | Not mixed with |
|---|---|---|
| Interaction latency | capture-phase input timestamp to the moment a DOM condition first holds (`to_dom`) and to the following painted frame (`to_paint`), via an in-page `MutationObserver` | frame, long-task and heap sampling |
| After placement | main thread watched until a 1 s window has no long task and no frame over 50 ms (`busy_ms` is how long that took) | gestures |
| Frames and long tasks | `requestAnimationFrame` intervals and `PerformanceObserver('longtask')` during one fixed script: 10 wheel steps in, 10 out, a 30-step pan from an empty corner, a 30-step drag from the canvas centre | latency |
| JS heap | `HeapProfiler.collectGarbage` twice, then `Runtime.getHeapUsage` | everything else |
| Service memory | `VmRSS`/`VmHWM` of the `ki` process from `/proc`, never the Python allocator | JS heap, `tracemalloc` |
| Python allocations | `tracemalloc` in the existing `docs/evidence/measure_memory.py`, run separately | timings (it slows Python several-fold) |
| CPU attribution | Chrome CPU profile of one expansion on an unminified build, [`profile_expand.mjs`](../benchmarks/profile_expand.mjs) | all timings |

**Workload dimensions** are varied independently, using deterministic generated databases ([`make_fixtures.py`](../benchmarks/make_fixtures.py)) plus the pinned Chinook file:

| Dimension | How it is varied | Fixtures |
|---|---|---|
| Database size | an `event` table of 10 k / 100 k / 1 M rows (0.9 / 9 / 91 MB) beside an unchanged 3-table core | `size-*.sqlite` |
| Records on the canvas | pages of 50 `item` rows placed with *add all*; no foreign keys, so 0 displayed relationships | `hub-500.sqlite` |
| Displayed relationships | one parent expanded through N children (*place on the canvas* on the referenced-by group): N + 1 records, N relationships | `hub-50/200/500.sqlite` |

In this star topology the number of relationships tracks the number of records minus one. A topology with many more relationships than records (for example a dense mesh) was not measured.

**Repetition and statistics.** Interactions: 2 warm-up repetitions discarded, then 10 measured, on a single running service. Startup: a new service process and new browser context each time, 6 repetitions, first one kept separately and excluded from the median. Working-set growth: the whole scenario repeated 3 times with fresh processes. Medians are reported. A p95 is reported only for 20 or more samples; no scenario reaches that, so the tail is shown as the maximum. Working-set growth medians are of **3** repetitions, which is thin: the highest and lowest of the three differed by at most 25 % for every quoted figure (under 15 % for most; the heap by under 1 %), but that is three runs, not a distribution.

**Read-only inputs.** Fixtures are generated into a temporary directory and deleted afterwards. The startup scenario hashes each input file before and after every launch and fails if it changed.

**Cold versus warm.** *Cold* means a new service process and an empty browser cache. *Warm* means the same running service, reloaded with the browser cache. The operating system's file cache was **not** dropped (that needs root), so "cold" does not mean cold disk.

### Environment

| | |
|---|---|
| CPU | Intel Core Ultra 5 125H, 18 logical CPUs |
| RAM | 14.2 GB |
| OS / kernel | Linux 7.0.0-38-generic x86_64 |
| CPU governor | `powersave`; clock readings from 0.4 to 2.0 GHz during runs |
| Python / SQLite | 3.13.12 / 3.51.1 |
| Node.js | 22.22.1 |
| Chromium | 153.0.8010.12 (Playwright 1.63.0), **headless** (Playwright's headless shell, not a full desktop Chrome), software rasterisation |
| Viewport | 1440 × 900, device scale factor 1, normal motion (reduced motion measured separately) |

**Run-to-run drift.** Two sessions on the same machine and commit differed in absolute time. An earlier exploratory session (its raw files were not archived) measured the first usable interface at ≈ 315 ms against ≈ 540 ms in the final run, and its single-interaction medians were 1.1× to 2.3× faster (open table 16 vs 37 ms, expand 200 relationships 0.99 vs 1.28 s); a 500-record add took ≈ 440 ms against ≈ 570 ms. Within one session repeats agree closely (the spread of six startups is a few percent). The governor and other desktop activity are the likely cause, not something the benchmark can control. **Treat absolute times as indicative for this machine; the scaling shape (what grows with what) was identical in both sessions.** Frame times are capped at the 60 Hz refresh and, in headless mode with software rasterisation, say nothing about GPU-accelerated desktops.

## Results

### Distribution

| | Raw | gzip (level 6) |
|---|---:|---:|
| Main JavaScript (`index-*.js`) | 2,080,304 B | 615,875 B |
| CSS | 81,307 B | 14,422 B |
| Fonts (12 files, woff and woff2 variants; a browser fetches one per face) | 154,752 B | not measured |
| All 16 shipped frontend files | 2,318,534 B | 786,166 B |
| Wheel | 911,744 B | |
| Installed Python + frontend in `site-packages` | 2,612,097 B | |

The wheel declares only `Requires-Python: >=3.11`; installing it into a fresh virtual environment adds one distribution, `knowledge-inspector`. A first page load transfers 2.15 MB (uncompressed: the bundled server does not compress responses).

Where the JavaScript comes from, by the *source* size each package contributes before minification (from a sourcemap build; a guide to relative weight, not shipped bytes):

| Share | Package or area |
|---:|---|
| 17.3 % | `@antv/layout` |
| 15.3 % | `@antv/g6` |
| 14.1 % | application code under `src/world` (shared canvas, relationship and reader modules) |
| 10.0 % | `@antv/g-lite` |
| 9.0 % | `react-dom` |
| 6.8 % | `html2canvas` |
| 6.4 % | `@antv/component` |
| 4.2 % | application code under `src/source` |

### Startup

Median of 5 (6 launches, first discarded); `listen` is process start to the "Knowledge Inspector:" line, so it includes the read-only capture.

| Database | Size | Service listening | First usable interface | Warm reload | RSS idle → after UI | Capture on disk |
|---|---:|---:|---:|---:|---:|---:|
| `hub-50` | 16 KB | 101 ms | 548 ms | 241 ms | 26.3 → 29.0 MB | 0 MB |
| `size-10000` | 0.9 MB | 102 ms | 531 ms | 246 ms | 28.2 → 30.9 MB | 0.9 MB |
| `size-100000` | 9.1 MB | 120 ms | 538 ms | 214 ms | 28.1 → 30.9 MB | 9.1 MB |
| `size-1000000` | 91.1 MB | 278 ms | 539 ms | 241 ms | 28.2 → 30.9 MB | 91.1 MB |
| Chinook | 1.0 MB | 104 ms | 589 ms | 278 ms | 29.0 → 31.8 MB | 1.0 MB |

"First usable interface" is browser context creation to the schema view being present. The capture is a full on-disk copy of the database made by SQLite's online backup, so disk use equals database size while process memory does not depend on it. The capture time (the difference in `listen`) is roughly linear in size (≈ 2 ms per MB here). Startup showed no page errors in any repetition.

### Opening a large table: validation versus later navigation

Opening a table the first time verifies the identity of every row in it (so handles can be issued); later opens reuse that verdict.

| Table rows | First open | Later opens (median of 8) | Service RSS before → after |
|---:|---:|---:|---:|
| 10,000 | 244 ms | 35 ms | 30.8 → 33.2 MB |
| 100,000 | 1,122 ms | 35 ms | 30.8 → 34.7 MB (peak 44.7 MB during verification) |
| 1,000,000 | 160 ms, **verification refused** | 35 ms | 30.9 → 31.2 MB |

At 1,000,000 rows the table's footer reads *key verification incomplete · too large to verify within its limits*; rows remain browsable but *canvas placement unavailable*. This is the application's existing bounded-read budget working as designed. **The 160 ms is the time to refuse, not to verify**, and no limits were raised to obtain a result.

### Interactions

Median of 10 after 2 warm-ups. `to_dom` is input to the condition being true in the DOM; `to_paint` is to the next painted frame. Maximum is shown instead of a p95.

| Interaction | `hub-200` to DOM | to paint | max | `size-1000000` to DOM |
|---|---:|---:|---:|---:|
| Open a table (first rows visible) | 37 ms | 58 ms | 65 ms | 29 ms |
| Inspect a row (Reader shows it, record placed) | 107 ms | 134 ms | 126 ms | 69 ms |
| Follow a foreign key to the parent record | 219 ms | 234 ms | 269 ms | 238 ms |
| Place a page of 50 records (*add all*) | 196 ms | 224 ms | 209 ms | 187 ms |
| Expand all references to a parent: 200 children / 50 children | 1,278 ms | 1,436 ms | 1,506 ms | 172 ms (50 children) |

The two fixtures use the same small tables, so database size is isolated: the 91 MB database's results are within about ±35 % of the 16 KB one's, in both directions (inspect row 107 vs 69 ms, follow a foreign key 219 vs 238 ms). That spread is the size of the run-to-run noise, so these results show no *detectable* effect of database size, not proof of none. The 1 M-row `event` table is never opened in this scenario.

### Working-set growth

Median of 3 full repetitions with fresh service and browser each time. *Place* is the click that placed the last batch to the DOM list being complete. *Settle* is how long the main thread then stayed busy. *Gestures* is the fixed pan/zoom/drag script. *Restore* is a page reload with the working set, which re-reads every record from the service.

**Records only (no relationships displayed)**

| Records | Place last 50 | Settle | Gesture long tasks | Gesture max frame | JS heap | Restore | Service requests on restore |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 50 | 187 ms | 0 | 0–1 | 50 ms | 10.2 MB | 0.79 s | 54 |
| 100 | 187 ms | 0 | 0 | 17 ms | 11.6 MB | 0.92 s | 104 |
| 200 | 271 ms | 0 | 0 | 17 ms | 14.2 MB | 1.60 s | 204 |
| 500 | 566 ms | 0 | 0 | 33 ms | 21.3 MB | 3.09 s | 504 |

**Records with relationships (one parent expanded through N children)**

| Records / relationships | Place | Settle | Gesture long tasks | Gesture max frame / p95 | JS heap | Restore | Requests on restore |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 51 / 50 | 0.21 s | 0.4 s | 2 | 67 / 17 ms | 13.8 MB | 1.20 s | 105 |
| 201 / 200 | 1.47 s | 3.5 s | 4–5 | 233 / 33 ms | 24.5 MB | 2.97 s | 405 |
| 501 / 500 | **10.8 s** | **15.3 s** | 27–29 | 567 / 83 ms | 45.6 MB | 6.77 s | 1,005 |

Placing records costs roughly linearly (500 records: 21 MB heap, smooth). Placing relationships does not: going from 50 to 200 to 500 relationships raised place time ≈ 7× then ≈ 7× again, and the post-placement busy period more than 4×. JS heap grows roughly 2.5 MB per 100 records and 7 MB per 100 records-with-relationships. Restoring issues about two service requests per record, so it grows linearly with the working set: a marginal ≈ 5 ms per record without relationships and ≈ 12 ms per record with them (measured from 50 to 500 records). Each restore also includes a fixed page-load cost of roughly 0.5 s, because it is timed from the reload call.

With `prefers-reduced-motion: reduce` (the application's existing alternative, measured as a diagnostic, not a proposal):

| Records / relationships | Place | Settle | Gesture long tasks | Restore |
|---:|---:|---:|---:|---:|
| 51 / 50 | 0.18 s | 0 | 2 | 1.17 s |
| 201 / 200 | 0.89 s | 0 | 4–5 | 2.90 s |
| 501 / 500 | 4.1 s | 0 | 25–27 | 6.64 s |

## Bottlenecks investigated

**1. Relationship placement and its aftermath (clear and material).** A CPU profile of the 500-relationship expansion on an unminified build (profile overhead inflates the absolute time to ≈ 33 s; use it for proportions only):

| Share of profiled CPU | Where |
|---:|---|
| 29.7 % + 26.9 % self | `@antv/g` animation timeline: `updateAnimationsPromises` and `updatePromises`, run from `AnimationTimeline.processRafCallbacks` |
| 65.6 % inclusive | `AnimationTimeline.processRafCallbacks` |
| 11.5 % inclusive | G6 `draw` (of which 9.5 % is `setAnimationTask` / `animate`, starting the per-element arrival animations) |
| 5.0 % inclusive | the application's `expandSourceGroup` / `placeSourceRecords` |
| 2.7 % self | the application's `platesOverlap` (`src/world/spread.ts`) |

The application's own placement and layout work is a few percent. Most of the time is the renderer's animation timeline servicing every simultaneously animating element each frame, which becomes superlinear as elements are added. The reduced-motion run supports that: the 15 s post-placement busy period disappears (0 s), yet placement still takes 4.1 s, so animation is the larger but not the only cost. The remaining gesture long tasks (25–27, max ≈ 0.55 s at 500 relationships) are *not* explained by animation and are not diagnosed here.

**2. Session restoration is one service request per record (moderate).** The restore makes about two requests per placed record (504 for 500 records, 1,005 for 501 with 500 relationships), each answered by the service. At 500 records that is 3.1 s; with relationships 6.8 s (reduced motion does not change it). A batched read would change the HTTP API contract, so it is noted and not pursued.

**3. Bundle contains code the Source view does not use (moderate, unquantified effect).** `@antv/layout` is the largest single contributor to the source size, though the application lays out records with its own placement and `d3-force`, and `html2canvas` (6.8 %) comes in with the renderer. About 14 % comes from `src/world`, which the Source build shares with a view it does not ship. Whether tree-shaking or per-module imports would remove these was not tested, so no saving is claimed.

**4. Not found / not measured.**
- **Unnecessary React re-renders:** not measured. It would need a React-profiler (development) build, and the profile above shows React's own reconcile and commit time as small (commit effects are mostly the renderer drawing). No finding.
- **Redundant redraws and repeated layout during ordinary navigation:** the single-record interactions (open, inspect, follow) finish in 40–220 ms with no long tasks observed; a redraw problem there is not evident. Not examined further.
- **Memory retention:** not assessed. The pan/zoom/drag script left the JS heap 0.4–3.7 MB *higher* than before it (for example 45.6 → 49.3 MB at 501 records / 500 relationships) after a forced collection. That is one pass of a few seconds; it is neither evidence of a leak nor evidence of none.

## Optimisation proposals (not implemented)

None is implemented. The one candidate with the clearest evidence is:

**Skip or stagger the arrival animation for very large single placements.** Evidence: about 60 % of the profiled time and the entire 15 s post-placement busy period come from the animation timeline, and the application's own reduced-motion path already shows it can run without it. Risks that stop this being a drive-by change: it alters visible motion that the application's tests and design treat as deliberate (`src/world/canvasMotion.ts` documents an arrival plan), reduced motion alone still takes 4.1 s at 500 relationships, and the right threshold is a product decision. If pursued, it should be benchmarked in its own commit against the fixed baseline above with `benchmarks/run_all.sh`, and verified with the Playwright suites for canvas motion.

## Existing evidence

| Claim | Status |
|---|---|
| **52.4 MB → 0.8 MB retained Python allocations** (`README.md`, `docs/ENGINEERING_EVIDENCE.md`) | **Recorded and consistent.** [`docs/evidence/memory.jsonl`](evidence/memory.jsonl) holds 52,414,010 B (baseline) and 802,755 B (current) retained after verifying a 91,966-row table, `tracemalloc`. The original Stack Exchange dataset is not in the repository, so those numbers cannot be reproduced exactly. **The mechanism is reproducible**: on a generated 100,000-row table the same script gives **55,242,517 B vs 266,906 B retained**, with 100,000 vs 2,100 registry entries. Note that the *peak during verification* stays at **11.4 MB** for the current reader (baseline 58.9 MB): retained memory fell, transient memory did not vanish. These are `tracemalloc` figures, not process RSS; whole-process RSS stays about 31–35 MB. |
| **283 Playwright scenarios** | Recorded in [`docs/evidence/source-browser.txt`](evidence/source-browser.txt) (`283 passed (5.1m)`, 4 workers, development frontend). **Re-run here at the baseline commit: `283 passed (8.3m)`**, exit 0, same configuration (`playwright.source.config.ts`, 4 workers). The longer time than the recorded 5.1 min is consistent with this machine's slower session (see drift above); the count is what the claim rests on. |
| **Source capture/read benchmark** (`adapters/source/benchmark_source.py`) | **Was not reproducible as shipped**: it crashed with `UnboundLocalError` because incoming references on Chinook are now served rather than refused. Fixed in a separate one-line commit. Chinook medians: capture 4.2 ms, whole-key verification of `Track` 45 ms, warm page 3.8 ms, record read 1.3 ms, outgoing references 7.2 ms. A generated 100,000-row child table: capture 28 MB, verification ≈ 0.97 s. Results in [`python-source.json`](../benchmarks/results/python-source.json). |
| **Search benchmark** (`python3 -m adapters.source.benchmark_search`) | Runs unchanged ([`python-search.json`](../benchmarks/results/python-search.json)). Examples: Chinook exact key 1.7–1.9 ms, broad `Evil Walks` 13.8 ms warm (63 ms first); on a 50,000-row table an indexed exact lookup 0.5–0.7 ms warm (529 ms first), an unindexed substring scan 32.5 ms. |
| **Wheel and runtime dependency model** | Confirmed above: one wheel, no third-party Python dependencies, frontend precompiled; `scripts/test_installed_wheel.py` (12 checks) and the installed-application Playwright test pass in CI-equivalent runs. |

## Limits of these measurements

- One machine, one Chromium, headless with software rendering; no macOS or Windows; no GPU. Frame timings are capped at 60 Hz.
- Absolute times drifted by up to ≈ 1.9× between two sessions (see above). Relative scaling did not.
- Star-shaped relationship topology only; hub fan-out fixtures with one parent. No dense mesh, no multi-column or composite keys, no views.
- At most 500 records or 500 relationships on the canvas. Larger working sets were not attempted; the application's own limits (200,000 issued handles, 64 MiB registry payload) were not approached.
- The drag gesture starts at the canvas centre and may land on a mark or empty space; it was not checked which.
- "Settle" is a main-thread quiet criterion, not a visual-rest check of node positions, which production builds do not expose.
- Cold means a new process and browser cache; the operating system file cache was warm.
- p95 is not reported anywhere because no scenario has 20 samples.
- Interaction latency excludes Playwright's own overhead but includes the application's deliberate motion where it affects when the DOM condition is true.

## Reproducing

```bash
npm ci
python3 scripts/build_release.py --out /tmp/ki-wheel
python3 examples/chinook/prepare.py --view-copy
npx playwright install chromium
benchmarks/run_all.sh /tmp/ki-wheel/knowledge_inspector-0.1.0-py3-none-any.whl
```

`run_all.sh` creates its own virtual environment and generated fixtures under `/tmp`, deletes them on exit, and writes results into `benchmarks/results/`. It takes about 15 minutes. Close other applications first. For the CPU attribution, build an unminified frontend and launch it directly:

```bash
VITE_INSPECTOR_ENTRY=source npx vite build --outDir /tmp/ki-map --sourcemap --minify false
node benchmarks/profile_expand.mjs --ki YOUR_LAUNCHER --db hub-500.sqlite --children 500 --out profile.json
node benchmarks/analyze_profile.mjs profile.json /tmp/ki-map/assets/index-*.js.map
```

where `YOUR_LAUNCHER` is an executable that calls `adapters.source.app.main(frontend=Path("/tmp/ki-map"))`.

## What to claim

| Result | README | LinkedIn | CV |
|---|:-:|:-:|:-:|
| No third-party Python runtime dependencies; 0.9 MB wheel; ≈ 31 MB service RSS (peak 45 MB), little affected by database size | yes | yes | yes |
| Precompiled frontend served by a single local Python process; service start to usable UI ≈ 0.65 s on a laptop-class CPU | yes | yes | no (hardware-dependent) |
| Retained Python allocations after whole-table identity verification cut from 52.4 MB to 0.8 MB (`tracemalloc`, 91,966 rows) | yes | yes | yes, with "tracemalloc" |
| 283 recorded passing Playwright scenarios across SQLite, canvas interaction, keyboard focus and mocked HTTP failure | yes | yes | yes |
| 500 records on the canvas with no long tasks during pan/zoom/drag and ≈ 21 MB JS heap | yes | no | no |
| Bounded, honest limits: a 1 M-row table is refused for canvas placement rather than slowing the UI | yes | optional | no |
| Relationship placement scales superlinearly (10.8 s at 500); profiled to the renderer's animation timeline | engineering report only | no | no |
| Session restore ≈ 5–12 ms per record (marginal); two requests per record | engineering report only | no | no |
| Bundle composition | engineering report only | no | no |

Avoid: "lightning fast", "production scale", "handles millions of rows" (it refuses table placement at 1 M), any percentage improvement other than the recorded 52.4 → 0.8 MB retained-allocation figure, and any statement that restore or large relationship expansion is fast.

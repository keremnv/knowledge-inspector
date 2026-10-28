#!/usr/bin/env node
/** Summarise a CPU profile: self time and inclusive time per function, mapped to source files.
 *   node benchmarks/analyze_profile.mjs profile.json path/to/index-XXXX.js.map [top=25]
 */
import { readFileSync } from "node:fs";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
const [profilePath, mapPath, top = "25"] = process.argv.slice(2);
const profile = JSON.parse(readFileSync(profilePath, "utf8"));
const map = new TraceMap(JSON.parse(readFileSync(mapPath, "utf8")));
const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const dt = profile.timeDeltas, self = new Map();
profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (dt[i] ?? 0)));
const label = (n) => {
  const cf = n.callFrame;
  const o = cf.url.endsWith(".js") ? originalPositionFor(map, { line: cf.lineNumber + 1, column: cf.columnNumber }) : null;
  const file = o?.source ? o.source.replace(/^.*node_modules\//, "node_modules/").replace(/^(\.\.\/)+/, "") : cf.url.split("/").pop() || "(native)";
  return `${cf.functionName || "(anonymous)"}  ${file}${o?.line ? ":" + o.line : ""}`;
};
const children = (n) => (n.children ?? []).map((id) => nodes.get(id));
const incl = new Map(), total = [...self.values()].reduce((a, b) => a + b, 0);
const walk = (n) => { let t = self.get(n.id) ?? 0; for (const c of children(n)) t += walk(c); incl.set(n.id, t); return t; };
walk(profile.nodes[0]);
const agg = (m) => { const out = new Map(); for (const [id, v] of m) { const k = label(nodes.get(id)); out.set(k, (out.get(k) ?? 0) + v); } return [...out].sort((a, b) => b[1] - a[1]); };
const show = (rows) => rows.slice(0, Number(top)).map(([k, v]) => `${(v / 1000).toFixed(0).padStart(7)} ms ${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`).join("\n");
console.log(`profile total ${(total / 1000).toFixed(0)} ms\n\nSELF TIME\n${show(agg(self))}\n\nINCLUSIVE (functions may nest; recursive calls double count)\n${show(agg(incl))}`);

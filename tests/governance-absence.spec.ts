/**
 * KI-009: absent governance metadata stays absent. Missing resolution
 * is not NO_CANDIDATE, a null assessment is not insufficiency, source
 * grounding is not warrant support, and a generic world advertises no
 * governance. Governed payloads are a labelled legacy/API fixture;
 * the generic-adapter case serves a real prepared SQLite world.
 */
import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const ROLES = [
  { name: "subject", type: "REFERENT", column: "subject", referent: true, kinds: ["entity"] },
  { name: "note", type: "TEXT", column: "note", referent: false },
];

function summary(id: string, question: string, extra: Record<string, unknown> = {}) {
  return {
    obligation_id: id,
    question,
    dimension: "fixture",
    relation: null,
    values: {},
    reason: null,
    demanded_by: { name: "fixture", revision: 1 },
    state: "UNRESOLVED",
    assertion_id: null,
    record_id: null,
    grounding_ref: null,
    contract_id: "fixture-contract",
    contract_revision: "1",
    generated_by_rule: "fixture-rule",
    candidates: [],
    ...extra,
  };
}

const RESOLUTION = (status: string, selected: string | null = null) => ({
  resolution_id: `res-${status}`,
  obligation_id: "ob-x",
  status,
  selected_commitment_id: selected,
  reason: `recorded ${status} reason`,
  contract_id: "fixture-contract",
  contract_revision: "1",
  candidate_assessments: [],
  adjudication_assessments: [],
  resolution_basis: [],
});

function candidate(id: string, patch: Record<string, unknown>) {
  return {
    relation: "candidate_for",
    association_id: `assoc-${id}`,
    commitment_id: id,
    created_revision: 1,
    obligation_id: "ob-1",
    commitment: {
      commitment_id: id,
      assertion_id: "record:1",
      relation: "record",
      roles: ROLES,
      values: { subject: "entity:A", note: "held" },
      origin: "SEMANTIC",
      created_revision: 1,
    },
    warrant: { construction_origins: ["SEMANTIC"], bases: [] },
    grounding: [],
    assessment: null,
    governing: false,
    ...patch,
  };
}

const GROUNDING = (ref: string, handle: string, location: string, kind = "SOURCE", provider = "fixture-provider") => ({
  reference: ref,
  provider,
  native_handle: handle,
  native_location: location,
  kind,
});

const DETAILS: Record<string, Record<string, unknown>> = {
  "ob-1": {
    candidates: [
      candidate("cand-grounded", {
        grounding: [GROUNDING("source:1", "SQLite", "row id=1 in record")],
      }),
      candidate("cand-warranted", {
        warrant: {
          construction_origins: ["SEMANTIC"],
          bases: [{ kind: "DOCUMENT", reference: "fixture-doc-1" }],
        },
        assessment: {
          commitment_id: "cand-warranted",
          status: "SUFFICIENT",
          reason: "recorded sufficient reason",
          warrant_authorities: ["Fixture Evidence Authority"],
          authority_basis: [{ authority: "Fixture Evidence Authority" }],
        },
      }),
      candidate("cand-mixed", {
        grounding: [
          GROUNDING("source:2", "SQLite", "row id=2 in record", "SQL_ROW", "fixture-provider"),
          GROUNDING("source:3", "Archive", "folio 9", "REGISTER", "archive-provider"),
        ],
        warrant: {
          construction_origins: ["SEMANTIC"],
          bases: [{ kind: "ATTESTATION", reference: "fixture-att-1" }],
        },
        assessment: {
          commitment_id: "cand-mixed",
          status: "INSUFFICIENT",
          reason: "recorded insufficient reason",
          warrant_authorities: [],
          authority_basis: [],
        },
      }),
    ],
    adjudications: [
      {
        record: {
          adjudication_id: "adj-1",
          obligation_id: "ob-1",
          selected_commitment_id: "cand-mixed",
          authority_basis: {},
          contract_id: "fixture-contract",
          contract_revision: "1",
        },
        assessment: null,
      },
    ],
  },
  "ob-2": { candidates: [], adjudications: [] },
  "ob-3": { candidates: [], adjudications: [], resolution: RESOLUTION("NO_CANDIDATE") },
  "ob-4": { candidates: [], adjudications: [], resolution: RESOLUTION("RESOLVED", "cand-x") },
  "ob-5": { candidates: [], adjudications: [], resolution: RESOLUTION("INSUFFICIENT_WARRANT") },
  "ob-6": { candidates: [], adjudications: [], resolution: RESOLUTION("CONFLICT") },
  "ob-7": { candidates: [], adjudications: [], resolution: RESOLUTION("AMBIGUOUS") },
  "ob-8": { candidates: [], adjudications: [], resolution: RESOLUTION("RESOLVED") },
};

const SUMMARIES = [
  summary("ob-1", "Absent resolution with candidates?"),
  summary("ob-2", "Absent resolution without candidates?"),
  summary("ob-3", "Recorded no candidate?", { resolution: RESOLUTION("NO_CANDIDATE") }),
  summary("ob-4", "Recorded resolved?", { resolution: RESOLUTION("RESOLVED", "cand-x") }),
  summary("ob-5", "Recorded insufficient warrant?", { resolution: RESOLUTION("INSUFFICIENT_WARRANT") }),
  summary("ob-6", "Recorded conflict?", { resolution: RESOLUTION("CONFLICT") }),
  summary("ob-7", "Recorded ambiguous?", { resolution: RESOLUTION("AMBIGUOUS") }),
  summary("ob-8", "Recorded resolved without selection?", { resolution: RESOLUTION("RESOLVED") }),
];

async function mockWorld(page: Page, governedCount: number | null) {
  await page.route("**/world/overview", (route) =>
    route.fulfill({
      json: {
        world_id: "governance-absence-fixture",
        revision: 1,
        relations: 1,
        referents: 2,
        assertions: 1,
        origins: { SEMANTIC: 1 },
        stale: [],
        incomplete: [],
        demand: {
          purpose: { statement: "Fixture purpose." },
          obligations: 1,
          demanded: 1,
        },
        governed_obligations: governedCount === null
          ? null
          : { count: governedCount, resolved: 0, unresolved: governedCount },
      },
    }),
  );
  await page.route("**/world/schema", (route) =>
    route.fulfill({
      json: {
        relations: [{
          name: "record", description: null, mode: "BASE", arity: 2, referent_arity: 1,
          roles: ROLES, count: 1, stale: false, origins: ["SEMANTIC"], scope: null, completeness: null,
        }],
      },
    }),
  );
  await page.route("**/world/referents", (route) =>
    route.fulfill({ json: { referents: [{ id: "entity:A", label: "Ark" }], total: 1, truncated: false } }),
  );
  await page.route("**/world/rows?**", (route) =>
    route.fulfill({
      json: {
        relation: "record", mode: "BASE", stale: false, total: 1, offset: 0, roles: ROLES,
        rows: [{ assertion_id: "record:1", origin: "SEMANTIC", origins: ["SEMANTIC"], values: { subject: "entity:A", note: "held" } }],
      },
    }),
  );
  await page.route("**/world/assertion?**", (route) =>
    route.fulfill({
      json: {
        assertion_id: "record:1", relation: "record", mode: "BASE", arity: 2, roles: ROLES,
        values: { subject: "entity:A", note: "held" }, origin: "SEMANTIC", origins: ["SEMANTIC"],
        assertion_state: "ASSERTED", created_revision: 1, relation_stale: false, completeness: null,
        grounding: [],
        warrant: { commitment_id: "record:1", relation: "record", assertion_origin: "SEMANTIC", recorded_construction_origin: "SEMANTIC", construction_origins: ["SEMANTIC"], created_revision: 1, bases: [] },
        commitment_id: "record:1", candidate_for: [], governing_obligations: [], candidate_assessments: [],
      },
    }),
  );
  await page.route("**/world/labels?**", (route) =>
    route.fulfill({ json: { labels: { "entity:A": "Ark" } } }),
  );
  await page.route("**/world/referent?**", (route) =>
    route.fulfill({ json: { id: "entity:A", label: "Ark", grounding: [], fields: [], relations: [] } }),
  );
  await page.route("**/world/obligations", (route) =>
    route.fulfill({ json: { contract: null, governance: null, obligations: governedCount === 0 ? [] : SUMMARIES } }),
  );
  await page.route("**/world/obligation?**", (route) => {
    const id = new URL(route.request().url()).searchParams.get("obligation_id") ?? "";
    const base = SUMMARIES.find((item) => item.obligation_id === id);
    if (!base) return route.fulfill({ json: null });
    return route.fulfill({
      json: {
        ...base,
        ...(DETAILS[id] ?? { candidates: [], adjudications: [] }),
        context: { contract: null, governance: null, evidence_authority: null, adjudication_authority: null },
      },
    });
  });
  await page.route("**/world/demand", (route) =>
    route.fulfill({
      json: {
        demand: {
          purpose: { statement: "Fixture purpose." },
          rule: null,
          demanded: 1,
          obligations: [{
            relation: "record",
            values: { subject: "entity:A", note: "missing" },
            demanded_by: { name: "fixture", revision: 1 },
            state: "UNRESOLVED",
            assertion_id: null,
            reason: "fixture frontier gap",
          }],
        },
      },
    }),
  );
}

const reader = (page: Page) => page.locator(".node-reader .motion-swap__is");
const governedRows = (page: Page) =>
  page.locator('section[aria-label="governed obligations"] .table__row');

async function openGoverned(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "obligations", exact: true }).first().click();
  await expect(governedRows(page).first()).toBeVisible();
}

test("absent resolution stays absent in table and reader; recorded statuses keep their meanings", async ({ page }) => {
  await mockWorld(page, 8);
  await openGoverned(page);
  await expect(governedRows(page).nth(0)).toContainText("resolution not recorded");
  await expect(governedRows(page).nth(1)).toContainText("resolution not recorded");
  await expect(governedRows(page).nth(2)).toContainText("no candidate");
  await expect(governedRows(page).nth(3)).toContainText("resolved");
  await expect(governedRows(page).nth(4)).toContainText("insufficient warrant");
  await expect(governedRows(page).nth(5)).toContainText("conflict");
  await expect(governedRows(page).nth(6)).toContainText("ambiguous");
  // Summary reader (links only) and full detail agree.
  await governedRows(page).nth(0).click();
  await expect(reader(page).locator(".node-reader__kind")).toHaveText("resolution not recorded");
  await expect(reader(page)).toContainText("Resolution not recorded.");
  await expect(reader(page)).not.toContainText("No candidate answer has been recorded.");
  await governedRows(page).nth(1).click();
  await expect(reader(page)).toContainText("Resolution not recorded.");
  await expect(reader(page)).toContainText("No candidate Commitment is recorded.");
  await governedRows(page).nth(2).click();
  await expect(reader(page)).toContainText("No candidate answer has been recorded.");
  // Recorded RESOLVED, with and without a selected commitment, and
  // recorded AMBIGUOUS are three different statements.
  await governedRows(page).nth(3).click();
  await expect(reader(page)).toContainText("Resolved → cand-x");
  await governedRows(page).nth(7).click();
  await expect(reader(page).locator(".node-reader__kind")).toHaveText("resolved");
  await expect(reader(page)).toContainText("Resolved; no selected commitment recorded.");
  await expect(reader(page)).not.toContainText("More than one compatible sufficient answer remains.");
  await governedRows(page).nth(6).click();
  await expect(reader(page)).toContainText("More than one compatible sufficient answer remains.");
});

test("null assessments are neutral and grounding never becomes warrant support", async ({ page }) => {
  await mockWorld(page, 8);
  await openGoverned(page);
  await governedRows(page).nth(0).click();
  await expect(reader(page).locator("h2")).toHaveText("Absent resolution with candidates?");
  await expect(page.locator(".world-reading")).toHaveCount(0);
  await expect(reader(page).locator(".world-attribution")).toHaveCount(0);
  await expect(reader(page)).not.toContainText("reader declaration");
  const grounded = reader(page).locator("article.world-reader__section", { hasText: "cand-grounded" });
  await expect(grounded).toContainText("SQLite · row id=1 in record");
  await expect(grounded).toContainText("No warrant basis recorded.");
  await expect(grounded).not.toContainText("supported by");
  await expect(grounded).toContainText("not assessed");
  const warranted = reader(page).locator("article.world-reader__section", { hasText: "cand-warranted" });
  await expect(warranted).toContainText("DOCUMENT · fixture-doc-1");
  await expect(warranted).toContainText("No source grounding recorded.");
  await expect(warranted).toContainText("sufficient · recorded sufficient reason");
  await expect(warranted).toContainText("Fixture Evidence Authority");
  const mixed = reader(page).locator("article.world-reader__section", { hasText: "cand-mixed" });
  // Every recorded grounding attribute survives, per entry, in its own
  // group — two groundings against one warrant basis, never aligned.
  await expect(mixed).toContainText("source:2");
  await expect(mixed).toContainText("SQL_ROW");
  await expect(mixed).toContainText("row id=2 in record");
  await expect(mixed).toContainText("source:3");
  await expect(mixed).toContainText("REGISTER");
  await expect(mixed).toContainText("folio 9");
  await expect(mixed).toContainText("archive-provider");
  await expect(mixed).toContainText("ATTESTATION · fixture-att-1");
  await expect(mixed).not.toContainText("recorded basis");
  await expect(mixed).toContainText("insufficient · recorded insufficient reason");
  // Null adjudication assessment: record visible, assessment neutral.
  await expect(reader(page)).toContainText("selected cand-mixed");
  const adjudication = reader(page).locator("section", { hasText: "selected cand-mixed" });
  await expect(adjudication).toContainText("not assessed");
  await expect(adjudication).not.toContainText("not sufficient");
});

test("recorded zero-count governed collection keeps its control; frontier stays independent", async ({ page }) => {
  await mockWorld(page, 0);
  await page.goto("/");
  await page.getByRole("button", { name: "obligations", exact: true }).first().click();
  await expect(page.locator('section[aria-label="governed obligations"]')).toContainText("0 governed obligations");
  await page.getByRole("navigation", { name: "Table subject" })
    .getByRole("button", { name: "purpose frontier", exact: true }).click();
  const frontier = page.locator('section[aria-label="unresolved frontier"]');
  await expect(frontier).toContainText("1 unresolved of 1 obligation");
  await frontier.locator(".table__row").first().click();
  await expect(reader(page)).toContainText("fixture frontier gap");
});

test("real generic adapter publishes no governance overview and no obligations control", async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), "ki-gov-absence-generic-"));
  const served = await serveGeneric(join(directory, "source.sqlite"));
  try {
    await page.goto(served.origin);
    const overview = await page.evaluate(() => fetch("/world/overview").then((r) => r.json()));
    expect(overview.governed_obligations).toBeNull();
    await expect(page.locator(".table__row").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "obligations", exact: true })).toHaveCount(0);
  } finally {
    await served.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

async function serveGeneric(path: string) {
  const script = `
import json,sys,sqlite3
from pathlib import Path
from http.server import ThreadingHTTPServer
from adapters.world import server as w
p=Path(sys.argv[1]);d=sqlite3.connect(p)
d.executescript('''
CREATE TABLE entity(id TEXT PRIMARY KEY,label TEXT);
INSERT INTO entity VALUES('A','A'),('B','B');
CREATE TABLE pair(id INTEGER PRIMARY KEY,a TEXT,b TEXT);
INSERT INTO pair VALUES(1,'A','B');
''');d.commit();d.close()
decl=w.validate_declaration({'version':1,'world':{'id_prefix':'absencegeneric'},
 'entities':[{'kind':'entity','source':'entity','key_columns':['id'],'label_column':'label'}],
 'relations':[{'name':'pair','source':'pair','key_columns':['id'],'roles':[
  {'role':'a','column_name':'a','target_kind':'entity'},
  {'role':'b','column_name':'b','target_kind':'entity'}]}]})
prepared=w.prepare_world(p,decl)
w.Handler.db_path=prepared.snapshot_path;w.Handler.model=prepared.model
w.Handler.world_id=prepared.world_id;w.Handler.fingerprint=prepared.fingerprint
w.Handler.snapshot_mode=True;w.Handler.db_connect=staticmethod(w.connect_snapshot)
s=ThreadingHTTPServer(('127.0.0.1',0),w.Handler)
print(json.dumps({'port':s.server_port}),flush=True)
try:s.serve_forever()
except KeyboardInterrupt:pass
finally:prepared.cleanup()
`;
  const child: ChildProcess = spawn("python3", ["-u", "-c", script, path]);
  const output = createInterface({ input: child.stdout });
  let errors = "";
  child.stderr.on("data", (data) => { errors += data; });
  const port = await new Promise<number>((resolve, reject) => {
    output.once("line", (line) => { try { resolve(JSON.parse(line).port); } catch (e) { reject(e); } });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Adapter exited (${code}): ${errors}`)));
  });
  const proxy: Server = createServer();
  proxy.on("request", (incoming, outgoing) => {
    const target = new URL(incoming.url ?? "/", incoming.url?.startsWith("/world/")
      ? `http://127.0.0.1:${port}` : "http://127.0.0.1:8143");
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
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async stop() {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      output.close();
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, "exit"); child.kill("SIGINT"); await stopped;
      }
    },
  };
}

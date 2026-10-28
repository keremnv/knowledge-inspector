/**
 * Scalar presentation, two review corrections.
 *
 *  1. The scalar markers are source-neutral. The same component prints the
 *     values of producer-authored Worlds that have no SQLite behind them, so a
 *     JSON null is "a null value supplied by the World", an empty string is
 *     "an empty string value", and no label says SQL, SQLite or "stored".
 *     (Where a SQLite storage class is known, it is source-grounding metadata.)
 *
 *  2. Plain-text summaries keep distinct values distinct. A roster row, a
 *     sibling list and a candidate line are sentences, not cells, so a reader
 *     has only the characters: NULL is a marker, "NULL" is text; "" is the
 *     empty string, "\"\"" is two quote characters; not supplied is an absent
 *     key, "not supplied" is text. These tests read visible text only: no
 *     tooltip, no data attribute, no italic.
 */
import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { serveDisposable } from "./disposable-world";

const test = base.extend<{}, { summary: string }>({
  summary: [async ({}, use) => { await serveDisposable("summary_fixture", (served) => use(served.origin)); }, { scope: "worker" }],
});

const reader = (page: Page) => page.locator(".node-reader .motion-swap__is");
const section = (page: Page, name: string) => page.locator(`.motion-swap__is section[aria-label="${name}"]`);
const exact = (locator: Locator) => locator.evaluate((node) => node.textContent);

// ---------------------------------------------------------------------------
// A producer-style World: no SQLite, no external reading descriptor.

const ROLES = [
  { name: "subject", type: "REFERENT", column: "subject", referent: true, kinds: ["entity"] },
  { name: "note", type: "TEXT", column: "note", referent: false },
  { name: "memo", type: "TEXT", column: "memo", referent: false },
];

type Values = Record<string, unknown>;
const RECORDS: Record<string, Values> = {
  "record:1": { subject: "entity:A", note: null, memo: "" },
  "record:2": { subject: "entity:A", note: "NULL", memo: '""' },
  "record:3": { subject: "entity:A", memo: "not supplied" }, // `note` key absent
};

const commitment = (id: string, values: Values) => ({
  relation: "candidate_for",
  association_id: `assoc-${id}`,
  commitment_id: id,
  created_revision: 3,
  obligation_id: "ob-1",
  commitment: {
    commitment_id: id, assertion_id: "record:1", relation: "record", roles: ROLES,
    values, origin: "SEMANTIC", created_revision: 3,
  },
  warrant: { construction_origins: ["SEMANTIC"], bases: [] },
  grounding: [],
  assessment: null,
  governing: false,
});

const CANDIDATES = [
  commitment("cand-1", { subject: "entity:A", note: null, memo: "" }),
  commitment("cand-2", { subject: "entity:A", note: "NULL", memo: '""' }),
  commitment("cand-3", { subject: "entity:A", memo: "x" }),
  commitment("cand-4", { subject: "entity:A", note: "not supplied", memo: "—" }),
];

async function producerWorld(page: Page) {
  await page.route("**/world/overview", (route) => route.fulfill({
    json: {
      world_id: "producer-fixture", revision: 3, relations: 1, referents: 1, assertions: 3,
      origins: { SEMANTIC: 3 }, stale: [], incomplete: [], demand: { purpose: { statement: "Fixture purpose." }, obligations: 4, demanded: 4 },
      governed_obligations: { count: 1, resolved: 0, unresolved: 1 },
    },
  }));
  await page.route("**/world/schema", (route) => route.fulfill({
    json: { relations: [{
      name: "record", description: null, mode: "BASE", arity: 3, referent_arity: 1, roles: ROLES,
      count: 3, stale: false, origins: ["SEMANTIC"], scope: null, completeness: null,
    }] },
  }));
  await page.route("**/world/referents", (route) => route.fulfill({
    json: { referents: [{ id: "entity:A", label: "Ark" }], total: 1, truncated: false },
  }));
  await page.route("**/world/rows?**", (route) => route.fulfill({
    json: {
      relation: "record", mode: "BASE", stale: false, total: 3, offset: 0, roles: ROLES,
      rows: Object.entries(RECORDS).map(([id, values]) => ({
        assertion_id: id, origin: "SEMANTIC", origins: ["SEMANTIC"], values,
      })),
    },
  }));
  await page.route("**/world/assertion?**", (route) => {
    const id = new URL(route.request().url()).searchParams.get("id") ?? "";
    return route.fulfill({
      json: {
        assertion_id: id, relation: "record", mode: "BASE", arity: 3, roles: ROLES,
        values: RECORDS[id], origin: "SEMANTIC", origins: ["SEMANTIC"],
        assertion_state: "ASSERTED", created_revision: 3, relation_stale: false, completeness: null,
        grounding: [],
        warrant: { commitment_id: id, relation: "record", assertion_origin: "SEMANTIC", recorded_construction_origin: "SEMANTIC", construction_origins: ["SEMANTIC"], created_revision: 3, bases: [] },
        commitment_id: id, candidate_for: [], governing_obligations: [], candidate_assessments: [],
      },
    });
  });
  await page.route("**/world/labels?**", (route) => route.fulfill({ json: { labels: { "entity:A": "Ark" } } }));
  await page.route("**/world/referent?**", (route) => route.fulfill({
    json: { id: "entity:A", label: "Ark", grounding: [], fields: [], relations: [] },
  }));
  const summary = {
    obligation_id: "ob-1", question: "Which record?", dimension: "fixture", relation: null, values: {},
    reason: null, demanded_by: { name: "fixture", revision: 1 }, state: "UNRESOLVED", assertion_id: null,
    record_id: null, grounding_ref: null, contract_id: "fixture-contract", contract_revision: "1",
    candidates: [],
  };
  await page.route("**/world/obligations", (route) => route.fulfill({
    json: { contract: null, governance: null, obligations: [summary] },
  }));
  await page.route("**/world/obligation?**", (route) => route.fulfill({
    json: {
      ...summary, candidates: CANDIDATES, adjudications: [],
      context: { contract: null, governance: null, evidence_authority: null, adjudication_authority: null },
    },
  }));
  await page.route("**/world/demand", (route) => route.fulfill({
    json: {
      demand: {
        purpose: { statement: "Fixture purpose." }, rule: null, demanded: 4,
        obligations: [
          { note: null, memo: "" },
          { note: "NULL", memo: '""' },
          { memo: "x" }, // `note` was not sent
          { note: "not supplied", memo: "\u2014" },
        ].map((scalars, index) => ({
          relation: "record", values: { subject: "entity:A", ...scalars },
          demanded_by: { name: "fixture", revision: 1 }, state: "UNRESOLVED",
          assertion_id: null, reason: `gap ${index + 1}`,
        })),
      },
    },
  }));
}

const openRecords = async (page: Page) => {
  await page.goto("/");
  await section(page, "world relations").locator(".table__row").filter({ has: page.locator('[title="record"]') }).click();
  await expect(section(page, "record extension").locator(".table__row[data-loaded]")).toHaveCount(3);
};
const recordRow = (page: Page, n: number) => section(page, "record extension").locator(".table__row[data-loaded]").nth(n - 1);

/** Every label, title and visible word the scalar surfaces print. */
const claimsStorage = /sqlite|\bsql\b|stored|\bstorage\b/i;

test.describe("a producer-authored World with no SQLite reading", () => {
  test("a JSON null and an empty string are named for what the World supplied, never for SQLite", async ({ page }) => {
    await producerWorld(page);
    await openRecords(page);
    // There is no reading descriptor, so nothing here may speak of SQLite.
    expect((await page.evaluate(() => fetch("/world/overview").then((r) => r.json()))).reading).toBeUndefined();

    const nullCell = recordRow(page, 1).locator(":scope > span").nth(1);
    const emptyCell = recordRow(page, 1).locator(":scope > span").nth(2);
    await expect(nullCell).toHaveAttribute("data-value-kind", "null");
    await expect(emptyCell).toHaveAttribute("data-value-kind", "empty text");
    expect(await exact(nullCell)).toBe("NULL");
    expect(await exact(emptyCell)).toBe('""');
    await expect(nullCell.getByRole("img", { name: "null value supplied by the World" })).toHaveCount(1);
    await expect(emptyCell.getByRole("img", { name: "empty string value" })).toHaveCount(1);
    await expect(nullCell).toHaveAttribute("title", "null value supplied by the World");
    await expect(emptyCell).toHaveAttribute("title", "empty string value");
    // The key that was never sent is also not called a NULL.
    const absent = recordRow(page, 3).locator(":scope > span").nth(1);
    await expect(absent.getByRole("img", { name: "value not supplied by the API" })).toHaveCount(1);

    // No marker label or tooltip on the page claims a storage system.
    const labels = await page.locator('[role="img"][aria-label], [data-value-kind][title]').evaluateAll(
      (nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? node.getAttribute("title") ?? ""));
    expect(labels.length).toBeGreaterThanOrEqual(5);
    for (const label of labels) expect(label, label).not.toMatch(claimsStorage);

    // The assertion reader prints the same neutral names.
    await recordRow(page, 1).click();
    await expect(reader(page).locator("h2")).toHaveText("record");
    await expect(reader(page).getByRole("img", { name: "null value supplied by the World" })).toHaveCount(1);
    await expect(reader(page).getByRole("img", { name: "empty string value" })).toHaveCount(1);
    const text = await reader(page).innerText();
    expect(text).not.toMatch(/sqlite|\bsql\b/i);
    for (const label of await reader(page).locator('[role="img"][aria-label]').evaluateAll(
      (nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? ""))) {
      expect(label, label).not.toMatch(claimsStorage);
    }
  });

  test("the neutral names do not depend on a World id or revision", async ({ page }) => {
    // A producer World may call itself anything, including something that
    // looks like the bridge; the label still claims nothing about storage.
    await producerWorld(page);
    await page.route("**/world/overview", (route) => route.fulfill({
      json: {
        world_id: "sqlite-looking-id:abc+def", revision: 1, relations: 1, referents: 1, assertions: 3,
        origins: { SEMANTIC: 3 }, stale: [], incomplete: [], demand: null,
        governed_obligations: { count: 1, resolved: 0, unresolved: 1 },
      },
    }));
    await openRecords(page);
    await expect(recordRow(page, 1).getByRole("img", { name: "null value supplied by the World" })).toHaveCount(1);
    await expect(page.locator('[role="img"][aria-label*="SQL" i]')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Plain-text summaries: a producer-style World, governed candidates.

test.describe("plain-text summaries keep distinct values distinct", () => {
  test("candidate lines: NULL/\"NULL\", empty/two quotes, absent/\"not supplied\" read differently from the characters alone", async ({ page }) => {
    await producerWorld(page);
    await page.goto("/");
    await page.getByRole("button", { name: "obligations", exact: true }).first().click();
    await section(page, "governed obligations").locator(".table__row").first().click();
    await expect(reader(page).locator("h2")).toHaveText("Which record?");
    const lines = reader(page).locator("p.world__code");
    await expect(lines).toHaveCount(4);
    const read = [];
    for (let i = 0; i < 4; i++) read.push(await exact(lines.nth(i)));
    expect(read).toEqual([
      "record(subject = entity:A, note = NULL, memo = \"\")",
      "record(subject = entity:A, note = \"NULL\", memo = \"\\\"\\\"\")",
      "record(subject = entity:A, note = not supplied, memo = x)",
      "record(subject = entity:A, note = \"not supplied\", memo = \"—\")",
    ]);
    expect(new Set(read).size).toBe(4);
  });

  test("the purpose frontier and its reader keep the same values apart", async ({ page }) => {
    await producerWorld(page);
    await page.goto("/");
    await page.getByRole("navigation", { name: "Table subject" }).getByRole("button", { name: "purpose frontier", exact: true }).click();
    const rows = page.locator('section[aria-label="unresolved frontier"] .table__row');
    await expect(rows).toHaveCount(4);
    const read = [];
    for (let i = 0; i < 4; i++) read.push(await exact(rows.nth(i).locator(":scope > span").nth(1)));
    expect(read).toEqual([
      "A, NULL, \"\"",
      "A, \"NULL\", \"\\\"\\\"\"",
      "A, x",
      "A, \"not supplied\", \"\u2014\"",
    ]);
    await rows.nth(0).click();
    await expect(reader(page)).toContainText("gap 1");
    await expect(reader(page).getByRole("img", { name: "null value supplied by the World" })).toHaveCount(1);
    await expect(reader(page).getByRole("img", { name: "empty string value" })).toHaveCount(1);
    await rows.nth(1).click();
    await expect(reader(page)).toContainText("gap 2");
    await expect(reader(page).getByRole("img")).toHaveCount(0);
  });

  test("with every marker style removed, the markers and their look-alikes still differ in the table", async ({ page }) => {
    // Reduced styling, forced colours and a screen magnifier all lose italics
    // and colour. What is left is the characters.
    await producerWorld(page);
    await openRecords(page);
    await page.addStyleTag({ content: ".scalar{font-style:normal !important;color:inherit !important;opacity:1 !important;text-decoration:none !important}" });
    const cell = (row: number, column: number) => recordRow(page, row).locator(":scope > span").nth(column);
    expect(await cell(1, 1).innerText()).toBe("NULL");
    expect(await cell(2, 1).innerText()).toBe('"NULL"');
    expect(await cell(1, 2).innerText()).toBe('""');
    expect(await cell(2, 2).innerText()).toBe('"\\"\\""');
    expect(await cell(3, 1).innerText()).toBe("not supplied");
    expect(await cell(3, 2).innerText()).toBe('"not supplied"');
  });
});

// Roster rows come from the real generic adapter over a disposable file.
const EXPECTED_SUMMARY: [number, string][] = [
  [1, "NULL · m"],
  [2, '"NULL" · m'],
  [3, '"" · m'],
  [4, '"\\"\\"" · m'],
  [5, '"not supplied" · m'],
  [6, '"—" · m'],
  [7, '"null" · m'],
  [8, "not supplied · m"], // the API response below drops this row's `value` key
];

async function dropValueOfRowEight(page: Page) {
  await page.route("**/world/rows?**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const row of body.rows) if (/:8$/.test(row.assertion_id)) delete row.values.value;
    await route.fulfill({ response, json: body });
  });
}

async function openProbe(page: Page, origin: string) {
  await dropValueOfRowEight(page);
  await page.goto(origin);
  await page.getByRole("combobox").fill("Probe");
  await page.getByRole("option").filter({ has: page.locator(".nodefind__anchor").filter({ hasText: /^item:1$/ }) }).click();
  await expect(reader(page).locator("h2")).toBeVisible();
}

test.describe("roster and sibling summaries, over the real adapter", () => {
  test("'on this disc': eight plates, eight different one-line summaries", async ({ page, summary }) => {
    await openProbe(page, summary);
    await reader(page).getByRole("button", { name: "mark 8", exact: true }).click();
    const roster = reader(page).locator("section").filter({ has: page.getByRole("heading", { name: "on this disc" }) });
    const meta = (n: number) => roster.locator(`button[title="mark:${n}"] .gm__list-meta`);
    const seen: string[] = [];
    for (const [n, far] of EXPECTED_SUMMARY) {
      await expect(meta(n)).toHaveCount(1);
      const text = (await exact(meta(n)))!;
      expect(text.startsWith(`item · ${far} · `), `mark:${n} read "${text}"`).toBe(true);
      seen.push(text.split(" · ").slice(1, -1).join(" · "));
    }
    expect(new Set(seen).size).toBe(8);
  });

  test("'On this filament': eight parallel bonds, eight different one-line summaries", async ({ page, summary }) => {
    await openProbe(page, summary);
    await reader(page).getByRole("button", { name: "tie 8", exact: true }).click();
    const roster = reader(page).locator("section").filter({ has: page.getByRole("heading", { name: "on this disc" }) });
    await roster.locator('button[title="tie:1"]').click();
    await expect(reader(page).locator("h2")).toHaveText("tie");
    const siblings = reader(page).locator("section").filter({ has: page.getByRole("heading", { name: "On this filament" }) });
    const name = (n: number) => siblings.locator(`button[title="tie:${n}"] .gm__list-name`);
    const seen: string[] = [];
    for (const [n, far] of EXPECTED_SUMMARY) {
      await expect(name(n)).toHaveCount(1);
      const text = (await exact(name(n)))!;
      expect(text, `tie:${n}`).toBe(`tie · ${far}`);
      seen.push(text);
    }
    expect(new Set(seen).size).toBe(8);
  });
});

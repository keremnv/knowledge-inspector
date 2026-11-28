/** Following records (owner decision 4, docs/DECISIONS.md): the same trail in
 * either direction, one Back, nonempty relationships first, a whole set kept
 * and removed precisely. A fixture in the shape of the traversal review's walk
 * B (finding → evidence through holder → span), written by Python's sqlite3,
 * through the actual SourceHTTPServer. */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveSource } from "./source-serve";
import { sourceList as list, sourceReader as reader, sourceTable as tables, openSourceReferences } from "./canvas-parity";

const records = (p: Page) => list(p).locator("[data-field-record]");
const connections = (p: Page) => list(p).locator("[data-field-reference]");
const incoming = (p: Page) => reader(p).locator(".source-incoming");
const fact = (p: Page, column: string) => reader(p).locator(".source-cells > div").filter({ has: p.locator("dt", { hasText: new RegExp(`^${column}(key)?$`) }) }).locator("dd");

const SCHEMA = `
CREATE TABLE source(id TEXT PRIMARY KEY);
CREATE TABLE source_field(source TEXT REFERENCES source(id), name TEXT, text TEXT, PRIMARY KEY (source, name));
CREATE TABLE span(id TEXT PRIMARY KEY, source TEXT REFERENCES source(id), field TEXT, start INTEGER, "end" INTEGER,
  FOREIGN KEY (source, field) REFERENCES source_field(source, name));
CREATE TABLE finding(ref TEXT PRIMARY KEY, outcome TEXT);
CREATE TABLE evidence(holder TEXT REFERENCES finding(ref), position INTEGER, span TEXT REFERENCES span(id), finding TEXT REFERENCES finding(ref),
  PRIMARY KEY (holder, position));
INSERT INTO source VALUES ('note');
INSERT INTO source_field VALUES ('note', 'text', '0. A 19-year-old came to clinic. 6. Testosterone 65 ng/dL.');
INSERT INTO span VALUES ('s0', 'note', 'text', 0, 33), ('s6', 'note', 'text', 34, 59);
INSERT INTO finding VALUES ('F1', 'met'), ('F2', 'met'), ('F3', 'not_met');
INSERT INTO evidence VALUES ('F1', 0, 's6', NULL), ('F2', 0, NULL, 'F1'), ('F3', 0, NULL, 'F1'), ('F2', 1, 's0', NULL);
CREATE TABLE artist(id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE album(id INTEGER PRIMARY KEY, artist INTEGER REFERENCES artist(id), title TEXT);
INSERT INTO artist VALUES (1, 'AC/DC');
INSERT INTO album VALUES (1, 1, 'For Those About To Rock'), (2, 1, 'Let There Be Rock');
CREATE TABLE doc(id INTEGER PRIMARY KEY);
INSERT INTO doc VALUES (1);
` + Array.from({ length: 12 }, (_, i) => {
  const t = `t${String(i + 1).padStart(2, "0")}`;
  return `CREATE TABLE ${t}(id INTEGER PRIMARY KEY, doc INTEGER REFERENCES doc(id));${i === 11 ? ` INSERT INTO ${t} VALUES (1, 1);` : ""}`;
}).join("\n");

let dir = "", db = "";
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ki-following-"));
  db = join(dir, "following.sqlite");
  execFileSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(sys.argv[2]); c.close()", db, SCHEMA]);
});
test.afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const key = (column: string, storage: "text" | "integer", exact: string) => encodeURIComponent(JSON.stringify([{ column, storage_class: storage, exact }]));
const open = (p: Page, origin: string, table: string, column: string, storage: "text" | "integer", exact: string) =>
  p.goto(`${origin}/source?record_table=${table}&record_key=${key(column, storage, exact)}`);

test("walk B: an incoming singleton opens in the Reader with its connection; three records, two connections, Back to the finding", async ({ page }) => {
  await serveSource(db, async ({ origin }) => {
    await open(page, origin, "finding", "ref", "text", "F1");
    await expect(reader(page).locator("h2")).toHaveText("finding");
    await expect(records(page)).toHaveCount(1);
    // evidence · holder has one row: it opens directly, Tables untouched.
    await incoming(page).getByRole("button", { name: /^evidence · holder, 1 row$/ }).click();
    await expect(reader(page).locator("h2")).toHaveText("evidence");
    await expect(fact(page, "span")).toHaveText("s6");
    await expect(records(page)).toHaveCount(2);
    await expect(connections(page)).toHaveCount(1);
    await expect(page.locator("#source-tables .source-incoming-subject")).toHaveCount(0);
    // Follow the span: Reader → Reader, drawn.
    await fact(page, "span").getByRole("button").click();
    await expect(reader(page).locator("h2")).toHaveText("span");
    await expect(records(page)).toHaveCount(3);
    await expect(connections(page)).toHaveCount(2);
    // Back walks the trail without erasing it.
    await reader(page).getByRole("button", { name: "Back", exact: true }).click();
    await expect(reader(page).locator("h2")).toHaveText("evidence");
    await reader(page).getByRole("button", { name: "Back", exact: true }).click();
    await expect(reader(page).locator("h2")).toHaveText("finding");
    await expect(fact(page, "ref")).toContainText("F1");
    await expect(reader(page).getByRole("button", { name: "Back", exact: true })).toHaveCount(0);
    await expect(records(page)).toHaveCount(3);
    await expect(connections(page)).toHaveCount(2);
  });
});

test("a row chosen from a set draws its connection to the set's parent, even after the Reader moved on; one Back restores both panels", async ({ page }) => {
  await serveSource(db, async ({ origin }) => {
    await open(page, origin, "finding", "ref", "text", "F1");
    await incoming(page).getByRole("button", { name: /^evidence · finding, 2 rows$/ }).click();
    await expect(tables(page).locator("[data-incoming-subject]")).toContainText("2 rows referencing");
    await expect(reader(page).locator("h2")).toHaveText("finding");
    await tables(page).locator('[data-row-position="1"]').click();
    await expect(reader(page).locator("h2")).toHaveText("evidence");
    await expect(connections(page)).toHaveCount(1);
    // Wander off in the Reader: follow the holder to another finding.
    await fact(page, "holder").getByRole("button").click();
    await expect(reader(page).locator("h2")).toHaveText("finding");
    const before = await connections(page).count();
    // The set is still on the left: its next row is drawn to F1, not to the finding on show.
    await tables(page).locator('[data-row-position="2"]').click();
    await expect(connections(page)).toHaveCount(before + 1);
    const names = await connections(page).allTextContents();
    expect(names.filter((name) => /F3/.test(name) && /F1/.test(name))).toHaveLength(1);
    // One Back: the previous Reader subject, with the same set on the left.
    await reader(page).getByRole("button", { name: "Back", exact: true }).click();
    await expect(reader(page).locator("h2")).toHaveText("finding");
    await expect(tables(page).locator("[data-incoming-subject]")).toBeVisible();
    // whole table widens the set; Back recovers the narrowed set.
    await tables(page).getByRole("button", { name: "whole table", exact: true }).click();
    await expect(tables(page).locator("[data-incoming-subject]")).toHaveCount(0);
    await expect(tables(page).locator("tbody tr")).toHaveCount(4);
    await tables(page).getByRole("button", { name: "Back", exact: true }).click();
    await expect(tables(page).locator("[data-incoming-subject]")).toContainText("2 rows referencing");
    await expect(tables(page).locator("tbody tr")).toHaveCount(2);
  });
});

test("a value in two declared references offers both; inspecting a reference leaves the canvas alone", async ({ page }) => {
  await serveSource(db, async ({ origin }) => {
    await open(page, origin, "span", "id", "text", "s6");
    await expect(records(page)).toHaveCount(1);
    // field takes part in one reference: a dotted value. source takes part in two: a choice.
    await expect(fact(page, "field").getByRole("button")).toHaveCount(1);
    const choice = fact(page, "source").locator("[data-reach-choice]");
    // In declaration order, whatever it is: both are offered.
    await expect(choice.getByRole("button")).toHaveCount(2);
    await expect(choice.getByRole("button", { name: /^go to source referenced by source$/ })).toHaveText("→ source");
    await expect(choice.getByRole("button", { name: /^go to source_field referenced by source, field$/ })).toHaveText("→ source_field");
    // Inspecting audits; it places nothing.
    await openSourceReferences(page);
    await reader(page).locator(".source-outgoing article").filter({ hasText: "→ source ·" }).first().getByRole("button", { name: /inspect FK/ }).click();
    await expect(reader(page).locator("h2")).toHaveText("reference");
    await page.waitForTimeout(300);
    await expect(records(page)).toHaveCount(1);
    await expect(connections(page)).toHaveCount(0);
    await reader(page).getByRole("button", { name: "Back", exact: true }).click();
    await choice.getByRole("button", { name: /source_field/ }).click();
    await expect(reader(page).locator("h2")).toHaveText("source_field");
    await expect(connections(page)).toHaveCount(1);
  });
});

test("referenced by lists only declarations that lead somewhere, across declaration pages; the complete list is under references", async ({ page }) => {
  await serveSource(db, async ({ origin }) => {
    await open(page, origin, "doc", "id", "integer", "1");
    // Twelve declarations, two pages: only t12 has a row.
    await expect(incoming(page).getByRole("button")).toHaveText([/^t12 · doc\s*1$/]);
    await expect(incoming(page).locator("[data-discovery]")).toHaveCount(0);
    await expect(incoming(page)).not.toContainText("No rows");
    await openSourceReferences(page);
    await expect(reader(page).locator("[data-incoming-ledger]")).toHaveCount(12);
    await expect(reader(page).locator("[data-incoming-ledger]").filter({ hasText: "t01 · doc" })).toContainText("0");
  });
});

test("keep all keeps the whole set and says its size; remove set leaves what was already on the canvas", async ({ page }) => {
  await serveSource(db, async ({ origin }) => {
    await open(page, origin, "album", "id", "integer", "1");
    await fact(page, "artist").getByRole("button").click();
    await expect(reader(page).locator("h2")).toHaveText("artist");
    await expect(records(page)).toHaveCount(2);
    await incoming(page).getByRole("button", { name: /^album · artist, 2 rows$/ }).click();
    // One row per page: keep all still keeps the whole set.
    await tables(page).getByRole("combobox", { name: "rows per page" }).selectOption("1");
    await expect(tables(page).locator("tbody tr")).toHaveCount(1);
    const keep = tables(page).getByRole("button", { name: "keep all 2", exact: true });
    await keep.click();
    await expect(records(page)).toHaveCount(3);
    await expect(connections(page)).toHaveCount(2);
    await expect(tables(page).locator("[data-outcome]")).toContainText("kept 1");
    await expect(tables(page).locator("[data-outcome]")).toContainText("1 already on the canvas");
    await tables(page).getByRole("button", { name: "remove set", exact: true }).click();
    // Album 1 was there before the set was kept: it stays, with the connection followed to it.
    await expect(records(page)).toHaveCount(2);
    await expect(connections(page)).toHaveCount(1);
    await expect(tables(page).getByRole("button", { name: "remove set", exact: true })).toHaveCount(0);
  });
});

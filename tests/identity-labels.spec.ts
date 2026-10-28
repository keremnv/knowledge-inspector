/** Real generic adapter + disposable SQLite. API routes forward HTTP responses,
 * never manufacture labels/records. These regressions run without opt-in flags. */
import { test as base, expect, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const SPECIAL = "a/b?c#d&e+f%,: Ω";
const SPECIAL_ID = "special:a%2Fb%3Fc%23d%26e%2Bf%25%2C%3A%20%CE%A9";

const test = base.extend<{}, { adapter: string }>({
  adapter: [async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), "ki-identity-browser-"));
    const path = join(dir, "source.sqlite");
    const script = `
import json, sqlite3, sys
from pathlib import Path
from http.server import ThreadingHTTPServer
sys.path.insert(0, str(Path.cwd()))
from adapters.world import server as w
p=Path(sys.argv[1])
d=sqlite3.connect(p)
d.executescript('''
CREATE TABLE subject(id INTEGER PRIMARY KEY, label NUMERIC);
INSERT INTO subject VALUES(1,700),(2,0),(3,NULL);
CREATE TABLE event(id INTEGER PRIMARY KEY, participant INTEGER REFERENCES subject(id));
INSERT INTO event VALUES(10,1),(20,2),(30,3);
CREATE TABLE special(id TEXT PRIMARY KEY);
CREATE TABLE special_event(id TEXT, seq INTEGER, PRIMARY KEY(id,seq));
''')
d.execute('INSERT INTO special VALUES (?)',(sys.argv[2],))
d.execute('INSERT INTO special_event VALUES (?,1)',(sys.argv[2],))
d.commit();d.close()
decl={'version':1,'entities':[
 {'kind':'number','source':'subject','key_columns':['id']},
 {'kind':'measurement','source':'subject','key_columns':['id'],'label_column':'label'},
 {'kind':'special','source':'special','key_columns':['id']}], 'relations':[
 {'name':'default_event','source':'event','key_columns':['id'],
  'roles':[{'role':'subject','column_name':'participant','target_kind':'number'}]},
 {'name':'named_event','source':'event','key_columns':['id'],
  'roles':[{'role':'subject','column_name':'participant','target_kind':'measurement'}]},
 {'name':'special_record','source':'special_event','key_columns':['id','seq'],
  'roles':[{'role':'subject','column_name':'id','target_kind':'special'},
           {'role':'seq','column_name':'seq','target_kind':None}]}]}
decl=w.validate_declaration(decl)
d=w.connect(p)
try: model=w.Model(d,decl)
finally: d.close()
w.Handler.db_path=p;w.Handler.model=model
w.Handler.world_id=w.build_world_id('labels',w.file_sha256(p),decl)
s=ThreadingHTTPServer(('127.0.0.1',0),w.Handler)
print(json.dumps({'port':s.server_port}),flush=True)
s.serve_forever()
`;
    const child = spawn("python3", ["-u", "-c", script, path, SPECIAL]);
    const output = createInterface({ input: child.stdout });
    let errors = "";
    child.stderr.on("data", (data) => { errors += data; });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        output.once("line", (line) => {
          try { resolve(JSON.parse(line).port); } catch (error) { reject(error); }
        });
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`Adapter exited (${code}): ${errors}`)));
      });
      const before = createHash("sha256").update(await readFile(path)).digest("hex");
      await use(`http://127.0.0.1:${port}`);
      expect(createHash("sha256").update(await readFile(path)).digest("hex")).toBe(before);
      expect(await readdir(dir)).toEqual(["source.sqlite"]);
    } finally {
      output.close();
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, "exit");
        child.kill("SIGTERM");
        await stopped;
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, { scope: "worker" }],
});

test.beforeEach(async ({ page, adapter }) => {
  await page.route("**/world/**", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/world/")) return route.continue();
    await route.fulfill({ response: await route.fetch({ url: adapter + url.pathname + url.search }) });
  });
  await page.goto("/");
});

const reader = (page: Page) => page.locator(".node-reader .motion-swap__is");

async function placeFirst(page: Page, relation: string) {
  await page.locator(".table__row").filter({ has: page.locator(`[title="${relation}"]`) }).click();
  const row = page.locator(`section[aria-label="${relation} extension"] .table__row[data-loaded]`).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(reader(page).locator("h2")).toHaveText(relation);
}

for (const [relation, id, label] of [
  ["default_event", "number:1", "1"],
  ["named_event", "measurement:1", "700"],
]) {
  test(`${relation} numeric labels survive nonmatching and matching field find`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await placeFirst(page, relation);
    const find = page.getByPlaceholder("find...");
    await find.fill("zzz");
    await expect(page.getByText("no matches in this search", { exact: true })).toBeVisible();
    await expect(reader(page).locator("h2")).toHaveText(relation);
    await find.fill(label);
    await page.getByRole("option").filter({ hasText: id }).click();
    await expect(reader(page).locator("h2")).toHaveText(label);
    await expect(reader(page)).toContainText(id);
    expect(errors).toEqual([]);
  });
}

test("all HTTP label reads return text or null and preserve source key types", async ({ page }) => {
  const data = await page.evaluate(async () => {
    const read = (path: string) => fetch(path).then((r) => r.json());
    return {
      directory: await read("/world/referents"),
      labels: await read("/world/labels?ids=number:1,measurement:1,measurement:2,measurement:3"),
      search: await read("/world/search?q=700"),
      detail: await read("/world/referent?id=measurement:1"),
      occurrence: await read("/world/assertion?id=named_event:10"),
    };
  });
  expect(data.labels.labels).toEqual({ "number:1": "1", "measurement:1": "700", "measurement:2": "0", "measurement:3": null });
  for (const item of data.directory.referents) expect(item.label === null || typeof item.label === "string").toBe(true);
  expect(data.search.results[0].label).toBe("700");
  expect(data.detail.label).toBe("700");
  expect(data.detail.grounding[0].detail.key).toEqual({ id: 1 });
  expect(data.occurrence.values).toEqual({ subject: "measurement:1" });
  expect(data.occurrence.grounding[0].detail.key).toEqual({ id: 10 });
});

test("reserved text and composite occurrence IDs navigate without re-encoding source identity", async ({ page }) => {
  await placeFirst(page, "special_record");
  await reader(page).locator(".world__roles button").click();
  await expect(reader(page).locator("h2")).toHaveText(SPECIAL);
  const data = await page.evaluate(async ({ id, occurrence }) => {
    const read = async (path: string) => {
      const r = await fetch(path);
      if (!r.ok) throw new Error(`Read failed: ${r.status}`);
      return r.json();
    };
    return {
      detail: await read("/world/referent?id=" + encodeURIComponent(id)),
      labels: await read("/world/labels?ids=" + encodeURIComponent(id)),
      assertion: await read("/world/assertion?id=" + encodeURIComponent(occurrence)),
      expanded: await read("/world/expand?id=" + encodeURIComponent(id) + "&relation=special_record"),
    };
  }, { id: SPECIAL_ID, occurrence: SPECIAL_ID.replace("special:", "special_record:") + "/1" });
  expect(data.detail.id).toBe(SPECIAL_ID);
  expect(data.detail.grounding[0].detail.key).toEqual({ id: SPECIAL });
  expect(data.labels.labels[SPECIAL_ID]).toBe(SPECIAL);
  expect(data.assertion.grounding[0].detail.key).toEqual({ id: SPECIAL, seq: 1 });
  expect(data.expanded.tuples[0].values.subject).toBe(SPECIAL_ID);
});

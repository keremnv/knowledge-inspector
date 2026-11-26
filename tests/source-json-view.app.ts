/** A TEXT holding JSON, shown as its JSON reading in the Reader, on the local application with no Vite:
 * `npx playwright test -c playwright.app.config.ts tests/source-json-view.app.ts`.
 *
 * KI_EXECUTABLE=/path/to/venv/bin/ki runs it against an installed wheel.
 * The fixture is written by Python's sqlite3: JSON documents with an integer
 * beyond binary64, a decimal with a trailing zero, a repeated key, nesting and
 * a long array; TEXT that is not JSON (a trailing comma, a scalar); and the
 * database is checked unchanged afterwards. */
import { test, expect, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALLED = process.env.KI_EXECUTABLE;
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

const DOCUMENT = '{"id": "judgment:z3:1", "clause": "sex == \\"male\\"\\nand hypogonadism", "count": 12345678901234567890, "score": 1.10, "outcome": "met", "outcome": "not_met", ' +
  '"evidence": [{"clause": "c1", "facts": {"testosterone": {"value": 65, "unit": "ng/dL"}}}], "items": [' +
  Array.from({ length: 250 }, (_, i) => i).join(", ") + "]}";
const FIXTURE = `
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE doc(id TEXT PRIMARY KEY, body TEXT)")
db.executemany("INSERT INTO doc VALUES (?, ?)", [
  ("json", sys.argv[2]),
  ("trailing-comma", '{"a": 1,}'),
  ("scalar", "5"),
])
db.commit(); db.close()
`;

async function freePort(): Promise<number> {
  return new Promise((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); }); });
}

function launch(database: string, port: number, tmp: string): Promise<{ child: ChildProcessWithoutNullStreams; url: string }> {
  const child = INSTALLED
    ? spawn(INSTALLED, ["open", database, "--no-browser", "--port", String(port)], { env: { ...process.env, TMPDIR: tmp } })
    : spawn("python3", ["bin/ki", "open", database, "--no-browser", "--port", String(port)], { env: { ...process.env, TMPDIR: tmp } });
  let text = "";
  child.stdout.on("data", (chunk) => { text += chunk; });
  child.stderr.on("data", (chunk) => { text += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const found = text.match(/Knowledge Inspector: (http:\/\/127\.0\.0\.1:\d+\/source)/);
      if (found) { clearInterval(timer); resolve({ child, url: found[1] }); }
    }, 100);
    child.on("exit", (code) => { clearInterval(timer); reject(new Error(`ki exited ${code}: ${text}`)); });
  });
}

const open = (page: Page, base: string, id: string) =>
  page.goto(`${base}?record_table=doc&record_key=${encodeURIComponent(JSON.stringify([{ column: "id", storage_class: "text", exact: id }]))}`);
const reader = (page: Page) => page.locator("#source-reader .motion-swap__is");
const body = (page: Page) => reader(page).locator(".source-cells > div").filter({ has: page.locator("dt", { hasText: /^body$/ }) }).locator("dd");

test.describe("JSON values", () => {
  let home = "", database = "", before = "", base = "";
  let child: ChildProcessWithoutNullStreams | null = null;

  test.beforeAll(async () => {
    test.skip(!INSTALLED && !existsSync("dist/index.html"), "Build the frontend first: npm run build");
    home = mkdtempSync(join(tmpdir(), "ki-json-view-"));
    database = join(home, "documents.sqlite");
    const made = spawnSync("python3", ["-c", FIXTURE, database, DOCUMENT]);
    if (made.status !== 0) throw new Error(String(made.stderr));
    before = digest(database);
    const launched = await launch(database, await freePort(), home);
    child = launched.child; base = launched.url;
  });

  test.afterAll(async () => {
    if (child && child.exitCode === null) await new Promise((resolve) => { child!.once("exit", resolve); child!.kill("SIGINT"); });
    if (database) expect(digest(database)).toBe(before);
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("a JSON document is shown as a tree, with numbers exactly as written and a repeated key kept", async ({ page }) => {
    await open(page, base, "json");
    const view = body(page).locator("[data-json-view]");
    await expect(view).toBeVisible();
    await expect(view.locator(".source-json__number").filter({ hasText: /^12345678901234567890$/ })).toHaveCount(1);
    await expect(view.locator(".source-json__number").filter({ hasText: /^1\.10$/ })).toHaveCount(1);
    // Both "outcome" members, in recorded order; the second is marked.
    await expect(view.locator(".source-json__key").filter({ hasText: /^outcome$/ })).toHaveCount(2);
    await expect(view.locator("[data-json-repeated]")).toHaveCount(1);
    await expect(view.locator("[data-json-repeated]").locator("..")).toContainText('"not_met"');
    // No explanatory sentence under the value.
    await expect(body(page)).not.toContainText("read as JSON");
  });

  test("a string shows its characters, not its escapes; invisible characters are shown as marked escapes", async ({ page }) => {
    await open(page, base, "json");
    const clause = body(page).locator("li").filter({ has: page.locator(".source-json__key", { hasText: /^clause$/ }) }).first().locator(".source-json__string");
    await expect(clause).toHaveText('"sex == "male"\\nand hypogonadism"');
    await expect(clause.locator("[data-escape]")).toHaveText(["\\n"]);
  });

  test("the first two levels are open; deeper ones open on request", async ({ page }) => {
    await open(page, base, "json");
    const view = body(page).locator("[data-json-view]");
    // The document and its members are open; evidence's first item (depth 2) is not, nor what it holds.
    const item = view.getByRole("button", { name: /^item 0, object, 2 keys, expand$/ });
    await expect(item).toHaveAttribute("aria-expanded", "false");
    await expect(view.locator(".source-json__key", { hasText: /^c$/ })).toHaveCount(0);
    await item.click();
    await expect(view.locator(".source-json__key", { hasText: /^facts$/ })).toHaveCount(1);
    const facts = view.getByRole("button", { name: /^facts, object, 1 key, expand$/ });
    await expect(facts).toHaveAttribute("aria-expanded", "false");
    await expect(view).not.toContainText("testosterone");
    await facts.click();
    await expect(view.getByRole("button", { name: /^facts, object, 1 key, collapse$/ })).toHaveAttribute("aria-expanded", "true");
    await expect(view).toContainText("testosterone");
  });

  test("a long array shows 100 items and the rest on request", async ({ page }) => {
    await open(page, base, "json");
    const items = body(page).locator('[data-json-kind="array"]').filter({ has: page.locator(".source-json__index", { hasText: /^249$/ }) });
    await expect(body(page).getByRole("button", { name: "show 100 more of 150" })).toBeVisible();
    await expect(body(page).locator(".source-json__index").filter({ hasText: /^100$/ })).toHaveCount(0);
    await body(page).getByRole("button", { name: "show 100 more of 150" }).click();
    await body(page).getByRole("button", { name: "show 50 more of 50" }).click();
    await expect(items.locator(":scope > li")).toHaveCount(250);
  });

  test("value details keep the exact TEXT", async ({ page }) => {
    await open(page, base, "json");
    const details = reader(page).locator("details", { has: page.locator("summary", { hasText: "value details" }) });
    await details.locator("summary").click();
    await expect(details).toContainText('"count\\": 12345678901234567890, \\"score\\": 1.10');
  });

  test("TEXT that is not one strict JSON object or array stays TEXT", async ({ page }) => {
    await open(page, base, "trailing-comma");
    await expect(body(page)).toContainText('"{\\"a\\": 1,}"');
    await expect(body(page).locator("[data-json-view]")).toHaveCount(0);
    await open(page, base, "scalar");
    await expect(body(page)).toContainText('"5"');
    await expect(body(page).locator("[data-json-view]")).toHaveCount(0);
  });
});

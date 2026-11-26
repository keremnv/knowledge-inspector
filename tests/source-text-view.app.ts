/** TEXT shown as its characters in the Reader and in table cells, on the local application with no Vite:
 * `npx playwright test -c playwright.app.config.ts tests/source-text-view.app.ts`.
 *
 * KI_EXECUTABLE=/path/to/venv/bin/ki runs it against an installed wheel. The fixture is written by Python's
 * sqlite3 and checked unchanged afterwards. */
import { test, expect, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALLED = process.env.KI_EXECUTABLE;
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

const FIXTURE = `
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE t(id TEXT PRIMARY KEY, v)")
db.executemany("INSERT INTO t VALUES (?, ?)", [
  ("quotes", 'sex == "male" and hypogonadism'),
  ("lines", "\\n".join(f"line {i}" for i in range(1, 21))),
  ("edges", "  padded "),
  ("empty", ""),
  ("text-null", "NULL"),
  ("null", None),
  ("invisible", "tab\\there\\u200bzero"),
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
  page.goto(`${base}?record_table=t&record_key=${encodeURIComponent(JSON.stringify([{ column: "id", storage_class: "text", exact: id }]))}`);
const reader = (page: Page) => page.locator("#source-reader .motion-swap__is");
const value = (page: Page) => reader(page).locator(".source-cells > div").filter({ has: page.locator("dt", { hasText: /^v$/ }) }).locator("dd .source-value");

test.describe("TEXT values", () => {
  let home = "", database = "", before = "", base = "";
  let child: ChildProcessWithoutNullStreams | null = null;

  test.beforeAll(async () => {
    test.skip(!INSTALLED && !existsSync("dist/index.html"), "Build the frontend first: npm run build");
    home = mkdtempSync(join(tmpdir(), "ki-text-view-"));
    database = join(home, "texts.sqlite");
    const made = spawnSync("python3", ["-c", FIXTURE, database]);
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

  test("a TEXT is shown as its characters, not quoted or escaped; value details keep the exact quoted TEXT", async ({ page }) => {
    await open(page, base, "quotes");
    await expect(value(page).locator("code").first()).toHaveText('sex == "male" and hypogonadism');
    const details = reader(page).locator("details", { has: page.locator("summary", { hasText: "value details" }) });
    await details.locator("summary").click();
    await expect(details).toContainText('"sex == \\"male\\" and hypogonadism"');
  });

  test("lines break as written in the Reader; a long TEXT shows 12 lines until show all", async ({ page }) => {
    await open(page, base, "lines");
    const text = value(page).locator(".source-text--block");
    await expect(text).toHaveAttribute("data-text-lines", "20");
    await expect(text.locator(".source-text__line")).toHaveCount(12);
    await expect(text.locator("[data-shortened]")).toHaveCount(1);
    await value(page).getByRole("button", { name: "show all · 20 lines" }).click();
    await expect(text.locator(".source-text__line")).toHaveCount(20);
    await expect(text.locator(".source-text__line").last()).toHaveText("line 20");
    await value(page).getByRole("button", { name: "show less" }).click();
    await expect(text.locator(".source-text__line")).toHaveCount(12);
  });

  test("in a table cell a line break is a marked escape on one line", async ({ page }) => {
    await open(page, base, "lines");
    await page.locator("#source-tables").getByRole("button", { name: /^t\b/ }).first().click().catch(() => undefined);
    const cell = page.locator("#source-tables td .source-text").filter({ hasText: "line 1" }).first();
    await expect(cell.locator("[data-escape]").first()).toHaveText("\\n");
  });

  test("spaces at either end, the empty TEXT and invisible characters are marked", async ({ page }) => {
    await open(page, base, "edges");
    await expect(value(page).locator("code")).toHaveText("␣␣padded␣");
    await expect(value(page).locator("[data-edge]")).toHaveCount(3);
    await open(page, base, "empty");
    await expect(value(page).locator("[data-empty]")).toHaveText("empty");
    await open(page, base, "invisible");
    await expect(value(page).locator("[data-escape]")).toHaveText(["\\t", "\\u200B"]);
  });

  test("the TEXT NULL and a NULL are told apart by storage class", async ({ page }) => {
    await open(page, base, "text-null");
    await expect(value(page)).toHaveClass(/source-value--text(\s|$)/);
    await expect(value(page).locator("code")).toHaveText("NULL");
    await open(page, base, "null");
    await expect(value(page)).toHaveClass(/source-value--null(\s|$)/);
    await expect(value(page).locator("code")).toHaveText("NULL");
  });
});

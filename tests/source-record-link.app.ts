/** `?record_table=&record_key=` on the local application, with no Vite:
 * `npx playwright test -c playwright.app.config.ts tests/source-record-link.app.ts`.
 *
 * KI_EXECUTABLE=/path/to/venv/bin/ki runs it against an installed wheel.
 * A small generic fixture with a TEXT key, an INTEGER key and a composite key
 * is written by Python's sqlite3, so no sample download is needed. */
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
db.executescript('''
PRAGMA foreign_keys=ON;
CREATE TABLE author(author_id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE book(book_id INTEGER PRIMARY KEY, title TEXT NOT NULL, author_id TEXT NOT NULL REFERENCES author(author_id));
CREATE TABLE edition(book_id INTEGER NOT NULL REFERENCES book(book_id), isbn TEXT NOT NULL, note TEXT, PRIMARY KEY(book_id, isbn));
INSERT INTO author VALUES ('ada:lovelace','Ada Lovelace'),('ada:lovelace:2','Ada Byron'),('alan:turing','Alan Turing');
INSERT INTO book VALUES (7,'Sketch of the Analytical Engine','ada:lovelace'),(8,'Computing Machinery and Intelligence','alan:turing');
INSERT INTO edition VALUES (7,'isbn-1843','first printing'),(7,'isbn-1953','reprint');
''')
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

const link = (base: string, table: string, key: unknown) =>
  `${base}?record_table=${encodeURIComponent(table)}&record_key=${encodeURIComponent(JSON.stringify(key))}`;
const reader = (page: Page) => page.locator("#source-reader .motion-swap__is");
const problem = (page: Page) => page.locator("[data-record-link-problem]");

test.describe("record links", () => {
  let home = "", database = "", before = "", base = "";
  let child: ChildProcessWithoutNullStreams | null = null;

  test.beforeAll(async () => {
    test.skip(!INSTALLED && !existsSync("dist/index.html"), "Build the frontend first: npm run build");
    home = mkdtempSync(join(tmpdir(), "ki-record-link-"));
    database = join(home, "library.sqlite");
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

  test("a TEXT key opens exactly that record in the Reader and places it", async ({ page }) => {
    await page.goto(link(base, "author", [{ column: "author_id", storage_class: "text", exact: "ada:lovelace" }]));
    await expect(reader(page)).toContainText("Ada Lovelace");
    await expect(reader(page)).not.toContainText("Ada Byron");
    await expect(page.locator("[data-field-record]")).toHaveCount(1);
    await expect(problem(page)).toHaveCount(0);
  });

  test("an INTEGER key and a composite key open their records", async ({ page }) => {
    await page.goto(link(base, "book", [{ column: "book_id", storage_class: "integer", exact: "8" }]));
    await expect(reader(page)).toContainText("Computing Machinery and Intelligence");
    await page.goto(link(base, "edition", [
      { column: "book_id", storage_class: "integer", exact: "7" }, { column: "isbn", storage_class: "text", exact: "isbn-1953" }]));
    await expect(reader(page)).toContainText("reprint");
    await expect(reader(page)).not.toContainText("first printing");
  });

  test("a key that is only a prefix, a different case or absent opens nothing and says so", async ({ page }) => {
    for (const exact of ["ada", "ADA:LOVELACE", "grace:hopper"]) {
      await page.goto(link(base, "author", [{ column: "author_id", storage_class: "text", exact }]));
      await expect(problem(page)).toContainText("was not found");
      await expect(page.locator("[data-field-record]")).toHaveCount(0);
    }
  });

  test("a malformed link opens nothing and says why", async ({ page }) => {
    await page.goto(`${base}?record_table=author`);
    await expect(problem(page)).toContainText("needs both record_table and record_key");
    await page.goto(`${base}?record_table=author&record_key=not-json`);
    await expect(problem(page)).toContainText("record_key is not JSON");
    await page.goto(link(base, "author", [{ column: "author_id", storage_class: "real", exact: "1" }]));
    await expect(problem(page)).toContainText("must be exactly");
    await page.goto(link(base, "no_such_table", [{ column: "id", storage_class: "text", exact: "x" }]));
    await expect(problem(page)).toContainText("was not opened");
    await expect(page.locator("[data-field-record]")).toHaveCount(0);
  });

  test("without a link the workspace opens as before", async ({ page }) => {
    await page.goto(base);
    await expect(page.locator(".source-schema")).toHaveAttribute("data-schema-tables", "3");
    await expect(problem(page)).toHaveCount(0);
    await expect(page.locator("[data-field-record]")).toHaveCount(0);
  });
});

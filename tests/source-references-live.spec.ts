import { openSourceReferences } from "./canvas-parity";
import { chooseSourceTable as choose } from "./source-navigation";
/** Real pinned Chinook and disposable SQLite via SourceHTTPServer; no HTTP mocks. */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveSource } from "./source-serve";
import { UPSTREAM, prepared } from "./chinook-serve";
const tables = (p: Page) => p.locator("#source-tables .source-table-slot > .motion-swap > .motion-swap__is");
const reader = (p: Page) => p.locator("#source-reader > .motion-swap > .motion-swap__is");
const list = (p: Page) => p.getByRole("region", { name: "Records on canvas" });
async function inspect(p: Page, parent: string) {
  const card = reader(p).locator(".source-outgoing article").filter({ hasText: `→ ${parent}` });
  await expect(card).toHaveCount(1);
  await openSourceReferences(p); await card.getByRole("button", { name: /inspect FK/ }).click();
  await expect(reader(p).locator("h2")).toContainText("reference");
  await expect(reader(p).getByRole("button", { name: /^(show|reveal) connection$/ })).toBeVisible();
}
async function drawn(p: Page) {
  return p.evaluate(() => {
    const g = (window as any).__sourceFieldGraph;
    return g ? { nodes: g.getNodeData().map((n: any) => ({ id: n.id, x: n.style.x, y: n.style.y, label: n.style.labelText, opacity: n.style.opacity, size: n.style.size })),
      edges: g.getEdgeData().filter((e: any) => !e.id.startsWith("source-carrier:") && !e.id.startsWith("source-summary:")).map((e: any) => ({ id: e.id, source: e.source, target: e.target, type: e.type, label: e.style.labelText, dash: e.style.lineDash })) } : { nodes: [], edges: [] };
  });
}
async function settle(p: Page, nodes: number, edges: number) {
  await expect.poll(async () => { const d = await drawn(p); return d.nodes.length === nodes && d.edges.length === edges && d.nodes.every((n: any) => n.opacity === 1 && n.size === 90); }).toBe(true);
}
async function shot(p: Page, name: string) {
  if (!process.env.KI_FK_SHOTS) return;
  await mkdir(process.env.KI_FK_SHOTS, { recursive: true });
  await expect(p.locator(".motion-swap__was")).toHaveCount(0);
  await p.screenshot({ path: join(process.env.KI_FK_SHOTS, name) });
}
for (const motion of ["reduce", "no-preference"] as const) {
  test(`J2-A/B/F/G real Chinook Track references, ${motion}`, async ({ page }) => {
    test.skip(!prepared(), "Prepare pinned Chinook");
    await page.emulateMedia({ reducedMotion: motion });
    await serveSource(UPSTREAM, async ({ origin, requests, commands, captureFingerprint }) => {
      const captureBefore = await captureFingerprint();
      await page.goto(`${origin}/source?placement=explicit`); await choose(page, "Track");
      await tables(page).getByRole("searchbox").fill("Evil Walks");
      await tables(page).getByRole("searchbox").press("Enter");
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).press("Enter");
      await expect(reader(page).locator("h2")).toHaveAccessibleName(/TrackId=10$/);
      await expect(reader(page).locator("details.source-references > summary")).toHaveText("references · 3 declared");
      await expect(page.locator(".source-canvas > .source-layer:not(.source-schema) canvas")).toHaveCount(0);
      await inspect(page, "Album");
      await expect(reader(page)).toContainText("SQLite INTEGER");
      await expect(reader(page)).toContainText("Historical enforcement is not established");
      await reader(page).getByRole("button", { name: "open referenced record" }).press("Enter");
      await expect(reader(page).locator("h2")).toHaveAccessibleName(/AlbumId=1$/);
      await expect(reader(page).locator(".source-cells")).toContainText("For Those About To Rock");
      await expect(tables(page).getByRole("searchbox")).toHaveValue("Evil Walks");
      await expect(tables(page).getByRole("button", { name: "Inspect row 1", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(tables(page).locator("h2")).toHaveText("Track");
      await expect(page.locator(".source-canvas > .source-layer:not(.source-schema) canvas")).toHaveCount(0);
      await reader(page).getByRole("button", { name: "Back", exact: true }).press("Enter");
      await expect(reader(page).locator("h2")).toBeFocused();
      await reader(page).getByRole("button", { name: /^(show|reveal) connection$/ }).press("Enter");
      await settle(page, 2, 1);
      await expect(list(page).locator("[data-field-record]")).toHaveText(["Track 10", "Album 1"]);
      await shot(page, `track-album-${motion}.png`);
      const baseline = (await drawn(page)).nodes;
      await reader(page).getByRole("button", { name: /^(show|reveal) connection$/ }).click();
      await settle(page, 2, 1);
      // Both further references remain selective, never a recursive neighborhood.
      for (const parent of ["Genre", "MediaType"]) {
        await reader(page).getByRole("button", { name: "Back", exact: true }).click();
        await inspect(page, parent);
        await reader(page).getByRole("button", { name: /^(show|reveal) connection$/ }).click();
      }
      await settle(page, 4, 3);
      for (const node of baseline) expect((await drawn(page)).nodes.find((n: any) => n.id === node.id)).toMatchObject({ x: node.x, y: node.y });
      await shot(page, `multiple-${motion}.png`);
      // A selectable filament exposes the exact observation, also from keyboard controls.
      await list(page).locator("[data-field-reference]").filter({ hasText: "→ Album" }).press("Enter");
      await expect(tables(page).getByRole("button", { name: "Inspect row 1", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(reader(page)).toContainText("so1:");
      await expect(reader(page)).toContainText("sf1:");
      await shot(page, `selected-evidence-${motion}.png`);
      // Drag an endpoint, pan/zoom, then select the real rendered label with the pointer.
      await list(page).getByRole("button", { name: "Track 10", exact: true }).press("Enter");
      await expect(page.locator(".source-canvas .ants__mark")).toBeVisible();
      const box = await page.locator(".source-canvas .ants__mark").boundingBox();
      if (!box) throw new Error("Missing record selection");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.waitForTimeout(150);
      await page.mouse.move(box.x + box.width / 2 - 40, box.y + box.height / 2 + 55, { steps: 8 }); await page.mouse.up();
      const labelPoint = await page.evaluate(() => {
        const g = (window as any).__sourceFieldGraph, edge = g.getEdgeData().find((e: any) => !e.id.startsWith("source-carrier:") && !e.id.startsWith("source-summary:"));
        const label = g.context.element.getElement(edge.id).getShape("label");
        const box = label.getBounds();
        const v = g.getViewportByCanvas([(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2]);
        const host = document.querySelector(".source-canvas .world__surface canvas")!.getBoundingClientRect();
        return { x: v[0] + host.left, y: v[1] + host.top };
      });
      await page.mouse.click(labelPoint.x, labelPoint.y);
      await expect(reader(page).locator("h2")).toContainText("reference");
      await expect(reader(page)).toContainText("observation grounding");
      for (const width of [1000, 900, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        await list(page).locator("[data-field-reference]").first().press("Enter");
        const room = await page.locator(".source-canvas").evaluate((el) => {
          const t = document.querySelector('[data-overlay="source-tables"] .ov__body')!.getBoundingClientRect();
          const r = document.querySelector('[data-overlay="source-reader"] .ov__body')!.getBoundingClientRect();
          return { actual: r.left - t.right, reported: Number((el as HTMLElement).dataset.unobscured) };
        });
        expect(Math.round(room.actual)).toBe(room.reported); expect(room.actual).toBeGreaterThanOrEqual(320);
        if (width === 900) await shot(page, `900-${motion}.png`);
      }
      const captureAfter = await captureFingerprint();
      expect(captureAfter).toEqual(captureBefore);
      // SQLite backup may normalize capture bytes; compare with the actual
      // SourceContext digest, not the upstream producer's file hash.
      const descriptor = await (await page.request.get(`${origin}/source/v1/session`)).json();
      expect(captureAfter.sha256).toBe(descriptor.capture_digest);
      if (process.env.KI_FK_SHOTS) await writeFile(join(process.env.KI_FK_SHOTS, `capture-integrity-${motion}.json`), JSON.stringify({ context_digest: descriptor.capture_digest, before: captureBefore, after: captureAfter }, null, 2));
      await commands("retire");
      await reader(page).getByRole("button", { name: "open referenced record" }).click();
      await expect(page.getByRole("heading", { name: "source reads stopped" })).toBeVisible();
      await expect(page.locator(".source-canvas > .source-layer:not(.source-schema) canvas")).toHaveCount(0);
      for (const request of requests.filter((r) => !r.pathname.endsWith("/session"))) {
        expect(request.searchParams.get("session")).toBeTruthy(); expect(request.searchParams.get("generation")).toBeTruthy();
      }
      expect(requests.some((r) => r.pathname.endsWith("/reference"))).toBe(true);
      expect(requests.filter((r) => r.pathname.endsWith("/references")).every((r) => r.searchParams.get("limit") === "10")).toBe(true);
    });
  });

  test(`J2-C real Chinook junction remains a record, ${motion}`, async ({ page }) => {
    test.skip(!prepared(), "Prepare pinned Chinook");
    await page.emulateMedia({ reducedMotion: motion });
    await serveSource(UPSTREAM, async ({ origin }) => {
      await page.goto(`${origin}/source`); await choose(page, "PlaylistTrack");
      await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
      await inspect(page, "Playlist"); await reader(page).getByRole("button", { name: /^(show|reveal) connection$/ }).click();
      await reader(page).getByRole("button", { name: "Back", exact: true }).click();
      await inspect(page, "Track"); await reader(page).getByRole("button", { name: /^(show|reveal) connection$/ }).click();
      await settle(page, 3, 2);
      await expect(list(page).locator("[data-field-record]")).toContainText(["PlaylistTrack PlaylistId=1; TrackId=1", "Playlist 1", "Track 1"]);
      await shot(page, `junction-${motion}.png`);
    });
  });
}

const SQL = `CREATE TABLE Parent(id INTEGER PRIMARY KEY); INSERT INTO Parent VALUES(10);
 CREATE TABLE Child(id INTEGER PRIMARY KEY, a REFERENCES Parent(id), b REFERENCES Parent(id));
 INSERT INTO Child VALUES(1,10,10),(2,10,NULL);
 CREATE TABLE Composite(a,b,PRIMARY KEY(a,b)); INSERT INTO Composite VALUES(1,2);
 CREATE TABLE Nullable(id INTEGER PRIMARY KEY,a,b,FOREIGN KEY(a,b) REFERENCES Composite(a,b)); INSERT INTO Nullable VALUES(1,1,NULL);
 CREATE TABLE CompositeResolved(id INTEGER PRIMARY KEY,a,b,FOREIGN KEY(a,b) REFERENCES Composite(a,b)); INSERT INTO CompositeResolved VALUES(1,1,2);
 CREATE TABLE Budget(id INTEGER PRIMARY KEY,p REFERENCES Parent(id)); INSERT INTO Budget VALUES(1,zeroblob(1048577));
 CREATE TABLE CustomParent(k TEXT COLLATE CUSTOM PRIMARY KEY); INSERT INTO CustomParent VALUES('x');
 CREATE TABLE CustomUnsupported(id INTEGER PRIMARY KEY,p REFERENCES CustomParent(k)); INSERT INTO CustomUnsupported VALUES(1,'x');
 CREATE TABLE Dangling(id INTEGER PRIMARY KEY,p REFERENCES Parent(id)); INSERT INTO Dangling VALUES(1,999);
 CREATE TABLE Invalid(id INTEGER PRIMARY KEY,p REFERENCES Missing(id)); INSERT INTO Invalid VALUES(1,10);
 CREATE TABLE Unkeyed(x UNIQUE); INSERT INTO Unkeyed VALUES(10);
 CREATE TABLE Unaddressable(id INTEGER PRIMARY KEY,p REFERENCES Unkeyed(x)); INSERT INTO Unaddressable VALUES(1,10);
 CREATE TABLE Weird(x TEXT,PRIMARY KEY(x COLLATE NOCASE)); INSERT INTO Weird VALUES('ABC');
 CREATE TABLE Unsupported(id INTEGER PRIMARY KEY,p REFERENCES Weird); INSERT INTO Unsupported VALUES(1,'abc');
 CREATE TABLE Self(id INTEGER PRIMARY KEY,p REFERENCES Self(id)); INSERT INTO Self VALUES(1,1);`;
async function fixture(use: (db: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "ki-fk-")), db = join(dir, "fixture.sqlite");
  try { execFileSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.create_collation('CUSTOM', lambda a,b:(a>b)-(a<b)); c.executescript(sys.argv[2]); c.close()", db, SQL]); await use(db); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

for (const motion of ["reduce", "no-preference"] as const) {
test(`J2-D real HTTP shared parent and parallel observations hide independently, and their records stand (${motion})`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion: motion });
  await fixture((db) => serveSource(db, async ({ origin }) => {
    await page.goto(`${origin}/source`); await choose(page, "Child");
    await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    for (const fk of [0, 1]) {
      await openSourceReferences(page); await reader(page).getByRole("button", { name: `inspect FK ${fk} reference` }).click();
      await reader(page).getByRole("button", { name: /^(show|reveal) connection$/ }).click();
      await reader(page).getByRole("button", { name: "Back", exact: true }).click();
    }
    await settle(page, 2, 2);
    expect((await drawn(page)).edges.map((e: any) => e.type)).toEqual(["world-filament", "world-filament"]);
    await shot(page, `parallel-${motion}.png`);
    await tables(page).getByRole("button", { name: "Inspect row 2", exact: true }).click();
    await openSourceReferences(page); await reader(page).getByRole("button", { name: "inspect FK 1 reference" }).click();
    await reader(page).getByRole("button", { name: /^(show|reveal) connection$/ }).click();
    await settle(page, 3, 3);
    await list(page).locator("[data-field-reference]").first().press("Enter");
    await reader(page).getByRole("button", { name: "hide connection" }).click();
    await settle(page, 3, 2);
    await shot(page, `shared-parent-standing-${motion}.png`);
    await list(page).getByRole("button", { name: "Parent 10", exact: true }).press("Enter");
    await expect(reader(page).locator('[data-placement="show"]')).toHaveText("reveal");
    await reader(page).locator('[data-placement="show"]').click();
    for (let i = 0; i < 2; i++) {
      await list(page).locator("[data-field-reference]").first().press("Enter");
      await reader(page).getByRole("button", { name: "hide connection" }).click();
    }
    await settle(page, 3, 0);
    await expect(list(page).locator("[data-field-record]")).toHaveText(["Child 1", "Parent 10", "Child 2"]);
    await shot(page, `hidden-connections-records-stand-${motion}.png`);
    await choose(page, "Self"); await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await inspect(page, "Self"); await reader(page).getByRole("button", { name: /^(show|reveal) connection$/ }).click();
    await settle(page, 4, 1); const edge = (await drawn(page)).edges[0]; expect(edge.source).toBe(edge.target);
    await shot(page, `self-${motion}.png`);
    await list(page).getByRole("button", { name: "remove Self 1 from canvas", exact: true }).press("Enter");
    await settle(page, 3, 0);
  }));
});

}

test("J2-E real HTTP nullable composite, dangling, invalid, unsupported and unaddressable evidence", async ({ page }) => {
  // Eight tables, the last read deliberately run to its budget: more than the
  // default 30 s once several workers share the machine.
  test.setTimeout(60_000);
  await fixture((db) => serveSource(db, async ({ origin }) => {
    await page.goto(`${origin}/source?placement=explicit`);
    for (const [table, status] of [["Nullable", "null_reference"], ["Dangling", "dangling"], ["Invalid", "invalid_declaration"], ["Unsupported", "unsupported"], ["Unaddressable", "resolved_unaddressable"], ["CustomUnsupported", "unsupported"], ["Budget", "budget_exceeded"]]) {
      await choose(page, table); await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
      await openSourceReferences(page); await reader(page).getByRole("button", { name: "inspect FK 0 reference" }).click();
      await expect(reader(page).locator("[data-reference-status]")).toHaveAttribute("data-reference-status", status);
      await expect(reader(page).getByRole("button", { name: /^(show|reveal) connection$/ })).toHaveCount(0);
      await expect(reader(page).getByRole("button", { name: "open referenced record" })).toHaveCount(0);
      if (table === "Nullable") { await expect(reader(page).locator("tbody tr")).toHaveCount(2); await expect(reader(page)).toContainText("SQLite NULL"); }
    }
    await expect(page.locator(".source-canvas > .source-layer:not(.source-schema) canvas")).toHaveCount(0);
    await choose(page, "CompositeResolved"); await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
    await inspect(page, "Composite");
    await expect(reader(page).locator("tbody tr")).toHaveCount(2);
    await reader(page).getByRole("button", { name: /^(show|reveal) connection$/ }).click();
    await settle(page, 2, 1);
  }));
});

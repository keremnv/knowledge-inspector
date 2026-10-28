/**
 * Epistemic presentation closure, live: the real generic adapter over
 * disposable SQLite files, and the pinned Chinook example. No producer
 * database is involved.
 *
 * Two rules:
 *
 *  1. A displayed value says what the source records. A stored NULL, the empty
 *     string, zero, whitespace-only text and the literal texts `null`, `NULL`,
 *     `—` and `""` are seven different things and must stay distinguishable
 *     in every table and reader that prints them, including to a screen reader.
 *     A value the API did not send is a different thing again.
 *
 *  2. A qualification must separate source-reported from adapter-provided.
 *     Revision 1 and BASE mode are the generic bridge's compatibility defaults:
 *     a *verified* external reading does not print them as if its producer had
 *     recorded them (the API still reports them), and any other World keeps
 *     printing them. The test is the verified descriptor, never an id prefix, a
 *     revision number or the word BASE.
 *
 * The expected values below are the fixture's (adapters/world/scalar_fixture.py,
 * whose Python test compares the same list with an independent SQL read).
 */
import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { serveDisposable } from "./disposable-world";
import { prepared, serve, UPSTREAM } from "./chinook-serve";

const test = base.extend<{}, { scalars: string; attribution: string; chinook: string }>({
  scalars: [async ({}, use) => { await serveDisposable("scalar_fixture", (served) => use(served.origin)); }, { scope: "worker" }],
  attribution: [async ({}, use) => { await serveDisposable("attribution_fixture", (served) => use(served.origin)); }, { scope: "worker" }],
  chinook: [async ({}, use) => {
    if (!prepared()) { await use(""); return; }
    await serve(UPSTREAM, "examples/chinook/declaration.json", use);
  }, { scope: "worker" }],
});

const reader = (page: Page) => page.locator(".node-reader .motion-swap__is");
const section = (page: Page, name: string) => page.locator(`.motion-swap__is section[aria-label="${name}"]`);
const api = <T = any>(page: Page, path: string) =>
  page.evaluate((p) => fetch(p).then((r) => r.json()), path) as Promise<T>;

async function openRelation(page: Page, name: string) {
  await section(page, "world relations").locator(".table__row").filter({ has: page.locator(`[title="${name}"]`) }).click();
  await expect(section(page, `${name} extension`).locator(".table__row[data-loaded]").first()).toBeVisible();
}

/** The cells of one loaded row, in role order (the trailing origin cell is excluded by role count). */
const rowOf = (page: Page, relation: string, assertionNumber: number) =>
  section(page, `${relation} extension`).locator(".table__row[data-loaded]").nth(assertionNumber - 1);

async function findReferent(page: Page, query: string, id: string) {
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  await page.getByRole("combobox").fill(query);
  const option = page.getByRole("option").filter({
    has: page.locator(".nodefind__anchor").filter({ hasText: new RegExp(`^${id}$`) }),
  });
  await expect(option).toBeVisible();
  await option.click();
  await expect(reader(page).locator("h2")).toBeVisible();
}

// What the fixture stores in probe.value, and how the interface must classify it.
// [id, API value, kind, visible text, marker element (role=img) expected]
const EXPECTED: [number, unknown, string, string, boolean][] = [
  [1, null, "null", "NULL", true],
  [2, "", "empty text", '""', true],
  [3, 0, "number", "0", false],
  [4, 0, "number", "0", false], // stored REAL 0.0: JSON 0.0 is the number 0; the class is in the source metadata
  [5, -3, "number", "-3", false],
  [6, -2.5, "number", "-2.5", false],
  [7, 7, "number", "7", false],
  [8, 3.25, "number", "3.25", false],
  [9, "   ", "whitespace text", '"   "', true],
  [10, "\t\n", "whitespace text", '"\\t\\n"', true],
  [11, "null", "text", '"null"', false],
  [12, "NULL", "text", '"NULL"', false],
  [13, "—", "text", '"—"', false],
  [14, '""', "text", '"\\"\\""', false],
  [15, " padded ", "text", " padded ", false],
  [16, "plain text", "text", "plain text", false],
];

/** Text exactly as stored in the DOM, not as layout trims it. */
const exact = (locator: Locator) => locator.evaluate((node) => node.textContent);

test.describe("scalar values: SQL, API and UI agree", () => {
  test("the API serves each stored value with its own type", async ({ page, scalars }) => {
    await page.goto(scalars);
    const served = await api(page, "/world/rows?relation=probe&limit=100");
    expect(served.rows.map((r: any) => r.values.value)).toEqual(EXPECTED.map(([, value]) => value));
    // null, "" and 0 are three values, not one.
    const kinds = served.rows.map((r: any) => (r.values.value === null ? "null" : typeof r.values.value));
    expect(kinds.slice(0, 3)).toEqual(["null", "string", "number"]);
  });

  test("relation table: each stored value is itself, with a name where it is a marker", async ({ page, scalars }) => {
    await page.goto(scalars);
    await openRelation(page, "probe");
    const rows = section(page, "probe extension").locator(".table__row[data-loaded]");
    await expect(rows).toHaveCount(16);
    for (const [id, , kind, text, marker] of EXPECTED) {
      const cell = rows.nth(id - 1).locator(":scope > span").nth(1);
      await expect(cell, `probe:${id}`).toHaveAttribute("data-value-kind", kind);
      expect(await exact(cell), `probe:${id} text`).toBe(text);
      await expect(cell.locator('[role="img"]'), `probe:${id} marker`).toHaveCount(marker ? 1 : 0);
    }
    // The literal texts are text: no marker element, no marker name.
    for (const id of [11, 12, 13, 14]) {
      await expect(rows.nth(id - 1).locator(":scope > span").nth(1).getByRole("img")).toHaveCount(0);
    }
    // The second scalar column: NULL on odd ids, "" on even ids.
    for (let id = 1; id <= 16; id++) {
      const memo = rows.nth(id - 1).locator(":scope > span").nth(2);
      await expect(memo).toHaveAttribute("data-value-kind", id % 2 ? "null" : "empty text");
      expect(await exact(memo)).toBe(id % 2 ? "NULL" : '""');
    }
  });

  test("relation table: markers are named for assistive technology, not just styled", async ({ page, scalars }) => {
    await page.goto(scalars);
    await openRelation(page, "probe");
    const table = section(page, "probe extension");
    // value NULL once + memo NULL eight times; empty text: value once + memo eight times.
    await expect(table.getByRole("img", { name: "null value supplied by the World" })).toHaveCount(9);
    await expect(table.getByRole("img", { name: "empty string value" })).toHaveCount(9);
    await expect(table.getByRole("img", { name: "whitespace-only text, 3 characters" })).toHaveCount(1);
    await expect(table.getByRole("img", { name: "whitespace-only text, 2 characters" })).toHaveCount(1);
    // The cell's tooltip says the same, as a supplement.
    await expect(rowOf(page, "probe", 1).locator(":scope > span").nth(1)).toHaveAttribute("title", "null value supplied by the World");
    await expect(rowOf(page, "probe", 12).locator(":scope > span").nth(1)).toHaveAttribute("title", "NULL");
  });

  test("assertion reader: the same values, the same kinds", async ({ page, scalars }) => {
    await page.goto(scalars);
    await openRelation(page, "probe");
    for (const id of [1, 2, 3, 9, 11, 12, 13, 14]) {
      await rowOf(page, "probe", id).click();
      await expect(reader(page).locator("h2")).toHaveText("probe");
      await expect(reader(page).locator(".world__roles li").filter({ has: page.locator("b", { hasText: /^value$/ }) })
        .locator(":scope > span")).toHaveAttribute("data-value-kind", EXPECTED[id - 1][2]);
      const value = reader(page).locator(".world__roles li").filter({ has: page.locator("b", { hasText: /^value$/ }) })
        .locator(":scope > span");
      expect(await exact(value), `probe:${id}`).toBe(EXPECTED[id - 1][3]);
      await expect(value.getByRole("img")).toHaveCount(EXPECTED[id - 1][4] ? 1 : 0);
    }
  });

  test("referent occurrence previews: sixteen occurrences, sixteen distinct kinds of value", async ({ page, scalars }) => {
    await page.goto(scalars);
    await findReferent(page, "Probe", "item:1");
    const items = reader(page).locator('.world-occurrence');
    await expect(items).toHaveCount(16);
    for (const [id, , kind, text, marker] of EXPECTED) {
      const cell = reader(page).locator(`.world-occurrence[data-assertion-id="probe:${id}"] .world__roles li`)
        .filter({ has: page.locator("b", { hasText: /^value$/ }) }).locator(":scope > span");
      await expect(cell, `probe:${id}`).toHaveAttribute("data-value-kind", kind);
      expect(await exact(cell), `probe:${id}`).toBe(text);
      await expect(cell.getByRole("img")).toHaveCount(marker ? 1 : 0);
    }
  });

  test("a value the API did not send is not a stored NULL; false and true stay words", async ({ page, scalars }) => {
    await page.route("**/world/rows?**", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      // probe:1 loses its `memo` key; probe:2 gets booleans.
      delete body.rows[0].values.memo;
      body.rows[1].values.value = false;
      body.rows[1].values.memo = true;
      await route.fulfill({ response, json: body });
    });
    await page.goto(scalars);
    await openRelation(page, "probe");
    const rows = section(page, "probe extension").locator(".table__row[data-loaded]");
    const absent = rows.nth(0).locator(":scope > span").nth(2);
    await expect(absent).toHaveAttribute("data-value-kind", "not supplied");
    expect(await exact(absent)).toBe("not supplied");
    await expect(absent.getByRole("img", { name: "value not supplied by the API" })).toHaveCount(1);
    await expect(rows.nth(0).getByRole("img", { name: "null value supplied by the World" })).toHaveCount(1); // its value, not its memo
    const booleans = rows.nth(1).locator(":scope > span");
    await expect(booleans.nth(1)).toHaveAttribute("data-value-kind", "boolean");
    expect(await exact(booleans.nth(1))).toBe("false");
    expect(await exact(booleans.nth(2))).toBe("true");
  });

  test("a legacy reader of the dash cannot be fooled: the literal dash is text, shown quoted", async ({ page, scalars }) => {
    await page.goto(scalars);
    await openRelation(page, "probe");
    const dash = rowOf(page, "probe", 13).locator(":scope > span").nth(1);
    expect(await exact(dash)).toBe('"—"'); // quoted: the bare dash is what the interface prints for missing metadata
    await expect(dash).toHaveAttribute("data-value-kind", "text");
    // And no cell prints the dash for NULL any more.
    const nulls = section(page, "probe extension").locator('[data-value-kind="null"]');
    for (let i = 0; i < (await nulls.count()); i++) expect(await exact(nulls.nth(i))).toBe("NULL");
  });
});

test.describe("chinook: nullable and numeric rows", () => {
  test.skip(!prepared(), "run examples/chinook/prepare.py --view-copy first");

  test("track_on_album:2 has a NULL composer; the numbers stay numbers; the layers agree", async ({ page, chinook }) => {
    await page.goto(chinook);
    // API: composer is null, milliseconds an integer, unit_price a real, stored as NUMERIC(10,2).
    const claim = await api(page, "/world/assertion?id=track_on_album:2");
    expect(claim.values.composer).toBeNull();
    expect(claim.values.milliseconds).toBe(342562);
    expect(claim.values.unit_price).toBe(0.99);
    const source = claim.grounding[0].detail;
    expect(source.scalar_storage).toEqual({ Composer: "null", Milliseconds: "integer", UnitPrice: "real" });
    const relation = (await api(page, "/world/schema")).relations.find((r: any) => r.name === "track_on_album");
    const role = (name: string) => relation.roles.find((r: any) => r.name === name);
    expect(role("unit_price")).toMatchObject({ declared_type: "NUMERIC(10,2)", type: "NUMERIC", type_basis: "sqlite_affinity" });
    expect(role("composer")).toMatchObject({ declared_type: "NVARCHAR(220)", type: "TEXT" });

    // UI table: the same row, NULL marked, numbers untouched.
    await openRelation(page, "track_on_album");
    const second = section(page, "track_on_album extension").locator(".table__row[data-loaded]").nth(1);
    const cells = second.locator(":scope > span");
    await expect(cells.nth(2)).toHaveAttribute("data-value-kind", "null");
    expect(await exact(cells.nth(2))).toBe("NULL");
    await expect(cells.nth(2).getByRole("img", { name: "null value supplied by the World" })).toHaveCount(1);
    expect(await exact(cells.nth(3))).toBe("342562");
    expect(await exact(cells.nth(4))).toBe("0.99");
    await expect(cells.nth(3)).toHaveAttribute("data-value-kind", "number");

    // UI reader: same, plus the storage class is one click away in the source metadata.
    await second.click();
    await expect(reader(page).locator("h2")).toHaveText("track_on_album");
    const composer = reader(page).locator(".world__roles li").filter({ has: page.locator("b", { hasText: /^composer$/ }) })
      .locator(":scope > span");
    await expect(composer).toHaveAttribute("data-value-kind", "null");
    expect(await exact(composer)).toBe("NULL");
    await reader(page).getByText("Source metadata").click();
    await expect(reader(page).locator(".world__source-metadata")).toContainText('"Composer": "null"');
    await expect(reader(page).locator(".world__source-metadata")).toContainText('"UnitPrice": "real"');
  });
});

test.describe("chinook: a row that is still loading", () => {
  test.skip(!prepared(), "run examples/chinook/prepare.py --view-copy first");

  test("an unloaded row is a blank placeholder, never a NULL", async ({ page, chinook }) => {
    // track_on_album has 3,503 rows; the table asks 200 at a time and draws the rest as blanks.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/world/rows?**", async (route) => {
      if (new URL(route.request().url()).searchParams.get("offset") !== "0") await held;
      await route.continue();
    });
    await page.goto(chinook);
    await openRelation(page, "track_on_album");
    const table = section(page, "track_on_album extension");
    await table.locator(".table__scroll").evaluate((node) => { node.scrollTop = 26 * 1200; });
    const placeholders = table.locator(".table__row:not([data-loaded])");
    await expect(placeholders.first()).toBeVisible();
    await expect(placeholders.locator("[data-value-kind]")).toHaveCount(0);
    await expect(placeholders.getByRole("img")).toHaveCount(0);
    expect(await exact(placeholders.first())).toBe("");
    release();
    await expect(table.locator(".table__row:not([data-loaded])")).toHaveCount(0);
    // Real rows now: values, and markers only where the file stores NULL (Composer, in this region).
    const loaded = table.locator(".table__row[data-loaded]");
    expect(await loaded.count()).toBeGreaterThan(10);
    const kinds = await loaded.first().locator(":scope > span").evaluateAll((cells) => cells.map((c) => c.getAttribute("data-value-kind")));
    expect(kinds.slice(0, 5).every((kind) => kind !== null)).toBe(true);
  });
});

test.describe("adapter compatibility defaults", () => {
  const headerOf = (page: Page) => page.locator(".product-shell__workspace");
  const readerMeta = (page: Page) => reader(page).locator(".world-reader__heading p[title]");

  test("a verified generic reading prints neither revision 1 nor BASE; the API still reports them", async ({ page, attribution }) => {
    await page.goto(attribution);
    const overview = await api(page, "/world/overview");
    const schema = await api(page, "/world/schema");
    // The API is unchanged.
    expect(overview.revision).toBe(1);
    expect(schema.relations.map((r: any) => r.mode)).toEqual(["BASE", "BASE", "BASE", "BASE"]);
    expect(overview.reading).toMatchObject({ adapter: "generic_sqlite_v1", interpretation_source: "external_reader_declaration" });
    const claim = await api(page, "/world/assertion?id=assignment:1");
    expect(claim).toMatchObject({ mode: "BASE", created_revision: 1, assertion_state: "UNKNOWN", relation_stale: false });
    expect(claim.warrant.bases).toEqual([]);

    // The interface: the World is named, not given a revision it never recorded.
    await expect(headerOf(page)).toHaveText(overview.world_id);
    await expect(headerOf(page)).toHaveAttribute("aria-label", `World ${overview.world_id}`);
    await expect(headerOf(page)).toHaveAttribute("title", /default, not one the database's producer recorded/);
    const dock = section(page, "world relations");
    await expect(dock.locator(".table__meta")).toHaveText("4 relations · 7 referents");
    await expect(dock.getByText(/^mode$/)).toHaveCount(0);
    await expect(dock).not.toContainText(/\bbase\b/);

    // The qualification that remains is the reader's: still there, still visible.
    await expect(page.locator(".world__reading-badge")).toHaveText("Reader-declared interpretation");
    await expect(page.locator(".world-reading > summary")).toHaveText("Reading attribution · reader-declared interpretation");

    // The explanation is where it always was, and says what is no longer printed and why.
    await page.locator(".world-reading > summary").click();
    await page.getByText("Adapter compatibility values").click();
    const explanation = page.locator(".world-reading details").filter({ hasText: "Adapter compatibility values" });
    await expect(explanation).toContainText("revision 1, BASE mode, created revision 1, stale false and assertion state UNKNOWN are adapter defaults");
    await expect(explanation).toContainText("do not say that the database's producer recorded a revision, declared BASE semantics or made an assessment");
    await expect(explanation).toContainText("prints neither revision 1 nor BASE mode");
    // The digest in the descriptor is the declaration's, shown unchanged.
    await expect(page.locator(".world-reading__body")).toContainText(overview.reading.declaration_digest);
  });

  test("a verified generic reading: relation reader, table bar and assertion reader omit them too", async ({ page, attribution }) => {
    await page.goto(attribution);
    await openRelation(page, "assignment");
    const bar = section(page, "assignment extension").locator(".table__meta");
    await expect(bar).toHaveText("3 tuples");
    await rowOf(page, "assignment", 1).click();
    await expect(reader(page).locator("h2")).toHaveText("assignment");
    await expect(readerMeta(page)).toHaveCount(0);
    await expect(reader(page).locator(".world-reader__qualifier")).toHaveText("Reader-declared interpretation");
  });

  test("a mechanical relation's reader chip is its declared origin, not the adapter's mode; dependencies omit the default", async ({ page, attribution }) => {
    // ledger declares no origin; give it a declared MECHANICAL one so the chip has something to say.
    await page.route("**/world/schema", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const ledger = body.relations.find((r: { name: string }) => r.name === "ledger");
      ledger.origins = ["MECHANICAL"];
      await route.fulfill({ response, json: body });
    });
    await page.goto(attribution);
    // Mechanical material is off by default in the vocabulary; ask for it, as a person would.
    const { world_id } = await api(page, "/world/overview");
    await page.evaluate((id) => localStorage.setItem(`worldir.show:${id}`, JSON.stringify({
      version: 1, world: id, namedAtRest: true, spreadOnSelect: false, framing: true,
      show: { semantic: true, adjudicated: true, derived: true, mechanical: true, unstated: true, unresolved: true },
    })), world_id);
    await page.reload();
    await expect.poll(() => page.evaluate(() =>
      (window as any).__worldVocabulary?.getNodeData().some((n: { id: string }) => n.id === "rel:ledger"))).toBe(true);
    await page.evaluate(() => (window as any).__worldVocabulary.emit("node:click", { target: { id: "rel:ledger" } }));
    await expect(reader(page).locator("h2")).toHaveText("ledger");
    await expect(reader(page).locator(".world-reader__heading .node-reader__kind")).toHaveText("mechanical");
    await expect(readerMeta(page)).toHaveText("105 tuples · 3 roles");
    // The dependencies view of a base relation: its own count, no default mode in front of it.
    await reader(page).getByRole("button", { name: "Dependencies" }).click();
    await expect(page.locator('section[aria-label="ledger derivation"] .table__meta')).toHaveText("105");
  });

  test("a classified generic reading: the relation chip names the declared origin, not the default mode", async ({ page, attribution }) => {
    await page.goto(attribution);
    const dock = section(page, "world relations");
    const row = dock.locator(".table__row").filter({ has: page.locator('[title="review_rejected"]') });
    // Construction is a reader declaration, printed as a column; mode is not.
    await expect(row).toContainText("mech");
    await expect(row).not.toContainText("base");
    await row.click();
    await expect(section(page, "review_rejected extension").locator(".table__meta")).toHaveText("1 tuple");
  });

  test("the same values in a World with no verified descriptor are printed as before", async ({ page, attribution }) => {
    // Same bytes and same API; only the descriptor is missing. The id prefix,
    // revision 1 and BASE are no evidence that the adapter wrote them.
    await page.route("**/world/overview", async (route) => {
      const response = await route.fetch();
      const { reading: _dropped, ...rest } = await response.json();
      await route.fulfill({ response, json: rest });
    });
    await page.goto(attribution);
    const overview = await api(page, "/world/overview");
    await expect(headerOf(page)).toHaveText(`${overview.world_id} · rev 1`);
    await expect(headerOf(page)).toHaveAttribute("title", "World identifier and current revision");
    await expect(headerOf(page)).toHaveAttribute("aria-label", `World ${overview.world_id}, revision 1`);
    const dock = section(page, "world relations");
    await expect(dock.locator(".table__meta")).toHaveText("4 relations · 7 referents · rev 1");
    await expect(dock.locator(".table__row").first()).toContainText("base");
    await openRelation(page, "assignment");
    await expect(section(page, "assignment extension").locator(".table__meta")).toHaveText("3 tuples · base");
    await rowOf(page, "assignment", 1).click();
    await expect(readerMeta(page)).toHaveText("base · revision 1");
    await expect(page.locator(".world__reading-badge")).toHaveCount(0);
    await expect(page.locator(".world-reading")).toHaveCount(0);
  });

  test("a descriptor that is not the generic bridge's does not qualify anything", async ({ page, attribution }) => {
    await page.route("**/world/overview", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.reading = { ...body.reading, adapter: "another_producer_v1" };
      await route.fulfill({ response, json: body });
    });
    await page.goto(attribution);
    const overview = await api(page, "/world/overview");
    await expect(headerOf(page)).toHaveText(`${overview.world_id} · rev 1`);
    await expect(page.locator(".world__reading-badge")).toHaveCount(0);
  });

  test("a verified reading still prints a revision or mode that is not the adapter's default", async ({ page, attribution }) => {
    await page.route("**/world/overview", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.revision = 7;
      await route.fulfill({ response, json: body });
    });
    await page.route("**/world/schema", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.relations[0].mode = "DERIVED";
      await route.fulfill({ response, json: body });
    });
    await page.goto(attribution);
    const overview = await api(page, "/world/overview");
    await expect(headerOf(page)).toHaveText(`${overview.world_id} · rev 7`);
    await expect(section(page, "world relations").locator(".table__meta")).toHaveText("4 relations · 7 referents · rev 7");
    // A mode that is not the default is printed (the column shortens it; the title has it whole).
    await expect(section(page, "world relations").locator('.table__row').first().locator('[title="derived"]')).toHaveCount(1);
  });
});

test.describe("producer-recorded status is displayed as recorded", () => {
  test("an assessed candidate with an empty authority list does not read as 'no authority'", async ({ page, attribution }) => {
    // Governed Worlds record assessments. An empty warrant-authority list is
    // an empty list, as the obligation reader already says ("not recorded").
    await page.route("**/world/assertion?**", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.candidate_for = ["ob-1", "ob-2"];
      body.candidate_assessments = [
        { obligation_id: "ob-1", commitment_id: body.assertion_id, status: "INSUFFICIENT", reason: "fixture reason",
          warrant_authorities: [], authority_basis: [] },
        { obligation_id: "ob-2", commitment_id: body.assertion_id, status: "SUFFICIENT", reason: "fixture reason",
          warrant_authorities: ["Fixture Evidence Authority"], authority_basis: [] },
      ];
      await route.fulfill({ response, json: body });
    });
    await page.goto(attribution);
    await openRelation(page, "assignment");
    await rowOf(page, "assignment", 1).click();
    const candidate = reader(page).locator("section").filter({ has: page.getByRole("heading", { name: "Candidate for" }) });
    await expect(candidate).toContainText("insufficient · authority not recorded");
    await expect(candidate).toContainText("sufficient · Fixture Evidence Authority");
    await expect(candidate).not.toContainText("no authority");
  });
});

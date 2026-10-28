/**
 * KI-007/KI-008: governed rows are individually reachable, and the
 * reader always belongs to the currently selected obligation.
 *
 * Governed obligations are a legacy/contract fixture here: the generic
 * SQLite adapter does not produce them, and no test below claims it
 * does. Detail responses are controlled deferred promises released by
 * the test — never sleeps.
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import type { Graph } from "@antv/g6";

type CanvasWindow = Window & { __worldVocabulary?: Graph };

type Gate = { promise: Promise<void>; release: () => void };
function makeGate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const ROLES = [
  { name: "subject", type: "REFERENT", column: "subject", referent: true, kinds: ["entity"] },
  { name: "note", type: "TEXT", column: "note", referent: false },
];

function summary(id: string, question: string) {
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
    candidates: [],
  };
}

function detail(id: string, question: string) {
  return {
    ...summary(id, question),
    candidates: [],
    adjudications: [],
    context: { contract: null, governance: null, evidence_authority: null, adjudication_authority: null },
  };
}

type WorldOptions = {
  count?: number;
  withDemand?: boolean;
  withResolved?: boolean;
  governed?: boolean;
};

type AssertionControl = { assertionGate: Gate | null; failAssertion: boolean };

async function mockWorld(
  page: Page,
  gates: Map<string, Gate>,
  failures: Set<string>,
  missing: Set<string>,
  options: WorldOptions = {},
  controls: AssertionControl = { assertionGate: null, failAssertion: false },
) {
  const count = options.count ?? 2;
  const obligations = Array.from({ length: count }, (_, i) =>
    summary(`ob-${i + 1}`, `Question ${i + 1}?`),
  );
  await page.route("**/world/overview", (route) =>
    route.fulfill({
      json: {
        world_id: "governed-fixture",
        revision: 1,
        relations: 1,
        referents: 2,
        assertions: 1,
        origins: { SEMANTIC: 1 },
        stale: [],
        incomplete: [],
        demand: options.withDemand
          ? { purpose: { statement: "Fixture purpose." }, obligations: 1, demanded: 1 }
          : null,
        governed_obligations: options.governed === false
          ? null
          : { count, resolved: 0, unresolved: count },
      },
    }),
  );
  await page.route("**/world/schema", (route) =>
    route.fulfill({
      json: {
        relations: [
          {
            name: "record", description: null, mode: "BASE", arity: 2, referent_arity: 1,
            roles: ROLES, count: 1, stale: false, origins: ["SEMANTIC"], scope: null, completeness: null,
          },
        ],
      },
    }),
  );
  await page.route("**/world/referents", (route) =>
    route.fulfill({
      json: { referents: [{ id: "entity:A", label: "Ark" }, { id: "entity:B", label: "Barge" }], total: 2, truncated: false },
    }),
  );
  await page.route("**/world/rows?**", (route) =>
    route.fulfill({
      json: {
        relation: "record", mode: "BASE", stale: false, total: 1, offset: 0, roles: ROLES,
        rows: [{ assertion_id: "record:1", origin: "SEMANTIC", origins: ["SEMANTIC"], values: { subject: "entity:A", note: "held" } }],
      },
    }),
  );
  await page.route("**/world/assertion?**", async (route) => {
    if (controls.assertionGate) await controls.assertionGate.promise;
    if (controls.failAssertion) {
      return route.fulfill({ status: 503, json: { error: "fixture assertion failure" } });
    }
    return route.fulfill({
      json: {
        assertion_id: "record:1", relation: "record", mode: "BASE", arity: 2, roles: ROLES,
        values: { subject: "entity:A", note: "held" }, origin: "SEMANTIC", origins: ["SEMANTIC"],
        assertion_state: "ASSERTED", created_revision: 1, relation_stale: false, completeness: null,
        grounding: [],
        warrant: { commitment_id: "record:1", relation: "record", assertion_origin: "SEMANTIC", recorded_construction_origin: "SEMANTIC", construction_origins: ["SEMANTIC"], created_revision: 1, bases: [] },
        commitment_id: "record:1", candidate_for: [], governing_obligations: [], candidate_assessments: [],
      },
    });
  });
  await page.route("**/world/labels?**", (route) =>
    route.fulfill({ json: { labels: { "entity:A": "Ark", "entity:B": "Barge" } } }),
  );
  await page.route("**/world/referent?**", (route) =>
    route.fulfill({ json: { id: "entity:A", label: "Ark", grounding: [], fields: [], relations: [] } }),
  );
  await page.route("**/world/obligations", (route) =>
    route.fulfill({ json: { contract: null, governance: null, obligations } }),
  );
  await page.route("**/world/obligation?**", async (route: Route) => {
    const id = new URL(route.request().url()).searchParams.get("obligation_id") ?? "";
    const gate = gates.get(id);
    if (gate) await gate.promise;
    if (failures.has(id)) {
      return route.fulfill({ status: 503, json: { error: `fixture failure for ${id}` } });
    }
    if (missing.has(id)) return route.fulfill({ json: null });
    const index = Number(id.split("-")[1]) - 1;
    return route.fulfill({ json: detail(id, `Question ${index + 1} (inspected)?`) });
  });
  await page.route("**/world/demand", (route) =>
    route.fulfill({
      json: {
        demand: options.withDemand
          ? {
              purpose: { statement: "Fixture purpose." },
              rule: null,
              demanded: 1,
              obligations: [
                {
                  relation: "record",
                  values: { subject: "entity:B", note: "missing" },
                  demanded_by: { name: "fixture", revision: 1 },
                  state: "UNRESOLVED",
                  assertion_id: null,
                  reason: "fixture frontier gap",
                },
                ...(options.withResolved
                  ? [{
                      relation: "record",
                      values: { subject: "entity:A", note: "held" },
                      demanded_by: { name: "fixture", revision: 1 },
                      state: "ASSERTED",
                      assertion_id: "record:1",
                      reason: "fixture answered",
                    }]
                  : []),
              ],
            }
          : null,
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

test("two governed rows occupy different rectangles and both accept ordinary clicks", async ({ page }) => {
  await mockWorld(page, new Map(), new Set(), new Set());
  await openGoverned(page);
  const first = await governedRows(page).nth(0).boundingBox();
  const second = await governedRows(page).nth(1).boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(Math.abs(first!.y - second!.y)).toBeGreaterThanOrEqual(first!.height - 1);
  await governedRows(page).nth(1).click();
  await expect(reader(page).locator("h2")).toHaveText("Question 2 (inspected)?");
  await governedRows(page).nth(0).click();
  await expect(reader(page).locator("h2")).toHaveText("Question 1 (inspected)?");
});

test("one hundred governed rows scroll and support pointer and keyboard selection", async ({ page }) => {
  await mockWorld(page, new Map(), new Set(), new Set(), { count: 100 });
  await openGoverned(page);
  await expect(governedRows(page)).toHaveCount(100);
  const boxes = await governedRows(page).evaluateAll((rows) =>
    rows.slice(0, 3).map((row) => {
      const rect = row.getBoundingClientRect();
      return { y: rect.y, height: rect.height };
    }),
  );
  expect(boxes[1].y).toBeGreaterThanOrEqual(boxes[0].y + boxes[0].height - 1);
  expect(boxes[2].y).toBeGreaterThanOrEqual(boxes[1].y + boxes[1].height - 1);
  await governedRows(page).nth(0).click();
  await expect(reader(page).locator("h2")).toHaveText("Question 1 (inspected)?");
  const middle = governedRows(page).nth(49);
  await middle.scrollIntoViewIfNeeded();
  await middle.click();
  await expect(reader(page).locator("h2")).toHaveText("Question 50 (inspected)?");
  const last = governedRows(page).nth(99);
  await last.scrollIntoViewIfNeeded();
  await last.click();
  await expect(reader(page).locator("h2")).toHaveText("Question 100 (inspected)?");
  const fifth = governedRows(page).nth(4);
  await fifth.scrollIntoViewIfNeeded();
  await fifth.focus();
  await page.keyboard.press("Enter");
  await expect(reader(page).locator("h2")).toHaveText("Question 5 (inspected)?");
  const sixth = governedRows(page).nth(5);
  await sixth.scrollIntoViewIfNeeded();
  await sixth.focus();
  await page.keyboard.press("Space");
  await expect(reader(page).locator("h2")).toHaveText("Question 6 (inspected)?");
});

test("search narrows the collection without overlap or stale selection", async ({ page }) => {
  await mockWorld(page, new Map(), new Set(), new Set(), { count: 12 });
  await openGoverned(page);
  await governedRows(page).nth(1).click();
  await expect(reader(page).locator("h2")).toHaveText("Question 2 (inspected)?");
  await page.getByLabel("Search governed obligations").fill("Question 11?");
  await expect(governedRows(page)).toHaveCount(1);
  await governedRows(page).nth(0).click();
  await expect(reader(page).locator("h2")).toHaveText("Question 11 (inspected)?");
  await page.getByLabel("Search governed obligations").fill("no such question");
  await expect(page.locator('section[aria-label="governed obligations"]')).toContainText("No obligations match this search.");
});

test("delayed A cannot replace immediate B, in success or failure", async ({ page }) => {
  const gates = new Map<string, Gate>([["ob-1", makeGate()]]);
  const failures = new Set<string>();
  await mockWorld(page, gates, failures, new Set());
  await openGoverned(page);
  await governedRows(page).nth(0).click();
  await governedRows(page).nth(1).click();
  await expect(reader(page).locator("h2")).toHaveText("Question 2 (inspected)?");
  gates.get("ob-1")!.release();
  // Give the released A response its chance to land; B must remain.
  await expect(reader(page).locator("h2")).toHaveText("Question 2 (inspected)?");
  await page.waitForLoadState("networkidle");
  await expect(reader(page).locator("h2")).toHaveText("Question 2 (inspected)?");

  // Same ordering, but A fails late: B must not inherit A's error.
  gates.set("ob-1", makeGate());
  failures.add("ob-1");
  await governedRows(page).nth(0).click();
  await governedRows(page).nth(1).click();
  await expect(reader(page).locator("h2")).toHaveText("Question 2 (inspected)?");
  gates.get("ob-1")!.release();
  await page.waitForLoadState("networkidle");
  await expect(reader(page).locator("h2")).toHaveText("Question 2 (inspected)?");
  await expect(reader(page)).not.toContainText("fixture failure");
  await expect(reader(page)).not.toContainText("Inspector could not respond");
});

test("A to B to A respects the newest request, and closing invalidates pending detail", async ({ page }) => {
  const gates = new Map<string, Gate>([["ob-1", makeGate()], ["ob-2", makeGate()]]);
  await mockWorld(page, gates, new Set(), new Set());
  await openGoverned(page);
  await governedRows(page).nth(0).click();
  await governedRows(page).nth(1).click();
  gates.set("ob-1", makeGate());
  await governedRows(page).nth(0).click();
  // Release in the worst order: stale B completes while the newest A
  // is still pending, and must not win; then the newest A lands.
  const staleB = page.waitForResponse((r) => r.url().includes("obligation_id=ob-2"));
  gates.get("ob-2")!.release();
  await staleB;
  await expect(reader(page).locator("h2")).toHaveText("Question 1?");
  const newestA = page.waitForResponse((r) => r.url().includes("obligation_id=ob-1"));
  gates.get("ob-1")!.release();
  await newestA;
  await expect(reader(page).locator("h2")).toHaveText("Question 1 (inspected)?");

  // Close while pending: releasing afterwards must not reopen the reader.
  gates.set("ob-2", makeGate());
  await governedRows(page).nth(1).click();
  await reader(page).locator(".panel__close").click();
  await expect(reader(page).locator("h2")).not.toHaveText("Question 2 (inspected)?");
  const released = page.waitForResponse((r) => r.url().includes("obligation_id=ob-2"));
  gates.get("ob-2")!.release();
  await released;
  await expect(page.locator(".node-reader .motion-swap__is h2")).not.toHaveText("Question 2 (inspected)?");
});

test("navigating to an ordinary assertion while governed detail is pending keeps the ordinary reader", async ({ page }) => {
  const gates = new Map<string, Gate>([["ob-1", makeGate()]]);
  await mockWorld(page, gates, new Set(), new Set());
  await openGoverned(page);
  await governedRows(page).nth(0).click();
  await page.getByRole("navigation", { name: "Table subject" }).getByRole("button", { name: "world", exact: true }).click();
  await page.locator(".table__row").filter({ has: page.locator('[title="record"]') }).click();
  await page.locator('section[aria-label="record extension"] .table__row[data-loaded]').first().click();
  await expect(reader(page).locator("h2")).toHaveText("record");
  gates.get("ob-1")!.release();
  await page.waitForLoadState("networkidle");
  await expect(reader(page).locator("h2")).toHaveText("record");
});

test("current-subject failure and missing detail still produce feedback", async ({ page }) => {
  const failures = new Set(["ob-1"]);
  const missing = new Set(["ob-2"]);
  await mockWorld(page, new Map(), failures, missing);
  await openGoverned(page);
  await governedRows(page).nth(0).click();
  await expect(reader(page)).toContainText("Inspector could not respond");
  await governedRows(page).nth(1).click();
  await expect(reader(page)).toContainText("This Obligation is not present in the sealed World.");
});

test("legacy Purpose frontier stays functional and distinct from governed obligations", async ({ page }) => {
  await mockWorld(page, new Map(), new Set(), new Set(), { withDemand: true });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Table subject" }).getByRole("button", { name: "purpose frontier", exact: true }).click();
  const frontier = page.locator('section[aria-label="unresolved frontier"]');
  await expect(frontier).toContainText("1 unresolved of 1 obligation");
  await frontier.locator(".table__row").first().click();
  await expect(reader(page)).toContainText("fixture frontier gap");
  await expect(reader(page)).not.toContainText("Question 1");
});

test("a world without governance stays neutral and navigable", async ({ page }) => {
  await mockWorld(page, new Map(), new Set(), new Set(), { governed: false, withDemand: false });
  await page.goto("/");
  await expect(page.locator(".table__row").filter({ has: page.locator('[title="record"]') })).toBeVisible();
  await expect(page.getByRole("button", { name: "obligations", exact: true })).toHaveCount(0);
});

async function selectSchemaRelation(page: Page) {
  await page.evaluate(() =>
    (window as unknown as CanvasWindow).__worldVocabulary!.emit("node:click", {
      target: { id: "rel:record" },
    }),
  );
  await expect(reader(page).locator("h2")).toHaveText("record");
}

test("schema-relation selection clears governed ownership (late success)", async ({ page }) => {
  const gates = new Map<string, Gate>([["ob-1", makeGate()]]);
  await mockWorld(page, gates, new Set(), new Set());
  await openGoverned(page);
  await governedRows(page).nth(0).click();
  await selectSchemaRelation(page);
  const released = page.waitForResponse((r) => r.url().includes("obligation_id=ob-1"));
  gates.get("ob-1")!.release();
  await released;
  await expect(reader(page).locator("h2")).toHaveText("record");
  await expect(reader(page)).not.toContainText("Question 1");
});

test("schema-relation selection clears governed ownership (late failure)", async ({ page }) => {
  const gates = new Map<string, Gate>([["ob-1", makeGate()]]);
  const failures = new Set(["ob-1"]);
  await mockWorld(page, gates, failures, new Set());
  await openGoverned(page);
  await governedRows(page).nth(0).click();
  await selectSchemaRelation(page);
  const released = page.waitForResponse((r) => r.url().includes("obligation_id=ob-1"));
  gates.get("ob-1")!.release();
  await released;
  await expect(reader(page).locator("h2")).toHaveText("record");
  await expect(reader(page)).not.toContainText("Inspector could not respond");
  await expect(page.locator(".world__notice")).toHaveCount(0);
});

async function openResolvedLegacy(page: Page) {
  await page.getByRole("navigation", { name: "Table subject" })
    .getByRole("button", { name: "purpose frontier", exact: true }).click();
  const frontier = page.locator('section[aria-label="unresolved frontier"]');
  await frontier.getByRole("button", { name: "show resolved" }).click();
  const row = frontier.locator(".table__row").filter({ hasText: "asserted" }).first();
  await row.click();
}

test("an obsolete legacy-demand failure never reaches the new subject", async ({ page }) => {
  const controls: AssertionControl = { assertionGate: makeGate(), failAssertion: true };
  await mockWorld(page, new Map(), new Set(), new Set(), { withDemand: true, withResolved: true }, controls);
  await page.goto("/");
  await openResolvedLegacy(page);
  // Navigate to another subject before the failure is released.
  await page.getByRole("button", { name: "obligations", exact: true }).first().click();
  await governedRows(page).nth(0).click();
  await expect(reader(page).locator("h2")).toHaveText("Question 1 (inspected)?");
  const released = page.waitForResponse((r) => r.url().includes("/world/assertion"));
  controls.assertionGate!.release();
  await released;
  // Let the released failure reach React before judging its absence.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(reader(page).locator("h2")).toHaveText("Question 1 (inspected)?");
  await expect(page.locator(".world__notice")).toHaveCount(0);
});

test("a current legacy-demand failure remains visible", async ({ page }) => {
  const controls: AssertionControl = { assertionGate: null, failAssertion: true };
  await mockWorld(page, new Map(), new Set(), new Set(), { withDemand: true, withResolved: true }, controls);
  await page.goto("/");
  await openResolvedLegacy(page);
  await expect(page.locator(".world__notice")).toContainText("could not respond");
});

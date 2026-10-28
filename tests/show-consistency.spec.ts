/**
 * KI-015: schema and occurrence SHOW visibility share one rule.
 *
 * The generic adapter cannot produce DERIVED-mode or mixed-origin
 * relations (it serves BASE relations with at most one declared origin),
 * so the DERIVED/mixed payloads below are a clearly identified
 * legacy/contract fixture served over mocked routes — not a capability
 * claim about the generic adapter. PR #13's real generic-adapter
 * behaviour remains covered by tests/unstated-origin.spec.ts.
 */
import { test, expect, type Page } from "@playwright/test";
import type { Graph } from "@antv/g6";

type CanvasWindow = Window & { __worldVocabulary?: Graph; __worldFieldGraph?: Graph };

const ROLES = [
  { name: "subject", type: "REFERENT", column: "subject", referent: true, kinds: ["entity"] },
  { name: "other", type: "REFERENT", column: "other", referent: true, kinds: ["entity"] },
  { name: "note", type: "TEXT", column: "note", referent: false },
];

const RELATIONS: Record<string, { mode: string; origins: string[] }> = {
  mixed_derived: { mode: "DERIVED", origins: ["SEMANTIC", "ADJUDICATED", "MECHANICAL"] },
  plain_derived: { mode: "DERIVED", origins: [] },
  base_mixed: { mode: "BASE", origins: ["SEMANTIC", "MECHANICAL"] },
};

const ROW_ORIGINS: Record<string, { origin: string; origins?: string[] }> = {
  mixed_derived: { origin: "SEMANTIC", origins: ["SEMANTIC", "ADJUDICATED", "MECHANICAL"] },
  plain_derived: { origin: "UNSTATED" },
  base_mixed: { origin: "SEMANTIC", origins: ["SEMANTIC", "MECHANICAL"] },
};

function assertion(id: string) {
  const relation = id.split(":")[0];
  const spec = RELATIONS[relation];
  const row = ROW_ORIGINS[relation];
  return {
    assertion_id: id,
    relation,
    mode: spec.mode,
    arity: 3,
    roles: ROLES,
    values: { subject: "entity:A", other: "entity:B", note: "held" },
    origin: row.origin,
    ...(row.origins ? { origins: row.origins } : {}),
    assertion_state: "ASSERTED",
    ...(relation === "mixed_derived" ? { occurrence_state: "PROPOSED" } : {}),
    created_revision: 1,
    relation_stale: false,
    completeness: null,
    grounding: [],
    warrant: {
      commitment_id: id,
      relation,
      assertion_origin: row.origin,
      recorded_construction_origin: row.origin,
      construction_origins: row.origins ?? [],
      created_revision: 1,
      bases: [],
    },
    commitment_id: id,
    candidate_for: [],
    governing_obligations: [],
    candidate_assessments: [],
  };
}

test.beforeEach(async ({ page }) => {
  await page.route("**/world/overview", (route) =>
    route.fulfill({
      json: {
        world_id: "legacy-show-fixture",
        revision: 1,
        relations: 3,
        referents: 2,
        assertions: 3,
        origins: { SEMANTIC: 2, ADJUDICATED: 1, MECHANICAL: 1 },
        stale: [],
        incomplete: [],
        demand: null,
        governed_obligations: null,
      },
    }),
  );
  await page.route("**/world/schema", (route) =>
    route.fulfill({
      json: {
        relations: Object.entries(RELATIONS).map(([name, spec]) => ({
          name,
          description: null,
          mode: spec.mode,
          arity: 3,
          referent_arity: 2,
          roles: ROLES,
          count: 1,
          stale: false,
          origins: spec.origins,
          scope: null,
          completeness: null,
        })),
      },
    }),
  );
  await page.route("**/world/referents", (route) =>
    route.fulfill({
      json: {
        referents: [
          { id: "entity:A", label: "Ark" },
          { id: "entity:B", label: "Barge" },
        ],
        total: 2,
        truncated: false,
      },
    }),
  );
  await page.route("**/world/rows?**", (route) => {
    const relation = new URL(route.request().url()).searchParams.get("relation") ?? "";
    const spec = RELATIONS[relation];
    const row = ROW_ORIGINS[relation];
    return route.fulfill({
      json: {
        relation,
        mode: spec.mode,
        stale: false,
        total: 1,
        offset: 0,
        roles: ROLES,
        rows: [
          {
            assertion_id: `${relation}:1`,
            origin: row.origin,
            ...(row.origins ? { origins: row.origins } : {}),
            values: { subject: "entity:A", other: "entity:B", note: "held" },
          },
        ],
      },
    });
  });
  await page.route("**/world/assertion?**", (route) => {
    const id = new URL(route.request().url()).searchParams.get("id") ?? "";
    return route.fulfill({ json: assertion(id) });
  });
  await page.route("**/world/labels?**", (route) =>
    route.fulfill({ json: { labels: { "entity:A": "Ark", "entity:B": "Barge" } } }),
  );
  await page.route("**/world/referent?**", (route) =>
    route.fulfill({
      json: { id: "entity:A", label: "Ark", grounding: [], fields: [], relations: [] },
    }),
  );
  await page.route("**/world/demand", (route) => route.fulfill({ json: { demand: null } }));
  await page.goto("/");
});

const reader = (page: Page) => page.locator(".node-reader .motion-swap__is");
const ids = (page: Page, room: "schema" | "field") =>
  page.evaluate((room) => {
    const graph = (window as unknown as CanvasWindow)[
      room === "schema" ? "__worldVocabulary" : "__worldFieldGraph"
    ];
    return [...(graph?.getNodeData() ?? []), ...(graph?.getEdgeData() ?? [])].map((item) =>
      String(item.id),
    );
  }, room);

async function toggle(page: Page, layer: string, on: boolean) {
  const button = page.locator(`.world-show__filter[data-layer="${layer}"]`);
  if ((await button.getAttribute("aria-pressed")) === String(on)) return;
  await page.locator(".world-filter__summary").hover();
  await expect(button).toBeVisible();
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", String(on));
}

async function place(page: Page, relation: string) {
  await page
    .getByRole("navigation", { name: "Table subject" })
    .getByRole("button", { name: "world", exact: true })
    .click();
  await page
    .locator(".table__row")
    .filter({ has: page.locator(`[title="${relation}"]`) })
    .click();
  await page
    .locator(`section[aria-label="${relation} extension"] .table__row[data-loaded]`)
    .first()
    .click();
  await expect(reader(page).locator("h2")).toHaveText(relation);
  await expect.poll(() => ids(page, "field")).toContain(`bond:${relation}:1`);
}

test("a mixed-origin DERIVED relation stays in the schema while any occurrence category is enabled", async ({
  page,
}) => {
  for (const name of ["mixed_derived", "plain_derived", "base_mixed"]) {
    await expect.poll(() => ids(page, "schema")).toContain(`rel:${name}`);
  }
  // Turning derived off alone: authored categories keep the mixed relation
  // (and the empty-origin DERIVED relation, which follows mode, goes).
  await toggle(page, "derived", false);
  await expect.poll(() => ids(page, "schema")).toContain("rel:mixed_derived");
  await expect.poll(() => ids(page, "schema")).not.toContain("rel:plain_derived");
  await expect.poll(() => ids(page, "schema")).toContain("rel:base_mixed");
  // With every category the mixed relation occupies turned off, it goes.
  await toggle(page, "semantic", false);
  await toggle(page, "adjudicated", false);
  await expect.poll(() => ids(page, "schema")).not.toContain("rel:mixed_derived");
  await toggle(page, "derived", true);
  await toggle(page, "semantic", true);
  await toggle(page, "adjudicated", true);
  await expect.poll(() => ids(page, "schema")).toContain("rel:mixed_derived");
  await expect.poll(() => ids(page, "schema")).toContain("rel:plain_derived");
});

test("schema and field agree when placing and filtering mixed and empty-origin DERIVED rows", async ({
  page,
}) => {
  await place(page, "mixed_derived");
  // Construction origin and occurrence stance stay separate dimensions:
  // semantic construction, proposal stance, neither reclassified.
  await expect(
    reader(page).locator(".node-reader__kind:not([data-occurrence-state])"),
  ).toHaveText("semantic + adjudicated + mechanical");
  await expect(reader(page).locator("[data-occurrence-state]")).toHaveText("proposal");
  await toggle(page, "derived", false);
  await expect.poll(() => ids(page, "field")).toContain("bond:mixed_derived:1");
  await toggle(page, "semantic", false);
  await toggle(page, "adjudicated", false);
  // The MECHANICAL support path classifies to derived under DERIVED mode,
  // so the tuple follows that layer back on together with the schema.
  await toggle(page, "derived", true);
  await expect.poll(() => ids(page, "field")).toContain("bond:mixed_derived:1");
  await expect.poll(() => ids(page, "schema")).toContain("rel:mixed_derived");
  await toggle(page, "derived", false);
  await expect.poll(() => ids(page, "field")).not.toContain("bond:mixed_derived:1");
  await expect.poll(() => ids(page, "schema")).not.toContain("rel:mixed_derived");
  await toggle(page, "semantic", true);
  await toggle(page, "adjudicated", true);
  await toggle(page, "derived", true);

  // An empty origins array is no longer silently invisible: the tuple and
  // its schema relation follow the derived layer together.
  await place(page, "plain_derived");
  await toggle(page, "derived", false);
  await expect.poll(() => ids(page, "field")).not.toContain("bond:plain_derived:1");
  await expect.poll(() => ids(page, "schema")).not.toContain("rel:plain_derived");
  await toggle(page, "derived", true);
  await expect.poll(() => ids(page, "field")).toContain("bond:plain_derived:1");
  await expect.poll(() => ids(page, "schema")).toContain("rel:plain_derived");
});

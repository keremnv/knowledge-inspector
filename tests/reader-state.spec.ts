/**
 * The reader shows a tuple's recorded state as its own dimension, read from
 * occurrence_state exclusively. Every fixture below carries the legacy
 * assertion_state "ASSERTED" — the value legacy producers assign from
 * stored origins — so any chip the reader shows must come from the
 * occurrence field alone. Pairs are deliberately crossed: a SEMANTIC
 * proposal must still read as a proposal, and a legacy ASSERTED tuple
 * without occurrence state must never read as adopted.
 */
import { test, expect, type Page } from "@playwright/test";

const ROLES = [
  { name: "subject", type: "REFERENT", column: "subject", referent: true, kinds: ["entity"] },
  { name: "note", type: "TEXT", column: "note", referent: false },
];

const STANCES: Record<string, { origin: string; occurrence?: string }> = {
  "probe:adopted": { origin: "SEMANTIC", occurrence: "ADOPTED" },
  "probe:proposal": { origin: "SEMANTIC", occurrence: "PROPOSED" },
  "probe:rejection": { origin: "REJECTED", occurrence: "REJECTED" },
  "probe:recorded": { origin: "SEMANTIC", occurrence: "RECORDED" },
  "probe:legacy": { origin: "SEMANTIC" },
  "probe:odd": { origin: "SEMANTIC", occurrence: "FROBNICATED" },
};

const NOTES: Record<string, string> = {
  "probe:adopted": "held",
  "probe:proposal": "offered",
  "probe:rejection": "refused",
  "probe:recorded": "observed",
  "probe:legacy": "old",
  "probe:odd": "strange",
};

function assertion(id: string) {
  const { origin, occurrence } = STANCES[id];
  return {
    assertion_id: id,
    relation: "record",
    mode: "BASE",
    arity: 2,
    roles: ROLES,
    values: { subject: "entity:A", note: NOTES[id] },
    origin,
    origins: [origin],
    // Legacy value on every tuple, including proposals: the chip must
    // never read this field.
    assertion_state: "ASSERTED",
    ...(occurrence === undefined ? {} : { occurrence_state: occurrence }),
    created_revision: 1,
    relation_stale: false,
    completeness: null,
    grounding: [],
    warrant: {
      commitment_id: id,
      relation: "record",
      assertion_origin: origin,
      recorded_construction_origin: origin,
      construction_origins: [origin],
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
  await page.route("**/world/overview", async (route) =>
    route.fulfill({
      json: {
        world_id: "state-probe",
        revision: 1,
        relations: 1,
        referents: 2,
        assertions: 6,
        origins: { SEMANTIC: 5, REJECTED: 1 },
        stale: [],
        incomplete: [],
        demand: {
          purpose: { statement: "Probe the unresolved channel." },
          obligations: 1,
          demanded: 1,
        },
        governed_obligations: { count: 0, resolved: 0, unresolved: 0 },
      },
    }),
  );
  await page.route("**/world/schema", async (route) =>
    route.fulfill({
      json: {
        relations: [
          {
            name: "record",
            description: "Probe relation.",
            mode: "BASE",
            arity: 2,
            referent_arity: 1,
            roles: ROLES,
            count: 6,
            stale: false,
            origins: ["SEMANTIC", "REJECTED"],
            scope: null,
            completeness: null,
          },
        ],
      },
    }),
  );
  await page.route("**/world/referents", async (route) =>
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
  await page.route("**/world/rows?**", async (route) =>
    route.fulfill({
      json: {
        relation: "record",
        mode: "BASE",
        stale: false,
        total: 6,
        offset: 0,
        roles: ROLES,
        rows: Object.keys(STANCES).map((id) => ({
          assertion_id: id,
          origin: STANCES[id].origin,
          origins: [STANCES[id].origin],
          values: { subject: "entity:A", note: NOTES[id] },
        })),
      },
    }),
  );
  await page.route("**/world/assertion?**", async (route) => {
    const id = new URL(route.request().url()).searchParams.get("id") ?? "";
    return route.fulfill({ json: assertion(id) });
  });
  await page.route("**/world/labels?**", async (route) =>
    route.fulfill({ json: { labels: { "entity:A": "Ark", "entity:B": "Barge" } } }),
  );
  await page.route("**/world/referent?**", async (route) =>
    route.fulfill({
      json: { id: "entity:A", label: "Ark", grounding: [], fields: [], relations: [] },
    }),
  );
  await page.route("**/world/demand", async (route) =>
    route.fulfill({
      json: {
        demand: {
          purpose: { statement: "Probe the unresolved channel." },
          rule: null,
          demanded: 1,
          obligations: [
            {
              relation: "record",
              values: { subject: "entity:B", note: "missing" },
              demanded_by: { name: "probe", revision: 1 },
              state: "UNRESOLVED",
              assertion_id: null,
              reason: "probe gap: no tuple covers entity B",
            },
          ],
        },
      },
    }),
  );
  await page.goto("/");
});

/**
 * The table being read: the incoming half of the Tables swap, by its own name.
 * The world catalogue it replaced stays mounted, inert, while it withdraws.
 */
const activeTable = (page: Page, name: string) =>
  page.locator(`.motion-swap__is section[aria-label="${name}"]`);
const reader = (page: Page) => page.locator(".node-reader .motion-swap__is");
const originChip = (page: Page) =>
  reader(page).locator(".node-reader__kind:not([data-occurrence-state])");
const stanceChip = (page: Page) => reader(page).locator("[data-occurrence-state]");

/**
 * Open one fixture tuple by its own values, and confirm the reader holds it.
 *
 * A row is found by its note rather than its position, and the reader must
 * show that note under its role before any chip is read — so a chip can only
 * ever be compared against the tuple it belongs to.
 */
async function openRecord(page: Page, id: keyof typeof STANCES) {
  await activeTable(page, "world relations")
    .locator(".table__row")
    .filter({ has: page.locator('[title="record"]') })
    .click();
  await activeTable(page, "record extension")
    .locator(".table__row[data-loaded]")
    .filter({ has: page.getByText(NOTES[id], { exact: true }) })
    .click();
  await expect(reader(page).locator("h2")).toHaveText("record");
  await expect(
    reader(page).locator(".world__roles li").filter({ has: page.locator("b", { hasText: /^note$/ }) }).locator("span"),
  ).toHaveText(NOTES[id]);
}

test("an explicit ADOPTED occurrence reads as adopted", async ({ page }) => {
  await openRecord(page, "probe:adopted");
  await expect(originChip(page)).toHaveText("semantic");
  await expect(stanceChip(page)).toHaveText("adopted");
  await expect(stanceChip(page)).toHaveAttribute("data-occurrence-state", "ADOPTED");
});

test("a proposal is never described as adopted, whatever its origin", async ({
  page,
}) => {
  await openRecord(page, "probe:proposal");
  // Crossed on purpose: SEMANTIC construction, PROPOSED stance.
  await expect(originChip(page)).toHaveText("semantic");
  await expect(stanceChip(page)).toHaveText("proposal");
  await expect(stanceChip(page)).toHaveAttribute("data-occurrence-state", "PROPOSED");
  await expect(reader(page)).not.toContainText("adopted", { ignoreCase: true });
  await expect(reader(page)).not.toContainText(/commitment|warrant/i);
});

test("a rejection stays a recorded negative decision", async ({ page }) => {
  await openRecord(page, "probe:rejection");
  await expect(originChip(page)).toHaveText("rejected");
  await expect(stanceChip(page)).toHaveText("rejection");
  await expect(stanceChip(page)).toHaveAttribute("data-occurrence-state", "REJECTED");
  await expect(reader(page)).not.toContainText("adopted", { ignoreCase: true });
});

test("a recorded occurrence implies no conceptual commitment", async ({ page }) => {
  await openRecord(page, "probe:recorded");
  await expect(originChip(page)).toHaveText("semantic");
  await expect(stanceChip(page)).toHaveText("recorded");
  await expect(stanceChip(page)).toHaveAttribute("data-occurrence-state", "RECORDED");
  await expect(reader(page)).not.toContainText("adopted", { ignoreCase: true });
});

test("a legacy ASSERTED tuple without occurrence state shows no chip", async ({
  page,
}) => {
  await openRecord(page, "probe:legacy");
  await expect(originChip(page)).toHaveText("semantic");
  await expect(stanceChip(page)).toHaveCount(0);
  await expect(reader(page)).not.toContainText("adopted", { ignoreCase: true });
});

test("unknown states render raw, never invented", async ({ page }) => {
  await openRecord(page, "probe:odd");
  await expect(stanceChip(page)).toHaveText("frobnicated");
  await expect(stanceChip(page)).toHaveAttribute("data-occurrence-state", "FROBNICATED");
});

test("unresolved interpretations stay on the demand frontier", async ({ page }) => {
  await page
    .getByRole("navigation", { name: "Table subject" })
    .getByRole("button", { name: "purpose frontier" })
    .click();
  const frontier = page.locator('section[aria-label="unresolved frontier"]');
  await expect(frontier).toContainText("1 unresolved of 1 obligation");
  await frontier.locator(".table__row").first().click();
  await expect(reader(page)).toContainText("probe gap: no tuple covers entity B");
  await expect(reader(page)).toContainText("unresolved");
});

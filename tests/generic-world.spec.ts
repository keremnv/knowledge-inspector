/**
 * Live generic World: real generic adapter, real frozen knowledge.sqlite,
 * real graph explorer. No route mocking. Run only with KI_LIVE_GENERIC=1,
 * KI_KNOWLEDGE_SQLITE naming the frozen file, and the generic adapter
 * serving it with the knowledge-flow declaration on the Vite /world proxy
 * target:
 *
 *   python3 adapters/world/server.py \
 *     --db "$KI_KNOWLEDGE_SQLITE" \
 *     --declaration examples/knowledge-flow/declaration.json --port 8181
 *   KI_LIVE_GENERIC=1 KI_KNOWLEDGE_SQLITE="$KI_KNOWLEDGE_SQLITE" \
 *     VITE_WORLD_TARGET=http://127.0.0.1:8181 \
 *     npx playwright test tests/generic-world.spec.ts
 *
 * The coexistence test additionally needs the structural adapter on the
 * same frozen file and KI_LIVE_GENERIC_SQLITE=1:
 *
 *   python3 adapters/sqlite/server.py --db "$KI_KNOWLEDGE_SQLITE" --port 8182
 *   ... VITE_SQLITE_TARGET=http://127.0.0.1:8182 KI_LIVE_GENERIC_SQLITE=1 ...
 */
import { test, expect, type Page } from "@playwright/test";

const FROZEN_SHA12 = "a5a64ac74fda";
// Canonical declaration digest (first 12 hex) of
// examples/knowledge-flow/declaration.json; the file half stays the frozen
// fingerprint, so the World identity names both halves independently.
const DECLARATION_SHA12 = "d8a605942f43";
const WORLD_ID = `knowledge:${FROZEN_SHA12}+${DECLARATION_SHA12}`;

test.beforeEach(({ page }) => {
  test.skip(
    process.env.KI_LIVE_GENERIC !== "1" || !process.env.KI_KNOWLEDGE_SQLITE,
    "requires the generic adapter on the frozen knowledge.sqlite",
  );
  return page.goto("/");
});

const rows = (page: Page) => page.locator(".table__row[data-loaded]");
const reader = (page: Page) => page.locator(".node-reader .motion-swap__is");
const subjectNav = (page: Page) => page.getByRole("navigation", { name: "Table subject" });
const originChip = (page: Page) =>
  reader(page).locator(".node-reader__kind:not([data-occurrence-state])");
const stanceChip = (page: Page) => reader(page).locator("[data-occurrence-state]");

async function openTable(page: Page, name: string) {
  await subjectNav(page).getByRole("button", { name: "world" }).click();
  await page.locator(".table__row").filter({ has: page.locator(`[title="${name}"]`) }).click();
  await expect(rows(page).first()).toBeVisible();
}

test("the frozen file serves one declared relation in place", async ({ page }) => {
  // A declaration-driven reading: revision 1 is the adapter's default, not printed.
  await expect(page.locator(".product-shell__workspace")).toHaveText(WORLD_ID);
  await expect(
    page.locator(".table__row").filter({ has: page.locator('[title="flow_step"]') }),
  ).toBeVisible();
  // Nothing else was declared: no expedition relations leak in.
  await expect(page.locator(".table__row").filter({ hasText: "determination" })).toHaveCount(0);
  await expect(subjectNav(page).getByRole("button", { name: "purpose frontier" })).toHaveCount(0);
});

test("a flow step travels from table to reader to its flow", async ({ page }) => {
  await openTable(page, "flow_step");
  await expect(rows(page)).toHaveCount(19);
  await rows(page).first().click();
  await expect(reader(page).locator("h2")).toHaveText("flow_step");
  await expect(originChip(page)).toHaveText("unstated");
  await expect(stanceChip(page)).toHaveCount(0);
  await expect(reader(page)).toContainText("row flow_id=F1, seq=1 in flow_hop");
  for (const role of ["flow", "seq", "participant", "action"]) {
    await expect(
      reader(page).locator(".world__roles").getByText(role, { exact: true }),
    ).toBeVisible();
  }
  await reader(page).locator(".world__roles").getByRole("button", { name: "structural browse" }).click();
  await expect(reader(page).locator("h2")).toHaveText("structural browse");
  // The flow's own panel: its five flow_step tuples as expandable context.
  await expect(reader(page)).toContainText("expand through");
  await expect(reader(page)).toContainText("flow_step");
});

test("generic responses claim no stance, origin, or herbarium demand", async ({ page }) => {
  const overview = await page.evaluate(() =>
    fetch("/world/overview").then((response) => response.json()),
  );
  expect(overview.world_id).toBe(WORLD_ID);
  expect(overview.relations).toBe(1);
  expect(overview.referents).toBe(5);
  expect(overview.assertions).toBe(19);
  expect(overview.origins).toEqual({});
  expect(overview.demand).toBeNull();
  expect(JSON.stringify(overview)).not.toContain("determination");
  const demand = await page.evaluate(() =>
    fetch("/world/demand").then((response) => response.json()),
  );
  expect(demand).toEqual({ demand: null });
  const one = await page.evaluate(() =>
    fetch("/world/assertion?id=flow_step:F1/1").then((response) => response.json()),
  );
  expect(one.origin).toBe("UNSTATED");
  expect(one).not.toHaveProperty("origins");
  expect(one).not.toHaveProperty("occurrence_state");
  expect(one.assertion_state).toBe("UNKNOWN");
});

test("the world carries no herbarium purpose text", async ({ page }) => {
  await openTable(page, "flow_step");
  await rows(page).first().click();
  await expect(reader(page).locator("h2")).toHaveText("flow_step");
  for (const text of [
    "determination records as adopted",
    "matches no known taxon alias",
    "expedition-interpretation",
  ]) {
    await expect(page.locator("body")).not.toContainText(text);
  }
});

test("structural and conceptual planes read the same frozen file", async ({ page }) => {
  test.skip(
    process.env.KI_LIVE_GENERIC_SQLITE !== "1",
    "requires the structural adapter on the same frozen file",
  );
  await page.goto("/sqlite");
  await expect(page.getByText("knowledge.sqlite")).toBeVisible();
  await expect(page.getByText(FROZEN_SHA12, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: /flow_hop/ }).click();
  await expect(page.getByRole("cell", { name: "F1" }).first()).toBeVisible();
  await page.goto("/");
  await expect(
    page.locator(".table__row").filter({ has: page.locator('[title="flow_step"]') }),
  ).toBeVisible();
});

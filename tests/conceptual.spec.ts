/**
 * Live conceptual navigation: real World adapter, real expedition database,
 * real graph explorer. No route mocking. Run only with KI_LIVE_CONCEPTUAL=1
 * and the adapter serving a seeded expedition database on the Vite /world
 * proxy target:
 *
 *   python3 examples/expedition/seed.py /tmp/expedition-live.sqlite
 *   python3 examples/expedition/server.py --db /tmp/expedition-live.sqlite --port 8139
 *   KI_LIVE_CONCEPTUAL=1 npx playwright test tests/conceptual.spec.ts
 */
import { test, expect, type Page } from "@playwright/test";
import type { Graph } from "@antv/g6";

type CanvasWindow = Window & {
  __worldFieldGraph: Graph;
};

test.beforeEach(({ page }) => {
  test.skip(
    process.env.KI_LIVE_CONCEPTUAL !== "1",
    "requires the expedition adapter and database on :8139",
  );
  return page.goto("/");
});

const rows = (page: Page) => page.locator(".table__row[data-loaded]");
const reader = (page: Page) => page.locator(".node-reader .motion-swap__is");
const subjectNav = (page: Page) => page.getByRole("navigation", { name: "Table subject" });
const originChip = (page: Page) =>
  reader(page).locator(".node-reader__kind:not([data-occurrence-state])");
const stanceChip = (page: Page) => reader(page).locator("[data-occurrence-state]");
const fieldIds = (page: Page) =>
  page.evaluate(() => {
    const graph = (window as unknown as Partial<CanvasWindow>).__worldFieldGraph;
    return graph ? graph.getNodeData().map((node) => String(node.id)) : [];
  });

async function openTable(page: Page, name: string) {
  await subjectNav(page).getByRole("button", { name: "world" }).click();
  await page.locator(".table__row").filter({ has: page.locator(`[title="${name}"]`) }).click();
  await expect(rows(page).first()).toBeVisible();
}

/** Table row to field: open the adopted determination, land on specimen K-118. */
async function enterField(page: Page) {
  await openTable(page, "determination");
  await rows(page).first().click();
  await reader(page).locator(".world__roles").getByRole("button", { name: "K-118" }).click();
  await expect(reader(page).locator("h2")).toHaveText("K-118");
  await expect.poll(() => fieldIds(page), { timeout: 10000 }).toContain("specimen:K-118");
}

test("the expedition world loads its four declared relations", async ({ page }) => {
  for (const name of [
    "determination",
    "determination_proposed",
    "determination_rejected",
    "collection",
  ]) {
    await expect(
      page.locator(".table__row").filter({ has: page.locator(`[title="${name}"]`) }),
    ).toBeVisible();
  }
});

test("a three-participant tuple travels from table to field and back", async ({
  page,
}) => {
  await openTable(page, "determination");
  await rows(page).first().click();
  await expect(reader(page).locator("h2")).toHaveText("determination");
  await expect(originChip(page)).toHaveText("semantic");
  await expect(stanceChip(page)).toHaveText("adopted");
  await expect(stanceChip(page)).toHaveAttribute("data-occurrence-state", "ADOPTED");
  for (const role of ["specimen", "taxon", "determiner"]) {
    await expect(
      reader(page).locator(".world__roles").getByText(role, { exact: true }),
    ).toBeVisible();
  }
  // Selecting the row placed its tuple on the field; follow a role there.
  await reader(page).locator(".world__roles").getByRole("button", { name: "K-118" }).click();
  await expect(reader(page).locator("h2")).toHaveText("K-118");
  await expect.poll(() => fieldIds(page), { timeout: 10000 }).toContain("determination:1");
  // And the field leads back: an occurrence's button returns to its tuple's table.
  // Its scalar is the occurrence's own, listed under it, not K-118's property.
  await expect(
    reader(page).locator('.world-occurrence[data-assertion-id="determination:1"]'),
  ).toContainText("floral morphology");
  await reader(page).getByRole("button", { name: "Open occurrence determination:1" }).click();
  await expect(reader(page).locator("h2")).toHaveText("determination");
  await reader(page).getByRole("button", { name: "Open extension" }).click();
  await expect(rows(page).first()).toBeVisible();
});

test("a field referent expands through the interpretation", async ({ page }) => {
  await enterField(page);
  await reader(page).locator(".gm__list button").filter({ hasText: "collection" }).click();
  await expect.poll(() => fieldIds(page), { timeout: 10000 }).toContain("collection:K-118");
  await expect.poll(() => fieldIds(page), { timeout: 10000 }).toContain("site:S-1");
});

test("proposals and gaps stay visibly unresolved, never adopted", async ({ page }) => {
  await subjectNav(page).getByRole("button", { name: "purpose frontier" }).click();
  const frontier = page.locator('section[aria-label="unresolved frontier"]');
  await expect(frontier).toContainText("1 unresolved of 1 obligation");
  await frontier.locator(".table__row").first().click();
  await expect(reader(page)).toContainText("matches no known taxon alias");
  await openTable(page, "determination_proposed");
  await rows(page).first().click();
  // Construction origin is SEMANTIC for every expedition relation; stance
  // travels only via occurrence_state (read by the occurrence chip below),
  // so the origin chip no longer mirrors proposal/rejection status.
  await expect(originChip(page)).toHaveText("semantic");
  await expect(stanceChip(page)).toHaveText("proposal");
  await expect(stanceChip(page)).toHaveAttribute("data-occurrence-state", "PROPOSED");
  await expect(reader(page).locator("h2")).toHaveText("determination_proposed");
  await openTable(page, "determination_rejected");
  await rows(page).first().click();
  await expect(originChip(page)).toHaveText("semantic");
  await expect(stanceChip(page)).toHaveText("rejection");
  await expect(stanceChip(page)).toHaveAttribute("data-occurrence-state", "REJECTED");
  await expect(reader(page).locator("h2")).toHaveText("determination_rejected");
});

test("live collection records imply no conceptual commitment", async ({ page }) => {
  await openTable(page, "collection");
  await rows(page).first().click();
  await expect(reader(page).locator("h2")).toHaveText("collection");
  await expect(originChip(page)).toHaveText("semantic");
  await expect(stanceChip(page)).toHaveText("recorded");
  await expect(stanceChip(page)).toHaveAttribute("data-occurrence-state", "RECORDED");
  await expect(reader(page)).not.toContainText("adopted", { ignoreCase: true });
});

test("find reaches the alias-resolved taxon on the field", async ({ page }) => {
  // T-042's disc is on the field only because the alias map resolved det 1's
  // "S. globulifera" spelling; find (a field question once fielded) reaches it.
  await enterField(page);
  await page.getByPlaceholder("find...").fill("Symphonia");
  await page.getByRole("option", { name: /Symphonia globulifera/ }).click();
  await expect(reader(page).locator("h2")).toHaveText("Symphonia globulifera");
});

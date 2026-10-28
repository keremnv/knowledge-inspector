/** KI-013/KI-014 browser presentation: generated columns and implicit
 * FK targets, with backend truth covered by adapters' pytest suites. */
import { test, expect } from "@playwright/test";

const col = (name: string, type: string, pk = 0, generated: "VIRTUAL" | "STORED" | null = null) => ({
  name, type, notnull: 0, pk, generated,
});

const schema = {
  file: "structure.sqlite",
  file_sha256: "0".repeat(64),
  tables: [
    {
      name: "parent2",
      columns: [col("id", "INTEGER", 1), col("name", "TEXT")],
      pk: ["id"], fks: [], rows: 1,
    },
    {
      name: "parent",
      columns: [col("a", "TEXT", 1), col("b", "TEXT", 2), col("code", "TEXT")],
      pk: ["a", "b"], fks: [], rows: 0,
    },
    {
      name: "measure",
      columns: [
        col("id", "INTEGER", 1), col("qty", "REAL"), col("doubled", "REAL", 0, "VIRTUAL"),
        col("label", "TEXT", 0, "STORED"), col("big", "REAL", 0, "VIRTUAL"),
      ],
      pk: ["id"], fks: [], rows: 2,
    },
    {
      name: "child_single",
      columns: [col("id", "INTEGER", 1), col("parent_id", "INTEGER")],
      pk: ["id"],
      fks: [[{ id: 0, seq: 0, table: "parent2", from: "parent_id", to: null, resolved_to: "id" }]],
      rows: 0,
    },
    {
      name: "child_mismatch",
      columns: [col("id", "INTEGER", 1), col("ref", "TEXT")],
      pk: ["id"],
      fks: [[{ id: 0, seq: 0, table: "parent", from: "ref", to: null, resolved_to: null }]],
      rows: 0,
    },
  ],
  views: [],
};

test.beforeEach(async ({ page }) => {
  await page.route("**/sqlite/schema", (route) => route.fulfill({ json: schema }));
  await page.route("**/sqlite/rows?**", (route) => {
    const table = new URL(route.request().url()).searchParams.get("table");
    const base = { name: table, total: 0, offset: 0, navigable: true, ordering_guarantee: "declared key", rows: [] as Record<string, unknown>[] };
    if (table === "measure") {
      return route.fulfill({
        json: {
          ...base, total: 2, columns: ["id", "qty", "doubled", "label", "big"],
          rows: [
            { id: 1, qty: 3, doubled: 6, label: "item-1", big: null },
            { id: 2, qty: 20, doubled: 40, label: "item-2", big: 20 },
          ],
        },
      });
    }
    return route.fulfill({ json: { ...base, columns: ["id"] } });
  });
  await page.goto("/sqlite");
});

test("generated columns render with their recorded kind and values", async ({ page }) => {
  await page.getByRole("button", { name: /measure/ }).click();
  await expect(page.getByRole("columnheader", { name: "doubled · generated virtual" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "label · generated stored" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "qty", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "item-1" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "6" })).toBeVisible();
});

test("implicit FK targets are qualified, never blank, and still table-level", async ({ page }) => {
  await page.getByRole("button", { name: /child_single/ }).click();
  const fk = page.getByRole("button", { name: /parent_id → parent2/ });
  await expect(fk).toHaveText("parent_id → parent2 (id (implicit target))");
  await expect(fk).toHaveAttribute(
    "title",
    "Open table parent2 (table-level; does not follow to the referenced record)",
  );
  await fk.click();
  await expect(page.getByRole("heading", { name: "parent2", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /child_mismatch/ }).click();
  await expect(page.getByText("ref → parent (parent primary key (implicit target))")).toBeVisible();
});

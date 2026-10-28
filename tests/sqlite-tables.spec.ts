/**
 * Browser acceptance for the real /sqlite route with a stubbed read plane,
 * so a CI checkout needs no Python for this component test. The live adapter
 * is covered by tests/sqlite-live.spec.ts and adapters/sqlite/test_server.py.
 */
import { test, expect } from "@playwright/test";

const schema = {
  file: "external.sqlite",
  file_sha256: "0".repeat(64),
  tables: [
    {
      name: "events",
      columns: [{ name: "payload", type: "TEXT", notnull: 0, pk: 0 }],
      pk: [],
      fks: [],
      rows: 2,
    },
    {
      name: "targets",
      columns: [
        { name: "scope", type: "TEXT", notnull: 1, pk: 1 },
        { name: "code", type: "TEXT", notnull: 1, pk: 2 },
      ],
      pk: ["scope", "code"],
      fks: [],
      rows: 120,
    },
    {
      name: "links",
      columns: [{ name: "id", type: "TEXT", notnull: 1, pk: 1 }],
      pk: ["id"],
      fks: [
        [
          { id: 0, seq: 0, table: "targets", from: "target_scope", to: "scope" },
          { id: 0, seq: 1, table: "targets", from: "target_code", to: "code" },
        ],
      ],
      rows: 1,
    },
  ],
  views: ["v_link_detail"],
};

test.beforeEach(async ({ page }) => {
  await page.route("**/sqlite/schema", async (route) => route.fulfill({ json: schema }));
  await page.route("**/sqlite/rows?**", async (route) => {
    const url = new URL(route.request().url());
    const table = url.searchParams.get("table");
    const offset = Number(url.searchParams.get("offset") || 0);
    const limit = Number(url.searchParams.get("limit") || 50);
    if (table === "events") {
      await route.fulfill({
        json: {
          name: "events",
          columns: ["payload"],
          total: 2,
          offset,
          navigable: false,
          ordering_guarantee: "none; rows are not durable identities",
          rows: [{ payload: "repeat" }, { payload: "repeat" }],
        },
      });
    } else if (table === "targets") {
      const rows = Array.from({ length: Math.min(limit, 120 - offset) }, (_, i) => ({
        scope: `S${offset + i}`,
        code: "1",
      }));
      await route.fulfill({
        json: {
          name: "targets",
          columns: ["scope", "code"],
          total: 120,
          offset,
          navigable: true,
          ordering_guarantee: "declared key",
          rows,
        },
      });
    } else if (table === "v_link_detail") {
      await route.fulfill({
        json: {
          name: "v_link_detail",
          columns: ["link_id", "scope"],
          total: 1,
          offset,
          navigable: false,
          ordering_guarantee: "none; rows are not durable identities",
          rows: [{ link_id: "l1", scope: "A" }],
        },
      });
    } else {
      await route.fulfill({
        json: {
          name: table,
          columns: ["id"],
          total: 1,
          offset,
          navigable: true,
          ordering_guarantee: "declared key",
          rows: [{ id: "link-1" }],
        },
      });
    }
  });
});

test("unkeyed duplicate rows are not deduplicated or assigned identity", async ({
  page,
}) => {
  await page.goto("/sqlite");
  await expect(page.getByRole("heading", { name: "SQLite tables" })).toBeVisible();
  await expect(page.getByText("(at startup)")).toBeVisible();
  await expect(
    page.getByText("Table-only records: no durable per-row identity is inferred."),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: "repeat" })).toHaveCount(2);
  await expect(page.getByText("1–2 of 2")).toBeVisible();
});

test("composite foreign keys appear as grouped physical references", async ({
  page,
}) => {
  await page.goto("/sqlite");
  await page.getByRole("button", { name: /links/ }).click();
  await expect(
    page.getByText("target_scope + target_code → targets (scope + code)"),
  ).toBeVisible();
  await expect(
    page.getByText("Record keys verified for structural navigation."),
  ).toBeVisible();
});

test("keyed tables paginate through server-side windows", async ({ page }) => {
  await page.goto("/sqlite");
  await page.getByRole("button", { name: /targets/ }).click();
  await expect(page.getByText("1–50 of 120")).toBeVisible();
  const next = page.getByRole("button", { name: "Next" });
  await expect(next).toBeEnabled();
  const request = page.waitForRequest((url) =>
    url.url().includes("/sqlite/rows") && url.url().includes("offset=50"),
  );
  await next.click();
  await request;
  await expect(page.getByText("51–100 of 120")).toBeVisible();
});

test("sql views browse without invented identity", async ({ page }) => {
  await page.goto("/sqlite");
  await page.getByRole("button", { name: /v_link_detail/ }).click();
  await expect(page.getByText("SQL VIEW")).toBeVisible();
  await expect(page.getByRole("cell", { name: "l1" })).toBeVisible();
  await expect(
    page.getByText("Table-only records: no durable per-row identity is inferred."),
  ).toBeVisible();
});

test("the structural room links back to the explorer at root", async ({ page }) => {
  await page.goto("/sqlite");
  await expect(page.getByRole("link", { name: /Back to explorer/ })).toHaveAttribute(
    "href",
    "/",
  );
});

test("a foreign key opens its declared target table", async ({ page }) => {
  await page.goto("/sqlite");
  await page.getByRole("button", { name: /links/ }).click();
  await page.getByRole("button", { name: /target_scope \+ target_code/ }).click();
  await expect(page.getByRole("heading", { name: "targets", exact: true })).toBeVisible();
  await expect(page.getByText("1–50 of 120")).toBeVisible();
});

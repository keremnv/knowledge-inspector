/**
 * Live structural inspection: real Python adapter, real SQLite file, real
 * browser. No route mocking. Run only with KI_LIVE_SQLITE=1 and the adapter
 * serving the structural fixture on the Vite /sqlite proxy target:
 *
 *   python3 adapters/sqlite/fixture.py /tmp/ki-sqlite-live.sqlite
 *   python3 adapters/sqlite/server.py --db /tmp/ki-sqlite-live.sqlite --port 8139
 *   KI_LIVE_SQLITE=1 npx playwright test tests/sqlite-live.spec.ts
 */
import { test, expect } from "@playwright/test";

test("live adapter preserves unkeyed duplicates and composite structure", async ({
  page,
}) => {
  test.skip(
    process.env.KI_LIVE_SQLITE !== "1",
    "requires the SQLite adapter and fixture on :8139",
  );
  await page.goto("/sqlite");
  await expect(page.getByText("ki-sqlite-live.sqlite")).toBeVisible();
  await expect(
    page.getByText("Table-only records: no durable per-row identity is inferred."),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: "repeat" })).toHaveCount(2);
  await page.getByRole("button", { name: /links/ }).click();
  await expect(
    page.getByText("target_scope + target_code → targets (scope + code)"),
  ).toBeVisible();
  await expect(
    page.getByText("Record keys verified for structural navigation."),
  ).toBeVisible();
});

test("live adapter browses views and nullable keys without invention", async ({
  page,
}) => {
  test.skip(
    process.env.KI_LIVE_SQLITE !== "1",
    "requires the SQLite adapter and fixture on :8139",
  );
  await page.goto("/sqlite");
  await page.getByRole("button", { name: /v_link_detail/ }).click();
  await expect(page.getByText("SQL VIEW")).toBeVisible();
  await expect(page.getByRole("cell", { name: "l1" })).toBeVisible();
  await expect(
    page.getByText("Table-only records: no durable per-row identity is inferred."),
  ).toBeVisible();
  await page.getByRole("button", { name: /loose/ }).click();
  await expect(page.getByText("scope + code", { exact: false })).toBeVisible();
  await expect(
    page.getByText("Table-only records: no durable per-row identity is inferred."),
  ).toBeVisible();
});

test("live foreign keys open the declared target table", async ({ page }) => {
  test.skip(
    process.env.KI_LIVE_SQLITE !== "1",
    "requires the SQLite adapter and fixture on :8139",
  );
  await page.goto("/sqlite");
  await page.getByRole("button", { name: /links/ }).click();
  await page.getByRole("button", { name: /target_scope/ }).click();
  await expect(page.getByRole("heading", { name: "targets", exact: true })).toBeVisible();
  await expect(page.getByText("1–2 of 2")).toBeVisible();
});

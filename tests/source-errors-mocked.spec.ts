/** What a failure says, whether anything changed, and what safely recovers.
 *
 * Controlled HTTP boundary cases (mocks, not SQLite evidence): a busy or
 * unreachable service, a server error, a query over its budget, a lost
 * context, global find's failures and partial coverage, a failed placement
 * on the way to a referenced record, and a canvas restore that could not read
 * everything. Each asserts the plain sentence, the recovery offered (or its
 * absence), that the code stays available, and that the canvas is unchanged
 * unless the person acted. */
import { test, expect } from "@playwright/test";
import { openSourceReferences } from "./canvas-parity";
import { context, child, parent, field, find, found, hit, mock, open, reader, refuse, tables } from "./source-error-fixtures";

test("a service that stops answering mid-session says so, changes nothing, and can be tried again from the keyboard", async ({ page }) => {
  let down = false;
  await mock(page, (route, url) => down && url.pathname.endsWith("/rows") ? route.abort("connectionrefused").then(() => true) : false);
  await open(page);
  await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
  await reader(page).getByRole("button", { name: "show on canvas", exact: true }).click();
  await expect(field(page)).toHaveCount(1);
  down = true;
  await tables(page).locator("[data-catalogue]").click();
  await page.getByRole("button", { name: "Parent table", exact: true }).click();
  const problem = tables(page).getByRole("alert");
  await expect(problem).toContainText("The source service did not answer");
  await expect(problem).toContainText("Nothing on the canvas changed");
  await expect(problem).toContainText("source_disconnected");
  await expect(field(page)).toHaveCount(1);
  // The recovery is the next stop for the keyboard after the table's own controls.
  down = false;
  const retry = tables(page).getByRole("button", { name: "try again", exact: true });
  for (let i = 0; i < 30 && !(await retry.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(retry).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(tables(page).getByRole("button", { name: "Inspect row 1", exact: true })).toBeVisible();
  await expect(tables(page).getByRole("alert")).toHaveCount(0);
});

test("a server error offers try again; nothing is claimed about the capture", async ({ page }) => {
  let fail = true;
  await mock(page, (route, url) => fail && url.pathname.endsWith("/rows") ? refuse(500, "source_server_failure")(route) : false);
  await open(page);
  await expect(tables(page).getByRole("alert")).toContainText("The source service could not complete this read");
  await expect(page.getByRole("heading", { name: "source reads stopped" })).toHaveCount(0);
  fail = false;
  await tables(page).getByRole("button", { name: "try again", exact: true }).click();
  await expect(tables(page).getByRole("button", { name: "Inspect row 1", exact: true })).toBeVisible();
});

test("a filter over its query budget says how to narrow it, offers no blind retry, and claims no absence", async ({ page }) => {
  await mock(page, (route, url) => url.pathname.endsWith("/search") ? refuse(422, "source_query_budget_exceeded")(route) : false);
  await open(page);
  await tables(page).getByRole("searchbox", { name: "filter Child", exact: true }).fill("x");
  await tables(page).getByRole("searchbox", { name: "filter Child", exact: true }).press("Enter");
  const problem = tables(page).getByRole("alert");
  await expect(problem).toContainText("did not finish within the query limit");
  await expect(problem).toContainText("one column");
  await expect(problem).toContainText("source_query_budget_exceeded");
  await expect(tables(page)).toContainText("filter incomplete · no absence claim");
  await expect(tables(page).getByRole("button", { name: "try again", exact: true })).toHaveCount(0);
});

test("a lost context stops every read, clears the canvas, and says what to do by hand", async ({ page }) => {
  let lost = false;
  const requests = await mock(page, (route, url) => lost && url.pathname.endsWith("/rows") ? route.fulfill({ json: { context: { ...context, generation: "gen1_other" }, data: {} } }).then(() => true) : false);
  await open(page);
  await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
  await reader(page).getByRole("button", { name: "show on canvas", exact: true }).click();
  const bootstraps = requests.filter((url) => url.pathname.endsWith("/session")).length;
  lost = true;
  await tables(page).locator("[data-catalogue]").click();
  await page.getByRole("button", { name: "Parent table", exact: true }).click();
  const stopped = page.locator(".source-fatal");
  await expect(stopped.getByRole("heading", { name: "source reads stopped" })).toBeVisible();
  await expect(stopped).toContainText("source_context_mismatch");
  await expect(stopped).toContainText("reload this page");
  await expect(stopped).toContainText("Nothing was read from another capture");
  await expect(stopped.getByRole("button", { name: "try again", exact: true })).toHaveCount(0);
  await expect(page.locator(".source-field-list")).toHaveCount(0);
  // Nothing reconnects by itself: no new session is asked for.
  expect(requests.filter((url) => url.pathname.endsWith("/session"))).toHaveLength(bootstraps);
});

test("an unreachable service at start offers try again, which starts the workspace", async ({ page }) => {
  let down = true;
  await mock(page, (route, url) => down && url.pathname.endsWith("/session") ? route.abort("connectionrefused").then(() => true) : false);
  await page.goto("/source");
  await expect(page.getByRole("alert")).toContainText("The source service did not answer");
  down = false;
  await page.getByRole("button", { name: "try again", exact: true }).click();
  await expect(page.getByRole("button", { name: "Child table", exact: true })).toBeVisible();
});

test.describe("global find", () => {
  test("a search that could not inspect some tables never says nothing matches anywhere", async ({ page }) => {
    await mock(page, (route, url) => url.pathname.endsWith("/find")
      ? route.fulfill({ json: { context, data: found(url.searchParams.get("text")!, [], [{ table: "Parent", reason: "source_query_budget_exceeded" }], "complete") } }).then(() => true) : false);
    await page.goto("/source?placement=explicit");
    await find(page).fill("zz");
    const list = page.getByRole("listbox", { name: "found tables and records" });
    await expect(list).toContainText("no matches in the tables searched");
    await expect(list).toContainText("not searched: Parent");
    await expect(list).toContainText("ran out of its query limit");
    await expect(list).not.toContainText("no tables or records match");
  });

  test("a failed find is announced, stays with the find field after its list closes, and can be tried again", async ({ page }) => {
    let busy = true;
    await mock(page, (route, url) => url.pathname.endsWith("/find")
      ? busy ? refuse(429, "source_reader_busy")(route)
        : route.fulfill({ json: { context, data: found(url.searchParams.get("text")!, [hit()], [], "complete") } }).then(() => true) : false);
    await page.goto("/source?placement=explicit");
    await find(page).fill("1");
    const announced = page.locator(".source-global-find [data-find-problem]");
    await expect(announced).toContainText("The source service is busy");
    await expect(announced).toHaveAttribute("role", "alert");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox", { name: "found tables and records" })).toHaveCount(0);
    // Closed, the failure is still said by the field itself.
    const describedBy = await find(page).getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`[id="${describedBy}"]`)).toContainText("The source service is busy");
    busy = false;
    await find(page).press("ArrowDown");
    const retry = page.getByRole("option", { name: /try again/ });
    await expect(retry).toHaveAttribute("aria-selected", "true");
    await find(page).press("Enter");
    await expect(page.getByRole("option", { name: /Child 1/ })).toBeVisible();
    await expect(announced).toHaveCount(0);
  });

  test("a continuation that fails keeps what was already found and can be tried again", async ({ page }) => {
    let continuations = 0;
    await mock(page, (route, url) => {
      if (!url.pathname.endsWith("/find")) return false;
      const text = url.searchParams.get("text")!;
      if (url.searchParams.get("cursor") === null) return route.fulfill({ json: { context, data: found(text, [hit()], [], "budget_exceeded", "1:0") } }).then(() => true);
      continuations += 1;
      return continuations === 1 ? refuse(429, "source_reader_busy")(route)
        : route.fulfill({ json: { context, data: found(text, [hit(parent)], [], "complete") } }).then(() => true);
    });
    await page.goto("/source?placement=explicit");
    await find(page).fill("1");
    await expect(page.getByRole("option", { name: /Child 1/ })).toBeVisible();
    await page.getByRole("option", { name: /stopped early · continue/ }).click();
    await expect(page.locator(".source-global-find [data-find-problem]")).toContainText("could not continue");
    await expect(page.getByRole("option", { name: /Child 1/ })).toBeVisible();
    await page.getByRole("option", { name: /try again/ }).click();
    await expect(page.getByRole("option", { name: /Parent 10/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /Child 1/ })).toBeVisible();
  });

  test("a find answered from another context stops the workspace, as every other read does", async ({ page }) => {
    await mock(page, (route, url) => url.pathname.endsWith("/find")
      ? route.fulfill({ json: { context: { ...context, generation: "gen1_other" }, data: found(url.searchParams.get("text")!, [], [], "complete") } }).then(() => true) : false);
    await page.goto("/source?placement=explicit");
    await find(page).fill("1");
    await expect(page.getByRole("heading", { name: "source reads stopped" })).toBeVisible();
  });
});

test("a reference followed from its value that cannot be placed says so where it was followed, and can be tried again", async ({ page }) => {
  let busy = true;
  await mock(page, (route, url) => busy && url.pathname.endsWith("/record") && url.searchParams.get("id") === parent.record_id
    ? refuse(429, "source_reader_busy")(route) : false);
  await open(page, "Child", "");
  await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
  await expect(field(page)).toHaveCount(1);
  await reader(page).getByRole("button", { name: "go to Parent referenced by parent_id" }).click();
  const problem = reader(page).locator("[data-placement-problem]");
  await expect(problem).toContainText("The source service is busy");
  await expect(problem).toContainText("Nothing on the canvas changed");
  await expect(field(page)).toHaveCount(1);
  await expect(reader(page).locator("h2")).toHaveAccessibleName(/^Child/);
  busy = false;
  await problem.getByRole("button", { name: "try again", exact: true }).press("Enter");
  await expect(field(page)).toHaveCount(2);
  await expect(page.locator(".source-field-list [data-field-reference]")).toHaveCount(1);
  await expect(reader(page).locator("h2")).toHaveAccessibleName(/^Parent/);
});

test("a canvas restore that could not read every record changes nothing, keeps what was remembered, and can be tried again", async ({ page }) => {
  let refuseParent = false;
  await mock(page, (route, url) => refuseParent && url.pathname.endsWith("/record") && url.searchParams.get("id") === parent.record_id
    ? refuse(429, "source_reader_busy")(route) : false);
  await open(page);
  await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
  await reader(page).getByRole("button", { name: "show on canvas", exact: true }).click();
  await openSourceReferences(page); await reader(page).getByRole("button", { name: "inspect FK 0 reference", exact: true }).click();
  await reader(page).getByRole("button", { name: "show connection", exact: true }).click();
  await expect(field(page)).toHaveCount(2);
  await page.waitForTimeout(600);
  const remembered = () => page.evaluate(() => {
    const key = Object.keys(sessionStorage).find((k) => k.startsWith("ki.source.field:"));
    return key ? JSON.parse(sessionStorage.getItem(key)!).records.length : 0;
  });
  expect(await remembered()).toBe(2);
  refuseParent = true;
  await page.reload();
  const note = page.locator(".source-restore");
  await expect(note).toContainText("could not be read");
  await expect(note).toContainText("busy");
  await expect(note).not.toContainText("not found");
  await expect(page.locator(".source-field-list [data-field-record]")).toHaveCount(0);
  await page.waitForTimeout(600);
  expect(await remembered()).toBe(2);
  refuseParent = false;
  await note.getByRole("button", { name: "try again", exact: true }).click();
  await expect(page.locator(".source-restore")).toContainText("restored 2 records from the last visit");
  await expect(page.locator(".source-field-list [data-field-reference]")).toHaveCount(1);
});

test("a read that fails while its panel is closed is there, with its recovery, when the panel opens", async ({ page }) => {
  let hold: ((value: void) => void) | null = null;
  const held = new Promise<void>((resolve) => { hold = resolve; });
  let refuseOnce = true;
  await mock(page, async (route, url) => {
    if (!refuseOnce || !url.pathname.endsWith("/record")) return false;
    refuseOnce = false; await held;
    return refuse(429, "source_reader_busy")(route);
  });
  await open(page);
  await tables(page).getByRole("button", { name: "Inspect row 1", exact: true }).click();
  await reader(page).getByRole("button", { name: "close", exact: true }).first().click();
  await expect(page.locator('[data-overlay="source-reader"]')).not.toHaveClass(/is-open/);
  hold!();
  await page.waitForTimeout(500);
  await page.locator('[data-overlay="source-reader"] .ov__handle').click();
  await expect(reader(page).getByRole("alert")).toContainText("The source service is busy");
  await reader(page).getByRole("button", { name: "try again", exact: true }).click();
  await expect(reader(page).getByRole("button", { name: "show on canvas", exact: true })).toBeVisible();
});

test("a session description this page cannot read is said, with no retry that could not help", async ({ page }) => {
  await mock(page, (route, url) => url.pathname.endsWith("/session") ? route.fulfill({ json: { ...context, projection_version: "sqlite_source_v9" } }).then(() => true) : false);
  await page.goto("/source");
  await expect(page.getByRole("alert")).toContainText("in a form this page cannot read");
  await expect(page.getByRole("alert")).toContainText("source_invalid_context");
  await expect(page.getByRole("button", { name: "try again", exact: true })).toHaveCount(0);
});

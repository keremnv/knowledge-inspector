/**
 * A subject that has been replaced takes no more actions.
 *
 * `Swap` keeps the outgoing copy of a table, or of the reader, mounted while
 * it withdraws, and stacks it above the incoming one. That copy is a picture
 * of the previous subject, not the subject: no press, click or key may reach
 * it. These checks use real input — pointer presses queued the way a quick
 * second click arrives, and keyboard Tab and Enter — under ordinary motion,
 * where the overlap actually exists, and they sample hit testing and focus on
 * every frame the outgoing copy is mounted.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

const ROLES = [
  { name: "subject", type: "REFERENT", column: "subject", referent: true, kinds: ["entity"] },
  { name: "note", type: "TEXT", column: "note", referent: false },
];
const ROWS: Record<string, string[]> = {
  record: ["r0", "r1", "r2", "r3", "r4", "r5"],
  ledger: ["l0", "l1", "l2"],
};
const OBLIGATIONS = ["ob-1", "ob-2"].map((id) => ({
  obligation_id: id, question: `Question ${id}?`, dimension: "fixture", relation: null, values: {},
  reason: null, demanded_by: { name: "fixture", revision: 1 }, state: "UNRESOLVED", assertion_id: null,
  record_id: null, grounding_ref: null, contract_id: "fixture-contract", contract_revision: "1",
  generated_by_rule: "fixture-rule", candidates: [],
}));

function assertion(id: string) {
  const [relation, note] = id.split(":");
  return {
    assertion_id: id, relation, mode: "BASE", arity: 2, roles: ROLES,
    values: { subject: "entity:A", note }, origin: "SEMANTIC", origins: ["SEMANTIC"],
    occurrence_state: "RECORDED", created_revision: 1, relation_stale: false, completeness: null,
    grounding: [],
    warrant: {
      commitment_id: id, relation, assertion_origin: "SEMANTIC", recorded_construction_origin: "SEMANTIC",
      construction_origins: ["SEMANTIC"], created_revision: 1, bases: [],
    },
    commitment_id: id, candidate_for: [], governing_obligations: [], candidate_assessments: [],
  };
}

/** The plane, answered in the test. Every read is logged by path and query. */
async function world(page: Page) {
  const reads: string[] = [];
  await page.route((url) => url.pathname.startsWith("/world/"), (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.slice("/world/".length);
    reads.push(`${path}${url.search}`);
    const json = (() => {
      switch (path) {
        case "overview": return {
          world_id: "swap-fixture", revision: 1, relations: 2, referents: 1, assertions: 9,
          origins: { SEMANTIC: 9 }, stale: [], incomplete: [],
          demand: { purpose: { statement: "Fixture purpose." }, obligations: 1, demanded: 1 },
          governed_obligations: { count: OBLIGATIONS.length, resolved: 0, unresolved: OBLIGATIONS.length },
        };
        case "schema": return { relations: Object.keys(ROWS).map((name) => ({
          name, description: name, mode: "BASE", arity: 2, referent_arity: 1, roles: ROLES,
          count: ROWS[name].length, stale: false, origins: ["SEMANTIC"], scope: null, completeness: null,
        })) };
        case "referents": return { referents: [{ id: "entity:A", label: "Ark" }], total: 1, truncated: false };
        case "rows": {
          const relation = url.searchParams.get("relation")!;
          return { relation, mode: "BASE", stale: false, total: ROWS[relation].length, offset: 0, roles: ROLES,
            rows: ROWS[relation].map((note) => ({ assertion_id: `${relation}:${note}`, origin: "SEMANTIC",
              origins: ["SEMANTIC"], values: { subject: "entity:A", note } })) };
        }
        case "assertion": return assertion(url.searchParams.get("id")!);
        case "labels": return { labels: { "entity:A": "Ark" } };
        case "referent": return { id: "entity:A", label: "Ark", grounding: [], fields: [], relations: [] };
        case "demand": return { demand: { purpose: { statement: "Fixture purpose." }, rule: null, demanded: 1,
          obligations: [{ relation: "record", values: { subject: "entity:A", note: "missing" },
            demanded_by: { name: "fixture", revision: 1 }, state: "UNRESOLVED", assertion_id: null,
            reason: "fixture gap: no tuple covers the missing note" }] } };
        case "obligations": return { contract: null, governance: null, obligations: OBLIGATIONS };
        case "obligation": {
          const found = OBLIGATIONS.find((item) => item.obligation_id === url.searchParams.get("obligation_id"));
          return found ? { ...found, adjudications: [], context: { contract: null, governance: null,
            evidence_authority: null, adjudication_authority: null } } : null;
        }
        default: return undefined;
      }
    })();
    if (json === undefined) return route.fulfill({ status: 404, json: { detail: path } });
    return route.fulfill({ json });
  });
  return reads;
}

/** The table being read: the incoming half of the Tables swap, by its own name. */
const activeTable = (page: Page, name: string) =>
  page.locator(`.motion-swap__is section[aria-label="${name}"]`);
const worldRow = (page: Page, relation: string) =>
  activeTable(page, "world relations").locator(".table__row").filter({ has: page.locator(`[title="${relation}"]`) });
const tupleRow = (page: Page, relation: string, note: string) =>
  activeTable(page, `${relation} extension`).locator(".table__row[data-loaded]")
    .filter({ has: page.getByText(note, { exact: true }) });
const reader = (page: Page) => page.locator(".node-reader .motion-swap__is");
const readerNote = (page: Page) =>
  reader(page).locator(".world__roles li").filter({ has: page.locator("b", { hasText: /^note$/ }) }).locator("span");
const subjectButton = (page: Page, name: string) =>
  activeTable(page, "record extension").getByRole("navigation", { name: "Table subject" })
    .getByRole("button", { name, exact: true });

async function centre(locator: Locator) {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** No swap is mid-withdrawal: every subject on screen is the current one. */
async function settled(page: Page) {
  await expect(page.locator(".motion-swap__was")).toHaveCount(0);
}

/**
 * Watch every frame an outgoing copy is mounted, until stopped.
 *
 * Per frame: whether each outgoing layer is inert, whether focus sits inside
 * one, and what a pointer at the centre of each of its controls would hit.
 * And every press, click or key whose target lies in an outgoing copy.
 */
async function watchOutgoing(page: Page) {
  await page.evaluate(() => {
    type Watch = { frames: number; layers: number; notInert: number; focused: string[]; hits: string[]; reached: string[]; stop: boolean };
    const watch: Watch = { frames: 0, layers: 0, notInert: 0, focused: [], hits: [], reached: [], stop: false };
    (window as unknown as { __outgoing: Watch }).__outgoing = watch;
    const name = (element: Element) =>
      `${element.tagName.toLowerCase()} "${(element.textContent ?? "").trim().slice(0, 24)}"`;
    const controls = "button, a[href], input, select, textarea, [tabindex], [role=button], .table__row";
    const tick = () => {
      if (watch.stop) return;
      const layers = [...document.querySelectorAll(".motion-swap__was")];
      if (layers.length) {
        watch.frames += 1;
        watch.layers = Math.max(watch.layers, layers.length);
        for (const layer of layers) {
          if (!(layer as HTMLElement).inert) watch.notInert += 1;
          if (document.activeElement && layer.contains(document.activeElement)) {
            watch.focused.push(name(document.activeElement));
          }
          for (const control of layer.querySelectorAll(controls)) {
            const box = control.getBoundingClientRect();
            if (!box.width || !box.height) continue;
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            if (hit?.closest(".motion-swap__was")) watch.hits.push(name(control));
          }
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    for (const type of ["pointerdown", "click", "keydown"]) {
      document.addEventListener(type, (event) => {
        const target = event.target as Element | null;
        if (target?.closest?.(".motion-swap__was")) watch.reached.push(`${type} ${name(target)}`);
      }, true);
    }
  });
  return async () => page.evaluate(() => {
    const watch = (window as unknown as { __outgoing: { stop: boolean } }).__outgoing;
    watch.stop = true;
    return watch as unknown as { frames: number; layers: number; notInert: number; focused: string[]; hits: string[]; reached: string[] };
  });
}

/**
 * Real presses, queued without waiting for each to be answered — the way a
 * quick second click arrives while the first is still being drawn. Each
 * press records, in the page, whether an outgoing copy was mounted when it
 * landed, so a test can prove the overlap it meant to exercise happened.
 */
async function burst(page: Page, ...points: { x: number; y: number }[]) {
  await page.evaluate(() => {
    const landed: boolean[] = [];
    (window as unknown as { __landed: boolean[] }).__landed = landed;
    document.addEventListener("pointerdown", () => {
      landed.push(Boolean(document.querySelector(".motion-swap__was")));
    }, true);
  });
  const cdp = await page.context().newCDPSession(page);
  await Promise.all(points.flatMap((at) => [
    cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 }),
    cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 }),
  ]));
  await cdp.detach();
  return () => page.evaluate(() => (window as unknown as { __landed: boolean[] }).__landed);
}

const field = (page: Page) => page.evaluate(() => localStorage.getItem("worldir.field:swap-fixture:1"));

/**
 * Stage a two-press gesture until its second press lands on an overlap.
 *
 * Queued input is answered on the browser's schedule: the second press can
 * come before the first has been drawn — when the old table is still the
 * subject and acting on it is right — or after the withdrawal is over. Only
 * an attempt whose second press met a mounted outgoing copy tests anything,
 * so the gesture is staged afresh until one does, and never more than five
 * times.
 */
async function overlapped(page: Page, stage: () => Promise<{ x: number; y: number }[]>) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const reads = await world(page);
    await page.goto("/");
    const points = await stage();
    reads.length = 0;
    const stop = await watchOutgoing(page);
    const landed = await burst(page, ...points);
    await settled(page);
    const watch = await stop();
    if ((await landed())[1]) return { reads, watch };
    await page.unrouteAll();
  }
  throw new Error("no attempt pressed the outgoing copy while it was mounted");
}

test.describe("under ordinary motion", () => {
  test.use({ reducedMotion: "no-preference" });

  test("an outgoing world catalogue takes no press while its relation enters", async ({ page }) => {
    // Open record, then press where ledger's row still shows as it withdraws.
    const { reads, watch } = await overlapped(page, async () => [
      await centre(worldRow(page, "record")),
      await centre(worldRow(page, "ledger")),
    ]);
    expect(watch.hits).toEqual([]);
    expect(watch.reached).toEqual([]);
    expect(watch.notInert, "an outgoing copy was left operable").toBe(0);
    expect(reads.filter((read) => read.startsWith("rows?relation=ledger"))).toEqual([]);
    await expect(activeTable(page, "record extension")).toBeVisible();

    // The incoming table is the one that answers, by the row's own identity.
    await tupleRow(page, "record", "r3").click();
    await expect(readerNote(page)).toHaveText("r3");
    expect(reads.filter((read) => read.startsWith("assertion?"))).toEqual(["assertion?id=record%3Ar3"]);
  });

  test("a relation that has been left takes no press on its old rows", async ({ page }) => {
    const { reads, watch } = await overlapped(page, async () => {
      await worldRow(page, "record").click();
      await expect(tupleRow(page, "record", "r1")).toBeVisible();
      await settled(page);
      return [await centre(subjectButton(page, "world")), await centre(tupleRow(page, "record", "r1"))];
    });
    expect(watch.hits).toEqual([]);
    expect(watch.reached).toEqual([]);
    expect(watch.notInert, "an outgoing copy was left operable").toBe(0);
    // No assertion read, nothing placed, and the catalogue is the subject.
    expect(reads.filter((read) => read.startsWith("assertion?"))).toEqual([]);
    expect(await field(page)).toBeNull();
    await expect(activeTable(page, "world relations")).toBeVisible();
  });

  test("rapid subject changes leave only the last one operable, with no late return", async ({ page }) => {
    const reads = await world(page);
    await page.goto("/");
    const stop = await watchOutgoing(page);
    // Each press is a real click, made as soon as its target is actionable:
    // well inside the previous subject's withdrawal.
    await worldRow(page, "record").click();
    await subjectButton(page, "world").click();
    await worldRow(page, "ledger").click();
    await tupleRow(page, "ledger", "l2").click();
    await expect(readerNote(page)).toHaveText("l2");
    await settled(page);
    // Stays where it was left: nothing stale brings record back.
    for (let frame = 0; frame < 30; frame += 1) {
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    await expect(activeTable(page, "ledger extension")).toBeVisible();
    await expect(page.locator('section[aria-label="record extension"]')).toHaveCount(0);
    const watch = await stop();
    expect(watch.frames).toBeGreaterThan(0);
    expect(watch.hits).toEqual([]);
    expect(watch.reached).toEqual([]);
    expect(watch.notInert, "an outgoing copy was left operable").toBe(0);
    expect(reads.filter((read) => read.startsWith("assertion?"))).toEqual(["assertion?id=ledger%3Al2"]);
  });

  test("Purpose frontier and governed obligations stay operable through their own swaps", async ({ page }) => {
    const reads = await world(page);
    await page.goto("/");
    const stop = await watchOutgoing(page);
    const subjects = page.getByRole("navigation", { name: "Table subject" });

    await subjects.getByRole("button", { name: "purpose frontier", exact: true }).click();
    const frontier = activeTable(page, "unresolved frontier");
    await frontier.locator(".table__row").first().click();
    await expect(reader(page)).toContainText("fixture gap: no tuple covers the missing note");

    await subjects.getByRole("button", { name: "obligations", exact: true }).click();
    const governed = activeTable(page, "governed obligations");
    await governed.locator(".table__row").filter({ hasText: "Question ob-2?" }).click();
    await expect(reader(page).locator("h2")).toContainText("Question ob-2?");
    // Two collections, two tables: Purpose demand is not governed obligation.
    await expect(governed).not.toContainText("fixture gap");
    await settled(page);
    const watch = await stop();
    expect(watch.frames).toBeGreaterThan(0);
    expect(watch.hits).toEqual([]);
    expect(watch.reached).toEqual([]);
    expect(reads.filter((read) => read.startsWith("obligation?"))).toEqual(["obligation?obligation_id=ob-2"]);
  });

  test("keyboard focus never enters an outgoing table or reader", async ({ page }) => {
    const reads = await world(page);
    await page.goto("/");
    const stop = await watchOutgoing(page);

    // Enter on a catalogue row replaces the table. Enter and Space at once
    // after reach nothing; Tab moves on without passing through the old copy.
    await worldRow(page, "record").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press(" ");
    for (let step = 0; step < 6; step += 1) await page.keyboard.press("Tab");
    await settled(page);
    await expect(activeTable(page, "record extension")).toBeVisible();
    expect(reads.filter((read) => read === "demand" || read.startsWith("rows?relation=ledger"))).toEqual([]);

    // Enter on a tuple replaces the reader; the same, through the reader.
    await tupleRow(page, "record", "r0").focus();
    await page.keyboard.press("Enter");
    for (let step = 0; step < 6; step += 1) await page.keyboard.press("Shift+Tab");
    await expect(readerNote(page)).toHaveText("r0");
    await settled(page);

    const watch = await stop();
    expect(watch.layers, "both the table and the reader swapped").toBeGreaterThan(0);
    expect(watch.frames).toBeGreaterThan(0);
    expect(watch.focused).toEqual([]);
    expect(watch.reached).toEqual([]);
    expect(reads.filter((read) => read.startsWith("assertion?"))).toEqual(["assertion?id=record%3Ar0"]);
  });
});

test("with reduced motion the incoming table is operable at once", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reads = await world(page);
  await page.goto("/");
  const stop = await watchOutgoing(page);
  const ledger = await centre(worldRow(page, "ledger"));
  await worldRow(page, "record").click();
  // No withdrawal to wait out: the catalogue is gone, and the press where
  // ledger stood finds the new table instead.
  await page.mouse.click(ledger.x, ledger.y);
  await expect(activeTable(page, "record extension")).toBeVisible();
  await tupleRow(page, "record", "r1").click();
  await expect(readerNote(page)).toHaveText("r1");
  const watch = await stop();
  expect(watch.hits).toEqual([]);
  expect(watch.reached).toEqual([]);
  expect(reads.filter((read) => read.startsWith("rows?relation=ledger"))).toEqual([]);
  expect(reads.filter((read) => read.startsWith("assertion?")).at(-1)).toBe("assertion?id=record%3Ar1");
});

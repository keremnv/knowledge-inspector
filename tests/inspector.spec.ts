import { test as base, expect, type Page, type Route } from "@playwright/test";
import type { Graph } from "@antv/g6";
import type { WorldAssertion, WorldRelation, WorldTuple } from "../src/api/world";
import { VISIBILITY_STRENGTHS_ON } from "../src/world/visibility";

/** Crowding is off, as in the original (owner decision O16): these return if it is switched back on. */
const CROWDING_OFF = "label crowding is off, as in the original (O16)";

type CanvasWindow = Window & {
  __worldVocabulary: Graph;
  __worldFieldGraph: Graph;
};

type LabelShape = {
  style: { fillOpacity: number; opacity: number };
  getAnimations: () => { playState: string; effect: { getKeyframes: () => { fillOpacity: number }[] } }[];
};
const vocabularyText = (page: Page) => page.evaluate(() => {
  const graph = (window as unknown as CanvasWindow).__worldVocabulary;
  const text = (graph as unknown as {
    context: { element: { getElement: (id: string) => {
      getShape: (name: string) => { getShape: (name: string) => LabelShape };
    } } };
  })?.context?.element?.getElement("kind:entity")?.getShape("label")?.getShape("text");
  return Number(text?.style.fillOpacity);
});
type Field = {
  assertions: [string, unknown][];
  referents: [string, unknown][];
  bonds: { assertion_id: string }[];
  depth: [string, number][];
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class FixtureWorld {
  count = 3;
  hub = false;
  binary = false;
  /**
   * Claims a subject's read orders last, as a server may: the relation table
   * lists them first while the neighborhood pages them at its tail.
   */
  subjectLast: string[] = [];
  requests: URL[] = [];
  private blocked = new Map<string, {
    reached: ReturnType<typeof deferred>;
    released: ReturnType<typeof deferred>;
    status: number;
  }>();

  block(key: string, status = 200) {
    const gate = { reached: deferred(), released: deferred(), status };
    this.blocked.set(key, gate);
    return { requested: gate.reached.promise, release: gate.released.resolve };
  }

  releaseAll() {
    for (const gate of this.blocked.values()) gate.released.resolve();
  }

  get relation(): WorldRelation {
    return {
      name: "property", description: "Fixture property", mode: "BASE",
      arity: this.binary ? 3 : 2, referent_arity: this.binary ? 2 : 1,
      roles: [
        { name: "item", type: "REFERENT", referent: true, kinds: ["entity"] },
        ...(this.binary ? [{ name: "peer", type: "REFERENT", referent: true, kinds: ["entity"] }] : []),
        { name: "value", type: "TEXT", referent: false },
      ],
      count: this.count, stale: false, origins: ["SEMANTIC"],
      scope: "WORLD", completeness: null,
    };
  }

  tuples(): WorldTuple[] {
    return Array.from({ length: this.count }, (_, i) => ({
      assertion_id: `assertion:${i}`, origin: "SEMANTIC", origins: ["SEMANTIC"],
      values: { item: `entity:${this.hub ? 0 : i}`, value: `value-${i}`,
        ...(this.binary ? { peer: `entity:${i + 1}` } : {}) },
    }));
  }

  async respond(route: Route) {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/world/")) return route.continue();
    this.requests.push(url);
    const name = url.pathname.slice("/world/".length);
    const id = url.searchParams.get("id") ?? "";
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const key = name === "rows" ? `rows:${offset}` : `${name}${id ? `:${id}` : ""}`;
    const gate = this.blocked.get(key);
    if (gate) {
      gate.reached.resolve();
      await gate.released.promise;
      this.blocked.delete(key);
      if (gate.status !== 200) return route.fulfill({ status: gate.status, json: { error: "Fixture read failed" } });
    }
    let answer: unknown;
    switch (name) {
      case "overview":
        answer = {
          world_id: "review", revision: 1, relations: 1, referents: this.count + 1,
          assertions: this.count, origins: { SEMANTIC: this.count }, stale: [], incomplete: [],
          demand: { purpose: { statement: "fixture" }, obligations: 0, demanded: 0 },
          governed_obligations: { count: 0, resolved: 0, unresolved: 0 },
        };
        break;
      case "schema": answer = { relations: [this.relation] }; break;
      case "referents":
        answer = { referents: Array.from({ length: this.count + 1 }, (_, i) => ({
          id: `entity:${i}`, label: `Entity ${i}`,
        })), total: this.count + 1, truncated: false };
        break;
      case "rows": {
        const subject = url.searchParams.get("subject");
        const matching = this.tuples().filter((tuple) => !subject || Object.values(tuple.values).includes(subject));
        const last = (tuple: WorldTuple) => Boolean(subject) && this.subjectLast.includes(tuple.assertion_id);
        const rows = [...matching.filter((tuple) => !last(tuple)), ...matching.filter(last)];
        answer = { relation: "property", mode: "BASE", stale: false, roles: this.relation.roles,
          offset, total: rows.length, rows: rows.slice(offset, offset + Number(url.searchParams.get("limit") ?? 200)) };
        break;
      }
      case "assertion": {
        const tuple = this.tuples().find((item) => item.assertion_id === id)!;
        answer = {
          ...tuple, relation: "property", mode: "BASE", arity: this.relation.arity, roles: this.relation.roles,
          assertion_state: "ASSERTED", created_revision: 1, relation_stale: false,
          completeness: null, grounding: [], commitment_id: id, candidate_for: [],
          governing_obligations: [], candidate_assessments: [],
          warrant: { commitment_id: id, relation: "property", assertion_origin: "SEMANTIC",
            recorded_construction_origin: "SEMANTIC", construction_origins: ["SEMANTIC"],
            created_revision: 1, bases: [] },
        } satisfies WorldAssertion;
        break;
      }
      case "referent":
        // Entity 0 carries one fact from a tuple never placed, so the
        // reader's back-link reads past the field.
        answer = { id, label: `Entity ${id.split(":")[1]}`, grounding: [],
          fields: id === "entity:0"
            ? [{ relation: "property", role: "value", value: "value-7",
                assertion_id: "assertion:7", origin: "SEMANTIC" }]
            : [],
          relations: [{ name: "property", arity: this.relation.arity, mode: "BASE", stale: false,
            count: this.tuples().filter((tuple) => Object.values(tuple.values).includes(id)).length }] };
        break;
      case "demand": answer = { demand: {
        purpose: { statement: "fixture" }, rule: null, demanded: 0, obligations: [],
      } }; break;
      case "obligations": answer = { obligations: [] }; break;
      default: throw new Error(`Unexpected fixture read: ${url}`);
    }
    return route.fulfill({ json: answer });
  }
}

const test = base.extend<{ world: FixtureWorld }>({
  world: async ({ page }, use) => {
    const world = new FixtureWorld();
    await page.route("**/world/**", (route) => world.respond(route));
    try { await use(world); } finally { world.releaseAll(); }
  },
});

const reader = (page: Page) => page.locator(".node-reader .motion-swap__is");
/**
 * The table being read: the incoming half of the Tables swap, by its own name.
 *
 * While one subject replaces another, the outgoing copy stays mounted for its
 * withdrawal. It is inert and no longer the subject, but its rows are still in
 * the document, so a selector over every `.table__row` counts them too and an
 * index can land one row short.
 */
const activeTable = (page: Page, name: string) =>
  page.locator(`.motion-swap__is section[aria-label="${name}"]`);
const rows = (page: Page) => activeTable(page, "property extension").locator(".table__row[data-loaded]");
const worldRow = (page: Page, relation: string) =>
  activeTable(page, "world relations").locator(".table__row").filter({ has: page.locator(`[title="${relation}"]`) });
const field = (page: Page) => page.evaluate(() =>
  JSON.parse(localStorage.getItem("worldir.field:review:1") ?? "null") as Field | null);

async function openProperty(page: Page) {
  await page.goto("/");
  await worldRow(page, "property").click();
  await expect(rows(page).first()).toBeVisible();
}

async function readRow(page: Page, index: number) {
  await rows(page).nth(index).click();
  await expect(reader(page)).toContainText(`value-${index}`);
}

/**
 * Click a referent once the field graph holding it is up.
 *
 * Reader text is not that signal: placing the first row swaps the vocabulary
 * for the field behind an absorb (`useSequencedSwap`), so the field canvas
 * mounts after the reader already shows the claim. Checking and emitting in
 * one evaluation leaves no gap for the graph to be replaced in between, and
 * the click is sent exactly once.
 */
async function selectReferent(page: Page, id: string) {
  await expect.poll(() => page.evaluate((id) => {
    const graph = (window as unknown as Partial<CanvasWindow>).__worldFieldGraph;
    if (!graph || graph.destroyed || !graph.getNodeData().some((node) => node.id === id)) return false;
    graph.emit("node:click", { target: { id } });
    return true;
  }, id), `the field graph never held ${id}`).toBe(true);
}

for (const motion of ["reduce", "no-preference"] as const) {
  test(`a small vocabulary is visible with ${motion} motion`, async ({ page, world }) => {
    world.count = 1;
    await page.emulateMedia({ reducedMotion: motion });
    await page.goto("/");
    const camera = () => page.evaluate(() => {
      const graph = (window as unknown as CanvasWindow).__worldVocabulary;
      if (!graph?.getNodeData().length) return false;
      const [x, y] = graph.getViewportByCanvas(graph.getElementPosition("kind:entity"));
      return x > 450 && x < 1350 && y > 150 && y < 850 && graph.getZoom() <= 2;
    });
    await expect.poll(camera).toBe(true);
    // A user reframe uses the same bounded placement, including after panning.
    await page.evaluate(async () => {
      const graph = (window as unknown as CanvasWindow).__worldVocabulary;
      await graph.translateBy([0, -1500], false);
    });
    await expect.poll(camera).toBe(false);
    await page.evaluate(() => {
      (window as unknown as CanvasWindow).__worldVocabulary.emit("canvas:dblclick", {});
    });
    await expect.poll(camera).toBe(true);
  });
}

test("text strength fades from its painted value, including an interrupted recovery", async ({ page, world }) => {
  world.count = 1;
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await expect.poll(() => vocabularyText(page)).toBe(0.85);
  // Let establishment finish before probing the painter independently of
  // the initial lifecycle's own reconciliation of authored label styles.
  await expect.poll(() => page.evaluate(() => {
    const graph = (window as unknown as CanvasWindow).__worldVocabulary;
    return graph.getViewportByCanvas(graph.getElementPosition("kind:entity"))[1];
  })).toBeCloseTo(499.99, 2);
  const paint = async (to: number, animate = true) => page.evaluate(async ({ to, animate }) => {
    const motionPath = "/src/styles/motion.ts";
    const painterPath = "/src/world/canvasMotion.ts";
    const { DEFAULT_MOTION_PLANS } = await import(motionPath);
    const { paintLabelStrength } = await import(painterPath);
    const graph = (window as unknown as CanvasWindow).__worldVocabulary;
    const text = (graph as unknown as {
      context: { element: { getElement: (id: string) => {
        getShape: (name: string) => { getShape: (name: string) => LabelShape };
      } } };
    }).context.element.getElement("kind:entity").getShape("label").getShape("text");
    const before = Number(text.style.fillOpacity);
    // The previous target can differ from the value currently being painted.
    paintLabelStrength(graph, [{ id: "kind:entity", from: 0.85, to }], animate ? {
      weakenPlan: DEFAULT_MOTION_PLANS.absorb, restorePlan: DEFAULT_MOTION_PLANS.emit,
    } : {});
    const running = text.getAnimations().find((animation) => animation.playState === "running" &&
      animation.effect.getKeyframes().some((frame) => typeof frame.fillOpacity === "number"));
    return { before, after: Number(text.style.fillOpacity), frames: running?.effect.getKeyframes() };
  }, { to, animate });
  const yielding = await paint(0.25);
  expect(yielding.frames?.map((frame) => frame.fillOpacity)).toEqual([0.85, 0.25]);
  expect(yielding.after).toBe(0.85);
  await expect.poll(async () => (await vocabularyText(page)) < 0.84).toBe(true);
  const recovering = await paint(0.85);
  expect(recovering.frames?.[0].fillOpacity).toBe(recovering.before);
  expect(recovering.frames?.[1].fillOpacity).toBe(0.85);
  expect(recovering.after).toBe(recovering.before);
  await expect.poll(() => vocabularyText(page)).toBe(0.85);
  await paint(0.25);
  // Switching to reduced motion must cancel a running fade as well as snap.
  const reduced = await paint(0.6, false);
  expect(reduced.after).toBe(0.6);
  expect(reduced.frames).toBeUndefined();
  await expect.poll(() => vocabularyText(page)).toBe(0.6);
});

type Canvas = "field" | "vocabulary";
const graphName = (canvas: Canvas) => canvas === "field" ? "__worldFieldGraph" : "__worldVocabulary";
type Box = { minX: number; minY: number; maxX: number; maxY: number };

/** What a person sees of each name, beside what the store says it should be. */
const labelsOf = (page: Page, canvas: Canvas, ids: string[]) => page.evaluate(async ({ name, ids }) => {
  const visibilityPath = "/src/world/visibility.ts";
  const { paintedLabelBox } = await import(visibilityPath);
  const graph = (window as unknown as CanvasWindow)[name as "__worldFieldGraph"];
  return ids.map((id) => {
    const element = (graph as unknown as {
      context: { element: { getElement: (id: string) => {
        getShape: (name: string) => LabelShape & { getShape: (name: string) => LabelShape | undefined };
      } } };
    }).context.element.getElement(id);
    const label = element.getShape("label");
    const text = label.getShape("text")!;
    const plate = label.getShape("background");
    const style = graph.getElementData(id).style!;
    // Any opacity channel moving on the name's text, its plate or its mark.
    const moving = (shape?: LabelShape) => (shape?.getAnimations() ?? []).filter((animation) =>
      animation.playState === "running" && animation.effect.getKeyframes().some((frame) =>
        ["opacity", "fillOpacity", "strokeOpacity"].some((key) => key in frame))).length;
    return {
      painted: Number(text.style.fillOpacity),
      target: Number(style.labelFillOpacity),
      opacity: style.opacity,
      fillOpacity: style.fillOpacity,
      plate: plate ? { opacity: plate.style.opacity, fillOpacity: plate.style.fillOpacity } : null,
      z: Number(style.zIndex),
      box: paintedLabelBox(graph, id) as Box,
      fading: text.getAnimations().some((animation) => animation.playState === "running" &&
        animation.effect.getKeyframes().some((frame) => typeof frame.fillOpacity === "number")),
      opacityMotion: moving(text) + moving(plate) + moving(element.getShape("key")),
    };
  });
}, { name: graphName(canvas), ids });

/** The yielding name's covered fraction, by the same painted boxes the pass reads. */
function coverageOf(yielding: Box, other: Box) {
  const x = Math.min(yielding.maxX, other.maxX) - Math.max(yielding.minX, other.minX);
  const y = Math.min(yielding.maxY, other.maxY) - Math.max(yielding.minY, other.minY);
  return x > 0 && y > 0 ? x * y / ((yielding.maxX - yielding.minX) * (yielding.maxY - yielding.minY)) : 0;
}

/** Whether each name is shown at all — the display rules' channel, not crowding's. */
const shownNames = (page: Page, canvas: Canvas) => page.evaluate((name) => {
  const graph = (window as unknown as CanvasWindow)[name as "__worldFieldGraph"];
  return Object.fromEntries([...graph.getNodeData(), ...graph.getEdgeData()]
    .filter((datum) => typeof datum.style?.labelText === "string" && datum.style.labelText)
    .map((datum) => [String(datum.id), Number(datum.style!.labelOpacity ?? 1)]));
}, graphName(canvas));

const markPositions = (page: Page, canvas: Canvas) => page.evaluate((name) => {
  const graph = (window as unknown as CanvasWindow)[name as "__worldFieldGraph"];
  return Object.fromEntries(graph.getNodeData().map((node) =>
    [String(node.id), graph.getElementPosition(String(node.id)).slice(0, 2)]));
}, graphName(canvas));

/**
 * The names once their paint has stopped changing: no fade running on text,
 * plate or mark, ink on its target, and the same answer a few frames later. A
 * reading between a drop and its redraw is not a settled one.
 */
async function settledLabels(page: Page, canvas: Canvas, ids: string[]) {
  let last = "";
  let labels: Awaited<ReturnType<typeof labelsOf>> = [];
  await expect.poll(async () => {
    labels = await labelsOf(page, canvas, ids);
    const now = JSON.stringify(labels.map((label) => [label.painted, label.target, label.plate, label.box]));
    const still = now === last && labels.every((label) =>
      !label.fading && !label.opacityMotion && label.painted === label.target);
    last = now;
    if (!still) await settleFrames(page, 3);
    return still;
  }).toBe(true);
  return labels;
}

/**
 * Names standing with settled ink, out from under the docks, on a still camera.
 *
 * A pointer pressed where a mark was is only a press on that mark if the
 * camera has stopped moving it.
 */
async function settleNames(page: Page, canvas: Canvas, marks: string[], names = marks) {
  await expect.poll(() => page.evaluate(({ name, marks, names }) => {
    const graph = (window as unknown as Partial<CanvasWindow>)[name as "__worldFieldGraph"];
    return Boolean(graph && !graph.destroyed && marks.every((id) => graph.getNodeData().some((node) => node.id === id)) &&
      names.every((id) => Number(graph.getElementData(id).style!.labelOpacity ?? 1) > 0));
  }, { name: graphName(canvas), marks, names })).toBe(true);
  await page.evaluate(({ name, marks }) =>
    (window as unknown as CanvasWindow)[name as "__worldFieldGraph"].focusElement(marks, false),
  { name: graphName(canvas), marks });
  const viewport = () => page.evaluate(({ name, id }) => {
    const graph = (window as unknown as CanvasWindow)[name as "__worldFieldGraph"];
    return graph.getViewportByCanvas(graph.getElementPosition(id)).slice(0, 2).map(Math.round).join(",");
  }, { name: graphName(canvas), id: marks[0] });
  let last = "";
  await expect.poll(async () => {
    const now = await viewport();
    const still = now === last;
    last = now;
    return still && (await labelsOf(page, canvas, names)).every((label) => !label.fading && label.painted === label.target);
  }).toBe(true);
}

/**
 * A real pointer gesture: press on a mark, then steer one name against
 * another in screen space while the press is held.
 *
 * A mark's own name moves with it; a bond's name moves part of the way, so
 * the response is measured off the painted boxes rather than assumed.
 */
async function pressMark(page: Page, canvas: Canvas, mark: string) {
  const at = await page.evaluate(({ name, mark }) => {
    const graph = (window as unknown as CanvasWindow)[name as "__worldFieldGraph"];
    const [x, y] = graph.getViewportByCanvas(graph.getElementPosition(mark));
    const frame = graph.getCanvas().getContainer()!.getBoundingClientRect();
    return { x: frame.left + x, y: frame.top + y, zoom: graph.getZoom() };
  }, { name: graphName(canvas), mark });
  const start = await page.evaluate(({ name, mark }) =>
    (window as unknown as CanvasWindow)[name as "__worldFieldGraph"].getElementPosition(mark).slice(0, 2),
  { name: graphName(canvas), mark });
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  let pointer = { x: at.x, y: at.y };
  return {
    /** Where the pointer has put the held mark, beside where the canvas has it. */
    async ownership() {
      const actual = await page.evaluate(({ name, mark }) =>
        (window as unknown as CanvasWindow)[name as "__worldFieldGraph"].getElementPosition(mark).slice(0, 2),
      { name: graphName(canvas), mark });
      return {
        expected: [start[0] + (pointer.x - at.x) / at.zoom, start[1] + (pointer.y - at.y) / at.zoom],
        actual,
      };
    },
    /** Bring `moving`'s box to start `coverage` of its width short of `other`'s end, tops level. */
    async steer(moving: string, other: string, coverage: number) {
      let gain = 1;
      for (let round = 0; round < 8; round += 1) {
        const [a, b] = (await labelsOf(page, canvas, [moving, other])).map((label) => label.box);
        const error = {
          x: b.minX + (a.maxX - a.minX) * (1 - coverage) - a.minX,
          y: b.minY - a.minY,
        };
        if (Math.abs(error.x) < 0.5 && Math.abs(error.y) < 0.5) return;
        const step = { x: error.x / gain, y: error.y / gain };
        pointer = { x: pointer.x + step.x * at.zoom, y: pointer.y + step.y * at.zoom };
        await page.mouse.move(pointer.x, pointer.y, { steps: 8 });
        await settleFrames(page, 2);
        const [moved] = (await labelsOf(page, canvas, [moving])).map((label) => label.box);
        const travel = Math.hypot(moved.minX - a.minX, moved.minY - a.minY);
        const asked = Math.hypot(step.x, step.y);
        if (asked > 1 && travel > 0) gain = Math.min(1.5, Math.max(0.25, travel / asked));
      }
    },
    release: () => page.mouse.up(),
  };
}

/** A chain 0–1–2–3 with Entity 1 selected: two bond names meet at its junction. */
async function junction(page: Page, world: FixtureWorld, spread = true, count = 3) {
  world.count = count;
  world.binary = true;
  await gotoWithSpread(page, spread);
  await openPropertyTable(page);
  await readRow(page, 0);
  await readRow(page, 1);
  await readRow(page, 2);
  await selectReferent(page, "entity:1");
  await expect(reader(page).locator("h2")).toHaveText("Entity 1");
  const bonds = ["bond:assertion:0", "bond:assertion:1"];
  await settleNames(page, "field", ["entity:0", "entity:1", "entity:2"], bonds);
  return bonds;
}

/*
 * The two historical crowding checks below once overlapped names written on
 * two discs. A disc's name only overlaps another disc's name when one body
 * covers the other's name, and a covered name presses nothing — so that
 * scene could only "yield" through a stale depth or between a drop and its
 * redraw. They now stage a contest between two visible names: bond names
 * meeting at a junction on the field, and the vocabulary's own pair.
 */
test("the field paints partial crowding and recovers without changing mark opacity", async ({ page, world }, testInfo) => {
  test.skip(!VISIBILITY_STRENGTHS_ON, CROWDING_OFF);
  // The fan off, so the crowding a drop leaves is still standing to be read.
  const bonds = await junction(page, world, false);
  const marks = ["entity:0", "entity:1", "entity:2"];
  const [top, beneath] = await settledLabels(page, "field", bonds);
  const discs = await settledLabels(page, "field", marks);
  const place = async (coverage: number) => {
    const hold = await pressMark(page, "field", "entity:0");
    await hold.steer(bonds[0], bonds[1], coverage);
    await hold.release();
  };

  await place(0.3);
  const [over, yielding] = await settledLabels(page, "field", bonds);
  const coverage = coverageOf(yielding.box, over.box);
  expect(coverage).toBeGreaterThan(0.2);
  expect(coverage).toBeLessThan(0.45);
  // Partial: weaker than its authored ink, still above the whisper.
  expect(yielding.painted).toBeLessThan(beneath.target);
  expect(yielding.painted).toBeGreaterThan(beneath.target * 0.25);
  expect(over.painted).toBe(top.target);
  // Only the text channel moved: plates and marks keep their authored paint.
  expect(yielding.plate).toEqual(beneath.plate);
  expect(over.plate).toEqual(top.plate);
  expect((await labelsOf(page, "field", marks)).map(({ opacity, fillOpacity }) => ({ opacity, fillOpacity })))
    .toEqual(discs.map(({ opacity, fillOpacity }) => ({ opacity, fillOpacity })));
  await page.screenshot({ path: testInfo.outputPath("partial-crowding.png") });

  await place(-2);
  const apart = await settledLabels(page, "field", bonds);
  expect(coverageOf(apart[1].box, apart[0].box)).toBe(0);
  expect(apart.map((label) => label.painted)).toEqual([top.target, beneath.target]);
  expect((await labelsOf(page, "field", marks)).map(({ opacity, fillOpacity }) => ({ opacity, fillOpacity })))
    .toEqual(discs.map(({ opacity, fillOpacity }) => ({ opacity, fillOpacity })));
});

for (const canvas of ["field", "vocabulary"] as const) {
  test(`${canvas} text follows crowding before a drag is released`, async ({ page, world }) => {
    test.skip(!VISIBILITY_STRENGTHS_ON, CROWDING_OFF);
    // `held` is pressed; `moving` is the name it carries, steered against
    // `still`; `yielding` is the visible name that loses the contest, and
    // `rival` the one that wins.
    let scene: { held: string; moving: string; still: string; yielding: string; rival: string };
    if (canvas === "field") {
      const [rival, yielding] = await junction(page, world);
      scene = { held: "entity:0", moving: rival, still: yielding, yielding, rival };
    } else {
      world.count = 2;
      world.binary = true;
      await page.goto("/");
      await expect.poll(() => vocabularyText(page)).toBe(0.85);
      await page.evaluate(() => {
        (window as unknown as CanvasWindow).__worldVocabulary.emit("node:click", { target: { id: "rel:property" } });
      });
      await expect(reader(page).locator("h2")).toHaveText("property");
      await settleNames(page, "vocabulary", ["kind:entity", "rel:property"]);
      scene = { held: "kind:entity", moving: "kind:entity", still: "rel:property", yielding: "kind:entity", rival: "rel:property" };
    }
    const ids = [scene.yielding, scene.rival];
    // Establish the scene without lifecycle travel, then exercise the gesture
    // with ordinary motion enabled.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const [rest, winner] = await labelsOf(page, canvas, ids);

    const hold = await pressMark(page, canvas, scene.held);
    const strengths: number[] = [];
    for (const coverage of [0.2, 0.35, 0.5]) {
      await hold.steer(scene.moving, scene.still, coverage);
      const [yielding, rival] = await labelsOf(page, canvas, ids);
      expect(coverageOf(yielding.box, rival.box)).toBeGreaterThan(coverage - 0.08);
      // Ink is where the crowding says, on this frame: nothing trails the hand.
      expect(yielding.painted).toBeCloseTo(yielding.target, 6);
      expect(yielding.fading).toBe(false);
      expect(yielding.opacityMotion + rival.opacityMotion).toBe(0);
      expect(yielding.painted).toBeLessThan(rest.target);
      expect(yielding.painted).toBeGreaterThan(rest.target * 0.25);
      expect(rival.painted).toBe(winner.target);
      // The pointer still owns where the held mark is.
      const { expected, actual } = await hold.ownership();
      expect(actual[0]).toBeCloseTo(expected[0], 0);
      expect(actual[1]).toBeCloseTo(expected[1], 0);
      strengths.push(yielding.painted);
    }
    // Progressive: more overlap, less ink.
    expect(strengths[1]).toBeLessThan(strengths[0]);
    expect(strengths[2]).toBeLessThan(strengths[1]);

    // Apart again before letting go: recovered while still held.
    await hold.steer(scene.moving, scene.still, -2);
    const [clear] = await labelsOf(page, canvas, ids);
    expect(clear.painted).toBe(rest.target);
    expect(clear.fading).toBe(false);
    await hold.release();
    await expect.poll(async () => (await labelsOf(page, canvas, ids))[0].painted).toBe(rest.target);
  });
}

for (const motion of ["reduce", "no-preference"] as const) {
  test(`vocabulary names yield under a held pointer and recover with ${motion} motion`, async ({ page, world }) => {
    test.skip(!VISIBILITY_STRENGTHS_ON, CROWDING_OFF);
    const problems: string[] = [];
    page.on("pageerror", (problem) => problems.push(String(problem)));
    world.count = 2;
    world.binary = true;
    await page.emulateMedia({ reducedMotion: motion });
    await page.goto("/");
    await expect.poll(() => vocabularyText(page)).toBe(0.85);
    await page.evaluate(() => {
      (window as unknown as CanvasWindow).__worldVocabulary.emit("node:click", { target: { id: "rel:property" } });
    });
    await expect(reader(page).locator("h2")).toHaveText("property");
    const ids = ["kind:entity", "rel:property"];
    await settleNames(page, "vocabulary", ids);
    const [rest, selected] = await labelsOf(page, "vocabulary", ids);
    const shown = await shownNames(page, "vocabulary");

    const hold = await pressMark(page, "vocabulary", ids[0]);
    await hold.steer(ids[0], ids[1], 0.3);
    const [partial, other] = await labelsOf(page, "vocabulary", ids);
    expect(coverageOf(partial.box, other.box)).toBeGreaterThan(0.2);
    expect(partial.target).toBeLessThan(rest.target);
    expect(partial.target).toBeGreaterThan(rest.target * 0.25);
    // Ink tracks the hand: no fade trailing behind the pointer.
    expect(partial.painted).toBeCloseTo(partial.target, 6);
    expect(partial.fading).toBe(false);
    expect(other.target).toBe(selected.target);
    await hold.steer(ids[0], ids[1], 0.55);
    const [crowded] = await labelsOf(page, "vocabulary", ids);
    expect(crowded.painted).toBeLessThan(partial.painted);
    expect(crowded.painted).toBeGreaterThanOrEqual(rest.target * 0.25 - 1e-9);
    await hold.steer(ids[0], ids[1], -2);
    const [clear] = await labelsOf(page, "vocabulary", ids);
    expect(clear.painted).toBe(rest.target);
    expect(clear.fading).toBe(false);
    const dropped = (await markPositions(page, "vocabulary"))[ids[0]];
    await hold.release();

    await expect.poll(async () => (await labelsOf(page, "vocabulary", ids))[0].painted).toBe(rest.target);
    const [settled] = await labelsOf(page, "vocabulary", ids);
    // Strength is the only thing contested: the mark keeps its paint, the
    // drop keeps its place (to the whole pixel the field stores), and every
    // name a display rule hid stays hidden.
    expect(settled).toMatchObject({ opacity: rest.opacity, fillOpacity: rest.fillOpacity });
    const kept = (await markPositions(page, "vocabulary"))[ids[0]];
    expect(Math.abs(kept[0] - dropped[0])).toBeLessThanOrEqual(0.5);
    expect(Math.abs(kept[1] - dropped[1])).toBeLessThanOrEqual(0.5);
    expect(await shownNames(page, "vocabulary")).toEqual(shown);
    expect(problems).toEqual([]);
  });
}

for (const motion of ["reduce", "no-preference"] as const) {
  test(`field names at a junction yield under a held pointer and recover with ${motion} motion`, async ({ page, world }) => {
    test.skip(!VISIBILITY_STRENGTHS_ON, CROWDING_OFF);
    const problems: string[] = [];
    page.on("pageerror", (problem) => problems.push(String(problem)));
    await page.emulateMedia({ reducedMotion: motion });
    const bonds = await junction(page, world);
    const [top, beneath] = await labelsOf(page, "field", bonds);
    // Rank and paint agree: the incumbent is the one on top.
    expect(top.z).toBeGreaterThan(beneath.z);
    const [disc] = await labelsOf(page, "field", ["entity:0"]);
    const shown = await shownNames(page, "field");

    const hold = await pressMark(page, "field", "entity:0");
    await hold.steer(bonds[0], bonds[1], 0.3);
    const [over, partial] = await labelsOf(page, "field", bonds);
    expect(coverageOf(partial.box, over.box)).toBeGreaterThan(0.2);
    expect(partial.target).toBeLessThan(beneath.target);
    expect(partial.target).toBeGreaterThan(beneath.target * 0.25);
    expect(partial.painted).toBeCloseTo(partial.target, 6);
    expect(partial.fading).toBe(false);
    expect(over.target).toBe(top.target);
    await hold.steer(bonds[0], bonds[1], 0.55);
    const [, crowded] = await labelsOf(page, "field", bonds);
    expect(crowded.painted).toBeLessThan(partial.painted);
    expect(crowded.painted).toBeGreaterThanOrEqual(beneath.target * 0.25 - 1e-9);
    await hold.steer(bonds[0], bonds[1], -2);
    const [, clear] = await labelsOf(page, "field", bonds);
    expect(clear.painted).toBe(beneath.target);
    expect(clear.fading).toBe(false);
    await hold.release();

    await expect.poll(async () => (await labelsOf(page, "field", bonds)).map((label) => label.painted))
      .toEqual([top.target, beneath.target]);
    expect((await labelsOf(page, "field", ["entity:0"]))[0])
      .toMatchObject({ opacity: disc.opacity, fillOpacity: disc.fillOpacity });
    expect(await shownNames(page, "field")).toEqual(shown);
    expect(problems).toEqual([]);
  });
}

/**
 * Every shown name whose ink disagrees with its stored strength — on the
 * painted text, or in the attributes the next partial restyle starts from.
 */
const inkDisagreements = (page: Page, canvas: Canvas) => page.evaluate((name) => {
  const graph = (window as unknown as CanvasWindow)[name as "__worldFieldGraph"];
  type Held = { attributes: Record<string, unknown> };
  const context = (graph as unknown as {
    context: { element: { getElement: (id: string) => (Held & {
      getShape: (name: string) => (Held & { getShape: (name: string) => LabelShape | undefined }) | undefined;
    }) | undefined } };
  }).context;
  return [...graph.getNodeData(), ...graph.getEdgeData()]
    .filter((datum) => typeof datum.style?.labelText === "string" && datum.style.labelText &&
      Number(datum.style.labelOpacity ?? 1) > 0)
    .flatMap((datum) => {
      const element = context.element.getElement(String(datum.id));
      const label = element?.getShape("label");
      const stored = Number(datum.style!.labelFillOpacity ?? 1);
      const ink = {
        painted: Number(label?.getShape("text")?.style.fillOpacity),
        element: Number(element?.attributes.labelFillOpacity ?? 1),
        label: Number(label?.attributes.fillOpacity ?? 1),
      };
      return Object.values(ink).every((value) => value === stored) ? [] : [{ id: String(datum.id), stored, ...ink }];
    });
}, graphName(canvas));

/** Hover a mark with the real pointer, then leave it for empty canvas. */
async function hoverAndLeave(page: Page, canvas: Canvas, mark: string) {
  const at = await page.evaluate(({ name, mark }) => {
    const graph = (window as unknown as CanvasWindow)[name as "__worldFieldGraph"];
    const [x, y] = graph.getViewportByCanvas(graph.getElementPosition(mark));
    const frame = graph.getCanvas().getContainer()!.getBoundingClientRect();
    return { x: frame.left + x, y: frame.top + y, right: frame.right, bottom: frame.bottom };
  }, { name: graphName(canvas), mark });
  await page.mouse.move(at.x, at.y, { steps: 4 });
  await expect.poll(() => inkDisagreements(page, canvas)).toEqual([]);
  await page.mouse.move(at.right - 420, at.bottom - 60, { steps: 4 });
  await expect.poll(() => inkDisagreements(page, canvas)).toEqual([]);
}

for (const canvas of ["field", "vocabulary"] as const) {
  for (const motion of ["reduce", "no-preference"] as const) {
    test(`${canvas} strengths committed without a redraw survive restyles and draws with ${motion} motion`, async ({ page, world }) => {
      test.skip(!VISIBILITY_STRENGTHS_ON, CROWDING_OFF);
      await page.emulateMedia({ reducedMotion: motion });
      // `yielding` is left crowded by a released drag; nothing moves it after.
      let scene: { held: string; moving: string; still: string; yielding: string; hover: string };
      if (canvas === "field") {
        const bonds = await junction(page, world, false, 4);
        scene = { held: "entity:0", moving: bonds[0], still: bonds[1], yielding: bonds[1], hover: "entity:2" };
      } else {
        world.count = 2;
        world.binary = true;
        await page.goto("/");
        await expect.poll(() => vocabularyText(page)).toBe(0.85);
        await page.evaluate(() => {
          (window as unknown as CanvasWindow).__worldVocabulary.emit("node:click", { target: { id: "rel:property" } });
        });
        await expect(reader(page).locator("h2")).toHaveText("property");
        await settleNames(page, "vocabulary", ["kind:entity", "rel:property"]);
        scene = { held: "kind:entity", moving: "kind:entity", still: "rel:property", yielding: "kind:entity", hover: "rel:property" };
      }
      const [rest] = await settledLabels(page, canvas, [scene.yielding]);
      const hold = await pressMark(page, canvas, scene.held);
      await hold.steer(scene.moving, scene.still, 0.35);
      await hold.release();
      const [crowded] = await settledLabels(page, canvas, [scene.yielding]);
      expect(crowded.painted).toBeLessThan(rest.target);
      expect(await inkDisagreements(page, canvas)).toEqual([]);

      // A restyle updates an element with only what changed, over the
      // attributes it already holds; the committed strength must be among
      // them, or the name jumps back to its last drawn ink. Hover restyles
      // nothing here; moving the selection on restyles the bond names' colours.
      await hoverAndLeave(page, canvas, scene.hover);
      const [hovered] = await settledLabels(page, canvas, [scene.yielding]);
      expect(hovered.painted).toBe(crowded.painted);
      if (canvas === "field") {
        await selectReferent(page, "entity:2");
        await expect(reader(page).locator("h2")).toHaveText("Entity 2");
      } else {
        await page.evaluate(() => (window as unknown as CanvasWindow).__worldVocabulary.emit("canvas:click", {}));
        await expect(reader(page).locator("h2")).not.toHaveText("property");
      }
      await settleFrames(page, 6);
      const restyled = await settledLabels(page, canvas, [scene.yielding]);
      expect(await inkDisagreements(page, canvas)).toEqual([]);

      // A full draw rebuilds from the store, which carries the same strength.
      await page.evaluate((name) => (window as unknown as CanvasWindow)[name as "__worldFieldGraph"].draw(), graphName(canvas));
      const [drawn] = await settledLabels(page, canvas, [scene.yielding]);
      expect(drawn.painted).toBe(restyled[0].painted);
      expect(await inkDisagreements(page, canvas)).toEqual([]);

      // Only the text moved: the plate and the mark keep their authored paint.
      expect(drawn.plate?.opacity).toEqual(rest.plate?.opacity);
      expect(drawn.plate?.fillOpacity).toEqual(rest.plate?.fillOpacity);
      expect({ opacity: drawn.opacity, fillOpacity: drawn.fillOpacity })
        .toEqual({ opacity: rest.opacity, fillOpacity: rest.fillOpacity });

      if (canvas === "field") {
        // A name that did not exist yet is built and shown at its stated ink.
        await readRow(page, 3);
        await expect.poll(() => page.evaluate(() =>
          (window as unknown as CanvasWindow).__worldFieldGraph.getNodeData().some((node) => node.id === "entity:4"))).toBe(true);
        await expect.poll(() => inkDisagreements(page, "field")).toEqual([]);
        const [born] = await settledLabels(page, "field", ["entity:4"]);
        expect(born.painted).toBe(born.target);
        expect(born.painted).toBeGreaterThan(0);
      }
    });
  }
}

for (const motion of ["reduce", "no-preference"] as const) {
  test(`a held disc keeps its own name over a name its body covers, through release, with ${motion} motion`, async ({ page, world }) => {
    world.count = 2;
    await page.emulateMedia({ reducedMotion: motion });
    await openProperty(page);
    await readRow(page, 0);
    await readRow(page, 1);
    await reader(page).locator(".world__roles button").click();
    await expect(reader(page).locator("h2")).toHaveText("Entity 1");
    const ids = ["entity:0", "entity:1"];
    await settleNames(page, "field", ids);
    const rest = await labelsOf(page, "field", ids);

    // The held disc is painted above its neighbour from the grab, and the
    // selected name it crosses lies wholly under its body: an invisible
    // rival, which presses nothing — not while held, and not after the drop
    // restacks the disc where it was already painted.
    const hold = await pressMark(page, "field", ids[0]);
    await hold.steer(ids[0], ids[1], 0.3);
    const held = await labelsOf(page, "field", ids);
    expect(coverageOf(held[1].box, held[0].box)).toBeGreaterThan(0.2);
    expect(held.map((label) => label.target)).toEqual(rest.map((label) => label.target));
    await hold.steer(ids[0], ids[1], 0.55);
    expect((await labelsOf(page, "field", ids)).map((label) => label.target))
      .toEqual(rest.map((label) => label.target));
    await hold.release();
    await expect.poll(async () => {
      const [a, b] = await labelsOf(page, "field", ids);
      return a.z > b.z;
    }).toBe(true);
    await settleFrames(page, 6);
    const dropped = await labelsOf(page, "field", ids);
    expect(dropped.map((label) => [label.target, label.painted, label.fading]))
      .toEqual(rest.map((label) => [label.target, label.target, false]));
  });
}

for (const motion of ["reduce", "no-preference"] as const) {
  test(`a selection that withdraws a crowding name lets its neighbour read, moving nothing, with ${motion} motion`, async ({ page, world }) => {
    test.skip(!VISIBILITY_STRENGTHS_ON, CROWDING_OFF);
    await page.emulateMedia({ reducedMotion: motion });
    // The fan off, so the crowding the drop leaves is still there to settle.
    const bonds = await junction(page, world, false);
    const [top, beneath] = await labelsOf(page, "field", bonds);
    const hold = await pressMark(page, "field", "entity:0");
    await hold.steer(bonds[0], bonds[1], 0.35);
    await hold.release();
    await expect.poll(async () => {
      const [over, under] = await labelsOf(page, "field", bonds);
      return over.target === top.target && under.target < beneath.target && under.painted === under.target;
    }).toBe(true);
    const placed = await markPositions(page, "field");

    // Reading the claim beneath moves the light: naming reach withdraws the
    // other bond's name, and a name that is not shown presses nothing. The
    // withdrawn name stays withdrawn — crowding writes ink, never presence.
    await readRow(page, 1);
    await expect.poll(async () => (await shownNames(page, "field"))[bonds[0]]).toBe(0);
    await expect.poll(async () => {
      const [, under] = await labelsOf(page, "field", bonds);
      return under.target === beneath.target && under.painted === under.target && !under.fading;
    }).toBe(true);
    expect((await shownNames(page, "field"))[bonds[0]]).toBe(0);
    expect(await markPositions(page, "field")).toEqual(placed);
  });
}

test("an assertion stays readable until its replacement arrives", async ({ page, world }) => {
  await openProperty(page);
  await readRow(page, 0);
  const gate = world.block("assertion:assertion:1");
  await rows(page).nth(1).click();
  await gate.requested;
  await expect(reader(page)).toContainText("value-0");
  await expect(reader(page)).not.toContainText("Reading assertion");
  gate.release();
  await expect(reader(page)).toContainText("value-1");
});

test("a referent stays readable until its replacement arrives", async ({ page, world }) => {
  await openProperty(page);
  await readRow(page, 0);
  await readRow(page, 1);
  await reader(page).locator(".world__roles button").click();
  await expect(reader(page).locator("h2")).toHaveText("Entity 1");
  const gate = world.block("referent:entity:0");
  await selectReferent(page, "entity:0");
  await gate.requested;
  await expect(reader(page).locator("h2")).toHaveText("Entity 1");
  gate.release();
  await expect(reader(page).locator("h2")).toHaveText("Entity 0");
});

test("a retained assertion's remove button leaves the newly selected referent", async ({ page, world }) => {
  await openProperty(page);
  await readRow(page, 0);
  const gate = world.block("referent:entity:0");
  await reader(page).locator(".world__roles button").click();
  await gate.requested;
  await reader(page).getByRole("button", { name: "Take off the field", exact: true }).click();
  await expect.poll(async () => (await field(page))?.assertions.length).toBe(0);
  expect((await field(page))?.referents.map(([id]) => id)).toEqual(["entity:0"]);
  gate.release();
  await expect(reader(page).locator("h2")).toHaveText("Entity 0");
});

test("a retained assertion can still open its own bond", async ({ page, world }) => {
  world.binary = true;
  await openProperty(page);
  await readRow(page, 0);
  const gate = world.block("referent:entity:0");
  await reader(page).locator(".world__roles button").first().click();
  await gate.requested;
  await reader(page).getByRole("button", { name: "Open on the field", exact: true }).click();
  await expect.poll(async () => (await field(page))?.assertions.map(([id]) => id)).toEqual(["assertion:0"]);
  expect((await field(page))?.bonds).toHaveLength(0);
  gate.release();
});

test("a retained referent expands and retracts its own neighborhood", async ({ page, world }) => {
  world.binary = true;
  world.hub = true;
  await openProperty(page);
  await readRow(page, 0);
  await reader(page).locator(".world__roles button").first().click();
  await expect(reader(page).locator("h2")).toHaveText("Entity 0");
  const gate = world.block("referent:entity:1");
  await selectReferent(page, "entity:1");
  await gate.requested;
  const expand = reader(page).locator(".gm__list button").filter({ hasText: "property" }).first();
  const claims = async () => {
    const current = await field(page);
    return (current?.assertions.length ?? 0) + (current?.bonds.length ?? 0);
  };
  await expand.click();
  await expect.poll(claims).toBe(3);
  expect(world.requests.filter((url) => url.pathname === "/world/rows" && url.searchParams.has("subject"))
    .map((url) => url.searchParams.get("subject"))).toEqual(["entity:0"]);
  await expect(expand).toContainText("take off");
  await expand.click();
  await expect.poll(claims).toBe(0);
  gate.release();
  await expect(reader(page).locator("h2")).toHaveText("Entity 1");
});

test("a failed replacement shows its error rather than the previous claim", async ({ page, world }) => {
  await openProperty(page);
  await readRow(page, 0);
  const gate = world.block("assertion:assertion:1", 500);
  await rows(page).nth(1).click();
  await gate.requested;
  await expect(reader(page)).toContainText("value-0");
  gate.release();
  await expect(reader(page).getByRole("alert")).toBeVisible();
  await expect(reader(page)).not.toContainText("value-0");
});

test("frontier reads settle after selection and table changes", async ({ page, world }) => {
  await openProperty(page);
  await readRow(page, 0);
  const demand = world.block("demand");
  const obligations = world.block("obligations");
  await page.getByRole("button", { name: "purpose frontier", exact: true }).first().click();
  await Promise.all([demand.requested, obligations.requested]);
  await selectReferent(page, "entity:0");
  await page.getByRole("button", { name: "obligations", exact: true }).first().click();
  demand.release();
  obligations.release();
  await expect(activeTable(page, "governed obligations").locator(".table__meta")).toContainText("0 governed obligations");
  await page.getByRole("button", { name: "purpose frontier", exact: true }).first().click();
  const frontier = activeTable(page, "unresolved frontier").locator(".table__meta");
  await expect(frontier).toContainText("0 unresolved of 0 obligations");
  await expect(frontier).not.toContainText("Reading");
  expect(world.requests.filter((url) => url.pathname === "/world/demand")).toHaveLength(1);
  expect(world.requests.filter((url) => url.pathname === "/world/obligations")).toHaveLength(1);
});

/**
 * A 250-mark expansion reads its pages one after another, then draws: under
 * a full parallel run that can take longer than the default 5 s poll. The
 * wait is longer; what is waited for is the same.
 */
const EXPANSION_WAIT = { timeout: 15_000 };

test("expansion reads every page and can retract the whole neighborhood", async ({ page, world }) => {
  world.count = 250;
  world.hub = true;
  await openProperty(page);
  await readRow(page, 0);
  await reader(page).locator(".world__roles button").click();
  const expand = reader(page).locator(".gm__list button").filter({ hasText: "property" }).first();
  await expand.click();
  await expect.poll(async () => (await field(page))?.assertions.length, EXPANSION_WAIT).toBe(250);
  await expect(expand).toContainText("take off");
  const offsets = world.requests.filter((url) => url.pathname === "/world/rows" && url.searchParams.get("subject") === "entity:0")
    .map((url) => Number(url.searchParams.get("offset")));
  expect(offsets).toEqual([0, 200]);
  await expand.click();
  await expect.poll(async () => (await field(page))?.assertions.length).toBe(0);
});

test("a failed expansion page retains its earlier page and retries", async ({ page, world }) => {
  world.count = 250;
  world.hub = true;
  await openProperty(page);
  await readRow(page, 0);
  await reader(page).locator(".world__roles button").click();
  const gate = world.block("rows:200", 500);
  const expand = reader(page).locator(".gm__list button").filter({ hasText: "property" }).first();
  await expand.click();
  await gate.requested;
  await expect.poll(async () => (await field(page))?.assertions.length).toBe(200);
  gate.release();
  await expect(expand).toContainText("retry");
  await expand.click();
  await expect.poll(async () => (await field(page))?.assertions.length, EXPANSION_WAIT).toBe(250);
});

test("removing an expansion's anchor discards its outstanding page", async ({ page, world }) => {
  world.count = 250;
  world.hub = true;
  await openProperty(page);
  await readRow(page, 0);
  await reader(page).locator(".world__roles button").click();
  const gate = world.block("rows:200");
  await reader(page).locator(".gm__list button").filter({ hasText: "property" }).first().click();
  await gate.requested;
  await reader(page).getByRole("button", { name: "Take off the field", exact: true }).click();
  gate.release();
  await expect.poll(() => field(page)).toBeNull();
  await page.getByRole("button", { name: "world", exact: true }).first().click();
  await expect(worldRow(page, "property")).not.toHaveAttribute("data-present", "true");
});

/**
 * Which marks the canvas wrote at zero, from now on.
 *
 * A lifecycle birth is written at opacity 0 and then grown to its authored
 * pose, and a lifecycle collapse writes a leaving mark at 0 before removing
 * it. A still frame writes the authored pose and removes outright, so zero is
 * never written. Read at the writes, not per frame: a pose can be gone before
 * the next frame samples it.
 */
async function watchPoses(page: Page) {
  await page.evaluate(() => {
    type Poses = { zero: Set<string> };
    const holder = window as unknown as { __poses?: Poses; __posesGraph?: unknown };
    holder.__poses = { zero: new Set<string>() };
    const graph = (window as unknown as CanvasWindow).__worldFieldGraph as unknown as {
      setData: (data: { nodes?: { id: string; style?: { opacity?: unknown } }[] }) => unknown;
      updateNodeData: (nodes: { id: string; style?: { opacity?: unknown } }[]) => unknown;
    };
    if (holder.__posesGraph === graph) return;
    holder.__posesGraph = graph;
    const note = (nodes: { id: string; style?: { opacity?: unknown } }[] | undefined) => {
      for (const node of nodes ?? []) {
        if (node.style?.opacity === 0) holder.__poses!.zero.add(String(node.id));
      }
    };
    const setData = graph.setData.bind(graph);
    graph.setData = (data) => { note(data.nodes); return setData(data); };
    const updateNodeData = graph.updateNodeData.bind(graph);
    graph.updateNodeData = (nodes) => { note(nodes); return updateNodeData(nodes); };
  });
}

async function posesSince(page: Page) {
  return page.evaluate(() => ({
    zero: [...(window as unknown as { __poses: { zero: Set<string> } }).__poses.zero],
  }));
}

const fieldMarks = (page: Page) => page.evaluate(() =>
  (window as unknown as CanvasWindow).__worldFieldGraph.getNodeData().map((node) => String(node.id)));

test("a small expansion keeps its births", async ({ page, world }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  world.count = 10;
  world.hub = true;
  await openProperty(page);
  await readRow(page, 0);
  await reader(page).locator(".world__roles button").click();
  await expect(reader(page).locator("h2")).toHaveText("Entity 0");
  const before = new Set(await fieldMarks(page));
  await watchPoses(page);
  const expand = reader(page).locator(".gm__list button").filter({ hasText: "property" }).first();
  await expand.click();
  await expect(expand).toContainText("take off");
  await expect.poll(async () => (await fieldMarks(page)).length).toBe(11);
  const born = (await fieldMarks(page)).filter((id) => !before.has(id));
  expect(born).toHaveLength(9);
  // Each neighbour nucleated: posed at zero before it grew.
  const { zero } = await posesSince(page);
  expect(born.filter((id) => !zero.includes(id))).toEqual([]);
});

test("a large expansion arrives and leaves still, and the next arrival is born again", async ({ page, world }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  world.count = 250;
  world.hub = true;
  await openProperty(page);
  await readRow(page, 0);
  await reader(page).locator(".world__roles button").click();
  await expect(reader(page).locator("h2")).toHaveText("Entity 0");
  const before = new Set(await fieldMarks(page));
  await watchPoses(page);
  // Both pages answer at once, so the request loop is done long before the
  // field has drawn the first: the second page's frame comes after it.
  const expand = reader(page).locator(".gm__list button").filter({ hasText: "property" }).first();
  await expand.click();
  await expect.poll(async () => (await field(page))?.assertions.length, EXPANSION_WAIT).toBe(250);
  await expect.poll(async () => (await fieldMarks(page)).length).toBe(251);
  const born = (await fieldMarks(page)).filter((id) => !before.has(id));
  expect(born).toHaveLength(249);
  // One admission: no neighbour, of either page, nucleated.
  expect((await posesSince(page)).zero).toEqual([]);

  // Taking it off is one withdrawal: nothing fades out mark by mark.
  await selectReferent(page, "entity:0");
  await expect(reader(page).locator("h2")).toHaveText("Entity 0");
  await watchPoses(page);
  await expand.click();
  await expect.poll(async () => (await field(page))?.assertions.length).toBe(0);
  await expect.poll(async () => (await fieldMarks(page)).filter((id) => id.startsWith("assertion:"))).toEqual([]);
  expect((await posesSince(page)).zero).toEqual([]);

  // And the hold is gone with it: the next single read is born as ever.
  await watchPoses(page);
  await readRow(page, 3);
  await expect.poll(async () => (await fieldMarks(page)).includes("assertion:3")).toBe(true);
  await expect.poll(async () => (await posesSince(page)).zero).toContain("assertion:3");
});

test("a later page released into a selection still arrives still", async ({ page, world }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  world.count = 250;
  world.hub = true;
  await openProperty(page);
  await readRow(page, 0);
  await reader(page).locator(".world__roles button").click();
  await expect(reader(page).locator("h2")).toHaveText("Entity 0");
  await watchPoses(page);
  // The second page held until the first has drawn, then released into a
  // selection, so its frame has something else to coalesce with.
  const gate = world.block("rows:200");
  await reader(page).locator(".gm__list button").filter({ hasText: "property" }).first().click();
  await gate.requested;
  await expect.poll(async () => (await fieldMarks(page)).length).toBe(201);
  gate.release();
  await selectReferent(page, "assertion:7");
  await expect.poll(async () => (await field(page))?.assertions.length, EXPANSION_WAIT).toBe(250);
  await expect.poll(async () => (await fieldMarks(page)).length).toBe(251);
  expect((await posesSince(page)).zero).toEqual([]);
});

test("a still frame waiting behind a press stays still when something replaces it", async ({ page, world }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  world.count = 250;
  world.hub = true;
  await openProperty(page);
  await readRow(page, 0);
  await reader(page).locator(".world__roles button").click();
  await expect(reader(page).locator("h2")).toHaveText("Entity 0");
  const expand = reader(page).locator(".gm__list button").filter({ hasText: "property" }).first();
  await watchPoses(page);
  // A mark held in a drag holds the lane, so the expansion's frames wait
  // undrawn; the drag outlives the click's own release.
  await emitField(page, "node:pointerdown", "entity:0");
  await emitField(page, "node:dragstart", "entity:0");
  await expand.click();
  await expect.poll(async () => (await field(page))?.assertions.length, EXPANSION_WAIT).toBe(250);
  expect(await fieldMarks(page)).toHaveLength(2);
  // The admission has landed and let go of its hold; a selection now builds
  // a frame of its own, which replaces the one still waiting.
  await selectReferent(page, "assertion:0");
  await expect(reader(page).locator("h2")).toHaveText("property");
  await emitField(page, "node:dragend", "entity:0");
  await expect.poll(async () => (await fieldMarks(page)).length).toBe(251);
  expect((await posesSince(page)).zero).toEqual([]);
});

test("a large expansion keeps every identity, value and standing place, and restores as stored", async ({ page, world }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  world.count = 250;
  world.hub = true;
  type Stored = {
    assertions: [string, {
      relation: string;
      origin: string;
      spokes: { role: string; id: string }[];
      scalars: { role: string; value: unknown }[];
    }][];
    positions: [string, { x: number; y: number }][];
  };
  const stored = async () => (await field(page)) as unknown as Stored;
  await openProperty(page);
  await readRow(page, 0);
  await reader(page).locator(".world__roles button").click();
  await expect(reader(page).locator("h2")).toHaveText("Entity 0");
  const standing = new Map((await stored()).positions);
  expect([...standing.keys()].sort()).toEqual(["assertion:0", "entity:0"]);
  const expand = reader(page).locator(".gm__list button").filter({ hasText: "property" }).first();
  await expand.click();
  await expect(expand).toContainText("take off");
  await expect.poll(async () => (await field(page))?.assertions.length, EXPANSION_WAIT).toBe(250);
  const after = await stored();
  // Every tuple, once, exactly as the rows gave it.
  const ids = after.assertions.map(([id]) => id);
  expect(new Set(ids).size).toBe(250);
  expect([...ids].sort()).toEqual(Array.from({ length: 250 }, (_, i) => `assertion:${i}`).sort());
  for (const [id, claim] of after.assertions) {
    const i = Number(id.split(":")[1]);
    expect(claim.relation).toBe("property");
    expect(claim.origin).toBe("SEMANTIC");
    expect(claim.spokes).toEqual([{ role: "item", id: "entity:0" }]);
    expect(claim.scalars).toEqual([{ role: "value", value: `value-${i}` }]);
  }
  // What stood before the expansion stands where it stood; everything new has
  // a place of its own.
  const placed = new Map(after.positions);
  for (const [id, at] of standing) expect(placed.get(id), id).toEqual(at);
  for (const id of ids) {
    const at = placed.get(id);
    expect(Number.isFinite(at?.x) && Number.isFinite(at?.y), id).toBe(true);
  }
  // A reload puts back the same field, from storage rather than from the rows.
  const rowReads = () => world.requests.filter((url) =>
    url.pathname === "/world/rows" && url.searchParams.get("subject") === "entity:0").length;
  const readsBefore = rowReads();
  await page.reload();
  await expect.poll(async () => {
    const graph = await page.evaluate(() => {
      const graph = (window as unknown as Partial<CanvasWindow>).__worldFieldGraph;
      return graph && !graph.destroyed ? graph.getNodeData().length : 0;
    });
    return graph;
  }).toBe(251);
  const restored = await stored();
  expect(restored.assertions.map(([id]) => id).sort()).toEqual([...ids].sort());
  expect(new Map(restored.positions)).toEqual(placed);
  expect(rowReads()).toBe(readsBefore);
});

for (const [count, last] of [[201, "already standing"], [202, "partly standing"]] as const) {
test(`an expansion whose last page is ${last} is still one admission`, async ({ page, world }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  world.count = count;
  world.hub = true;
  // Row 0 is read from the table first, and the neighborhood pages it last:
  // the first page brings two hundred new claims, and the final page brings
  // only claims already standing, or one standing beside one new.
  world.subjectLast = ["assertion:0"];
  type Stored = {
    assertions: [string, { relation: string; spokes: { role: string; id: string }[]; scalars: { role: string; value: unknown }[] }][];
    positions: [string, { x: number; y: number }][];
  };
  const stored = async () => (await field(page)) as unknown as Stored;
  await openProperty(page);
  await readRow(page, 0);
  await reader(page).locator(".world__roles button").click();
  await expect(reader(page).locator("h2")).toHaveText("Entity 0");
  const standing = new Map((await stored()).positions);
  expect([...standing.keys()].sort()).toEqual(["assertion:0", "entity:0"]);
  // Each page's answer is in hand before the next is asked for, so the
  // request loop runs to its end before the field renders the first page.
  // The reads themselves still go out, once each, to the fixture.
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    const asked: string[] = [];
    (window as unknown as { __rowsAsked: string[] }).__rowsAsked = asked;
    const ahead = new Map<string, Promise<{ status: number; text: string }>>();
    const read = (url: string, init?: RequestInit) =>
      real(url, init).then(async (response) => ({ status: response.status, text: await response.text() }));
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname !== "/world/rows" || url.searchParams.get("subject") !== "entity:0") {
        return real(input, init);
      }
      const offset = Number(url.searchParams.get("offset") ?? 0);
      asked.push(String(offset));
      let answer = ahead.get(String(offset));
      if (!answer) {
        const own = read(url.href, init);
        const next = new URL(url.href);
        next.searchParams.set("offset", String(offset + Number(url.searchParams.get("limit") ?? 200)));
        const following = read(next.href, init);
        ahead.set(next.searchParams.get("offset")!, following);
        answer = Promise.all([own, following]).then(([mine]) => mine);
      }
      // The body is already read: answering it is a microtask, not a task.
      return answer.then(({ status, text }) => {
        const response = new Response(text, { status, headers: { "Content-Type": "application/json" } });
        response.json = () => Promise.resolve(JSON.parse(text));
        return response;
      });
    };
  });
  await watchPoses(page);
  const expand = reader(page).locator(".gm__list button").filter({ hasText: "property" }).first();
  await expand.click();
  await expect(expand).toContainText("take off");
  await expect.poll(async () => (await field(page))?.assertions.length).toBe(count);
  await expect.poll(async () => (await fieldMarks(page)).length).toBe(count + 1);
  // One admission: none of the new plates nucleated.
  expect((await posesSince(page)).zero).toEqual([]);
  // The same two bounded reads, at the same offsets, asked once each.
  const offsets = world.requests.filter((url) => url.pathname === "/world/rows" && url.searchParams.get("subject") === "entity:0")
    .map((url) => Number(url.searchParams.get("offset")));
  expect(offsets).toEqual([0, 200]);
  expect(await page.evaluate(() => (window as unknown as { __rowsAsked: string[] }).__rowsAsked)).toEqual(["0", "200"]);
  // Every claim once, as the rows gave it; what stood keeps its place.
  const after = await stored();
  const ids = after.assertions.map(([id]) => id);
  expect(new Set(ids).size).toBe(count);
  expect([...ids].sort()).toEqual(Array.from({ length: count }, (_, i) => `assertion:${i}`).sort());
  for (const [id, claim] of after.assertions) {
    expect(claim.relation).toBe("property");
    expect(claim.spokes).toEqual([{ role: "item", id: "entity:0" }]);
    expect(claim.scalars).toEqual([{ role: "value", value: `value-${id.split(":")[1]}` }]);
  }
  const placed = new Map(after.positions);
  for (const [id, at] of standing) expect(placed.get(id), id).toEqual(at);
  // Fully retractable, and the hold is gone: the next single read is born.
  await expand.click();
  await expect.poll(async () => (await field(page))?.assertions.length).toBe(0);
  await watchPoses(page);
  await readRow(page, 5);
  await expect.poll(async () => (await fieldMarks(page)).includes("assertion:5")).toBe(true);
  await expect.poll(async () => (await posesSince(page)).zero).toContain("assertion:5");
});
}

test("a retraction that starts before its expansion has drawn leaves nothing held", async ({ page, world }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  world.count = 250;
  world.hub = true;
  await openProperty(page);
  await readRow(page, 0);
  await reader(page).locator(".world__roles button").click();
  await expect(reader(page).locator("h2")).toHaveText("Entity 0");
  const expand = reader(page).locator(".gm__list button").filter({ hasText: "property" }).first();
  await watchPoses(page);
  // A held drag keeps the expansion's frame undrawn while it is taken off
  // again: the admission's hold and the withdrawal's overlap.
  await emitField(page, "node:pointerdown", "entity:0");
  await emitField(page, "node:dragstart", "entity:0");
  await expand.click();
  await expect(expand).toContainText("take off");
  await expect.poll(async () => (await field(page))?.assertions.length, EXPANSION_WAIT).toBe(250);
  expect(await fieldMarks(page)).toHaveLength(2);
  await expand.click();
  await expect.poll(async () => (await field(page))?.assertions.length).toBe(0);
  await emitField(page, "node:dragend", "entity:0");
  await expect.poll(async () => (await fieldMarks(page)).filter((id) => id.startsWith("assertion:"))).toEqual([]);
  expect((await posesSince(page)).zero).toEqual([]);
  // Both holds are gone: the next single read is born.
  await watchPoses(page);
  await readRow(page, 3);
  await expect.poll(async () => (await fieldMarks(page)).includes("assertion:3")).toBe(true);
  await expect.poll(async () => (await posesSince(page)).zero).toContain("assertion:3");
});

test("a medium expansion arrives complete and still", async ({ page, world }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  world.count = 50;
  world.hub = true;
  await openProperty(page);
  await readRow(page, 0);
  await reader(page).locator(".world__roles button").click();
  await expect(reader(page).locator("h2")).toHaveText("Entity 0");
  await watchPoses(page);
  const expand = reader(page).locator(".gm__list button").filter({ hasText: "property" }).first();
  await expand.click();
  await expect(expand).toContainText("take off");
  await expect.poll(async () => (await field(page))?.assertions.length).toBe(50);
  await expect.poll(async () => (await fieldMarks(page)).length).toBe(51);
  const stored = (await field(page))!.assertions.map(([id]) => id).sort();
  expect(stored).toEqual(Array.from({ length: 50 }, (_, i) => `assertion:${i}`).sort());
  expect((await posesSince(page)).zero).toEqual([]);
});

/* ------------------------------------------------------------------ *
 * Drag-depth silence: the gesture shows the settled state
 * ------------------------------------------------------------------ *
 * A drop restacks its mark to the front of the depth stack, so the grab
 * carries that depth for the whole gesture: G6 fronts the held mark for
 * the drag and the release redraw must restate identical numbers, or the
 * mark visibly sinks a layer on release. Incident labels likewise track
 * the line live and must not jump once the pointer lets go.
 */

type DragSample = {
  z: number;
  pos: [number, number];
  boxes: Record<string, [number, number] | null>;
};

async function dragSample(page: Page, id: string): Promise<DragSample> {
  return page.evaluate(async ({ id, readerPath }) => {
    const graph = (window as unknown as CanvasWindow).__worldFieldGraph;
    const { paintedLabelBox } = await import(readerPath);
    const boxes: Record<string, [number, number] | null> = {};
    for (const edge of graph.getRelatedEdgesData(id)) {
      const style = (edge.style ?? {}) as Record<string, unknown>;
      if (typeof style.labelText !== "string" || !style.labelText) continue;
      const box = paintedLabelBox(graph, String(edge.id)) as {
        minX: number; minY: number; maxX: number; maxY: number;
      } | null;
      boxes[String(edge.id)] = box
        ? [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2]
        : null;
    }
    const at = graph.getElementPosition(id);
    return {
      z: Number(graph.getNodeData(id).style?.zIndex),
      pos: [Number(at?.[0]), Number(at?.[1])] as [number, number],
      boxes,
    };
  }, { id, readerPath: "/src/world/visibility.ts" });
}

async function settleFrames(page: Page, count = 3) {
  await page.evaluate((count) => new Promise<void>((done) => {
    const step = () => {
      count -= 1;
      if (count <= 0) done();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), count);
}

async function emitField(page: Page, type: string, id: string, extra: Record<string, unknown> = {}) {
  await page.evaluate(({ type, id, extra }) => {
    const graph = (window as unknown as CanvasWindow).__worldFieldGraph;
    graph.emit(type, { target: { id }, ...extra });
  }, { type, id, extra });
}

/** How many of this mark's strokes are standing bent, read off the renderer. */
async function fannedStrokes(page: Page, id: string): Promise<number> {
  return page.evaluate((id) => {
    const graph = (window as unknown as CanvasWindow).__worldFieldGraph;
    const elements = (graph as unknown as {
      context: { element: { getElement: (edgeId: string) => {
        hasFan?: (fan: null) => boolean;
      } | undefined } };
    }).context.element;
    let open = 0;
    for (const edge of graph.getRelatedEdgesData(id)) {
      const rendered = elements.getElement(String(edge.id));
      if (rendered && typeof rendered.hasFan === "function" && !rendered.hasFan(null)) {
        open += 1;
      }
    }
    return open;
  }, id);
}

/**
 * Frames, one per sample, until this mark's fan is down; null if it never is.
 *
 * A press lowers the fan on the absorb curve under ordinary motion and at
 * once under reduced motion, so "down" is a state to wait for, not one that
 * holds a fixed number of frames after the press.
 */
async function framesUntilFanDown(page: Page, id: string, limit = 120): Promise<number | null> {
  for (let frames = 0; frames <= limit; frames += 1) {
    if ((await fannedStrokes(page, id)) === 0) return frames;
    await settleFrames(page, 1);
  }
  return null;
}

async function labeledIncidentCount(page: Page, id: string): Promise<number> {
  return page.evaluate((id) => {
    const graph = (window as unknown as CanvasWindow).__worldFieldGraph;
    return graph.getRelatedEdgesData(id).filter((edge) => {
      const style = (edge.style ?? {}) as Record<string, unknown>;
      return typeof style.labelText === "string" && style.labelText.length > 0;
    }).length;
  }, id);
}

async function gotoWithSpread(page: Page, spread: boolean) {
  await page.goto("/");
  if (spread) return;
  // The menu persists per world, so seed it off and reload rather than
  // fighting the hover-gated toggle. Seeded from what the app itself wrote,
  // so no defaults are guessed here.
  await expect.poll(() => page.evaluate(
    () => localStorage.getItem("worldir.show:review"),
  )).not.toBeNull();
  await page.evaluate(() => {
    const raw = localStorage.getItem("worldir.show:review")!;
    localStorage.setItem("worldir.show:review", JSON.stringify({
      ...JSON.parse(raw), spreadOnSelect: false,
    }));
  });
  await page.reload();
}

async function openPropertyTable(page: Page) {
  await worldRow(page, "property").click();
  await expect(rows(page).first()).toBeVisible();
}

/** Paint layers, as `src/world/marks.ts` states them. */
const PAINT_LAYER_MARK = 1;
const PAINT_LAYER_NAME = 2;

/**
 * The drop's draw has landed once the store agrees with the renderer, the
 * saved field records the drop's restack, the mark is painted on top, and
 * the mark's own labels stand on it.
 *
 * Agreeing positions alone is not that moment: a drag keeps them level, so
 * they agree from the release onward, while the restacked depth reaches the
 * graph a few frames later. Nor is the mark's depth: a held mark rides its
 * settled depth from the grab, and the save can land before the draw does.
 * Only the draw restates the labels — above their fronter end and below the
 * name layer — so until they stand there, a sample reads a depth that is
 * about to change. Every caller drops a mark that moved, so a restack is owed.
 */
async function awaitDropDraw(page: Page, id: string) {
  await expect.poll(() => page.evaluate(({ id, PAINT_LAYER_MARK, PAINT_LAYER_NAME }) => {
    const graph = (window as unknown as CanvasWindow).__worldFieldGraph;
    const node = graph.getNodeData(id);
    const at = graph.getElementPosition(id);
    const placed = Math.abs(Number(node.style?.x) - Number(at?.[0])) < 1 &&
      Math.abs(Number(node.style?.y) - Number(at?.[1])) < 1;
    const saved = (JSON.parse(localStorage.getItem("worldir.field:review:1") ?? "null") as Field | null)?.depth ?? [];
    const restacked = saved.length > 0 &&
      saved.reduce((top, entry) => (entry[1] > top[1] ? entry : top))[0] === id;
    const z = Number(node.style?.zIndex);
    const fronted = graph.getNodeData().every((other) => String(other.id) === id || Number(other.style?.zIndex ?? 0) < z);
    const standing = graph.getRelatedEdgesData(id).every((edge) => {
      const style = (edge.style ?? {}) as Record<string, unknown>;
      if (typeof style.labelText !== "string" || !style.labelText) return true;
      const depth = (end: unknown) =>
        Number(graph.getNodeData(String(end))?.style?.zIndex ?? PAINT_LAYER_MARK);
      const over = Math.max(depth(edge.source), depth(edge.target));
      const at = Number(style.zIndex);
      return at > over && at < PAINT_LAYER_NAME;
    });
    return placed && restacked && fronted && standing;
  }, { id, PAINT_LAYER_MARK, PAINT_LAYER_NAME })).toBe(true);
}

function expectBoxesSettled(before: DragSample, after: DragSample) {
  let compared = 0;
  for (const [id, pre] of Object.entries(before.boxes)) {
    const post = after.boxes[id];
    if (!pre || !post) continue;
    compared += 1;
    expect(
      Math.hypot(post[0] - pre[0], post[1] - pre[1]),
      `label ${id} moved after release`,
    ).toBeLessThanOrEqual(0.5);
  }
  expect(compared, "no incident label was readable in both samples").toBeGreaterThan(0);
}

test("a dragged mark keeps its settled depth from grab through release", async ({ page, world }) => {
  world.count = 3;
  world.binary = true;
  await page.goto("/");
  await openPropertyTable(page);
  await readRow(page, 0);
  await readRow(page, 1);
  await readRow(page, 2);
  await selectReferent(page, "entity:0");
  await expect(reader(page).locator("h2")).toHaveText("Entity 0");
  await expect.poll(() => labeledIncidentCount(page, "entity:0")).toBeGreaterThan(0);
  const rest = await dragSample(page, "entity:0");
  await emitField(page, "node:pointerdown", "entity:0");
  await settleFrames(page);
  await emitField(page, "node:dragstart", "entity:0");
  await settleFrames(page);
  const grabbed = await dragSample(page, "entity:0");
  const zoom = await page.evaluate(
    () => (window as unknown as CanvasWindow).__worldFieldGraph.getZoom(),
  );
  await emitField(page, "node:drag", "entity:0", { dx: 120 * zoom, dy: 60 * zoom });
  await settleFrames(page);
  const mid = await dragSample(page, "entity:0");
  expect(
    Math.hypot(mid.pos[0] - rest.pos[0], mid.pos[1] - rest.pos[1]),
    "the drag did not move its mark",
  ).toBeGreaterThan(50);
  await emitField(page, "node:dragend", "entity:0");
  await awaitDropDraw(page, "entity:0");
  await page.waitForTimeout(500);
  const settled = await dragSample(page, "entity:0");
  // The drop restacked, so flatness below is earned rather than vacuous.
  expect(settled.z).toBeGreaterThan(rest.z);
  expect(grabbed.z).toBe(settled.z);
  expect(mid.z).toBe(settled.z);
  expectBoxesSettled(mid, settled);
});

test("a press that goes nowhere keeps its rest depth", async ({ page, world }) => {
  world.count = 3;
  world.binary = true;
  await page.goto("/");
  await openPropertyTable(page);
  await readRow(page, 0);
  await readRow(page, 1);
  await readRow(page, 2);
  await selectReferent(page, "entity:0");
  await expect(reader(page).locator("h2")).toHaveText("Entity 0");
  await expect.poll(() => labeledIncidentCount(page, "entity:0")).toBeGreaterThan(0);
  const rest = await dragSample(page, "entity:0");
  await emitField(page, "node:pointerdown", "entity:0");
  await emitField(page, "node:dragstart", "entity:0");
  await settleFrames(page);
  await emitField(page, "node:dragend", "entity:0");
  await settleFrames(page, 5);
  const settled = await dragSample(page, "entity:0");
  expect(settled.pos).toEqual(rest.pos);
  expect(settled.z).toBe(rest.z);
});

async function buildHubField(page: Page) {
  await readRow(page, 0);
  await reader(page).locator(".world__roles button").first().click();
  await expect(reader(page).locator("h2")).toHaveText("Entity 0");
  const expand = reader(page).locator(".gm__list button").filter({ hasText: "property" }).first();
  await expand.click();
  await expect.poll(async () => {
    const current = await field(page);
    return (current?.assertions.length ?? 0) + (current?.bonds.length ?? 0);
  }).toBe(12);
  await selectReferent(page, "entity:0");
  await expect.poll(() => page.evaluate(() => {
    const graph = (window as unknown as CanvasWindow).__worldFieldGraph;
    return graph.getRelatedEdgesData("entity:0").length;
  })).toBeGreaterThanOrEqual(12);
}

/**
 * Pile two names onto one station so the fan has a collision to solve.
 * Placement spreads bonds too evenly to collide on their own, so one mark
 * is dragged to its sibling's doorstep first, as seen from their hub.
 */
async function crowdBonds(
  page: Page,
  hub = "entity:0",
  move = "entity:1",
  beside = "entity:2",
) {
  // Placement draws land behind the reads that placed them.
  await expect.poll(() => page.evaluate(({ hub, move, beside }) => {
    const graph = (window as unknown as CanvasWindow).__worldFieldGraph;
    return [hub, move, beside].every((id) => {
      try {
        const at = graph.getElementPosition(id);
        return !!at && Number.isFinite(Number(at[0])) && Number.isFinite(Number(at[1]));
      } catch {
        return false;
      }
    });
  }, { hub, move, beside })).toBe(true);
  const job = await page.evaluate(({ hub, move, beside }) => {
    const graph = (window as unknown as CanvasWindow).__worldFieldGraph;
    const at = (id: string) => graph.getElementPosition(id);
    const hubAt = at(hub);
    const besideAt = at(beside);
    const fromAt = at(move);
    const dx = Number(besideAt[0]) - Number(hubAt[0]);
    const dy = Number(besideAt[1]) - Number(hubAt[1]);
    const len = Math.hypot(dx, dy) || 1;
    return {
      dx: (Number(besideAt[0]) - Number(fromAt[0]) + (-dy / len) * 8) * graph.getZoom(),
      dy: (Number(besideAt[1]) - Number(fromAt[1]) + (dx / len) * 8) * graph.getZoom(),
    };
  }, { hub, move, beside });
  await emitField(page, "node:pointerdown", move);
  await emitField(page, "node:dragstart", move);
  await emitField(page, "node:drag", move, { dx: job.dx, dy: job.dy });
  await settleFrames(page);
  await emitField(page, "node:dragend", move);
  await awaitDropDraw(page, move);
}

async function dragHub(page: Page) {
  const rest = await dragSample(page, "entity:0");
  await emitField(page, "node:pointerdown", "entity:0");
  await settleFrames(page);
  await emitField(page, "node:dragstart", "entity:0");
  await settleFrames(page);
  const grabbed = await dragSample(page, "entity:0");
  const zoom = await page.evaluate(
    () => (window as unknown as CanvasWindow).__worldFieldGraph.getZoom(),
  );
  await emitField(page, "node:drag", "entity:0", { dx: 120 * zoom, dy: 60 * zoom });
  await settleFrames(page);
  const mid = await dragSample(page, "entity:0");
  expect(
    Math.hypot(mid.pos[0] - rest.pos[0], mid.pos[1] - rest.pos[1]),
    "the drag did not move its mark",
  ).toBeGreaterThan(50);
  return { rest, grabbed, mid };
}

test("a dense-field drag release moves no label with the fan off", async ({ page, world }) => {
  world.count = 12;
  world.hub = true;
  world.binary = true;
  await gotoWithSpread(page, false);
  await openPropertyTable(page);
  await buildHubField(page);
  await expect.poll(() => fannedStrokes(page, "entity:0")).toBe(0);
  await expect.poll(() => labeledIncidentCount(page, "entity:0")).toBeGreaterThan(0);
  const { rest, grabbed, mid } = await dragHub(page);
  await emitField(page, "node:dragend", "entity:0");
  await awaitDropDraw(page, "entity:0");
  await page.waitForTimeout(500);
  const settled = await dragSample(page, "entity:0");
  expect(settled.z).toBeGreaterThan(rest.z);
  expect(grabbed.z).toBe(settled.z);
  expect(mid.z).toBe(settled.z);
  expectBoxesSettled(mid, settled);
});

test("a dense-field drag keeps its settled depth with the fan on", async ({ page, world }) => {
  world.count = 12;
  world.hub = true;
  world.binary = true;
  await gotoWithSpread(page, true);
  await openPropertyTable(page);
  await buildHubField(page);
  await crowdBonds(page);
  // The fan is genuinely open: this is the dense reopen case, not chords.
  await expect.poll(() => fannedStrokes(page, "entity:0")).toBeGreaterThan(0);
  const { rest, grabbed, mid } = await dragHub(page);
  // The owner's press put the fan down for the gesture.
  expect(await framesUntilFanDown(page, "entity:0"), "the owner's press left the fan up").not.toBeNull();
  await emitField(page, "node:dragend", "entity:0");
  await awaitDropDraw(page, "entity:0");
  const track: { at: string; sample: DragSample }[] = [];
  for (const [at, wait] of [["rel30", 30], ["rel60", 30], ["rel120", 60], ["rel250", 130], ["rel500", 250]] as const) {
    await page.waitForTimeout(wait);
    track.push({ at, sample: await dragSample(page, "entity:0") });
  }
  const settled = track[track.length - 1]!.sample;
  expect(settled.z).toBeGreaterThan(rest.z);
  expect(grabbed.z).toBe(settled.z);
  expect(mid.z).toBe(settled.z);
  for (const { at, sample } of track) {
    expect(sample.z, `depth moved at ${at}`).toBe(settled.z);
  }
  // And the drop's draw opened it fresh once the strokes had settled.
  expect(await fannedStrokes(page, "entity:0")).toBeGreaterThan(0);
});

/**
 * Every painted depth on the field, marks and edge labels alike.
 *
 * Read off the data the lane stamped, after the drop's draw has landed it —
 * so this is what the renderer sorts, not a prediction of it.
 */
async function sampleDepths(page: Page): Promise<{
  marks: Record<string, number>;
  labels: Record<string, number>;
}> {
  return page.evaluate(() => {
    const graph = (window as unknown as CanvasWindow).__worldFieldGraph;
    const marks: Record<string, number> = {};
    for (const node of graph.getNodeData()) {
      marks[String(node.id)] = Number(node.style?.zIndex ?? -1);
    }
    const labels: Record<string, number> = {};
    for (const edge of graph.getEdgeData()) {
      const style = (edge.style ?? {}) as Record<string, unknown>;
      if (typeof style.labelText !== "string" || !style.labelText) continue;
      labels[String(edge.id)] = Number(style.zIndex ?? -1);
    }
    return { marks, labels };
  });
}

test("a drop renumbers only the dropped mark and its own labels", async ({ page, world }) => {
  world.count = 12;
  world.hub = true;
  world.binary = true;
  await gotoWithSpread(page, false);
  await openPropertyTable(page);
  await buildHubField(page);
  await crowdBonds(page);
  const before = await sampleDepths(page);
  // `crowdBonds` waits for each drop's draw — restacked, saved and fronting —
  // so both samples read settled depth.
  await crowdBonds(page, "entity:0", "entity:3", "entity:4");
  const after = await sampleDepths(page);
  // Same field, so the comparison is meaningful: nothing arrived or left.
  expect(new Set(Object.keys(after.marks))).toEqual(new Set(Object.keys(before.marks)));
  expect(new Set(Object.keys(after.labels))).toEqual(new Set(Object.keys(before.labels)));
  // Only the dropped mark moved.
  expect(
    Object.keys(after.marks).filter((id) => after.marks[id] !== before.marks[id]),
  ).toEqual(["entity:3"]);
  // And only the labels standing on it: their base rose with their endpoint.
  const incident = await page.evaluate(() => {
    const graph = (window as unknown as CanvasWindow).__worldFieldGraph;
    return graph.getRelatedEdgesData("entity:3")
      .filter((edge) => {
        const style = (edge.style ?? {}) as Record<string, unknown>;
        return typeof style.labelText === "string" && style.labelText.length > 0;
      })
      .map((edge) => String(edge.id))
      .sort();
  });
  expect(incident.length, "no labeled edge stands on the dropped mark").toBeGreaterThan(0);
  expect(
    Object.keys(after.labels)
      .filter((id) => after.labels[id] !== before.labels[id])
      .sort(),
  ).toEqual(incident);
});

test("depth assignment appends bounded tops and migrates legacy sequences", async ({ page, world }) => {
  world.count = 1;
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { emptySet, restack, paintDepths } = await import("/src/world/workingSet.ts");
    let set = emptySet();
    const ids = ["a", "b", "c", "d"];
    let renumbers = 0;
    let prev = new Map<string, number>();
    for (let drop = 0; drop < 120; drop += 1) {
      const id = ids[drop % ids.length]!;
      set = restack(set, id);
      const cur = paintDepths(set.depth);
      let changed = 0;
      for (const [key, z] of cur) {
        if (prev.get(key) !== z) changed += 1;
      }
      if (changed > 1) renumbers += 1;
      for (const z of cur.values()) {
        if (!(z > 1 && z < 2)) return { ok: false as const, why: `unbounded ${z} at drop ${drop}` };
      }
      const top = [...cur.entries()].sort((a, b) => a[1] - b[1]).pop()!;
      if (top[0] !== id) return { ok: false as const, why: `top ${top[0]} is not dropped ${id} at ${drop}` };
      prev = cur;
    }
    // Re-dropping the topmost mark is a no-op, not a new top.
    const held = paintDepths(set.depth);
    const replay = paintDepths(restack(set, "d").depth);
    if ([...held.entries()].some(([key, z]) => replay.get(key) !== z)) {
      return { ok: false as const, why: "re-dropping the top moved the stack" };
    }
    // Legacy sequences — bare drop counts from before paint lived here —
    // come back as the same order, inside the layer.
    const legacy = emptySet();
    legacy.depth.set("x", 1);
    legacy.depth.set("y", 2);
    legacy.depth.set("z", 3);
    const migrated = paintDepths(legacy.depth);
    const ordered = [...migrated.entries()].sort((a, b) => a[1] - b[1]).map(([key]) => key);
    return {
      ok: true as const,
      renumbers,
      migratedOrder: ordered.join(","),
      migratedBounded: [...migrated.values()].every((z) => z > 1 && z < 2),
    };
  });
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) return;
  expect(result.renumbers).toBeLessThanOrEqual(2);
  expect(result.migratedOrder).toBe("x,y,z");
  expect(result.migratedBounded).toBe(true);
});

test("a neighbour's press puts the fan down and a stranger's leaves it up", async ({ page, world }) => {
  world.count = 6;
  world.binary = true;
  await page.goto("/");
  await openPropertyTable(page);
  for (let index = 0; index < 6; index += 1) {
    await readRow(page, index);
  }
  // Pile entity:0 onto entity:2's station as seen from entity:1, before
  // anything is selected and there is a fan to disturb.
  await crowdBonds(page, "entity:1", "entity:0", "entity:2");
  await selectReferent(page, "entity:1");
  await expect(reader(page).locator("h2")).toHaveText("Entity 1");
  await expect.poll(() => fannedStrokes(page, "entity:1")).toBeGreaterThan(0);
  const release = () => page.evaluate(() => window.dispatchEvent(new Event("pointerup")));
  // A neighbour holds one end of the fan's strokes: down for the gesture.
  await emitField(page, "node:pointerdown", "entity:0");
  const lowered = await framesUntilFanDown(page, "entity:1");
  expect(lowered, "a neighbour's press left the fan up").not.toBeNull();
  await release();
  await expect.poll(() => fannedStrokes(page, "entity:1")).toBeGreaterThan(0);
  // A stranger touches none of them: the fan stands through the press, for
  // at least as long as the neighbour's press took to bring it down.
  await emitField(page, "node:pointerdown", "entity:4");
  for (let frame = 0; frame < Math.max(lowered! + 2, 3); frame += 1) {
    await settleFrames(page, 1);
    expect(await fannedStrokes(page, "entity:1")).toBeGreaterThan(0);
  }
  await release();
  expect(await fannedStrokes(page, "entity:1")).toBeGreaterThan(0);
});

/**
 * A collapse lands every stroke on its chord, whatever frames it is drawn on.
 *
 * Frame timing is the variable, so the page's frames are stepped by hand at
 * display rate, from every phase in a frame's width: where the second-last
 * frame of a collapse falls decides what it paints, and only the last frame
 * puts a stroke back on its chord. Read before the press is released, since
 * the release reopens the fan and repaints every stroke it owns.
 */
test("an owner's press brings every stroke to its chord on any frame schedule", async ({ page, world }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  world.count = 12;
  world.hub = true;
  world.binary = true;
  await page.goto("/");
  await openPropertyTable(page);
  await buildHubField(page);
  await crowdBonds(page);
  await crowdBonds(page, "entity:0", "entity:3", "entity:4");
  const left: { phase: number; strokes: number; bent: [string, number][] }[] = [];
  for (let phase = 0; phase < 16.67; phase += 0.5) {
    // Open and at rest, so every collapse starts from the same bend and on
    // these frames: the field announces each frame it moves something on,
    // so three quiet frames mean no reopen is still running. The renderer
    // skips restating a bend within 0.012 of the one it holds.
    await expect.poll(() => page.evaluate(async () => {
      const graph = (window as unknown as CanvasWindow).__worldFieldGraph;
      const container = graph.getCanvas().getContainer()!;
      let moved = 0;
      const count = () => { moved += 1; };
      container.addEventListener("world:spreadframe", count);
      for (let frame = 0; frame < 3; frame += 1) {
        await new Promise((done) => requestAnimationFrame(done));
      }
      container.removeEventListener("world:spreadframe", count);
      const elements = (graph as unknown as {
        context: { element: { getElement: (id: string) => { fan?: { amount: number } | null } | undefined } };
      }).context.element;
      const bends = graph.getRelatedEdgesData("entity:0")
        .map((edge) => elements.getElement(String(edge.id))?.fan?.amount ?? 0)
        .filter((amount) => amount > 0);
      return moved === 0 && bends.length > 0 && bends.every((amount) => amount >= 0.98);
    })).toBe(true);
    left.push(await page.evaluate((phase) => {
      const graph = (window as unknown as CanvasWindow).__worldFieldGraph;
      const elements = (graph as unknown as {
        context: { element: { getElement: (id: string) => { fan?: { amount: number } | null } | undefined } };
      }).context.element;
      const bend = (id: string) => elements.getElement(id)?.fan?.amount ?? 0;
      const strokes = graph.getRelatedEdgesData("entity:0")
        .map((edge) => String(edge.id))
        .filter((id) => bend(id) > 0);
      const real = { request: window.requestAnimationFrame, cancel: window.cancelAnimationFrame };
      let queue = new Map<number, FrameRequestCallback>();
      let next = 1;
      window.requestAnimationFrame = (callback) => {
        queue.set(next, callback);
        return next++;
      };
      window.cancelAnimationFrame = (handle) => {
        queue.delete(handle);
      };
      try {
        const t0 = performance.now();
        graph.emit("node:pointerdown", { target: { id: "entity:0" } });
        // Well past any collapse the motion plans state.
        for (let at = phase; at < 600; at += 1000 / 60) {
          const due = queue;
          queue = new Map();
          for (const callback of due.values()) callback(t0 + at);
        }
        return {
          phase,
          strokes: strokes.length,
          bent: strokes.filter((id) => bend(id) > 0).map((id) => [id, bend(id)] as [string, number]),
        };
      } finally {
        window.requestAnimationFrame = real.request;
        window.cancelAnimationFrame = real.cancel;
        for (const callback of queue.values()) real.request(callback);
        window.dispatchEvent(new Event("pointerup"));
      }
    }, phase));
  }
  expect(left.every((run) => run.strokes > 0), "a press found no stroke bent").toBe(true);
  expect(left.filter((run) => run.bent.length)).toEqual([]);
});

test("spoke roles fan open when their stations pile", async ({ page, world }) => {
  world.count = 12;
  world.hub = true;
  await page.goto("/");
  await openPropertyTable(page);
  await buildHubField(page);
  await expect.poll(() => labeledIncidentCount(page, "entity:0")).toBeGreaterThan(0);
  // Natural placement piles two roles onto one station as seen from the hub.
  // The solver must see the pile: its strokes bend rather than standing
  // straight through each other.
  await expect.poll(() => fannedStrokes(page, "entity:0")).toBeGreaterThanOrEqual(2);
  await settleFrames(page);
  // And every painted role plate clears every other.
  const overlap = await page.evaluate(async () => {
    const graph = (window as unknown as CanvasWindow).__worldFieldGraph;
    const { paintedLabelBox } = await import("/src/world/visibility.ts");
    const boxes = [];
    for (const edge of graph.getRelatedEdgesData("entity:0")) {
      const style = (edge.style ?? {}) as Record<string, unknown>;
      if (typeof style.labelText !== "string" || !style.labelText) continue;
      boxes.push(paintedLabelBox(graph, String(edge.id)) as {
        minX: number; minY: number; maxX: number; maxY: number;
      } | null);
    }
    let area = 0;
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        if (!a || !b) continue;
        area +=
          Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) *
          Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
      }
    }
    return { area, labels: boxes.length };
  });
  expect(overlap.labels).toBe(12);
  expect(overlap.area).toBe(0);
});

test("facts link back to their assertions and back walks the trail", async ({ page, world }) => {
  world.count = 12;
  world.binary = true;
  await page.goto("/");
  await openPropertyTable(page);
  await readRow(page, 0);
  // The first arrival pushes nothing: there is nowhere back to go.
  await expect(reader(page).locator(".panel__back")).toHaveCount(0);
  await reader(page).locator(".world__roles button").first().click();
  await expect(reader(page).locator("h2")).toHaveText("Entity 0");
  await expect(reader(page).locator(".panel__back")).toHaveCount(1);
  // The scalar is the occurrence's, listed under its id: no scalar sits in
  // the referent's identity header, and the id is the way back to it.
  await expect(reader(page).locator(".world-reader__facts")).toHaveCount(0);
  await expect(reader(page).locator('.world-occurrence[data-assertion-id="assertion:7"]')).toContainText("value-7");
  // The occurrence was never placed; the back-link reads it anyway.
  await reader(page).getByRole("button", { name: "Open occurrence assertion:7" }).click();
  await expect(reader(page).locator("h2")).toHaveText("property");
  await expect(reader(page)).toContainText("value-7");
  // Nothing on the field to take off, so no offer to.
  await expect(reader(page).getByText("Take off the field")).toHaveCount(0);
  // And back walks down the trail it came up, one arrival at a time.
  await reader(page).locator(".panel__back").click();
  await expect(reader(page).locator("h2")).toHaveText("Entity 0");
  await expect(reader(page).locator(".panel__back")).toHaveCount(1);
  await reader(page).locator(".panel__back").click();
  await expect(reader(page)).toContainText("value-0");
  await expect(reader(page).locator(".panel__back")).toHaveCount(0);
});

/**
 * Per-edge tab state, for the fan/tab drift extinction proof.
 *
 * The drift defect was a notch sitting off its plate. It cannot manifest
 * anymore: lone plates sit centred on their strokes (`chipLabelNudge` is 0,
 * spokes and single bonds stack nothing), so the stroke-crosses-plate rule
 * parks their tabs — and stacked plates are parked by the named-pair-sibling
 * rule. The fan only moves the share along the path, never the offsets, so
 * a parked tab stays parked through collapse and reopen. These checks pin
 * that: every labeled edge must report its tab hidden by design, and any
 * edge that ever draws one fails loudly with its id, reopening the bridge
 * question deliberately rather than by accident.
 */
type TabBridge = {
  edge: string;
  bridged: boolean | null;
  fanned: boolean;
  why: string;
};

async function tabBridges(page: Page, id: string): Promise<TabBridge[]> {
  return page.evaluate(async ({ id, readerPath }) => {
    const graph = (window as unknown as CanvasWindow).__worldFieldGraph;
    const { paintedLabelBox } = await import(readerPath);
    const elements = (graph as unknown as {
      context: { element: { getElement: (edgeId: string) => any } };
    }).context.element;
    const out: TabBridge[] = [];
    for (const edge of graph.getRelatedEdgesData(id)) {
      const style = (edge.style ?? {}) as Record<string, unknown>;
      if (typeof style.labelText !== "string" || !style.labelText) continue;
      const eid = String(edge.id);
      const rendered = elements.getElement(eid);
      const fanned =
        typeof rendered?.hasFan === "function" ? !rendered.hasFan(null) : false;
      const knockout = rendered?.getShape?.("knockout")?.getBounds?.();
      const plate = paintedLabelBox(graph, eid) as {
        minX: number; minY: number; maxX: number; maxY: number;
      } | null;
      if (!knockout || !plate) {
        out.push({ edge: eid, bridged: null, fanned, why: "shapes unreadable" });
        continue;
      }
      if (
        !(knockout.maxX - knockout.minX > 0.5) ||
        !(knockout.maxY - knockout.minY > 0.5)
      ) {
        out.push({ edge: eid, bridged: null, fanned, why: "tab hidden by design" });
        continue;
      }
      const overlapX =
        Math.min(knockout.maxX, plate.maxX) - Math.max(knockout.minX, plate.minX);
      const overlapY =
        Math.min(knockout.maxY, plate.maxY) - Math.max(knockout.minY, plate.minY);
      const bridged = overlapX > 0.5 && overlapY > 0.5;
      out.push({
        edge: eid,
        bridged,
        fanned,
        why: bridged
          ? "ok"
          : `knockout [${knockout.minX.toFixed(1)},${knockout.minY.toFixed(1)} ${knockout.maxX.toFixed(1)},${knockout.maxY.toFixed(1)}] plate [${plate.minX.toFixed(1)},${plate.minY.toFixed(1)} ${plate.maxX.toFixed(1)},${plate.maxY.toFixed(1)}]`,
      });
    }
    return out;
  }, { id, readerPath: "/src/world/visibility.ts" });
}

function expectTabsParked(rows: TabBridge[], { fanned }: { fanned: boolean }) {
  expect(rows.length, "no labeled edge to read a tab off").toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.why, `tab state changed on ${row.edge}`).toBe("tab hidden by design");
  }
  if (fanned) {
    expect(
      rows.filter((row) => row.fanned).length,
      "no parked tab stands on a bent stroke",
    ).toBeGreaterThan(0);
  }
}

/** Frames of tab checks across an animation: none may draw, on any frame. */
async function tabsVisibleDuring(page: Page, id: string, ms: number) {
  return page.evaluate(async ({ id, ms }) => {
    const graph = (window as unknown as CanvasWindow).__worldFieldGraph;
    const elements = (graph as unknown as {
      context: { element: { getElement: (edgeId: string) => any } };
    }).context.element;
    const visible: { frame: number; edge: string }[] = [];
    let frames = 0;
    let examined = 0;
    const started = performance.now();
    await new Promise<void>((done) => {
      const tick = () => {
        frames += 1;
        for (const edge of graph.getRelatedEdgesData(id)) {
          const style = (edge.style ?? {}) as Record<string, unknown>;
          if (typeof style.labelText !== "string" || !style.labelText) continue;
          const eid = String(edge.id);
          const knockout = elements
            .getElement(eid)
            ?.getShape?.("knockout")
            ?.getBounds?.();
          if (!knockout) continue;
          examined += 1;
          if (
            knockout.maxX - knockout.minX > 0.5 &&
            knockout.maxY - knockout.minY > 0.5
          ) {
            visible.push({ frame: frames, edge: eid });
          }
        }
        if (performance.now() - started < ms) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    return { frames, examined, visible: visible.slice(0, 8) };
  }, { id, ms });
}

test("label tabs stay parked under an active fan", async ({ page, world }) => {
  world.count = 12;
  world.hub = true;
  world.binary = true;
  await page.goto("/");
  await openPropertyTable(page);
  await buildHubField(page);
  await crowdBonds(page);
  await crowdBonds(page, "entity:0", "entity:3", "entity:4");
  await expect.poll(() => fannedStrokes(page, "entity:0")).toBeGreaterThan(0);
  await expect.poll(() => labeledIncidentCount(page, "entity:0")).toBeGreaterThan(0);
  expectTabsParked(await tabBridges(page, "entity:0"), { fanned: true });
});

test("label tabs stay parked through collapse and reopen", async ({ page, world }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  world.count = 12;
  world.hub = true;
  world.binary = true;
  await page.goto("/");
  await openPropertyTable(page);
  await buildHubField(page);
  await crowdBonds(page);
  await crowdBonds(page, "entity:0", "entity:3", "entity:4");
  await expect.poll(() => fannedStrokes(page, "entity:0")).toBeGreaterThan(0);
  // Collapse: the press puts the fan down over ~95ms of easing.
  await emitField(page, "node:pointerdown", "entity:0");
  const collapse = await tabsVisibleDuring(page, "entity:0", 600);
  expect(collapse.frames, "no frames sampled").toBeGreaterThan(5);
  expect(collapse.examined, "no tab readable mid-collapse").toBeGreaterThan(0);
  expect(collapse.visible).toEqual([]);
  await expect.poll(() => fannedStrokes(page, "entity:0")).toBe(0);
  // Reopen: release re-solves fresh over ~140ms of easing.
  await page.evaluate(() => window.dispatchEvent(new Event("pointerup")));
  const reopen = await tabsVisibleDuring(page, "entity:0", 800);
  expect(reopen.frames, "no frames sampled").toBeGreaterThan(5);
  expect(reopen.examined, "no tab readable mid-reopen").toBeGreaterThan(0);
  expect(reopen.visible).toEqual([]);
  await expect.poll(() => fannedStrokes(page, "entity:0")).toBeGreaterThan(0);
});

test("spoke tabs stay parked under selection", async ({ page, world }) => {
  world.count = 12;
  world.hub = true;
  await page.goto("/");
  await openPropertyTable(page);
  await buildHubField(page);
  await expect.poll(() => labeledIncidentCount(page, "entity:0")).toBeGreaterThan(0);
  expectTabsParked(await tabBridges(page, "entity:0"), { fanned: false });
});

/**
 * Stranded transient poses converge to the settled frame.
 *
 * A lifecycle run cancelled mid-arrival can leave births frozen in the model
 * — a disc at opacity 0 and mid-flight size — while every authored frame
 * says the end state, so restyle never patches them: it diffs authored
 * against authored, and both agree. The guard diffs the model against the
 * settled frame instead and patches what disagrees. Same guard both lanes
 * share; the schema lane grew it first.
 */
async function strandMark(page: Page, nodeId: string, edgeId: string) {
  await page.evaluate(({ nodeId, edgeId }) => {
    const graph = (window as unknown as CanvasWindow).__worldFieldGraph;
    const node = graph.getNodeData(nodeId);
    const edge = graph.getEdgeData(edgeId);
    graph.updateNodeData([
      { id: nodeId, style: { ...(node.style as object), opacity: 0, size: 3.6 } },
    ]);
    graph.updateEdgeData([{ id: edgeId, style: { ...(edge.style as object), opacity: 0 } }]);
  }, { nodeId, edgeId });
}

test("stranded poses converge to the settled frame", async ({ page, world }) => {
  world.count = 3;
  world.binary = true;
  await page.goto("/");
  await openPropertyTable(page);
  await readRow(page, 0);
  await readRow(page, 1);
  await readRow(page, 2);
  await selectReferent(page, "entity:0");
  await expect(reader(page).locator("h2")).toHaveText("Entity 0");
  await expect.poll(() => labeledIncidentCount(page, "entity:0")).toBeGreaterThan(0);
  const verdict = await page.evaluate(async () => {
    const graph = (window as unknown as CanvasWindow).__worldFieldGraph;
    const { convergeStrandedToFrame } = await import("/src/world/canvasMotion.ts");
    const node = graph.getNodeData("entity:0");
    const edge = graph.getEdgeData("bond:assertion:0");
    const frame = {
      nodes: [{ id: "entity:0", style: { ...(node.style as object) } }],
      edges: [{ id: "bond:assertion:0", style: { ...(edge.style as object) } }],
    };
    const problems: string[] = [];
    // Clean converges nothing.
    if (convergeStrandedToFrame(graph, frame) !== false) {
      problems.push("clean frame converged");
    }
    // Unknown ids are skipped, not failed.
    if (
      convergeStrandedToFrame(graph, {
        nodes: [{ id: "nope", style: { opacity: 0 } }],
        edges: [{ id: "nope", style: { opacity: 0 } }],
      }) !== false
    ) {
      problems.push("missing ids converged");
    }
    // Stranded poses patch to the frame and report it.
    graph.updateNodeData([
      { id: "entity:0", style: { ...frame.nodes[0]!.style, opacity: 0, size: 3.6 } },
    ]);
    graph.updateEdgeData([
      { id: "bond:assertion:0", style: { ...frame.edges[0]!.style, opacity: 0 } },
    ]);
    if (convergeStrandedToFrame(graph, frame) !== true) {
      problems.push("stranded frame did not converge");
    }
    const healedNode = graph.getNodeData("entity:0").style as Record<string, unknown>;
    const healedEdge = graph.getEdgeData("bond:assertion:0").style as Record<string, unknown>;
    const wantSize = (node.style as Record<string, unknown>).size;
    if (healedNode.opacity !== 1 || JSON.stringify(healedNode.size) !== JSON.stringify(wantSize)) {
      problems.push(`node not healed: ${JSON.stringify({ opacity: healedNode.opacity, size: healedNode.size })}`);
    }
    if (healedEdge.opacity !== 1) {
      problems.push(`edge not healed: ${JSON.stringify({ opacity: healedEdge.opacity })}`);
    }
    if (convergeStrandedToFrame(graph, frame) !== false) {
      problems.push("healed frame converged again");
    }
    return problems;
  });
  expect(verdict).toEqual([]);
});

test("a restyle heals poses a cancelled arrival stranded", async ({ page, world }) => {
  world.count = 3;
  world.binary = true;
  await page.goto("/");
  await openPropertyTable(page);
  await readRow(page, 0);
  await readRow(page, 1);
  await readRow(page, 2);
  await selectReferent(page, "entity:0");
  await expect(reader(page).locator("h2")).toHaveText("Entity 0");
  await expect.poll(() => labeledIncidentCount(page, "entity:0")).toBeGreaterThan(0);
  await strandMark(page, "entity:1", "bond:assertion:1");
  // A selection changes naming, never topology or positions, so this draw
  // takes the restyle lane — the lane that diffs authored against authored
  // and would otherwise leave the stranded poses frozen.
  await selectReferent(page, "entity:2");
  await expect(reader(page).locator("h2")).toHaveText("Entity 2");
  await expect.poll(() => page.evaluate(() => {
    const graph = (window as unknown as CanvasWindow).__worldFieldGraph;
    const node = graph.getNodeData("entity:1").style as Record<string, unknown>;
    const edge = graph.getEdgeData("bond:assertion:1").style as Record<string, unknown>;
    return node.opacity === 1 && edge.opacity === 1;
  })).toBe(true);
});

test("the fan yields to a hold exactly under its scope", async ({ page, world }) => {
  // Evaluated in the page: `spread.ts` shares its module graph with the
  // renderer's marks, which the Node runner cannot import.
  world.count = 1;
  await page.goto("/");
  const verdict = await page.evaluate(async () => {
    const { spreadYieldsToHold } = await import("/src/world/spread.ts");
    const edges = [
      { source: "hub", target: "a" },
      { source: "b", target: "hub" },
      { source: "hub", target: "hub" },
      { source: "x", target: "y" },
      { source: 7, target: "hub" },
    ];
    const scopes = ["none", "owner", "neighbourhood", "any"] as const;
    const yields = (scope: (typeof scopes)[number], pressed: string) =>
      spreadYieldsToHold(scope, "hub", pressed, edges);
    const problems: string[] = [];
    const check = (scope: (typeof scopes)[number], pressed: string, want: boolean) => {
      if (yields(scope, pressed) !== want) {
        problems.push(`${scope} + ${pressed}: want ${want}`);
      }
    };
    for (const scope of scopes) {
      check(scope, "hub", scope !== "none");
      check(scope, "a", scope === "neighbourhood" || scope === "any");
      check(scope, "b", scope === "neighbourhood" || scope === "any");
      check(scope, "stranger", scope === "any");
      check(scope, "x", scope === "any");
      check(scope, "7", scope === "any");
      if (spreadYieldsToHold(scope, null, "hub", edges)) {
        problems.push(`${scope} + null owner yields`);
      }
    }
    return problems;
  });
  expect(verdict).toEqual([]);
});

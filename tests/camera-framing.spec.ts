/**
 * The field camera: what a person can see after they introduce something.
 *
 * Every assertion here is about painted geometry in the browser — G6 render
 * bounds through G6's own canvas-to-viewport conversion, against the part of
 * the canvas the docks and the bars actually leave, measured from the DOM.
 * Not "a helper was called", and not a node centre with positive coordinates.
 *
 * The policy under test (see `canvasFocus.ts`):
 *
 * - The first claim on an empty field is composed: it and the discs it joins
 *   are centred in the usable room.
 * - After that the camera is the person's. A table row, the finder or reader
 *   travel reveals the named mark with its participants by the shortest pan,
 *   and does not move at all when they already show.
 * - An expansion reveals the anchor and the neighbours it introduced by the
 *   shortest pan. Too large for the room, the neighbourhood is centred with
 *   the anchor held in view. No automatic move changes zoom.
 * - A wheel or press on the field cancels any automatic move, pending or
 *   flying. A restored camera is never recomposed.
 *
 * The Chinook scenes use the real prepared file through the real adapters
 * (see `chinook-serve.ts`) and skip without it. KI_CAMERA_SHOTS=<dir> saves
 * the before/after screenshots used in the validation record.
 */
import { test as base, expect, type Page, type Route } from "@playwright/test";
import type { Graph } from "@antv/g6";
import { join } from "node:path";
import { prepared, serve, UPSTREAM } from "./chinook-serve";

type FieldWindow = Window & { __worldFieldGraph?: Graph };
type Box = { left: number; top: number; right: number; bottom: number };
type Camera = { zoom: number; cx: number; cy: number };

const SHOTS = process.env.KI_CAMERA_SHOTS;
async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

// ---------------------------------------------------------------- fixture

/**
 * An ordinary binary world, independent of Chinook: `property(item, peer,
 * value)`. A chain by default (`entity:i — entity:i+1`); with `hub`, every
 * claim hangs off `entity:0`, which is what an expansion reads.
 */
class FixtureWorld {
  count = 3;
  hub = false;
  id = "review";
  private gates = new Map<string, { reached: () => void; released: Promise<void>; release: () => void }>();

  block(key: string) {
    let reached!: () => void;
    let release!: () => void;
    const requested = new Promise<void>((done) => { reached = done; });
    const released = new Promise<void>((done) => { release = done; });
    this.gates.set(key, { reached, released, release });
    return { requested, release };
  }

  releaseAll() {
    for (const gate of this.gates.values()) gate.release();
  }

  get roles() {
    return [
      { name: "item", type: "REFERENT", referent: true, kinds: ["entity"] },
      { name: "peer", type: "REFERENT", referent: true, kinds: ["entity"] },
      { name: "value", type: "TEXT", referent: false },
    ];
  }

  tuples() {
    return Array.from({ length: this.count }, (_, i) => ({
      assertion_id: `assertion:${i}`, origin: "SEMANTIC", origins: ["SEMANTIC"],
      values: { item: `entity:${this.hub ? 0 : i}`, peer: `entity:${i + 1}`, value: `value-${i}` },
    }));
  }

  async respond(route: Route) {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/world/")) return route.continue();
    const name = url.pathname.slice("/world/".length);
    const id = url.searchParams.get("id") ?? "";
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const gate = this.gates.get(name === "rows" ? `rows:${offset}` : name);
    if (gate) {
      gate.reached();
      await gate.released;
    }
    const relation = {
      name: "property", description: "Fixture property", mode: "BASE", arity: 3, referent_arity: 2,
      roles: this.roles, count: this.count, stale: false, origins: ["SEMANTIC"], scope: "WORLD", completeness: null,
    };
    let answer: unknown;
    switch (name) {
      case "overview":
        answer = {
          world_id: this.id, revision: 1, relations: 1, referents: this.count + 1, assertions: this.count,
          origins: { SEMANTIC: this.count }, stale: [], incomplete: [],
          demand: { purpose: { statement: "fixture" }, obligations: 0, demanded: 0 },
          governed_obligations: { count: 0, resolved: 0, unresolved: 0 },
        };
        break;
      case "schema": answer = { relations: [relation] }; break;
      case "referents":
        answer = {
          referents: Array.from({ length: this.count + 1 }, (_, i) => ({ id: `entity:${i}`, label: `Entity ${i}` })),
          total: this.count + 1, truncated: false,
        };
        break;
      case "rows": {
        const subject = url.searchParams.get("subject");
        const rows = this.tuples().filter((tuple) => !subject || Object.values(tuple.values).includes(subject));
        answer = {
          relation: "property", mode: "BASE", stale: false, roles: this.roles, offset, total: rows.length,
          rows: rows.slice(offset, offset + Number(url.searchParams.get("limit") ?? 200)),
        };
        break;
      }
      case "assertion": {
        const tuple = this.tuples().find((item) => item.assertion_id === id)!;
        answer = {
          ...tuple, relation: "property", mode: "BASE", arity: 3, roles: this.roles,
          assertion_state: "ASSERTED", created_revision: 1, relation_stale: false, completeness: null,
          grounding: [], commitment_id: id, candidate_for: [], governing_obligations: [], candidate_assessments: [],
          warrant: {
            commitment_id: id, relation: "property", assertion_origin: "SEMANTIC",
            recorded_construction_origin: "SEMANTIC", construction_origins: ["SEMANTIC"], created_revision: 1, bases: [],
          },
        };
        break;
      }
      case "referent":
        answer = {
          id, label: `Entity ${id.split(":")[1]}`, grounding: [], fields: [],
          relations: [{
            name: "property", arity: 3, mode: "BASE", stale: false,
            count: this.tuples().filter((tuple) => Object.values(tuple.values).includes(id)).length,
          }],
        };
        break;
      case "demand":
        answer = { demand: { purpose: { statement: "fixture" }, rule: null, demanded: 0, obligations: [] } };
        break;
      case "obligations": answer = { obligations: [] }; break;
      default: return route.fulfill({ status: 404, json: { error: `Unexpected fixture read: ${url}` } });
    }
    return route.fulfill({ json: answer });
  }
}

const test = base.extend<{ world: FixtureWorld }, { chinook: string }>({
  world: async ({ page }, use) => {
    const world = new FixtureWorld();
    await page.route("**/world/**", (route) => world.respond(route));
    try { await use(world); } finally { world.releaseAll(); }
  },
  chinook: [async ({}, use) => {
    await serve(UPSTREAM, "examples/chinook/declaration.json", use);
  }, { scope: "worker" }],
});

// ---------------------------------------------------------------- page

const reader = (page: Page) => page.locator(".node-reader .motion-swap__is");
const activeTable = (page: Page, name: string) => page.locator(`.motion-swap__is section[aria-label="${name}"]`);
const relationRow = (page: Page, relation: string) =>
  activeTable(page, "world relations").locator(".table__row").filter({ has: page.locator(`[title="${relation}"]`) });
/** A relation-table row by its first cell's raw value, never by position. */
const rowOf = (page: Page, relation: string, first: string) =>
  activeTable(page, `${relation} extension`).locator(".table__row[data-loaded]").filter({
    has: page.locator(`span:first-child[title="${first}"]`),
  });
const fixtureRow = (page: Page, index: number) =>
  activeTable(page, "property extension").locator(".table__row[data-loaded]").nth(index);

async function openRelation(page: Page, relation: string) {
  await relationRow(page, relation).click();
  await expect(activeTable(page, `${relation} extension`).locator(".table__row[data-loaded]").first()).toBeVisible();
}

// ---------------------------------------------------------------- geometry

/**
 * The part of the field a person can see: the canvas, less the TABLES and
 * reader docks and the header and instrument bars standing over it, as
 * currently laid out — measured, not assumed.
 */
async function usableRoom(page: Page): Promise<Box> {
  return page.evaluate(() => {
    const graph = (window as FieldWindow).__worldFieldGraph!;
    const frame = graph.getCanvas().getContainer()!.getBoundingClientRect();
    const rect = (el: Element | null) => {
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return box.width && box.height ? box : null;
    };
    const left = rect(document.querySelector(".ov--left.is-open .ov__body")) ??
      rect(document.querySelector(".ov--left .ov__handle"));
    const right = rect(document.querySelector(".ov--right.is-open .ov__body"));
    const over = (selector: string) => [...document.querySelectorAll(selector)]
      .map(rect).filter((box): box is DOMRect => Boolean(box));
    return {
      left: Math.max(frame.left, left?.right ?? -Infinity),
      right: Math.min(frame.right, right?.left ?? Infinity),
      top: Math.max(frame.top, ...over(".product-shell__top *").map((box) => box.bottom)),
      bottom: Math.min(frame.bottom, ...over(".product-shell__instrument *").map((box) => box.top)),
    };
  });
}

/**
 * Painted extents in page pixels: a disc with its name, a bond with its
 * label. Ids the tables use resolve to what the field draws for them.
 */
async function painted(page: Page, ids: string[]): Promise<Record<string, Box | null>> {
  return page.evaluate((ids) => {
    const graph = (window as FieldWindow).__worldFieldGraph!;
    const frame = graph.getCanvas().getContainer()!.getBoundingClientRect();
    const has = (id: string) => {
      try { return Boolean(graph.getElementData(id)); } catch { return false; }
    };
    const out: Record<string, Box | null> = {};
    for (const id of ids) {
      const drawn = has(id) ? id : has(`bond:${id}`) ? `bond:${id}` : null;
      if (!drawn) { out[id] = null; continue; }
      const bounds = graph.getElementRenderBounds(drawn);
      const a = graph.getViewportByCanvas(bounds.min as never);
      const b = graph.getViewportByCanvas(bounds.max as never);
      out[id] = {
        left: frame.left + Math.min(a[0], b[0]), top: frame.top + Math.min(a[1], b[1]),
        right: frame.left + Math.max(a[0], b[0]), bottom: frame.top + Math.max(a[1], b[1]),
      };
    }
    return out;
  }, ids);
}

const within = (box: Box | null, room: Box, slack = 0.5) => Boolean(box) &&
  box!.left >= room.left - slack && box!.right <= room.right + slack &&
  box!.top >= room.top - slack && box!.bottom <= room.bottom + slack;

async function insideRoom(page: Page, ids: string[]) {
  const room = await usableRoom(page);
  const boxes = await painted(page, ids);
  return Object.fromEntries(ids.map((id) => [id, within(boxes[id], room)]));
}

async function camera(page: Page): Promise<Camera> {
  return page.evaluate(() => {
    const graph = (window as FieldWindow).__worldFieldGraph!;
    const [cx, cy] = graph.getViewportCenter();
    return { zoom: graph.getZoom(), cx, cy };
  });
}

const fieldHas = (page: Page, ids: string[]) => page.evaluate((ids) => {
  const graph = (window as FieldWindow).__worldFieldGraph;
  if (!graph || graph.destroyed) return false;
  const has = (id: string) => {
    try { return Boolean(graph.getElementData(id)); } catch { return false; }
  };
  return ids.every((id) => has(id) || has(`bond:${id}`));
}, ids);

/**
 * True once the camera has held still for `frames` consecutive frames.
 *
 * The completion condition for "the camera has finished": an automatic move
 * is a 240ms flight, a cut, or nothing, so a still run longer than a flight
 * is the observable end of it.
 */
const stillFor = (page: Page, frames = 24) => page.evaluate((frames) => new Promise<boolean>((resolve) => {
  const graph = (window as FieldWindow).__worldFieldGraph;
  if (!graph || graph.destroyed) return resolve(false);
  const read = () => {
    const [x, y] = graph.getViewportCenter();
    return `${graph.getZoom().toFixed(5)}:${x.toFixed(2)}:${y.toFixed(2)}`;
  };
  const first = read();
  let seen = 0;
  const tick = () => {
    if (graph.destroyed || read() !== first) return resolve(false);
    seen += 1;
    if (seen >= frames) return resolve(true);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}), frames);

async function settled(page: Page, ids: string[] = []) {
  await expect.poll(() => fieldHas(page, ids)).toBe(true);
  await expect.poll(() => stillFor(page)).toBe(true);
}

/** Record every distinct camera from now on, to read back after. */
const recordCamera = (page: Page) => page.evaluate(() => {
  const log: string[] = [];
  (window as unknown as { __cameraLog: string[] }).__cameraLog = log;
  const tick = () => {
    const graph = (window as FieldWindow).__worldFieldGraph;
    if (graph && !graph.destroyed) {
      const [x, y] = graph.getViewportCenter();
      const now = `${graph.getZoom().toFixed(4)}:${x.toFixed(1)}:${y.toFixed(1)}`;
      if (log[log.length - 1] !== now) log.push(now);
    }
    if (log.length < 2000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const cameraLog = (page: Page) => page.evaluate(() => (window as unknown as { __cameraLog: string[] }).__cameraLog);

/** The centre of a union of boxes. */
const centreOf = (boxes: (Box | null)[]) => {
  const real = boxes.filter((box): box is Box => Boolean(box));
  const left = Math.min(...real.map((box) => box.left));
  const right = Math.max(...real.map((box) => box.right));
  const top = Math.min(...real.map((box) => box.top));
  const bottom = Math.max(...real.map((box) => box.bottom));
  return { x: (left + right) / 2, y: (top + bottom) / 2, width: right - left, height: bottom - top };
};

/** Press empty canvas and pan by (dx, dy) with the real pointer. */
async function panBy(page: Page, dx: number, dy: number) {
  const room = await usableRoom(page);
  // An empty spot on the side the pan leaves from, so the whole gesture
  // stays over the canvas rather than running under a dock.
  const at = await emptyPoint(page, room, { right: dx < 0, bottom: dy < 0 });
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + dx, at.y + dy, { steps: 40 });
  await page.mouse.up();
}

/** A point in the room with no mark under it, from the corner asked for. */
async function emptyPoint(page: Page, room: Box, from = { right: false, bottom: true }) {
  return page.evaluate(({ room, from }) => {
    const graph = (window as FieldWindow).__worldFieldGraph!;
    const frame = graph.getCanvas().getContainer()!.getBoundingClientRect();
    const ids = [...graph.getNodeData(), ...graph.getEdgeData()].map((item) => String(item.id));
    const boxes = ids.flatMap((id) => {
      try {
        const bounds = graph.getElementRenderBounds(id);
        const a = graph.getViewportByCanvas(bounds.min as never);
        const b = graph.getViewportByCanvas(bounds.max as never);
        return [{ left: frame.left + a[0] - 12, top: frame.top + a[1] - 12, right: frame.left + b[0] + 12, bottom: frame.top + b[1] + 12 }];
      } catch {
        return [];
      }
    });
    const span = (start: number, end: number, step: number, reverse: boolean) => {
      const out: number[] = [];
      for (let at = start + 40; at < end - 40; at += step) out.push(at);
      return reverse ? out.reverse() : out;
    };
    for (const y of span(room.top, room.bottom, 37, from.bottom)) {
      for (const x of span(room.left, room.right, 41, from.right)) {
        if (!boxes.some((box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom)) return { x, y };
      }
    }
    throw new Error("no empty canvas in the room");
  }, { room, from });
}

/** Establish a field from the fixture's first row, settled. */
async function firstClaim(page: Page, world: FixtureWorld) {
  await page.goto("/");
  await openRelation(page, "property");
  await fixtureRow(page, 0).click();
  await expect(reader(page).locator("h2")).toHaveText("property");
  await settled(page, ["entity:0", "entity:1", "assertion:0"]);
  void world;
}

/**
 * Name claim 0 in its table row, then hand the camera to `gesture` while
 * the reveal is still under way.
 *
 * The row is pressed with bare mouse events, and under ordinary motion the
 * gesture waits for the camera's first moved frame — so it lands inside the
 * 240ms flight by construction, not by a race. The page timestamps both, and
 * the test fails if the person's input came after the flight would have
 * ended, rather than passing for the wrong reason.
 */
async function pressDuringReveal(
  page: Page,
  motion: "reduce" | "no-preference",
  gesture: () => Promise<void>,
  input: "wheel" | "pointerdown",
) {
  const row = (await fixtureRow(page, 0).boundingBox())!;
  await page.evaluate((input) => {
    const graph = (window as FieldWindow).__worldFieldGraph!;
    const read = () => graph.getViewportCenter().join(",");
    const start = read();
    const timing = { moved: 0, input: 0 };
    (window as unknown as { __timing: typeof timing }).__timing = timing;
    (window as unknown as { __moved: Promise<void> }).__moved = new Promise<void>((resolve) => {
      const tick = () => {
        if (read() !== start) {
          timing.moved = performance.now();
          resolve();
        } else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    graph.getCanvas().getContainer()!.addEventListener(input, () => {
      timing.input ||= performance.now();
    }, { capture: true });
  }, input);
  await page.mouse.click(row.x + row.width / 2, row.y + row.height / 2);
  if (motion === "no-preference") {
    await page.evaluate(() => (window as unknown as { __moved: Promise<void> }).__moved);
  }
  await gesture();
  if (motion === "no-preference") {
    const timing = await page.evaluate(() => (window as unknown as { __timing: { moved: number; input: number } }).__timing);
    expect(timing.input - timing.moved, "the person's input came after the flight had landed").toBeLessThan(200);
  }
}

// ---------------------------------------------------------------- scenes

for (const motion of ["reduce", "no-preference"] as const) {
  test(`the first binary claim is composed inside the usable room with ${motion} motion`, async ({ page, world }) => {
    await page.emulateMedia({ reducedMotion: motion });
    await recordCamera(page).catch(() => undefined);
    await firstClaim(page, world);
    await shot(page, `fixture-first-placement-${motion}`);
    const marks = ["entity:0", "entity:1", "assertion:0"];
    expect(await insideRoom(page, marks)).toEqual({ "entity:0": true, "entity:1": true, "assertion:0": true });
    // Composed, not merely inside: the claim stands in the middle of the room.
    const room = await usableRoom(page);
    const claim = centreOf(Object.values(await painted(page, marks)));
    expect(Math.abs(claim.x - (room.left + room.right) / 2)).toBeLessThan(30);
    expect(Math.abs(claim.y - (room.top + room.bottom) / 2)).toBeLessThan(30);
    // No zoom was chosen for the person.
    expect((await camera(page)).zoom).toBe(1);
  });

  test(`reduced or not, the first composition lands in the same place (${motion})`, async ({ page, world }) => {
    await page.emulateMedia({ reducedMotion: motion });
    await page.goto("/");
    await openRelation(page, "property");
    await recordCamera(page);
    await fixtureRow(page, 0).click();
    await settled(page, ["entity:0", "entity:1", "assertion:0"]);
    const log = await cameraLog(page);
    if (motion === "reduce") {
      // A cut: the mount's camera, then the composed one. No travel between.
      expect(log.length).toBeLessThanOrEqual(2);
    } else {
      expect(log.length).toBeGreaterThan(3);
    }
    // Both modes end at the same camera: 1440x1000, TABLES 360, reader open.
    const end = await camera(page);
    expect(end.zoom).toBe(1);
    const room = await usableRoom(page);
    const claim = centreOf(Object.values(await painted(page, ["entity:0", "entity:1", "assertion:0"])));
    expect(Math.abs(claim.x - (room.left + room.right) / 2)).toBeLessThan(30);
    expect(Math.abs(claim.y - (room.top + room.bottom) / 2)).toBeLessThan(30);
    void world;
  });

  test(`a selection already in view does not move the camera, with ${motion} motion`, async ({ page, world }) => {
    await page.emulateMedia({ reducedMotion: motion });
    await firstClaim(page, world);
    const before = await camera(page);
    await recordCamera(page);
    // The same row again, then the claim's own referent from the reader.
    await fixtureRow(page, 0).click();
    await reader(page).locator(".world__roles button").first().click();
    await expect(reader(page).locator("h2")).toHaveText("Entity 0");
    await expect.poll(() => stillFor(page, 30)).toBe(true);
    expect(await camera(page)).toEqual(before);
    expect(await cameraLog(page)).toHaveLength(1);
  });

  test(`a second claim is revealed by the shortest pan, zoom kept, with ${motion} motion`, async ({ page, world }) => {
    await page.emulateMedia({ reducedMotion: motion });
    await firstClaim(page, world);
    // Push the first claim to the room's far top-left, so the next claim —
    // placed beside it — starts mostly outside.
    await panBy(page, -320, -330);
    await expect.poll(() => stillFor(page)).toBe(true);
    const moved = await camera(page);
    await fixtureRow(page, 2).click();
    await settled(page, ["entity:2", "entity:3", "assertion:2"]);
    expect(await insideRoom(page, ["entity:2", "entity:3", "assertion:2"]))
      .toEqual({ "entity:2": true, "entity:3": true, "assertion:2": true });
    const after = await camera(page);
    expect(after.zoom).toBe(moved.zoom);
    // Revealed, not recomposed: the claim sits inside an edge of the room
    // rather than in its centre.
    const room = await usableRoom(page);
    const claim = centreOf(Object.values(await painted(page, ["entity:2", "entity:3", "assertion:2"])));
    expect(Math.hypot(claim.x - (room.left + room.right) / 2, claim.y - (room.top + room.bottom) / 2)).toBeGreaterThan(60);
  });

  test(`a wheel during a reveal keeps the person's camera, with ${motion} motion`, async ({ page, world }) => {
    await page.emulateMedia({ reducedMotion: motion });
    world.count = 3;
    await firstClaim(page, world);
    // Take the claim far off-screen by hand.
    await panBy(page, -620, -560);
    await expect.poll(() => stillFor(page)).toBe(true);

    expect((await insideRoom(page, ["entity:1"]))["entity:1"]).toBe(false);
    const room = await usableRoom(page);
    const spot = await emptyPoint(page, room);
    // Ask for it back, and take the wheel before the reveal can finish.
    await pressDuringReveal(page, motion, async () => {
      await page.mouse.move(spot.x, spot.y);
      await page.mouse.wheel(0, -120);
    }, "wheel");
    // The wheel's zoom is instant; a flight still running would keep the
    // canvas moving after it.
    expect(await stillFor(page, 20), "the camera kept moving after the wheel").toBe(true);
    const after = await camera(page);
    // What the person's wheel left is what stays: nothing pulls back later.
    await expect.poll(() => stillFor(page, 45)).toBe(true);
    expect(await camera(page)).toEqual(after);
    expect(after.zoom).toBeGreaterThan(1);
  });

  test(`a press and pan during a reveal keep the person's camera, with ${motion} motion`, async ({ page, world }) => {
    await page.emulateMedia({ reducedMotion: motion });
    await firstClaim(page, world);
    await panBy(page, -620, -560);
    await expect.poll(() => stillFor(page)).toBe(true);
    const spot = await emptyPoint(page, await usableRoom(page), { right: true, bottom: true });
    // Press empty canvas while the reveal flies, and hold it there. A
    // cancelled flight leaves the camera still under the held press; one
    // still running would carry the canvas on beneath the pointer.
    await pressDuringReveal(page, motion, async () => {
      await page.mouse.move(spot.x, spot.y);
      await page.mouse.down();
    }, "pointerdown");
    expect(await stillFor(page, 20), "the camera kept moving under a held press").toBe(true);
    // Then the person pans, and what they leave is what stays.
    await page.mouse.move(spot.x - 60, spot.y - 40, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => stillFor(page, 30)).toBe(true);
    const after = await camera(page);
    await expect.poll(() => stillFor(page, 45)).toBe(true);
    expect(await camera(page)).toEqual(after);
  });

  test(`the newest of two quick reveals wins, with ${motion} motion`, async ({ page, world }) => {
    await page.emulateMedia({ reducedMotion: motion });
    world.count = 4;
    await firstClaim(page, world);
    await fixtureRow(page, 3).click();
    await settled(page, ["entity:3", "entity:4", "assertion:3"]);
    // Both claims far away, on opposite sides.
    await panBy(page, 330, 380);
    await expect.poll(() => stillFor(page)).toBe(true);
    await fixtureRow(page, 0).click();
    await fixtureRow(page, 3).click();
    await expect(reader(page).locator(".world__roles")).toContainText("Entity 4");
    await settled(page, ["assertion:3"]);
    expect(await insideRoom(page, ["entity:3", "entity:4", "assertion:3"]))
      .toEqual({ "entity:3": true, "entity:4": true, "assertion:3": true });
    // And it stays there: the older request does not land afterwards.
    const end = await camera(page);
    await expect.poll(() => stillFor(page, 45)).toBe(true);
    expect(await camera(page)).toEqual(end);
  });

  test(`opening, closing and resizing panels leaves the camera alone, with ${motion} motion`, async ({ page, world }) => {
    await page.emulateMedia({ reducedMotion: motion });
    await firstClaim(page, world);
    const before = await camera(page);
    await recordCamera(page);
    await reader(page).getByRole("button", { name: "close" }).click();
    await expect(page.locator(".ov--right.is-open")).toHaveCount(0);
    await expect.poll(() => stillFor(page)).toBe(true);
    // The TABLES dock, by its resize separator.
    const separator = page.getByRole("separator", { name: "Resize Tables" });
    const grip = (await separator.boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + 120, grip.y + grip.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => stillFor(page)).toBe(true);
    // Reopen the reader by naming the same claim — already in view, so
    // nothing moves for that either.
    await fixtureRow(page, 0).click();
    await expect(page.locator(".ov--right.is-open")).toHaveCount(1);
    await expect.poll(() => stillFor(page, 30)).toBe(true);
    const after = await camera(page);
    expect(after.zoom).toBe(before.zoom);
    // The canvas did not move: only the panels did. (A host resize keeps the
    // camera's corner, so its centre may shift with the host; the marks may
    // not.)
    expect(await cameraLog(page)).toHaveLength(1);
  });

  test(`a cleared field composes afresh and keeps no stale flight, with ${motion} motion`, async ({ page, world }) => {
    await page.emulateMedia({ reducedMotion: motion });
    world.count = 3;
    await firstClaim(page, world);
    await panBy(page, -620, -560);
    await expect.poll(() => stillFor(page)).toBe(true);
    await fixtureRow(page, 0).click();
    await page.getByRole("button", { name: "clear", exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() =>
      (window as FieldWindow).__worldFieldGraph?.getNodeData().length ?? 0))).toBe(0);
    await fixtureRow(page, 2).click();
    await settled(page, ["entity:2", "entity:3", "assertion:2"]);
    const room = await usableRoom(page);
    const claim = centreOf(Object.values(await painted(page, ["entity:2", "entity:3", "assertion:2"])));
    expect(Math.abs(claim.x - (room.left + room.right) / 2)).toBeLessThan(30);
    expect(Math.abs(claim.y - (room.top + room.bottom) / 2)).toBeLessThan(30);
  });
}

test("the reveal rule, as arithmetic", async ({ page, world }) => {
  await page.goto("/");
  void world;
  const cases = await page.evaluate(async () => {
    const { revealDelta } = await import("/src/world/canvasFocus.ts" as string) as typeof import("../src/world/canvasFocus");
    const room = { left: 100, top: 50, right: 700, bottom: 650 };
    const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
    return {
      inside: revealDelta(box(200, 200, 300, 300), room),
      above: revealDelta(box(200, -100, 300, 0), room),
      right: revealDelta(box(650, 200, 760, 300), room),
      composed: revealDelta(box(200, 200, 300, 300), room, { centre: true }),
      // Wider than the room: centred, then held so the anchor stays inside.
      wide: revealDelta(box(-500, 300, 900, 400), room, { keep: box(-480, 330, -400, 370) }),
      wideFree: revealDelta(box(-500, 300, 900, 400), room),
      // An anchor larger than the room itself is centred.
      huge: revealDelta(box(0, 0, 2000, 100), room, { keep: box(0, 0, 1000, 100) }),
    };
  });
  expect(cases.inside).toEqual([0, 0]);
  expect(cases.above).toEqual([0, 150]);
  expect(cases.right).toEqual([-60, 0]);
  expect(cases.composed).toEqual([150, 100]);
  expect(cases.wide).toEqual([580, 0]);
  expect(cases.wideFree).toEqual([200, 0]);
  expect(cases.huge).toEqual([-100, 50]);
});

test("a narrow window with both docks open still composes the claim inside them", async ({ page, world }) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await firstClaim(page, world);
  const room = await usableRoom(page);
  // Both docks stand over a 1100px canvas: a little over a third is left.
  await expect(page.locator(".ov--left.is-open")).toHaveCount(1);
  await expect(page.locator(".ov--right.is-open")).toHaveCount(1);
  expect(room.right - room.left).toBeLessThan(450);
  expect(await insideRoom(page, ["entity:0", "entity:1", "assertion:0"]))
    .toEqual({ "entity:0": true, "entity:1": true, "assertion:0": true });
  await shot(page, "fixture-narrow-first-placement");
});

test("a deliberately moved camera is restored exactly and not recomposed", async ({ page, world }) => {
  await firstClaim(page, world);
  await panBy(page, 140, -90);
  await page.mouse.move(700, 600);
  await page.mouse.wheel(0, 200);
  await expect.poll(() => stillFor(page)).toBe(true);
  const left = await camera(page);
  expect(left.zoom).toBeLessThan(1);
  // The recorder keeps the settled, person-moved camera.
  await expect.poll(() => page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("worldir.camera:field:review:1") ?? "null");
    return stored && [stored.zoom, stored.cx, stored.cy];
  })).toEqual([left.zoom, left.cx, left.cy]);
  await page.reload();
  await settled(page, ["entity:0", "entity:1", "assertion:0"]);
  const back = await camera(page);
  expect(back.zoom).toBeCloseTo(left.zoom, 6);
  expect(Math.abs(back.cx - left.cx)).toBeLessThan(0.5);
  expect(Math.abs(back.cy - left.cy)).toBeLessThan(0.5);
  // Naming a claim that the restored camera already shows moves nothing.
  await openRelation(page, "property");
  await fixtureRow(page, 0).click();
  await expect(reader(page).locator("h2")).toHaveText("property");
  await expect.poll(() => stillFor(page, 30)).toBe(true);
  const after = await camera(page);
  expect(after.zoom).toBeCloseTo(left.zoom, 6);
  expect(Math.abs(after.cx - left.cx)).toBeLessThan(0.5);
  expect(Math.abs(after.cy - left.cy)).toBeLessThan(0.5);
});

test("dragging a mark moves the mark, never the camera", async ({ page, world }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await firstClaim(page, world);
  const before = await camera(page);
  await recordCamera(page);
  const at = await page.evaluate(() => {
    const graph = (window as FieldWindow).__worldFieldGraph!;
    const [x, y] = graph.getViewportByCanvas(graph.getElementPosition("entity:1"));
    const frame = graph.getCanvas().getContainer()!.getBoundingClientRect();
    return { x: frame.left + x, y: frame.top + y, canvas: graph.getElementPosition("entity:1").slice(0, 2) };
  });
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 90, at.y + 40, { steps: 8 });
  const held = await page.evaluate(() =>
    (window as FieldWindow).__worldFieldGraph!.getElementPosition("entity:1").slice(0, 2));
  await page.mouse.up();
  await expect.poll(() => stillFor(page)).toBe(true);
  // Under the pointer: zoom is 1, so canvas and screen deltas agree.
  expect(held[0] - at.canvas[0]).toBeCloseTo(90, 0);
  expect(held[1] - at.canvas[1]).toBeCloseTo(40, 0);
  expect(await camera(page)).toEqual(before);
  expect(await cameraLog(page)).toHaveLength(1);
});

/** Expand the reader's referent through `relation`, settled. */
async function expandThrough(page: Page, relation: string) {
  const expand = reader(page).locator(".gm__list button").filter({ hasText: relation }).first();
  await expand.click();
  await expect(expand).toContainText("take off");
  return expand;
}

for (const motion of ["reduce", "no-preference"] as const) {
  test(`a large expansion keeps its scale and the anchor, centred on its neighbourhood, with ${motion} motion`, async ({ page, world }) => {
    await page.emulateMedia({ reducedMotion: motion });
    world.count = 250;
    world.hub = true;
    await firstClaim(page, world);
    await reader(page).locator(".world__roles button").first().click();
    await expect(reader(page).locator("h2")).toHaveText("Entity 0");
    const zoom = (await camera(page)).zoom;
    // The second page waits, so the camera has to wait for the whole
    // neighbourhood rather than frame the first page and then the second.
    const gate = world.block("rows:200");
    const started = Date.now();
    const expand = reader(page).locator(".gm__list button").filter({ hasText: "property" }).first();
    await expand.click();
    await gate.requested;
    await expect.poll(() => fieldHas(page, ["entity:200"])).toBe(true);
    const waiting = await camera(page);
    await expect.poll(() => stillFor(page, 30)).toBe(true);
    expect(await camera(page)).toEqual(waiting);
    gate.release();
    await expect(expand).toContainText("take off");
    await settled(page, ["entity:250"]);
    const elapsed = Date.now() - started;
    test.info().annotations.push({ type: "expand-250-to-settled-ms", description: String(elapsed) });
    const room = await usableRoom(page);
    const ids = Array.from({ length: 251 }, (_, i) => `entity:${i}`);
    const boxes = await painted(page, ids);
    // Readable scale: the camera did not zoom out to fit 250 discs.
    expect((await camera(page)).zoom).toBe(zoom);
    // The anchor is in view, and the neighbourhood is centred on the room
    // rather than left hanging off one corner.
    expect(within(boxes["entity:0"], room)).toBe(true);
    const hood = centreOf(Object.values(boxes));
    expect(hood.width).toBeGreaterThan(room.right - room.left);
    expect(Math.abs(hood.x - (room.left + room.right) / 2)).toBeLessThan(60);
    expect(Math.abs(hood.y - (room.top + room.bottom) / 2)).toBeLessThan(60);
    // What is left over is one reader row away: reader travel reveals it.
    const outside = ids.find((id) => !within(boxes[id], room) && boxes[id])!;
    expect(outside).toBeTruthy();
    await shot(page, `fixture-250-expanded-${motion}`);
  });
}

// ---------------------------------------------------------------- Chinook

test.describe("Chinook", () => {
  test.skip(!prepared(), "run examples/chinook/prepare.py --view-copy first");

  for (const motion of ["reduce", "no-preference"] as const) {
    test(`track 10 and its album are framed, then album 1's tracks, with ${motion} motion`, async ({ page, chinook }) => {
      await page.emulateMedia({ reducedMotion: motion });
      await page.goto(chinook);
      await openRelation(page, "track_on_album");
      await rowOf(page, "track_on_album", "track:10").click();
      await expect(reader(page).locator("h2")).toHaveText("track_on_album");
      await settled(page, ["track:10", "album:1", "track_on_album:10"]);
      await shot(page, `chinook-track-10-${motion}`);
      expect(await insideRoom(page, ["track:10", "album:1", "track_on_album:10"]))
        .toEqual({ "track:10": true, "album:1": true, "track_on_album:10": true });
      // Not under the World-id header, specifically.
      const header = await page.locator(".product-shell__workspace").boundingBox();
      const album = (await painted(page, ["album:1"]))["album:1"]!;
      expect(album.top).toBeGreaterThan(header!.y + header!.height);

      await reader(page).locator(".world__roles button").filter({ hasText: "For Those About To Rock" }).click();
      await expect(reader(page).locator("h2")).toHaveText("For Those About To Rock We Salute You");
      const zoom = (await camera(page)).zoom;
      await expandThrough(page, "track_on_album");
      const tracks = [1, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((id) => `track:${id}`);
      await settled(page, tracks);
      await shot(page, `chinook-album-1-expanded-${motion}`);
      const inside = await insideRoom(page, ["album:1", ...tracks]);
      expect(Object.entries(inside).filter(([, shown]) => !shown)).toEqual([]);
      expect((await camera(page)).zoom).toBe(zoom);
    });

    test(`album 141's 57 tracks keep a readable scale, the anchor and a way to the rest, with ${motion} motion`, async ({ page, chinook }) => {
      await page.emulateMedia({ reducedMotion: motion });
      await page.goto(chinook);
      await page.locator(".nodefind__input").fill("Greatest Hits");
      await page.locator(".nodefind__row").filter({ has: page.locator(".nodefind__anchor", { hasText: /^album:141$/ }) })
        .dispatchEvent("mousedown");
      await expect(reader(page).locator("h2")).toHaveText("Greatest Hits");
      await settled(page, ["album:141"]);
      // A lone seed is composed in the middle of the room.
      const room = await usableRoom(page);
      const seed = centreOf([(await painted(page, ["album:141"]))["album:141"]]);
      expect(Math.abs(seed.x - (room.left + room.right) / 2)).toBeLessThan(2);
      expect(Math.abs(seed.y - (room.top + room.bottom) / 2)).toBeLessThan(2);

      const started = Date.now();
      await expandThrough(page, "track_on_album");
      const ids = await page.evaluate(() => (window as FieldWindow).__worldFieldGraph!.getNodeData()
        .map((node) => String(node.id)).filter((id) => id.startsWith("track:")));
      await expect.poll(async () => (await page.evaluate(() => (window as FieldWindow).__worldFieldGraph!.getNodeData()
        .filter((node) => String(node.id).startsWith("track:")).length))).toBe(57);
      await settled(page, ["album:141"]);
      test.info().annotations.push({ type: "expand-57-to-settled-ms", description: String(Date.now() - started) });
      await shot(page, `chinook-album-141-expanded-${motion}`);
      void ids;
      const tracks = await page.evaluate(() => (window as FieldWindow).__worldFieldGraph!.getNodeData()
        .map((node) => String(node.id)).filter((id) => id.startsWith("track:")));
      const boxes = await painted(page, ["album:141", ...tracks]);
      expect((await camera(page)).zoom).toBe(1);
      expect(within(boxes["album:141"], room)).toBe(true);
      const shown = tracks.filter((id) => within(boxes[id], room));
      test.info().annotations.push({ type: "album-141-tracks-inside", description: `${shown.length}/57` });
      expect(shown.length).toBeGreaterThan(40);
      // The rest is reachable by naming it: the finder reveals an off-screen
      // track's disc without changing the scale.
      const away = tracks.find((id) => !within(boxes[id], room))!;
      expect(away).toBeTruthy();
      const label = await page.evaluate((id) =>
        String((window as FieldWindow).__worldFieldGraph!.getNodeData(id).style?.labelText ?? ""), away);
      await page.locator(".nodefind__input").fill(label.split("\n")[0].replace(/…$/, "").trim());
      await page.locator(".nodefind__row").filter({ has: page.locator(".nodefind__anchor", { hasText: new RegExp(`^${away}$`) }) })
        .dispatchEvent("mousedown");
      await settled(page, [away]);
      expect(await insideRoom(page, [away])).toEqual({ [away]: true });
      expect((await camera(page)).zoom).toBe(1);
    });
  }
});

import { test, expect } from "@playwright/test";
import {
  resolveVisibility,
  stampLabelStrength,
  VISIBILITY_WHISPER,
  type VisibilityBox,
  type VisibilityRank,
} from "../src/world/visibility";

const rank = (changes: Partial<VisibilityRank> = {}): VisibilityRank => ({
  selection: false, hover: false, named: false, kind: 0, ...changes,
});
const box = (id: string, x: number, width = 100, height = 20): VisibilityBox => ({
  id, minX: x, maxX: x + width, minY: 0, maxY: height,
});
const equalRanks = new Map([["a", rank()], ["b", rank()]]);
const pair = (coverage: number, prev = new Map<string, number>()) =>
  resolveVisibility([box("a", 0), box("b", 100 * (1 - coverage))], equalRanks, prev);

test("a name yields progressively as crowding grows, with a readable winner", () => {
  const strengths = [0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.6, 1].map((coverage) => {
    const settled = pair(coverage);
    expect(settled.get("a")).toBe(1);
    return settled.get("b")!;
  });
  expect(strengths.slice(0, 2)).toEqual([1, 1]);
  for (let i = 2; i < 6; i += 1) {
    expect(strengths[i]).toBeLessThan(strengths[i - 1]);
    expect(strengths[i]).toBeGreaterThan(VISIBILITY_WHISPER);
  }
  expect(strengths.slice(6)).toEqual([VISIBILITY_WHISPER, VISIBILITY_WHISPER]);
  // Crossing the onset is a small change in ink, not the old 75% drop.
  expect(pair(0.0801).get("b")!).toBeGreaterThan(0.98);
});

test("short names and long names yield by their own occupied fraction", () => {
  const strength = (width: number, height: number) => resolveVisibility(
    [box("a", 0, width, height), box("b", width * 0.7, width, height)],
    equalRanks, new Map(),
  ).get("b")!;
  expect(strength(20, 8)).toBeCloseTo(strength(200, 20), 12);
});

test("moving or zooming the geometry preserves the reading hierarchy", () => {
  const original = [box("a", 0), box("b", 70)];
  const expected = resolveVisibility(original, equalRanks, new Map());
  for (const scale of [0.25, 0.5, 2, 8]) {
    const moved = original.map((item) => ({
      id: item.id,
      minX: item.minX * scale + 400, maxX: item.maxX * scale + 400,
      minY: item.minY * scale - 80, maxY: item.maxY * scale - 80,
    }));
    expect(resolveVisibility(moved, equalRanks, new Map())).toEqual(expected);
  }
});

test("a continuing contact survives small grazing movements and releases with room", () => {
  let previous = pair(0.2);
  for (const coverage of [0.079, 0.081, 0.06, 0.075, 0.05]) {
    previous = pair(coverage, previous);
    expect(previous.get("b")!).toBeLessThan(1);
    expect(previous.get("a")).toBe(1);
  }
  expect(pair(0.06).get("b")).toBe(1);
  previous = pair(0.039, previous);
  expect(previous.get("b")).toBe(1);
  expect(pair(0.079, previous).get("b")).toBe(1);
});

test("selection and hover override an incumbent without waiting for geometry to change", () => {
  const boxes = [box("a", 0), box("b", 0)];
  const previous = resolveVisibility(boxes, equalRanks, new Map());
  for (const attention of ["hover", "selection"] as const) {
    const ranks = new Map([["a", rank()], ["b", rank({ [attention]: true })]]);
    const settled = resolveVisibility(boxes, ranks, previous);
    expect(settled.get("b")).toBe(1);
    expect(settled.get("a")).toBe(VISIBILITY_WHISPER);
  }
  const selected = new Map([["a", rank({ hover: true })], ["b", rank({ selection: true })]]);
  expect(resolveVisibility(boxes, selected, previous).get("b")).toBe(1);
});

test("small movements within a yielded state do not keep restarting its ink", () => {
  const previous = pair(0.3);
  for (const coverage of [0.3001, 0.2999, 0.3005]) {
    expect(pair(coverage, previous)).toEqual(previous);
  }
  expect(pair(0.35, previous).get("b")!).toBeLessThan(previous.get("b")!);
  expect(pair(0, previous).get("b")).toBe(1);
});

test("naming and structural priority beat tie memory", () => {
  const boxes = [box("a", 0), box("b", 0)];
  const previous = new Map([["a", 1], ["b", VISIBILITY_WHISPER]]);
  const named = new Map([["a", rank()], ["b", rank({ named: true })]]);
  expect(resolveVisibility(boxes, named, previous).get("b")).toBe(1);
  const structural = new Map([["a", rank({ kind: 1 })], ["b", rank()]]);
  expect(resolveVisibility(boxes, structural, previous).get("b")).toBe(1);
});

test("equal ranks retain the readable incumbent regardless of enumeration order", () => {
  const previous = new Map([["a", VISIBILITY_WHISPER], ["b", 1]]);
  for (const boxes of [[box("a", 0), box("b", 0)], [box("b", 0), box("a", 0)]]) {
    const settled = resolveVisibility(boxes, equalRanks, previous);
    expect(settled.get("b")).toBe(1);
    expect(settled.get("a")).toBe(VISIBILITY_WHISPER);
    expect(resolveVisibility(boxes, equalRanks, settled)).toEqual(settled);
  }
});

test("a yielded name exerts less pressure on its other neighbor", () => {
  const boxes = [box("a", 0), box("b", 40), box("c", 100)];
  const ranks = new Map([
    ["a", rank({ selection: true })], ["b", rank({ hover: true })], ["c", rank()],
  ]);
  const settled = resolveVisibility(boxes, ranks, new Map());
  expect(settled.get("a")).toBe(1);
  expect(settled.get("b")).toBeCloseTo(VISIBILITY_WHISPER);
  expect(settled.get("c")!).toBeGreaterThan(0.95);
  expect(settled.get("c")!).toBeLessThan(1);
  expect(resolveVisibility(boxes, ranks, settled)).toEqual(settled);
});

// Occlusion: a name wholly under a mark body painted above it presses nothing.
// `a` is selected and `b` overlaps 30% of its own width — the ordinary contest
// `b` loses. Bodies and depths are explicit; nothing here is a browser.
const contest = [box("a", 0), box("b", 70)];
const selectedA = new Map([["a", rank({ selection: true })], ["b", rank()]]);
const body = (z: number, cover = { minX: -10, minY: -10, maxX: 110, maxY: 30 }) => ({ ...cover, z });
const depths = new Map([["a", 1], ["b", 3]]);
const ordinary = resolveVisibility(contest, selectedA, new Map());

test("overlapping visible names contest as usual when nothing covers them", () => {
  expect(ordinary.get("a")).toBe(1);
  expect(ordinary.get("b")!).toBeLessThan(1);
  expect(ordinary.get("b")!).toBeGreaterThan(VISIBILITY_WHISPER);
  expect(resolveVisibility(contest, selectedA, new Map(), { occluders: [], depths })).toEqual(ordinary);
});

test("a name wholly under a higher mark presses nothing on a readable neighbour", () => {
  const settled = resolveVisibility(contest, selectedA, new Map(), { occluders: [body(2)], depths });
  expect(settled.get("b")).toBe(1);
  expect(settled.get("a")).toBe(1);
  // Buried is out of the fight, not out of the field: under a stronger
  // visible name it still settles its own ink, so un-burying finds no pop.
  const selectedB = new Map([["a", rank()], ["b", rank({ selection: true })]]);
  const under = resolveVisibility(contest, selectedB, new Map(), { occluders: [body(2)], depths });
  expect(under.get("b")).toBe(1);
  expect(under.get("a")!).toBeLessThan(1);
});

test("a mark at equal or lower depth does not exempt the name beneath it", () => {
  for (const z of [1, 0.5]) {
    expect(resolveVisibility(contest, selectedA, new Map(), { occluders: [body(z)], depths })).toEqual(ordinary);
  }
  // A name with no stated depth always fights.
  expect(resolveVisibility(contest, selectedA, new Map(), {
    occluders: [body(2)], depths: new Map([["b", 3]]),
  })).toEqual(ordinary);
});

test("a body covering only part of a name does not bury it", () => {
  for (const cover of [
    { minX: -10, minY: -10, maxX: 80, maxY: 30 },
    { minX: -10, minY: 5, maxX: 110, maxY: 30 },
  ]) {
    expect(resolveVisibility(contest, selectedA, new Map(), { occluders: [body(2, cover)], depths }))
      .toEqual(ordinary);
  }
});

test("attention still ranks the names that are actually visible", () => {
  // `a` is selected but buried; `b` is hovered; `c` overlaps `b`.
  const boxes = [box("a", 0), box("b", 70), box("c", 140)];
  const ranks = new Map([
    ["a", rank({ selection: true })], ["b", rank({ hover: true })], ["c", rank()],
  ]);
  const layered = new Map([["a", 1], ["b", 3], ["c", 3]]);
  const settled = resolveVisibility(boxes, ranks, new Map(), { occluders: [body(2)], depths: layered });
  expect(settled.get("b")).toBe(1);
  expect(settled.get("c")!).toBeLessThan(1);
  expect(settled.get("c")!).toBeGreaterThan(VISIBILITY_WHISPER);
  // Uncovered, the selection outranks the hover again.
  const visible = resolveVisibility(boxes, ranks, new Map(), { occluders: [body(0.5)], depths: layered });
  expect(visible.get("a")).toBe(1);
  expect(visible.get("b")!).toBeLessThan(1);
});

test("crowding stamps only text strength and never compounds its authored ink", () => {
  const datum = { id: "b", style: {
    labelText: "neighbor", labelFillOpacity: 0.85, labelOpacity: 0.7,
    labelBackgroundOpacity: 1, fillOpacity: 0.78,
  } };
  const remembered = new Map([["b", { base: 0.85, strength: pair(0.3).get("b")! }]]);
  stampLabelStrength(datum, remembered);
  const once = { ...datum.style };
  stampLabelStrength(datum, remembered);
  expect(datum.style).toEqual(once);
  expect(datum.style.labelFillOpacity).toBeGreaterThan(0.85 * VISIBILITY_WHISPER);
  expect(datum.style.labelFillOpacity).toBeLessThan(0.85);
  expect(datum.style).toMatchObject({ labelOpacity: 0.7, labelBackgroundOpacity: 1, fillOpacity: 0.78 });
});

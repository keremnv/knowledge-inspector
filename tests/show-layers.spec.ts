/**
 * What SHOW actually does with the expedition's origins.
 *
 * Unstated construction has a neutral category. Other unnamed legacy
 * origin values — including PROPOSED and REJECTED — still share the
 * mechanical layer, which starts hidden and is revealed when its relation
 * is opened or one of its rows is placed. These tests pin that contract so
 * no adapter can claim a distinct proposal layer that does not exist.
 */
import { test, expect } from "@playwright/test";
import {
  SHOW_DEFAULT,
  assertionShown,
  layerOf,
  layersOfRelation,
  relationShown,
  originsLabel,
  reveal,
  revealSet,
  type ShowState,
} from "../src/world/show";
import type { WorldRelation } from "../src/api/world";
import type { FieldAssertion, FieldBond, WorkingSet } from "../src/world/workingSet";

const relation = (name: string, origin: string): WorldRelation => ({
  name,
  description: null,
  mode: "BASE",
  arity: 2,
  referent_arity: 1,
  roles: [],
  count: 1,
  stale: false,
  origins: [origin],
  scope: null,
  completeness: null,
});

test("only the named origins have layers of their own", () => {
  expect(layerOf("SEMANTIC", "BASE")).toBe("semantic");
  expect(layerOf("ADJUDICATED", "BASE")).toBe("adjudicated");
  expect(layerOf("DERIVED", "BASE")).toBe("derived");
  expect(layerOf("PROPOSED", "BASE")).toBe("mechanical");
  expect(layerOf("REJECTED", "BASE")).toBe("mechanical");
  expect(layerOf("UNKNOWN", "BASE")).toBe("mechanical");
});

test("proposals start hidden with mechanical and reveal on explicit open", () => {
  const show: ShowState = { ...SHOW_DEFAULT };
  expect(assertionShown("PROPOSED", "BASE", show)).toBe(false);
  expect(assertionShown("SEMANTIC", "BASE", show)).toBe(true);
  const revealed = reveal(relation("determination_proposed", "PROPOSED"), show);
  expect(assertionShown("PROPOSED", "BASE", revealed)).toBe(true);
  // Revealing never hides what was already showing.
  expect(assertionShown("SEMANTIC", "BASE", revealed)).toBe(true);
});

test("a proposed relation occupies the mechanical layer, not its own", () => {
  expect(layersOfRelation(relation("determination_proposed", "PROPOSED"))).toEqual([
    "mechanical",
  ]);
});

for (const origin of ['UNSTATED', '', undefined]) {
  test(`BASE origin ${String(origin)} has neutral default visibility`, () => {
    expect(layerOf(origin, 'BASE')).toBe('unstated');
    expect(assertionShown(origin, 'BASE', SHOW_DEFAULT)).toBe(true);
    expect(assertionShown(origin, 'BASE', { ...SHOW_DEFAULT, unstated: false, mechanical: true })).toBe(false);
    expect(originsLabel(origin)).toBe('unstated');
  });
}

test('empty and omitted schema origins do not mean mechanical construction', () => {
  const empty = { ...relation('plain', 'UNSTATED'), origins: [] };
  const omitted = { ...empty }; delete (omitted as Partial<WorldRelation>).origins;
  for (const item of [empty, omitted]) {
    expect(layersOfRelation(item)).toEqual(['unstated']);
    expect(relationShown(item, SHOW_DEFAULT)).toBe(true);
    expect(relationShown(item, { ...SHOW_DEFAULT, unstated: false, mechanical: true })).toBe(false);
  }
  expect(assertionShown([], 'BASE', SHOW_DEFAULT)).toBe(true);
  expect(originsLabel([])).toBe('unstated');
});

test('recorded construction origins keep their existing filters and default visibility', () => {
  for (const [origin, layer, shown] of [
    ['MECHANICAL', 'mechanical', false], ['SEMANTIC', 'semantic', true],
    ['ADJUDICATED', 'adjudicated', true], ['DERIVED', 'derived', true],
  ] as const) {
    expect(layerOf(origin, 'BASE')).toBe(layer);
    expect(layersOfRelation(relation('record', origin))).toEqual([layer]);
    expect(assertionShown(origin, 'BASE', SHOW_DEFAULT)).toBe(shown);
    expect(assertionShown(origin, 'BASE', { ...SHOW_DEFAULT, [layer]: false, unstated: true })).toBe(false);
  }
});

test('KI-015: schema layers are the union of occurrence layers for the declared origins', () => {
  const derived = { ...relation('legacy', 'UNSTATED'), mode: 'DERIVED' as const };
  // Single declared origins keep the occurrence-level precedence:
  // ADJUDICATED and SEMANTIC outrank DERIVED mode; the rest follow mode.
  expect(layersOfRelation({ ...derived, origins: ['MECHANICAL'] })).toEqual(['derived']);
  expect(layersOfRelation({ ...derived, origins: ['SEMANTIC'] })).toEqual(['semantic']);
  expect(layersOfRelation({ ...derived, origins: ['ADJUDICATED'] })).toEqual(['adjudicated']);
  expect(layersOfRelation({ ...derived, origins: ['UNSTATED'] })).toEqual(['derived']);
  expect(layersOfRelation({ ...derived, origins: [] })).toEqual(['derived']);
  // Mixed origins occupy the union, so no enabled occurrence category is
  // hidden from the schema while its occurrences remain visible.
  expect(layersOfRelation({ ...derived, origins: ['SEMANTIC', 'ADJUDICATED', 'MECHANICAL'] }))
    .toEqual(['semantic', 'adjudicated', 'derived']);
  expect(layerOf('UNSTATED', 'DERIVED')).toBe('derived');
  expect(layerOf('MECHANICAL', 'DERIVED')).toBe('derived');
  expect(layerOf('SEMANTIC', 'DERIVED')).toBe('semantic');
  expect(layerOf('ADJUDICATED', 'DERIVED')).toBe('adjudicated');
});

test('KI-015: the same SHOW choices govern schema and occurrences', () => {
  const mixed = { ...relation('legacy', 'SEMANTIC'), mode: 'DERIVED' as const, origins: ['SEMANTIC', 'ADJUDICATED', 'MECHANICAL'] };
  const derivedOff = { ...SHOW_DEFAULT, derived: false };
  // Disabling derived alone hides neither the schema relation nor its
  // authored occurrences while semantic/adjudicated stay enabled.
  expect(relationShown(mixed, derivedOff)).toBe(true);
  expect(assertionShown(['SEMANTIC', 'ADJUDICATED', 'MECHANICAL'], 'DERIVED', derivedOff)).toBe(true);
  const authoredOff = { ...SHOW_DEFAULT, semantic: false, adjudicated: false };
  expect(relationShown(mixed, authoredOff)).toBe(true);
  expect(assertionShown(['SEMANTIC', 'ADJUDICATED', 'MECHANICAL'], 'DERIVED', authoredOff)).toBe(true);
  const allOff = { ...SHOW_DEFAULT, semantic: false, adjudicated: false, derived: false };
  expect(relationShown(mixed, allOff)).toBe(false);
  expect(assertionShown(['SEMANTIC', 'ADJUDICATED', 'MECHANICAL'], 'DERIVED', allOff)).toBe(false);
  // BASE mixed origins already agreed; pin them beside the DERIVED cases.
  const baseMixed = { ...relation('base', 'SEMANTIC'), origins: ['SEMANTIC', 'MECHANICAL'] };
  expect(layersOfRelation(baseMixed)).toEqual(['semantic', 'mechanical']);
  expect(relationShown(baseMixed, { ...SHOW_DEFAULT, semantic: false })).toBe(false);
  expect(assertionShown(['SEMANTIC', 'MECHANICAL'], 'BASE', { ...SHOW_DEFAULT, semantic: false })).toBe(false);
  expect(relationShown(baseMixed, SHOW_DEFAULT)).toBe(true);
});

test('KI-015: an explicitly empty origins array never makes a DERIVED occurrence silently invisible', () => {
  expect(assertionShown([], 'DERIVED', SHOW_DEFAULT)).toBe(true);
  expect(assertionShown([], 'DERIVED', { ...SHOW_DEFAULT, derived: false })).toBe(false);
  expect(assertionShown(undefined, 'DERIVED', SHOW_DEFAULT)).toBe(true);
  const mixed = { ...relation('legacy', 'SEMANTIC'), mode: 'DERIVED' as const, origins: ['SEMANTIC', 'MECHANICAL'] };
  expect(reveal(mixed, { ...SHOW_DEFAULT, semantic: false, derived: false }))
    .toEqual({ ...SHOW_DEFAULT, semantic: true, derived: true });
});

test('placing and restoring unstated marks reveal only their neutral category', () => {
  const hidden = { ...SHOW_DEFAULT, unstated: false };
  const plain = { ...relation('plain', 'UNSTATED'), origins: [] };
  expect(reveal(plain, hidden)).toEqual({ ...hidden, unstated: true });
  const assertion: FieldAssertion = {
    assertion_id: 'plain:1', relation: 'plain', origin: 'UNSTATED', origins: [],
    mode: 'BASE', stale: false, completeness: null, spokes: [], scalars: [],
  };
  const bond: FieldBond = {
    assertion_id: 'pair:1', relation: 'pair', origin: 'UNSTATED', mode: 'BASE',
    stale: false, completeness: null, source: 'entity:A', target: 'entity:B', spokes: [], scalars: [],
  };
  for (const [assertions, bonds] of [[new Map([[assertion.assertion_id, assertion]]), []], [new Map(), [bond]]] as const) {
    const set: WorkingSet = {
      referents: new Map(), assertions, bonds: [...bonds], demands: new Map(),
      positions: new Map(), depth: new Map(), expanded: new Set(),
    };
    expect(revealSet(set, hidden)).toEqual({ ...hidden, unstated: true });
  }
  expect(assertion.origin).toBe('UNSTATED');
  expect(assertion.origins).toEqual([]);
  expect(bond.origin).toBe('UNSTATED');
});

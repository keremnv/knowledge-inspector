/**
 * §9 SHOW, and the epistemic overlay that rides the same marks.
 *
 * Construction origin (who decided this) and derivation mode (how it is
 * maintained) are different questions. Unstated construction has its own
 * neutral display category; mechanical stays off by default because it overwhelms the
 * semantic seams — at S100 that is not a preference, it is the difference
 * between a vocabulary and a pile.
 *
 * Completeness and staleness are not layers. They are a condition of a
 * relation, painted over whatever layer the mark already belongs to. A missing
 * receipt is not UNKNOWN: UNKNOWN is a declared status, and a BASE relation
 * that was never given a completeness claim is simply not in that vocabulary.
 */

import type { WorldRelation } from "../api/world";
import type { WorkingSet } from "./workingSet";

export type ShowLayer =
  | "semantic"
  | "derived"
  | "mechanical"
  | "unstated"
  | "unresolved"
  | "adjudicated";

export type ShowState = Record<ShowLayer, boolean>;

export const SHOW_ORIGIN_LAYERS: ShowLayer[] = [
  "semantic",
  "adjudicated",
  "derived",
  "mechanical",
  "unstated",
];

export const SHOW_LAYERS: ShowLayer[] = [
  ...SHOW_ORIGIN_LAYERS,
  "unresolved",
];

/**
 * The spec's useful defaults. Mechanical is the one that starts off.
 *
 * `adjudicated` is on and should stay on. A person must never have to opt in
 * to seeing which parts of a world a person decided — a hidden human judgment
 * reads as the machine's, which is the whole reason the origin exists.
 */
export const SHOW_DEFAULT: ShowState = {
  semantic: true,
  adjudicated: true,
  derived: true,
  mechanical: false,
  unstated: true,
  unresolved: true,
};

export type CompletenessStatus = "COMPLETE" | "INCOMPLETE" | "UNKNOWN";

export function isUnstatedOrigin(origin: string | undefined): boolean {
  return origin === undefined || origin === "" || origin === "UNSTATED";
}

/**
 * Whether any relation carries an explicitly recorded construction
 * origin. Derived from the schema response alone — no extra capability
 * flag. Derivation mode is a separate dimension (see below), and
 * governance is separate again: neither activates origin controls.
 */
export function worldHasClassification(relations: WorldRelation[]): boolean {
  return relations.some((relation) =>
    (relation.origins ?? []).some((origin) => !isUnstatedOrigin(origin)),
  );
}

/** Whether any relation supplies DERIVED mode (not a construction origin). */
export function worldHasDerivedMode(relations: WorldRelation[]): boolean {
  return relations.some((relation) => relation.mode === "DERIVED");
}

/**
 * One or more layers for one assertion. A proposition may have support paths
 * with different origins, so the complete origin list can occupy multiple
 * layers. ADJUDICATED is a person's, SEMANTIC is the constructor's even if it
 * later feeds a derivation, DERIVED (or a derived relation whose origin was
 * not recorded) follows the supplied derivation mode. UNSTATED or an absent
 * origin has a neutral category. Other legacy origin values keep their
 * existing mechanical grouping; this is not an occurrence-state classifier.
 *
 * This is the one classification rule (KI-015): schema relations and
 * individual occurrences share it. A relation occupies the union of the
 * layers its declared origins produce here, so the same SHOW choices show
 * or hide a relation and its occurrences together. In particular, turning
 * the `derived` layer off does not hide DERIVED-mode occurrences whose
 * explicitly recorded ADJUDICATED or SEMANTIC origins remain enabled, and
 * an empty origins array falls back to the mode's layer instead of making
 * an occurrence silently invisible.
 */
export function layerOf(origin: string | undefined, mode: string): ShowLayer {
  if (origin === "ADJUDICATED") return "adjudicated";
  if (origin === "SEMANTIC") return "semantic";
  if (origin === "DERIVED" || mode === "DERIVED") return "derived";
  if (isUnstatedOrigin(origin)) return "unstated";
  return "mechanical";
}

/**
 * The layers a schema relation occupies: the union of the occurrence
 * layers for its declared origins, under the one shared rule above. The
 * schema's `origins` is the source-supplied aggregate of occurrence
 * origins; it is read as supplied, never extended or rewritten.
 */
export function layersOfRelation(relation: WorldRelation): ShowLayer[] {
  return [...new Set(layersOfOrigins(relation.origins, relation.mode))];
}

export function relationShown(relation: WorldRelation, show: ShowState): boolean {
  return layersOfRelation(relation).some((layer) => show[layer]);
}

export function originsLabel(origin: string | string[] | undefined): string {
  const origins = Array.isArray(origin) ? origin : [origin];
  return origins.map((item) => isUnstatedOrigin(item) ? "unstated" : item).join(" + ") || "unstated";
}

function layersOfOrigins(origin: string | string[] | undefined, mode: string): ShowLayer[] {
  const origins = Array.isArray(origin) ? origin : [origin];
  // An empty or missing collection is absence, not a category of its own:
  // it falls through `layerOf` as an unstated origin, which for DERIVED
  // mode is the derived layer and for BASE the neutral unstated layer.
  return (origins.length ? origins : [undefined]).map((item) => layerOf(item, mode));
}

export function assertionShown(
  origin: string | string[] | undefined,
  mode: string,
  show: ShowState,
): boolean {
  return layersOfOrigins(origin, mode).some((layer) => show[layer]);
}

/**
 * Turn on every layer a relation occupies.
 *
 * SHOW hides what nobody asked for, and asking for one thing is not asking for
 * a layer. Placing a named row, or opening a named relation, is a request for
 * *that mark* and nothing else would arrive, so the layer comes on. Expanding
 * through a relation is a request for a neighborhood: the referents land and
 * are drawn whatever the filter says, and the tuple that carried them stays
 * hidden until someone turns its layer back on. A filter that a side effect
 * can switch off is not a filter.
 */
export function reveal(relation: WorldRelation, show: ShowState): ShowState {
  const next = { ...show };
  for (const layer of layersOfRelation(relation)) next[layer] = true;
  return next;
}

/**
 * Turn on every layer a restored field stands on.
 *
 * A restore re-places marks the person asked for last visit, and placing a
 * mark reveals its layer — see `reveal` — so a restore that skipped this
 * brought the discs back standing and left their filaments filtered out.
 * Only ever turns on; what is already showing stays showing. Demands ride
 * `unresolved`, the same layer their plates read.
 */
export function revealSet(set: WorkingSet, show: ShowState): ShowState {
  const next = { ...show };
  const revealOrigins = (
    origin: string | string[] | undefined,
    mode: string,
  ): void => {
    for (const layer of layersOfOrigins(origin, mode)) next[layer] = true;
  };
  for (const bond of set.bonds) {
    revealOrigins(bond.origins ?? bond.origin, bond.mode);
  }
  for (const assertion of set.assertions.values()) {
    revealOrigins(assertion.origins ?? assertion.origin, assertion.mode);
  }
  if (set.demands.size) next.unresolved = true;
  return next;
}

/**
 * Whether a relation's matter should take the provisional palette.
 *
 * Stale: the derivation's inputs have moved since it last ran. Incomplete:
 * a completeness receipt exists and does not claim COMPLETE. The two are
 * different facts and the inspector names which; on the canvas they share
 * the palette the DNA already spent on "present, not settled".
 */
export function unsettled(
  stale: boolean,
  completeness: CompletenessStatus | null,
): boolean {
  return stale || (completeness !== null && completeness !== "COMPLETE");
}

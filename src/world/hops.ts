/**
 * Graph distance across the field, for the light law.
 *
 * "Near" on this surface cannot mean *close on screen*. Two marks a thousand
 * pixels apart but joined by one relation are neighbours; two that happen to
 * overlap after a drag are strangers. So distance is hops, and zooming or
 * dragging changes nothing about what is lit.
 *
 * Every drawn mark is a node and every drawn connection is an edge of length
 * one, which decides the two cases that are otherwise arguable:
 *
 * - A **plate** stands between its referents with a spoke to each, so two
 *   referents joined through it are two hops apart. That is right: what joins
 *   them is a third thing, and you can point at it.
 * - A **bond** is the line itself. It touches both discs, so the discs are one
 *   hop apart and the bond is one hop from each. A folded tuple should not
 *   read as further away than the same tuple unfolded would.
 *
 * Furniture — a shelf under a chip, a crown over one — is not a mark. It takes
 * the light of the chip it hangs off, which `WorldCanvas` resolves by name.
 */

import type { WorkingSet } from "./workingSet";

function link(graph: Map<string, Set<string>>, a: string, b: string): void {
  if (a === b) return;
  let from = graph.get(a);
  if (!from) graph.set(a, (from = new Set()));
  from.add(b);
  let to = graph.get(b);
  if (!to) graph.set(b, (to = new Set()));
  to.add(a);
}

/** Adjacency over everything on the field, marks and connections alike. */
export function fieldGraph(set: WorkingSet): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const id of set.referents.keys()) if (!graph.has(id)) graph.set(id, new Set());

  for (const assertion of set.assertions.values()) {
    for (const spoke of assertion.spokes) {
      link(graph, assertion.assertion_id, spoke.id);
    }
  }
  for (const demand of set.demands.values()) {
    for (const spoke of demand.spokes) link(graph, demand.key, spoke.id);
  }
  for (const bond of set.bonds) {
    link(graph, bond.source, bond.target);
    link(graph, bond.assertion_id, bond.source);
    link(graph, bond.assertion_id, bond.target);
  }
  return graph;
}

/**
 * Hops from one mark to every mark it can reach.
 *
 * Breadth-first, which is exact for unit edges. The field is capped at a few
 * dozen marks, so this is cheaper than remembering the answer would be.
 * Marks in another component are simply absent — `luminance` reads that
 * absence as ambient, because nothing that happened here reaches them.
 */
export function hopsFrom(set: WorkingSet, source: string): Map<string, number> {
  return hopsFromGraph(fieldGraph(set), source);
}

/** Same walk for a field's own adjacency; no translation of subject meaning. */
export function hopsFromGraph(graph: ReadonlyMap<string, ReadonlySet<string>>, source: string): Map<string, number> {
  const distance = new Map<string, number>([[source, 0]]);
  let frontier = [source];
  let depth = 0;
  while (frontier.length) {
    depth += 1;
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbour of graph.get(id) ?? []) {
        if (distance.has(neighbour)) continue;
        distance.set(neighbour, depth);
        next.push(neighbour);
      }
    }
    frontier = next;
  }
  return distance;
}

/** Naming is the union of attention neighborhoods, independently of light. */
export function namesFromAttention(
  sources: readonly (string | null | undefined)[],
  distances: (source: string) => ReadonlyMap<string, number> | null,
  reach: number,
): Set<string> | null {
  const unique = [...new Set(sources.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return null;
  const named = new Set<string>();
  for (const source of unique) for (const [id, distance] of distances(source) ?? []) {
    if (distance <= reach) named.add(id);
  }
  return named;
}

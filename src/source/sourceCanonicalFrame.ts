/** Canonical presentation over Source-owned records and FK observations. No
 * World subjects, identity conversion, additional reads or membership changes. */
import type { Graph } from '@antv/g6';
import type { CanvasData, CanvasDatum } from '../world/canvasMotion';
import { restationFilament } from '../world/filaments';
import { hopsFromGraph, namesFromAttention } from '../world/hops';
import { lift, NAMING_HOPS, illuminateMaterial } from '../styles/light';
import { BOND_LABEL_ALONG_PX, bondFilament, bondLabelLayout, chipWidth, discNode, filamentEdge, summaryEdge,
  type MarkParams, type Paint } from '../world/marks';
import { groupParallel, parallelLabelPlan } from '../world/parallelLabels';
import { bondStation, type StationMemory, type StationSubjects, type Station } from '../world/stations';
import type { Point } from '../world/workingSet';
import type { PlacedReference, SourceField } from './sourceField';
import type { SourcePresentation } from './sourcePresentation';

const ends = (ref: PlacedReference) => ({ source: ref.child, target: ref.parent });
export const sourceSummaryId = (ref: PlacedReference) => `source-summary:${ref.elementId}`;
export const sourceCarrierId = (ref: PlacedReference) => `source-carrier:${ref.elementId}`;
/** A declaration the reader could not verify (the schema view draws every
 * recorded declaration, O8.12): named as such, never drawn as if it held. */
export const unverifiedDeclaration = (ref: PlacedReference) => ref.observation.declaration.validation.status !== 'verified_declaration';
const DECLARATION_MARK: Record<string, string> = { invalid: 'invalid', unsupported: 'unchecked' };
const samePair = (a: PlacedReference, b: PlacedReference) =>
  a.child === b.child && a.parent === b.parent || a.child === b.parent && a.parent === b.child;

/** `namedAtRest`: every connection keeps its name, World's "names" toggle (O12). */
export function sourceAttention(field: SourceField, hovered: string | null, selected: string | null, namedAtRest = false) {
  const adjacency = new Map<string, Set<string>>(field.records.map((r) => [r.elementId, new Set<string>()]));
  const link = (a: string, b: string) => {
    if (a === b) return;
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a)!.add(b); adjacency.get(b)!.add(a);
  };
  for (const ref of field.references) {
    link(ref.child, ref.parent); link(ref.elementId, ref.child); link(ref.elementId, ref.parent);
  }
  const active = hovered ?? selected;
  const hops = active ? hopsFromGraph(adjacency, active) : null;
  const named = namesFromAttention([hovered, selected], (id) => id === active ? hops : hopsFromGraph(adjacency, id), NAMING_HOPS);
  for (const id of [hovered, selected]) {
    const origin = field.references.find((r) => r.elementId === id);
    if (origin) for (const sibling of field.references) if (samePair(origin, sibling)) named?.add(sibling.elementId);
  }
  const atRest = namedAtRest ? new Set([...(named ?? []), ...field.references.map((ref) => ref.elementId)]) : named;
  return { named: atRest, incident: hops ? (id: string) => lift(hops.get(id) ?? null) : null };
}
export type SourcePlatePose = {
  child: string; parent: string; near: Station; owner: string; summary: boolean;
  stack: { x: number; y: number }; along: number; half: number;
};

export function sourceCanonicalFrame(field: SourceField, positions: ReadonlyMap<string, Point>, labels: ReadonlyMap<string, string>, paint: Paint, p: MarkParams,
  selected: string | null, subjects: StationSubjects, memory: StationMemory,
  attention: ReturnType<typeof sourceAttention>, presentation: SourcePresentation, opened: string | null,
): { data: CanvasData; poses: Map<string, SourcePlatePose>; named: Set<string> } {
  const named = new Set(attention.named);
  const at = (id: string) => positions.get(id) ?? field.positions.get(id) ?? { x: 0, y: 0 };
  const nodes = field.records.map((record) => {
    const point = at(record.elementId);
    const node = discNode(record.elementId, point.x, point.y, labels.get(record.elementId) ?? record.table, paint, p, record.elementId === selected);
    if (attention.incident) illuminateMaterial(node, ['fillOpacity', 'strokeOpacity'], attention.incident);
    return node;
  });
  const edges: CanvasDatum[] = [], poses = new Map<string, SourcePlatePose>();
  for (const group of groupParallel(field.references, ends).values()) {
    const texts = (ref: PlacedReference) => {
      const fk = ref.observation.declaration;
      const named = fk.pairs.length ? fk.pairs.map((pair) => pair.child_column ?? '?').join(' + ') : fk.recorded_pairs.map((pair) => pair.from).join(' + ');
      const columns = unverifiedDeclaration(ref) ? `${named} · ${DECLARATION_MARK[fk.validation.status] ?? fk.validation.status}` : named;
      const declaration = `${columns} → ${fk.parent_table}.${fk.pairs.map((pair) => pair.parent_column ?? '?').join(' + ')}`;
      return { shown: presentation.direction === 'selected' && ref.elementId === selected ? declaration : columns,
        reserved: presentation.direction === 'selected' ? declaration : columns };
    };
    const plan = parallelLabelPlan(group, {
      id: (ref) => ref.elementId, ends, order: (ref) => `${texts(ref).reserved}\u0000${ref.elementId}`,
      summaryId: sourceSummaryId, countLabel: (count) => {
        const unverified = group.filter(unverifiedDeclaration).length;
        return unverified ? `${count} references · ${unverified} unverified` : `${count} references`;
      },
      named: (id) => attention.named?.has(id) ?? false,
      selected, selectedEndpoint: field.positions.has(selected ?? '') ? selected : null,
      hovered: subjects.hovered, opened, params: p,
    });
    const first = plan.first;
    // One physical orientation/station per pair, including opposing FK evidence.
    // Direction remains in each observation's Source data and Reader, not the wire.
    const near = bondStation(ends(first), subjects, memory, first.elementId, (id) => {
      const sibling = field.references.find((ref) => ref.elementId === id || sourceSummaryId(ref) === id);
      return sibling ? ends(sibling) : null;
    }, 'source');
    const half = Math.max(...group.map((ref) => chipWidth(texts(ref).reserved, p) / 2));
    const carrier = bondFilament(sourceCarrierId(first), first.child, first.parent, paint, p);
    // One line per pair: dashed only when nothing it carries is a verified declaration.
    if (group.every(unverifiedDeclaration)) Object.assign(carrier.style, { lineDash: [4, 4] });
    edges.push(carrier);
    for (const ref of plan.group) {
      memory.set(ref.elementId, near);
      const stack = plan.stacks.get(ref.elementId)!;
      const layout = bondLabelLayout(at(first.child), at(first.parent), near, stack, p, undefined, undefined, BOND_LABEL_ALONG_PX, half);
      poses.set(ref.elementId, { child: first.child, parent: first.parent, near, stack, along: layout.along, half, owner: ref.elementId, summary: false });
      const isNamed = plan.names.get(ref.elementId) ?? false;
      if (isNamed) named.add(ref.elementId); else named.delete(ref.elementId);
      const edge = filamentEdge(ref.elementId, first.child, first.parent, paint, p, {
        label: texts(ref).shown, named: isNamed, labelPlacement: layout.placement,
        labelOffsetX: layout.offsetX, labelOffsetY: layout.offsetY, bondAlong: layout.along, bondHalf: half,
      });
      if (ref.elementId === selected) { edge.style.labelBackgroundFill = paint.canvas; edge.style.labelFill = paint.ink; }
      edges.push(edge);
    }
    if (plan.summary) {
      const summary = plan.summary, countHalf = chipWidth(summary.label, p) / 2;
      const layout = bondLabelLayout(at(first.child), at(first.parent), near, summary.stack, p, undefined, undefined, BOND_LABEL_ALONG_PX, countHalf);
      poses.set(summary.id, { child: first.child, parent: first.parent, near, stack: summary.stack,
        along: layout.along, half: countHalf, owner: first.elementId, summary: true });
      if (summary.shown) named.add(summary.id);
      edges.push(summaryEdge(summary.id, first.child, first.parent, paint, p, {
        ...summary, placement: layout.placement, offsetX: layout.offsetX, offsetY: layout.offsetY,
        bondAlong: layout.along, bondHalf: countHalf,
      }));
    }
  }
  return { data: { nodes, edges }, poses, named };
}

/** The actual World station writer, with the draw's frozen group pose. */
export function restationSourcePlates(graph: Graph, moved: string, positions: ReadonlyMap<string, Point>, poses: ReadonlyMap<string, SourcePlatePose>, params: MarkParams) {
  for (const [id, pose] of poses) {
    if (pose.child !== moved && pose.parent !== moved) continue;
    const a = positions.get(pose.child), b = positions.get(pose.parent);
    if (a && b) restationFilament(graph, id, bondLabelLayout(a, b, pose.near, pose.stack, params, undefined, undefined, pose.along, pose.half));
  }
}

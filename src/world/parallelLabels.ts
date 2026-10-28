import { BOND_LABEL_STACK_MAX, bondLabelStep, type MarkParams } from './marks';

/** Presentation groups only. Identity, retrieval and ownership stay with the caller. */
export const parallelGroupKey = (source: string, target: string) => [source, target].sort().join('\u0000');

export function groupParallel<T>(members: readonly T[], ends: (member: T) => { source: string; target: string }) {
  const groups = new Map<string, T[]>();
  for (const member of members) {
    const { source, target } = ends(member);
    const key = parallelGroupKey(source, target);
    const group = groups.get(key) ?? [];
    group.push(member); groups.set(key, group);
  }
  return groups;
}

/** World's existing quiet → count → open/capped stack law, over caller-owned ids.
 * Selecting an endpoint opens its groups. A selected member beyond the cap takes
 * the final seat. Hover never dismisses a group selection has opened. */
export function parallelLabelPlan<T>(members: readonly T[], options: {
  id: (member: T) => string;
  ends: (member: T) => { source: string; target: string };
  order: (member: T) => string;
  summaryId: (first: T) => string;
  countLabel?: (count: number) => string;
  named: (id: string) => boolean;
  selected: string | null;
  selectedEndpoint: string | null;
  hovered: string | null;
  opened: string | null;
  params: MarkParams;
}) {
  const { id, ends, named } = options;
  const group = [...members].sort((a, b) => options.order(a).localeCompare(options.order(b)));
  const first = group[0]!;
  const grouped = group.length > 1;
  const summaryId = options.summaryId(first);
  const endpoint = ends(first);
  const explicit = options.opened === summaryId;
  const onSelected = options.selectedEndpoint !== null &&
    (endpoint.source === options.selectedEndpoint || endpoint.target === options.selectedEndpoint);
  const groupNamed = group.some((member) => named(id(member))) || explicit;
  const selected = group.find((member) => id(member) === options.selected) ?? null;
  const opened = !grouped || explicit || onSelected || selected !== null ||
    (options.hovered !== null && group.some((member) => id(member) === options.hovered));
  const capped = group.slice(0, BOND_LABEL_STACK_MAX);
  const seated = selected && !capped.includes(selected) ? [...capped.slice(0, -1), selected] : capped;
  const shown = grouped && opened ? seated : group;
  const step = bondLabelStep(options.params), middle = (shown.length - 1) / 2;
  const stepped = (count: number) => ({ x: step.x * count, y: step.y * count });
  const stacks = new Map(group.map((member) => [id(member), { x: 0, y: 0 }]));
  shown.forEach((member, index) => stacks.set(id(member), stepped(index - middle)));
  const names = new Map(group.map((member) => [id(member), grouped
    ? groupNamed && opened && shown.includes(member) : named(id(member))]));
  const remainder = group.length - shown.length;
  return {
    first, group, grouped, stacks, names,
    pose: { bundleId: grouped ? summaryId : null, shown: shown.map(id),
      bundleSteps: opened ? shown.length - middle : 0 },
    summary: grouped ? {
      id: summaryId,
      label: opened ? `+${remainder} more` : (options.countLabel ?? ((count) => `${count} assertions`))(group.length),
      shown: groupNamed && (!opened || remainder > 0),
      interactive: !opened && groupNamed,
      stack: opened ? stepped(shown.length - middle) : { x: 0, y: 0 },
    } : null,
  };
}

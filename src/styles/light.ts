/**
 * Light — the second law, and the one that had to be rewritten.
 *
 * The first version was a spotlight. A source lit what a person had acted on,
 * fell off inverse-square through the graph, and everything beyond reach sat
 * at an ambient floor of 0.34. It was coherent and it was wrong, for a reason
 * worth keeping written down: **a vignette makes a claim about the marks
 * outside it.** Dropping seven of eight disconnected seeds to a third of their
 * opacity because the pointer is on the eighth says those seven are less
 * present, and they are not — nothing about them changed. The person looked
 * somewhere. The world did not move.
 *
 * There was a second, quieter fault. `opacity` on a shape composites its fill
 * and its stroke separately, so a disc whose stroke is its fill colour grows a
 * visible darker rim the moment it is drawn below 1 — the dimming invented an
 * outline on a mark that is supposed to read as a mass.
 *
 * So light lifts and never dims:
 *
 * ```text
 * lit    = albedo + (1 - albedo) * lift(hops)
 * lift   = LIFT / (1 + hops / falloff)^2
 * ```
 *
 * A mark already at 1 is untouched, which is most of them. What moves is what
 * rests below 1 — an unnamed filament, a quiet spoke — and near the acted-on
 * mark those come *up*. The result is the neighbourhood becoming more present
 * rather than the rest becoming less, and at rest, with nothing acted on, the
 * law changes nothing at all.
 *
 * Lift makes contact visible while preserving the material's resting
 * transparency. Selection remains a boundary treatment, distinct from light.
 */

export type LightField = {
  /** Lift at the source itself, 0..1. 0 switches the law off entirely. */
  lift: number;
  /** Hops at which the lift has fallen to a quarter. */
  falloff: number;
};

export const DEFAULT_LIGHT_FIELD: LightField = { lift: 0.55, falloff: 1.6 };

/**
 * How much of the way to full a mark at `hops` is carried.
 *
 * `null` — not reachable from the source, or nothing acted on — is 0, not a
 * floor. That is the whole difference from the spotlight.
 */
export function lift(
  hops: number | null,
  field: LightField = DEFAULT_LIGHT_FIELD,
): number {
  if (hops === null) return 0;
  const distance = Math.max(0, hops) / Math.max(0.01, field.falloff);
  return field.lift / (1 + distance) ** 2;
}

/**
 * The mark's own opacity, carried toward 1 by whatever light reaches it.
 *
 * Reflected rather than replaced, and one-sided: `albedo` is a floor the light
 * can only raise. A filament authored quiet stays quieter than the disc beside
 * it, and a mark at 1 cannot be made brighter than it already is — which is
 * why nothing has to be dimmed to make room.
 */
export function reflected(albedo: number, incidentLift: number): number {
  return albedo + (1 - albedo) * Math.max(0, Math.min(1, incidentLift));
}

/** Paint material channels only; presence and readable type are independent. */
export function illuminateMaterial(
  mark: { id: string; style?: Record<string, unknown> },
  channels: readonly ("fillOpacity" | "strokeOpacity")[],
  incident: (id: string) => number,
) {
  if (!mark.style) return;
  const incidentHere = incident(mark.id);
  for (const channel of channels) {
    const albedo = mark.style[channel] as number | undefined;
    if (albedo === undefined || albedo === 0) continue;
    mark.style[channel] = reflected(albedo, incidentHere);
  }
}

/**
 * How far a mark can be from the source and still name itself.
 *
 * One hop. Naming used to be read off the light at a threshold, which was neat
 * and made the two inseparable: retuning the falloff silently changed which
 * marks showed their labels. They are different questions. *What is lit* is a
 * matter of degree; *what says its name* is a matter of whether it is joined
 * to the thing you touched.
 */
export const NAMING_HOPS = 1;

export function lightCssVariables(
  field: LightField = DEFAULT_LIGHT_FIELD,
): Record<string, string> {
  return {
    "--light-lift": String(field.lift),
    "--light-falloff": String(field.falloff),
  };
}

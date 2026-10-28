/**
 * The type scale — the third thing that is code rather than a habit.
 *
 * Motion has a spine and light has a field, so neither can drift: a stylesheet
 * cannot write a duration, and it cannot write an opacity ramp. Type had
 * neither. Five live stylesheets carried **seventeen** distinct font sizes
 * between 0.54rem and 1.10rem — 0.60 and 0.62 next to each other, 0.66 and
 * 0.68 next to each other, differences of a third of a pixel that no reader
 * can see and no author chose. That is not a scale, it is a record of every
 * time somebody typed a number.
 *
 * Four steps of roughly 1.1, and then a break:
 *
 * ```text
 * caption  0.56rem   the smallest legend — a key, an axis, a count
 * label    0.62rem   the workhorse: control labels, metadata, chips
 * body     0.68rem   running prose and row subjects
 * subject  0.76rem   what a card or a panel is about
 * display  0.96rem   a page's own name
 * ```
 *
 * The ratio between the first four is 1.107, 1.097, 1.118 — near enough to
 * one step of a ladder that a reader reads them as one system. `display`
 * breaks it on purpose at 1.26: a page heading is a different register, not
 * the next rung, and pretending otherwise produced the 1.10rem that started
 * this.
 *
 * **The scale is the only place a size exists.** A stylesheet writes
 * `var(--type-label)`, never `0.62rem` — same rule as the motion spine, for
 * the same reason, and `scripts/check_field_laws.py` enforces both.
 */

export type TypeStep = "caption" | "label" | "body" | "subject" | "display";

/** rem, because the product respects the reader's root size. */
export const TYPE_SCALE: Record<TypeStep, number> = {
  caption: 0.56,
  label: 0.62,
  body: 0.68,
  subject: 0.76,
  display: 0.96,
};

/**
 * Leading, per step rather than one global multiple.
 *
 * Small type needs proportionally more air than large type — the same 1.5
 * that makes `caption` readable makes `display` look loose. These are the
 * multipliers, not lengths, so a step that changes size keeps its rhythm.
 */
export const TYPE_LEADING: Record<TypeStep, number> = {
  caption: 1.45,
  label: 1.45,
  body: 1.5,
  subject: 1.3,
  display: 1.2,
};

export const TYPE_STEPS: readonly TypeStep[] = [
  "caption",
  "label",
  "body",
  "subject",
  "display",
] as const;

/** `--type-<step>`, `--lead-<step>` and `--weight-<step>`, all in one call. */
export function typeCssVariables(
  scale: Record<TypeStep, number> = TYPE_SCALE,
  leading: Record<TypeStep, number> = TYPE_LEADING,
  weight: Record<WeightStep, number> = WEIGHT_SCALE,
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const step of TYPE_STEPS) {
    vars[`--type-${step}`] = `${scale[step]}rem`;
    vars[`--lead-${step}`] = String(leading[step]);
  }
  for (const step of WEIGHT_STEPS) {
    vars[`--weight-${step}`] = String(weight[step]);
  }
  return vars;
}

/**
 * The step a loose size belongs to.
 *
 * Kept because it is the argument for the collapse, not because anything
 * calls it at runtime: it is what mapped all seventeen values onto five, and
 * it is how you check a new number before adding it. If `nearestStep(x)`
 * returns a step whose size is within a hair of `x`, `x` did not need to
 * exist.
 */
export function nearestStep(rem: number): TypeStep {
  let best: TypeStep = "label";
  let gap = Infinity;
  for (const step of TYPE_STEPS) {
    const distance = Math.abs(TYPE_SCALE[step] - rem);
    if (distance < gap) {
      gap = distance;
      best = step;
    }
  }
  return best;
}

/**
 * The weight scale — three named steps, for the same reason size has five.
 *
 * `font-weight` had no scale at all: the inspector stylesheets
 * alone carried 400, 500 and 600 with no name for any of them, chosen per
 * rule rather than per intent, plus a lone 450 in the frozen product/ lineage
 * that nothing else agreed with. Three steps is what the actual live values
 * already collapse to once they are named instead of typed:
 *
 * ```text
 * regular   400   running text, most labels — the unmarked default
 * emphasis  500   a control that is live, active, or the current selection
 * strong    600   a heading, a primary number, a badge holding its own
 * ```
 *
 * Same rule as the size scale: a stylesheet writes `var(--weight-emphasis)`,
 * never `500`. `scripts/check_field_laws.py` enforces both.
 */
export type WeightStep = "regular" | "emphasis" | "strong";

export const WEIGHT_SCALE: Record<WeightStep, number> = {
  regular: 400,
  emphasis: 500,
  strong: 600,
};

export const WEIGHT_STEPS: readonly WeightStep[] = [
  "regular",
  "emphasis",
  "strong",
] as const;

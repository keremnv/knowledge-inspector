/**
 * The product's renderer-independent motion kernel.
 *
 * Renderers do not own the motion language. G6, DOM, SVG, and any future
 * canvas implementation consume the same MotionPlan: intent, physical field,
 * duration, easing, and normalized sampler. Adapters only translate that plan
 * into a renderer's animation API.
 */

export type MotionIntent =
  | "emit"
  | "absorb"
  | "settle"
  | "flow"
  | "hold";

export type MotionCurve = {
  /** Browser-native representation. Exact for the constant-acceleration laws. */
  css: string;
  /** AntV G's native easing name when it has an exact/physical equivalent. */
  g6: string;
  sample: (progress: number) => number;
};

export type MotionField = {
  /** Acceleration of the shared field in CSS pixels per second squared. */
  gravity: number;
  /** Canonical displacement used to derive timing and launch impulse. */
  travel: number;
  /** Inward acceleration multiplier. */
  absorbPull: number;
};

export type MotionPlanOptions = Partial<MotionField> & {
  /** Explicit duration wins; omit it to derive time from the physical field. */
  durationMs?: number;
  /** Intent-specific pull override, useful for calibrated settling. */
  pull?: number;
};

export type MotionPlan = Readonly<{
  intent: MotionIntent;
  durationMs: number;
  easing: MotionCurve;
  field: MotionField;
  pull: number;
  launchImpulse: number;
  sample: (elapsedMs: number) => number;
}>;

export type MotionPlans = Readonly<Record<MotionIntent, MotionPlan>>;

export type MotionPose = {
  x?: number;
  y?: number;
  scale?: number;
  rotate?: number;
  opacity?: number;
};

/**
 * The one number that sets how quick the whole surface is.
 *
 * `emit` and `absorb` are not read from the table below — they are consequences
 * of this field, `t = sqrt(2·travel / (gravity·pull))` — and so are the node
 * plans, which differ only by their own `travel`. So gravity is the knob for
 * *pace*, and every ratio the spine carries survives turning it: raising it
 * shortened arrival, withdrawal, a body's birth and a body's collapse by the
 * same quarter, and left a mass reading exactly as much heavier than a label as
 * it did before.
 *
 * It went 220 → 391 because the field was a beat slow to answer. A quarter is a
 * quarter of everything; the shape of the motion did not change.
 */
export const DEFAULT_MOTION_FIELD: MotionField = {
  gravity: 391,
  travel: 8.6,
  absorbPull: 2.18,
};

/**
 * `settle` and `hold` are stated here; `emit` and `absorb` are quoted here.
 *
 * The two gravity intents derive their duration from `DEFAULT_MOTION_FIELD`
 * and ignore these values at the default — but `scaleMotionPlans` passes the
 * whole table through when the lab runs at anything other than 1×, so a value
 * here that disagreed with the field would make the surface change shape the
 * moment it was slowed down to be looked at. Keep them equal to what the field
 * produces: `sqrt(2·8.6 / 391)` and `sqrt(2·8.6 / (391·2.18))`.
 */
export const MOTION_DURATION_MS = {
  emit: 210,
  absorb: 142,
  settle: 240,
  flow: 1000,
  hold: 68,
} as const;

export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): MotionCurve {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const x = (t: number) => ((ax * t + bx) * t + cx) * t;
  const y = (t: number) => ((ay * t + by) * t + cy) * t;
  const slope = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  return {
    css: `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`,
    g6: `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`,
    sample(progress: number) {
      const target = Math.max(0, Math.min(1, progress));
      let t = target;
      for (let iteration = 0; iteration < 5; iteration += 1) {
        const gradient = slope(t);
        if (Math.abs(gradient) < 1e-6) break;
        t = Math.max(0, Math.min(1, t - (x(t) - target) / gradient));
      }
      return y(t);
    },
  };
}

/**
 * Constant acceleration from rest.
 *
 * x(t) = 1/2 at², normalised by x(T), therefore p(u) = u². The cubic-bezier
 * below is not an approximation: with linear x control points it is the exact
 * quadratic polynomial.
 */
export const ABSORB_CURVE: MotionCurve = {
  css: "cubic-bezier(0.333333, 0, 0.666667, 0.333333)",
  g6: "in-quad",
  sample: (progress) => {
    const u = Math.max(0, Math.min(1, progress));
    return u * u;
  },
};

/**
 * The time reverse of Absorb: a body receives the calculated escape impulse
 * and gravity spends it exactly at its authored home. p(u) = 2u - u².
 */
export const EMIT_CURVE: MotionCurve = {
  css: "cubic-bezier(0.333333, 0.666667, 0.666667, 1)",
  g6: "out-quad",
  sample: (progress) => {
    const u = Math.max(0, Math.min(1, progress));
    return 2 * u - u * u;
  },
};

/**
 * Unit damped oscillator around equilibrium.
 *
 * This is an analytic under-damped spring, not a hand-shaped overshoot. The
 * renderer may sample it when it needs the exact trajectory; AntV G can run
 * its native spring without a JavaScript frame loop.
 */
export function dampedOscillator(
  dampingRatio = 0.78,
  angularFrequency = 10,
): MotionCurve {
  const zeta = Math.max(0.01, Math.min(0.999, dampingRatio));
  const omega = Math.max(0.01, angularFrequency);
  const damped = omega * Math.sqrt(1 - zeta * zeta);
  const coefficient = (zeta * omega) / damped;

  return {
    // CSS consumers that cannot sample get the restrained product fallback.
    css: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    g6: "spring",
    sample(progress: number) {
      const u = Math.max(0, Math.min(1, progress));
      if (u === 0 || u === 1) return u;
      return (
        1 -
        Math.exp(-zeta * omega * u) *
          (Math.cos(damped * u) + coefficient * Math.sin(damped * u))
      );
    },
  };
}

/**
 * Product motion grammar.
 *
 * Emit and absorb are deliberately asymmetric: matter arrives with an
 * outward impulse and leaves under inward acceleration. Settle belongs only
 * to released manipulation. Flow is constant signal; hold is pointer-direct.
 *
 * Refine here, not in components. A surface that feels wrong first has the
 * wrong intent (hold during a drag, emit on arrive, absorb on leave). Then
 * it has the wrong pose (which properties, how far — drawers width is geometry,
 * 8.6px is the canonical travel). Only then change this file: a duration or
 * curve edit moves the whole product. `createMotionPlan` accepts a duration
 * override for a calibrated one-off (neighbour preview); do not copy a cubic-
 * bezier into a stylesheet.
 */
export const MOTION_SPINE: Record<MotionIntent, MotionCurve> = {
  emit: EMIT_CURVE,
  absorb: ABSORB_CURVE,
  settle: dampedOscillator(),
  flow: cubicBezier(0, 0, 1, 1),
  hold: cubicBezier(0, 0, 1, 1),
};

export function gravityDurationMs(
  travel: number,
  gravity: number,
  pull = 1,
) {
  const seconds = Math.sqrt(
    (2 * Math.max(0.1, travel)) /
      Math.max(1, gravity * Math.max(0.05, pull)),
  );
  return Math.round(seconds * 1000);
}

export function gravityStrengthForDuration(
  travel: number,
  durationMs: number,
) {
  const seconds = Math.max(0.01, durationMs / 1000);
  return (2 * Math.max(0.1, travel)) / (seconds * seconds);
}

export function gravityPullForDuration(
  travel: number,
  gravity: number,
  durationMs: number,
) {
  return (
    gravityStrengthForDuration(travel, durationMs) /
    Math.max(1, gravity)
  );
}

export function gravityLaunchImpulse(
  travel: number,
  gravity: number,
) {
  return Math.sqrt(
    2 * Math.max(0.1, travel) * Math.max(1, gravity),
  );
}

function defaultPull(intent: MotionIntent, field: MotionField) {
  if (intent === "absorb") return field.absorbPull;
  return 1;
}

function defaultDuration(intent: MotionIntent, field: MotionField, pull: number) {
  if (intent === "emit" || intent === "absorb") {
    return gravityDurationMs(field.travel, field.gravity, pull);
  }
  return MOTION_DURATION_MS[intent];
}

export function createMotionPlan(
  intent: MotionIntent,
  options: MotionPlanOptions = {},
): MotionPlan {
  const field: MotionField = {
    gravity: Math.max(1, options.gravity ?? DEFAULT_MOTION_FIELD.gravity),
    travel: Math.max(0.1, options.travel ?? DEFAULT_MOTION_FIELD.travel),
    absorbPull: Math.max(
      0.05,
      options.absorbPull ?? DEFAULT_MOTION_FIELD.absorbPull,
    ),
  };
  const pull = Math.max(0.05, options.pull ?? defaultPull(intent, field));
  const durationMs = Math.max(
    1,
    Math.round(options.durationMs ?? defaultDuration(intent, field, pull)),
  );
  const easing = MOTION_SPINE[intent];

  return Object.freeze({
    intent,
    durationMs,
    easing,
    field: Object.freeze(field),
    pull,
    launchImpulse: gravityLaunchImpulse(field.travel, field.gravity * pull),
    sample(elapsedMs: number) {
      return easing.sample(
        Math.max(0, Math.min(1, elapsedMs / Math.max(1, durationMs))),
      );
    },
  });
}

export function createMotionPlans(
  field: Partial<MotionField> = {},
  durations: Partial<Record<MotionIntent, number>> = {},
): MotionPlans {
  const shared = {
    gravity: field.gravity,
    travel: field.travel,
    absorbPull: field.absorbPull,
  };
  return Object.freeze({
    emit: createMotionPlan("emit", {
      ...shared,
      durationMs: durations.emit,
    }),
    absorb: createMotionPlan("absorb", {
      ...shared,
      durationMs: durations.absorb,
    }),
    settle: createMotionPlan("settle", {
      ...shared,
      durationMs: durations.settle,
    }),
    flow: createMotionPlan("flow", {
      ...shared,
      durationMs: durations.flow,
    }),
    hold: createMotionPlan("hold", {
      ...shared,
      durationMs: durations.hold,
    }),
  });
}

/**
 * The spine at its defaults.
 *
 * Surfaces that do not tune the motion field share this rather than each
 * calling the factory, so "the kernel's timings" is one object and not a
 * convention several files are trusted to keep.
 */
export const DEFAULT_MOTION_PLANS = createMotionPlans();

/**
 * A node is a mass, so its birth and collapse carry more inertia than chrome
 * or a selection ring. These remain emit/absorb — the same laws and curves —
 * with a larger canonical travel supplying the slower, stellar scale change.
 *
 * Travel is the honest knob for how heavy a body reads, and duration falls out
 * of it: `t = sqrt(2·travel / gravity)`. So these are tuned by saying how far
 * the body is thrown, never by naming a duration, and the ratio to the rest of
 * the spine is preserved whichever way the field is later retuned.
 *
 * Travel is the honest knob for how heavy a body reads, and duration falls out
 * of it: `t = sqrt(2·travel / gravity)`. The ratio to a label is therefore
 * `sqrt(travel / field.travel)` and has nothing to do with gravity, which is
 * why making the whole surface quicker left these two numbers alone. A body is
 * still 1.45× an arrival and a collapse still 1.81× a release; both simply
 * happen sooner.
 */
/**
 * A body falls in its own well.
 *
 * Mass is what separates these two plans from the spine's, and the honest
 * place to put it is `gravity` rather than `travel` alone: a heavier body
 * deepens the field it is moving through, so it is thrown further *and* gets
 * there sooner. Travel alone can only buy the first half, and buys it by
 * making a collapse take longer the more violent it is asked to look — which
 * is backwards, and is what made a withdrawal read as a slow deflation
 * instead of something falling in.
 *
 * Six times the field, so the ratios inside each plan are untouched and only
 * the well these two live in is steeper.
 */
const STELLAR_GRAVITY = DEFAULT_MOTION_FIELD.gravity * 6;

export const NODE_BIRTH_PLAN = createMotionPlan("emit", {
  travel: 26,
  gravity: STELLAR_GRAVITY,
});
export const NODE_COLLAPSE_PLAN = createMotionPlan("absorb", {
  travel: 34,
  gravity: STELLAR_GRAVITY,
});

/**
 * Slow or accelerate one authored plan without changing its physical family.
 *
 * This exists for specialised plans such as massive-node birth/collapse,
 * which are not members of the five-intent `MotionPlans` record but must still
 * follow the lab's inspection speed. Distance, gravity, pull and curve remain
 * the same; only the clock is stretched.
 */
export function scaleMotionPlan(plan: MotionPlan, factor: number): MotionPlan {
  if (factor === 1) return plan;
  return createMotionPlan(plan.intent, {
    ...plan.field,
    pull: plan.pull,
    durationMs: plan.durationMs / Math.max(0.01, factor),
  });
}

/**
 * The same spine, slowed or sped for inspection.
 *
 * A design surface needs to be able to watch a 68ms `hold` happen. Scaling
 * every intent by one factor is what keeps this the same design at a
 * different speed rather than a different design: the ratios — emit against
 * absorb, hold against both — are the part of the spine that carries meaning,
 * and a factor that reached only some of them would quietly retune it.
 *
 * `factor` is a speed, so 0.25 is quarter speed. The field is untouched:
 * travel and gravity are distances, and a slow motion still moves 8.6px.
 */
export function scaleMotionPlans(factor: number): MotionPlans {
  if (factor === 1) return DEFAULT_MOTION_PLANS;
  const stretch = 1 / Math.max(0.01, factor);
  const durations = Object.fromEntries(
    Object.entries(MOTION_DURATION_MS).map(([intent, ms]) => [
      intent,
      Math.round(ms * stretch),
    ]),
  ) as Record<MotionIntent, number>;
  return createMotionPlans(DEFAULT_MOTION_FIELD, durations);
}

function poseTransform(pose: MotionPose) {
  const transforms: string[] = [];
  if (pose.x || pose.y) {
    transforms.push(`translate3d(${pose.x ?? 0}px, ${pose.y ?? 0}px, 0)`);
  }
  if (pose.rotate) transforms.push(`rotate(${pose.rotate}deg)`);
  if (pose.scale !== undefined) transforms.push(`scale(${pose.scale})`);
  return transforms.length ? transforms.join(" ") : "none";
}

/**
 * Canonical pose translation for DOM/SVG/Web Animations. The renderer adapter
 * supplies these frames unchanged; the MotionPlan supplies their time law.
 */
export function motionPoseKeyframes(
  from: MotionPose,
  to: MotionPose,
): Keyframe[] {
  return [
    {
      transform: poseTransform(from),
      ...(from.opacity === undefined ? {} : { opacity: from.opacity }),
    },
    {
      transform: poseTransform(to),
      ...(to.opacity === undefined ? {} : { opacity: to.opacity }),
    },
  ];
}

/** CSS-only consumers receive the same plans; no hand-copied timings/curves. */
export function motionCssVariables(plans: MotionPlans) {
  return {
    "--motion-emit-duration": `${plans.emit.durationMs}ms`,
    "--motion-emit-curve": plans.emit.easing.css,
    "--motion-absorb-duration": `${plans.absorb.durationMs}ms`,
    "--motion-absorb-curve": plans.absorb.easing.css,
    "--motion-settle-duration": `${plans.settle.durationMs}ms`,
    "--motion-settle-curve": plans.settle.easing.css,
    "--motion-hold-duration": `${plans.hold.durationMs}ms`,
    "--motion-hold-curve": plans.hold.easing.css,
    "--motion-flow-duration": `${plans.flow.durationMs}ms`,
    "--motion-flow-curve": plans.flow.easing.css,
    "--motion-travel": `${plans.emit.field.travel}px`,
  } as const;
}

/* ------------------------------------------------------------------ *
 * Stillness
 * ------------------------------------------------------------------ */

/**
 * Citations for deliberate stillness.
 *
 * They record decisions from the spec, canvas contract and owner review.
 * The legacy theme citation is explicitly qualified below. A decision
 * *not* to animate can point at its reason in code instead of being an
 * absence that the next person fills in with something that looks nice.
 */
export const STILL_RULES = {
  marksNeverMove:
    "Existing marks never move. The field must not re-layout under animation.",
  meaningIsStructural:
    "Meaning is carried structurally, never decoratively. Geometry never tweens — a mark caught between filled and outlined draws an origin that does not exist.",
  colourIsStatus:
    "Colour is for status only. It may cross-fade, but only at hold length: the midpoint between certified and stale is neither.",
  rowsNeverFly:
    "Windowed rows, fixed height, SQL-side sorting. A row entering the window is not an arrival; re-sorting is a re-query.",
  answersDoNotTween:
    "Exact misses stay exact misses; search results stay candidates. A changed result set is a new answer, not a rearranged one.",
  nothingIsIndeterminate:
    "Retrieval and traversal do not call a model, so nothing on the read plane is indeterminate and flow is never correct there.",
  /** @deprecated Historical name, retained for citation compatibility. Shell
   * appearance is explicitly allowed to ease by the established World runtime
   * and the PR #34 owner review; this is not a prohibition on palette easing.
   * Recorded meaning and immediate keyboard focus retain their own rules. */
  themeSnaps:
    "Theme selection changes appearance, not recorded meaning. The established shell eases appearance tokens over emit after is-motion-ready; this legacy citation does not require shell palettes to snap.",
  focusIsWhereYouAre:
    "A focus ring states where the keyboard is, and it is there the instant the key lands. A ring still arriving is a ring you cannot yet trust — and it is the affordance someone navigating without a pointer is steering by.",
} as const;

export type StillRule = keyof typeof STILL_RULES;

/**
 * Mark an element as deliberately unanimated, citing the rule.
 *
 * Spread onto the element: `<p {...still("rowsNeverFly")}>`. The attribute is
 * the citation — greppable, and visible in devtools next to the thing it
 * governs — and `presence.css` turns it into enforcement, so a transition
 * added to that element later is overridden rather than silently winning.
 * Descendants are untouched: stillness is a claim about this element's own
 * properties, not about everything under it.
 */
export function still(because: StillRule) {
  return { "data-still": because } as const;
}

/* ------------------------------------------------------------------ *
 * Stagger
 * ------------------------------------------------------------------ */

export type StaggerOptions = {
  /** Total spread from the first wave's start to the last's. */
  windowMs?: number;
  /** Ceiling on waves, so a large arrival does not become a queue. */
  maxWaves?: number;
};

/**
 * How long an arrival may be spread over.
 *
 * One `absorb`. The reading: the last mark of an expansion lands within a
 * departure's length of the first, so the group still reads as one event
 * rather than as a sequence of separate ones. It is deliberately shorter than
 * `emit` — the waves overlap, and what you see is a wave front crossing the
 * new matter, not marks queueing.
 */
export const STAGGER_WINDOW_MS = MOTION_DURATION_MS.absorb;

const STAGGER_MAX_WAVES = 5;

/**
 * Split arrivals into waves by rank, lowest first.
 *
 * `rank` is a distance — from the anchor an expansion grew out of, usually.
 * Ties share a wave, which is what makes a ring arrive as a ring. The count
 * is capped rather than one-wave-per-item: past a handful of steps the eye
 * stops reading order and starts reading lag.
 */
export function staggerWaves<T>(
  items: readonly T[],
  rank: (item: T) => number,
  options: StaggerOptions = {},
): { waves: T[][]; stepMs: number } {
  const maxWaves = Math.max(1, options.maxWaves ?? STAGGER_MAX_WAVES);
  const windowMs = Math.max(0, options.windowMs ?? STAGGER_WINDOW_MS);
  if (items.length <= 1) return { waves: items.length ? [[...items]] : [], stepMs: 0 };

  const ranked = [...items].sort((a, b) => rank(a) - rank(b));
  const lowest = rank(ranked[0]);
  const highest = rank(ranked[ranked.length - 1]);
  const spread = highest - lowest;

  // Everything the same distance out is one event, however many marks it is.
  if (spread <= 0) return { waves: [ranked], stepMs: 0 };

  const count = Math.min(maxWaves, ranked.length);
  const waves: T[][] = Array.from({ length: count }, () => []);
  for (const item of ranked) {
    const share = (rank(item) - lowest) / spread;
    const index = Math.min(count - 1, Math.floor(share * count));
    waves[index].push(item);
  }

  const occupied = waves.filter((wave) => wave.length > 0);
  return {
    waves: occupied,
    stepMs: occupied.length > 1 ? windowMs / (occupied.length - 1) : 0,
  };
}

/**
 * A selected mark spreads its own strokes so their names can be read.
 *
 * Every bond and spoke a mark carries stations its plate a fixed distance out
 * from that mark's rim — `BOND_LABEL_ALONG_PX`, the same station for all of
 * them, because a name must not drift toward the midpoint merely because
 * somebody dragged the other end further away. The consequence is that two
 * neighbours a few degrees apart put two plates in the same place. At rest
 * that costs nothing: nothing is named. Selecting the mark names all of them
 * at once, which is exactly when the pile appears, and a pile of names is not
 * an answer.
 *
 * So the selection spreads them. Each stroke leaves the mark on its own angle,
 * pushed off its neighbours until there is a minimum arc between them, and its
 * plate rides out to the station on that new angle. The names occupy an arc
 * instead of a point.
 *
 * Arc is not always enough. A ring of names spends a fixed budget — 2π — at a
 * rate the station sets, and at the resting station that budget is gone by
 * about five names, whatever order they are put in. So a fan that still has
 * names on top of each other spends the other resource and pushes its stations
 * outward, each stroke capped by its own half-filament. `planSpread` carries
 * the measurements and the property that costs.
 *
 * Four properties keep it a spread rather than a rearrangement, and all four
 * are the product canvas's, ported whole:
 *
 * **Circular order is kept.** Strokes are pushed apart in the order they
 * already stand in, so the fan is the neighbourhood as it was, opened up — not
 * a different neighbourhood with the same members.
 *
 * **Each stroke is clamped.** No stroke leaves its own angle by more than
 * `SPREAD_MAX_DEFLECT`, so a crowded mark fans in place instead of eating the
 * circle, and the direction a neighbour lies in stays true.
 *
 * **The far end never moves.** Only the held end's angle changes. What is
 * joined to what is not up for negotiation.
 *
 * **It is a rest pose.** A mark being dragged would re-solve every frame,
 * which is both expensive and unreadable, so the field snaps back to its
 * chords until the pointer lets go.
 *
 * This is presentation and nothing else. No tuple, position or label station
 * is touched: `filaments.ts` holds each elbow in the renderer, and letting go
 * of the mark puts every stroke back on the line it was always drawn as.
 */

import type { Graph } from "@antv/g6";
import {
  BOND_LABEL_ALONG_PX,
  BOND_LABEL_STACK_GAP,
  chipWidth,
  rimDistance,
  roleWidth,
  type MarkParams,
  type MarkRim,
} from "./marks";
import {
  clearFilamentFans,
  updateFilamentFans,
  type FilamentFanPatch,
} from "./filaments";
import type { MotionPlan, MotionPlans } from "../styles/motion";
import { scaleMotionPlan } from "../styles/motion";
import { FONT_MONO_FAMILY } from "../styles/typography";

type Point = { x: number; y: number };

/**
 * How far along the fan one plate is allowed to reach.
 *
 * A name only collides with strokes near it in the circular order, and the
 * pairs are what make the solve quadratic, so pairs further apart than this
 * are not considered. Six is well past the widest name any of these worlds
 * carries at its station.
 */
const SPREAD_REACH_SEATS = 6;

/**
 * How hard, and how many times, the fan is allowed to push its names outward.
 *
 * A step of a quarter and six rounds reaches just under four times the resting
 * station, which is far more headroom than any stroke's half-filament ceiling
 * will actually grant. The rounds are cheap — a solve is tens of microseconds
 * — and are only spent while names are still overlapping.
 */
const SPREAD_PUSH_STEP = 1.25;
const SPREAD_PUSH_ROUNDS = 6;

/**
 * How much faster than the spine the fan runs, as a speed.
 *
 * The strokes answer a hold directly, so at spine pace (210ms out, 142ms
 * back) they lag the pointer; at 1.5× they land in ~140ms out and ~95ms
 * back. A speed, not a duration, so the lab slowing the spine slows the fan
 * with it — see `scaleMotionPlan`.
 */
const SPREAD_PACE = 1.5;

/**
 * Never more than this, whatever the plates ask: past it the fan is a fiction.
 *
 * There is deliberately no matching floor. A floor answers "these two overlap"
 * with a fixed arc, so a pair a degree from clearing is opened as far as a
 * pair sitting exactly on top of each other, and the fan reads as having an
 * opinion about the neighbourhood rather than a job in it. What two plates
 * need is a measurable quantity; the room they need to be *comfortable* is
 * already in their half-extents as `BOND_LABEL_STACK_GAP`. Asking for exactly
 * that and no more is what keeps this minimal.
 */
const SPREAD_MAX_ARC = 0.9;
/**
 * How far a stroke may leave the angle its neighbour gives it, in radians.
 *
 * The direction a neighbour lies in is information the drawing is asserting,
 * and every radian of deflection is a small lie told to make a name legible.
 * 0.4 is about 23°: enough to unstack a crowded pair, small enough that the
 * neighbour is still where the fan says it is.
 */
const SPREAD_MAX_DEFLECT = 0.4;
/**
 * Below this much plate travel there is nothing to see, so nothing is moved.
 *
 * In pixels rather than radians, because an angle is not a visible quantity:
 * the same small rotation moves a plate stationed far out several pixels and
 * one stationed close in none at all. Held as an angle this threshold refused
 * the cheapest fixes there are — a pair a degree from clearing, which is
 * exactly the case a minimal spread should be best at — while still allowing
 * that angle on a stroke where it did less.
 */
const SPREAD_SKIP_PX = 1;

export type FanWaypoint = {
  angle: number;
  along: number;
  fromSource: boolean;
  /** How far this stroke was moved, so a stroke already clear stays still. */
  deflect: number;
};

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

function wrapAngle(angle: number) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/** What one stroke brings to the spacing: its bearing and the plate it carries. */
type Spoke = {
  angle: number;
  /** Half-extents of the plate at its station, plus the air it wants. */
  halfWidth: number;
  halfHeight: number;
  /** Distance from the mark's centre to that station. */
  station: number;
};

/**
 * Do two plates, placed on these bearings, actually overlap?
 *
 * An exact test, and it can be exact because a plate is an axis-aligned box:
 * `labelAutoRotate` is false, so a name at eleven o'clock is the same
 * rectangle as a name at four. Two boxes miss each other when they miss on
 * either axis, which is one comparison per axis and no trigonometry beyond
 * placing the centres.
 */
function platesOverlap(
  angleA: number,
  angleB: number,
  a: Spoke,
  b: Spoke,
): boolean {
  const dx = Math.cos(angleB) * b.station - Math.cos(angleA) * a.station;
  const dy = Math.sin(angleB) * b.station - Math.sin(angleA) * a.station;
  return (
    Math.abs(dx) < a.halfWidth + b.halfWidth &&
    Math.abs(dy) < a.halfHeight + b.halfHeight
  );
}

/**
 * The least arc between two adjacent strokes that clears their plates.
 *
 * This used to be a *step* rather than a bound — it answered "open this pair
 * by a bit more than they are open now", scaled from the gap they currently
 * held, and forty-eight passes of that converged on the arc that clears. Read
 * as a constraint instead, which is what an exact solve needs, it badly
 * under-asks: two names sitting exactly on top of each other hold almost no
 * gap, so a proportional step off that gap is almost nothing, and the solver
 * is told a pile is nearly fine.
 *
 * So this searches for the bound directly. The pair is opened symmetrically
 * about where it sits — the plates keep their own stations, which is what
 * makes the answer depend on *where* on the circle the pair is — and the
 * first arc that clears is refined by bisection. Coarse scan first rather than
 * bisecting from the start, because an axis-aligned box against another at a
 * different radius is not perfectly monotone in the arc, and a scan cannot
 * step over the crossing the way a bisection can.
 */
function requiredArc(
  angleA: number,
  angleB: number,
  a: Spoke,
  b: Spoke,
): number {
  // Deliberately not short-circuited on "these two are clear already". The
  // answer is what this pair *needs*, not what it currently has: a gap the
  // solve is told is free to close to nothing is a gap the solve will close.
  const middle = (angleA + angleB) / 2;
  const clears = (arc: number) =>
    !platesOverlap(middle - arc / 2, middle + arc / 2, a, b);

  const STEPS = 48;
  let found = -1;
  let previous = 0;
  for (let step = 1; step <= STEPS; step += 1) {
    const arc = (SPREAD_MAX_ARC * step) / STEPS;
    if (clears(arc)) {
      found = arc;
      break;
    }
    previous = arc;
  }
  // Nothing inside the cap clears them. The cap is the answer: past it the fan
  // is a fiction, and `crowded` is what reports that it did not fit.
  if (found < 0) return SPREAD_MAX_ARC;

  let low = previous;
  let high = found;
  for (let refine = 0; refine < 12; refine += 1) {
    const mid = (low + high) / 2;
    if (clears(mid)) high = mid;
    else low = mid;
  }
  return high;
}

/**
 * Isotonic regression, in place of forty-eight passes of shoving.
 *
 * The general problem here is point-feature label placement, and it is
 * NP-hard — Marks & Shieber (1991); the standard empirical comparison of
 * heuristics for it is Christensen, Marks & Shieber (1995). What saves this
 * particular fan is that two of the freedoms that make the general problem
 * hard were already given up by the design above: every plate sits on a circle
 * around one held mark, and **circular order is kept**. With position reduced
 * to one number per label and the order fixed, what is left is
 *
 *     minimise  Σ (yᵢ − xᵢ)²   subject to   yᵢ₊₁ − yᵢ ≥ gᵢ
 *
 * — move every name as little as possible, while giving each adjacent pair the
 * arc its plates actually need. Substituting out the cumulative gaps,
 * zᵢ = yᵢ − Σⱼ<ᵢ gⱼ, turns those constraints into `z` non-decreasing, which is
 * isotonic regression: solved **exactly**, in one linear pass, by
 * pool-adjacent-violators. No iteration count, no tuning, and the same answer
 * every time.
 *
 * What that buys over the relaxation it replaces is not speed, though it is
 * also faster — it is that the previous loop had no answer to "did it work".
 * It took forty-eight passes and shipped whatever it was holding when it ran
 * out, which on a crowded mark was still a pile. This either returns the
 * provably minimal fan that clears every pair, or reports that no fan can
 * (`crowded`), and those are the only two outcomes.
 *
 * Two wrinkles the textbook version does not have, both handled here:
 *
 * **The gaps depend on the answer.** Plates are axis-aligned, so a pair needs
 * its widths at twelve o'clock and its heights at three, and `requiredArc`
 * measures at the angles the pair currently holds. So the exact solve is run a
 * few times, each recomputing gaps from the solution before it. Unlike the old
 * loop, every pass is exact *given its gaps* rather than one nudge toward
 * being exact, so this converges in two or three rather than tens.
 *
 * **The circle has no first element.** Isotonic regression wants a line. The
 * seam is cut at the pair with the most room to spare, because that is the
 * join the solve is least likely to want to move across.
 */
function spreadAngles(
  spokes: Spoke[],
  maxDeflect: number,
): { angles: number[]; crowded: boolean; wanted: number; collisions: number } {
  const count = spokes.length;
  const angles = spokes.map((spoke) => spoke.angle);
  if (count < 2) return { angles, crowded: false, wanted: 0, collisions: 0 };

  const order = spokes
    .map((spoke, index) => ({ angle: wrapAngle(spoke.angle), index }))
    .sort((a, b) => a.angle - b.angle);
  const at = order.map((entry) => entry.angle);
  const of = (seat: number) => spokes[order[seat].index];

  /**
   * The arc each join has to hold — including for pairs that are not joined.
   *
   * Constraining only neighbours is the obvious thing and it is wrong: a long
   * name spans several seats, so it collides with the stroke two or three
   * along while every adjacent gap is satisfied. That is why the fan used to
   * report itself feasible and still read as a pile.
   *
   * A pair that is `d` seats apart is handled by asking each of the `d` joins
   * between them for `R / d`: the run between them then sums to at least `R`,
   * whatever the solve does with the individual joins. Conservative — the pair
   * might have been cleared by one wide join and several narrow — but a
   * constraint that can only be too strong never lets a collision through, and
   * an evenly opened run is what the eye reads as a fan anyway.
   *
   * Spans are cut off at `SPREAD_REACH_SEATS`. A plate has to be absurd to
   * reach further than that, and the pair count is what makes this quadratic.
   */
  const gapsAt = (held: number[]) => {
    const out = new Array<number>(count).fill(0);
    const reach = Math.min(SPREAD_REACH_SEATS, count - 1);
    for (let seat = 0; seat < count; seat += 1) {
      for (let span = 1; span <= reach; span += 1) {
        const far = (seat + span) % count;
        const share =
          requiredArc(held[seat], held[far], of(seat), of(far)) / span;
        for (let step = 0; step < span; step += 1) {
          const join = (seat + step) % count;
          if (share > out[join]) out[join] = share;
        }
      }
    }
    return out;
  };

  let held = [...at];
  let gaps = gapsAt(held);

  for (let pass = 0; pass < 3; pass += 1) {
    gaps = gapsAt(held);
    // The seam: the join with the most room to spare, so the solve is cut
    // where it is least likely to have wanted to reach across.
    let seam = 0;
    let best = -Infinity;
    for (let seat = 0; seat < count; seat += 1) {
      const next = (seat + 1) % count;
      let apart = held[next] - held[seat];
      if (next === 0) apart += Math.PI * 2;
      const slack = apart - gaps[seat];
      if (slack > best) {
        best = slack;
        seam = seat;
      }
    }
    // Unrolled from just after the seam, into one increasing run.
    const seats: number[] = [];
    for (let step = 1; step <= count; step += 1) {
      seats.push((seam + step) % count);
    }
    const desired: number[] = [];
    let running = held[seats[0]];
    desired.push(running);
    for (let i = 1; i < count; i += 1) {
      let step = held[seats[i]] - held[seats[i - 1]];
      while (step < 0) step += Math.PI * 2;
      running += step;
      desired.push(running);
    }
    const between = seats.slice(0, -1).map((seat) => gaps[seat]);
    const solved = separate(desired, between);
    for (let i = 0; i < count; i += 1) held[seats[i]] = solved[i];
  }

  /**
   * Whether any fan on this circle could have worked.
   *
   * Two ways it could not. The plates may want more arc than a circle has, in
   * which case no arrangement of them clears — this is the honest form of "the
   * mark is too crowded to name everything at once". Or the solve may have
   * asked a stroke to leave its true bearing by more than `SPREAD_MAX_DEFLECT`
   * allows, which is the clamp refusing to tell a bigger lie about where a
   * neighbour lies than the fan is worth.
   *
   * Either way the clamped fan below is still the best available and is still
   * drawn — reporting is not refusing.
   */
  const wanted = gaps.reduce((sum, gap) => sum + gap, 0);
  let worst = 0;
  for (let seat = 0; seat < count; seat += 1) {
    worst = Math.max(worst, Math.abs(wrapAngle(held[seat] - at[seat])));
  }
  const crowded = wanted > Math.PI * 2 || worst > maxDeflect;

  for (let seat = 0; seat < count; seat += 1) {
    const original = at[seat];
    const delta = Math.max(
      -maxDeflect,
      Math.min(maxDeflect, wrapAngle(held[seat] - original)),
    );
    angles[order[seat].index] = original + delta;
  }

  /**
   * What is left over, counted rather than inferred.
   *
   * `crowded` above is a diagnosis — the demand exceeded the circle, or the
   * clamp refused the solution. This is the outcome: pairs still sitting on
   * each other at the angles actually returned, after the clamp had its say.
   * The caller needs the outcome, because that is what it can spend more
   * radius on.
   */
  let collisions = 0;
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      if (platesOverlap(angles[i], angles[j], spokes[i], spokes[j])) {
        collisions += 1;
      }
    }
  }
  return { angles, crowded, wanted, collisions };
}

/**
 * Positions as near their desired ones as the required gaps allow, exactly.
 *
 * `gaps[i]` is the minimum `y[i + 1] - y[i]`. Subtracting the running total of
 * them leaves a plain non-decreasing fit, and pool-adjacent-violators is that
 * fit: push each value on, and while the block behind it sits higher, merge
 * the two and let them share their mean. Every merged block is a run of names
 * that ended up evenly spaced because they could not all have what they
 * wanted — which is the right answer and is what the eye reads as a fan.
 */
function separate(desired: number[], gaps: number[]): number[] {
  const running: number[] = [0];
  for (let i = 0; i < gaps.length; i += 1) running.push(running[i] + gaps[i]);

  const sums: number[] = [];
  const sizes: number[] = [];
  for (let i = 0; i < desired.length; i += 1) {
    sums.push(desired[i] - running[i]);
    sizes.push(1);
    while (
      sums.length > 1 &&
      sums[sums.length - 2] / sizes[sizes.length - 2] >
        sums[sums.length - 1] / sizes[sizes.length - 1]
    ) {
      const sum = sums.pop()!;
      const size = sizes.pop()!;
      sums[sums.length - 1] += sum;
      sizes[sizes.length - 1] += size;
    }
  }

  const out: number[] = [];
  for (let block = 0; block < sums.length; block += 1) {
    const mean = sums[block] / sizes[block];
    for (let k = 0; k < sizes[block]; k += 1) out.push(mean + running[out.length]);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Reading the field
 * ------------------------------------------------------------------ */

function positionOf(graph: Graph, id: string): Point | null {
  try {
    const at = graph.getElementPosition(id);
    if (!at || !Number.isFinite(at[0]) || !Number.isFinite(at[1])) return null;
    return { x: at[0], y: at[1] };
  } catch {
    return null;
  }
}

/**
 * G6 throws for an id it does not hold rather than answering nothing, and a
 * selection routinely names a mark the canvas has not drawn yet — the reader
 * opens on it while the frame carrying it is still in the draw lane. Asking is
 * the check.
 */
function standingNode(graph: Graph, id: string) {
  try {
    return graph.getNodeData(id) ?? null;
  } catch {
    return null;
  }
}

/**
 * Where a stroke's rim is, which is where its plate is measured from.
 *
 * The same rim `bondLabelLayout` is handed when it stations a resting name.
 * The two have to agree or the fanned plate would sit at a different distance
 * than the resting one, and the spread would read as the names jumping
 * outward — so this reads the mark's drawn size and hands back the shape,
 * leaving `rimDistance` to say how far that rim is along a given bearing.
 */
function rimOf(graph: Graph, id: string, params: MarkParams): MarkRim {
  const size = standingNode(graph, id)?.style?.size;
  if (typeof size === "number") return { shape: "disc", radius: size / 2 };
  if (
    Array.isArray(size) &&
    size.length >= 2 &&
    typeof size[0] === "number" &&
    typeof size[1] === "number"
  ) {
    return {
      shape: "plate",
      halfWidth: size[0] / 2,
      halfHeight: size[1] / 2,
    };
  }
  return { shape: "disc", radius: params.discDiameter / 2 };
}

/**
 * How wide the plate this stroke carries is drawn.
 *
 * Its own text when it has one — the mark is about to name everything it
 * touches, so a name that is not showing yet is still a name that will be.
 *
 * Zero when it carries none, and that is a real answer rather than a missing
 * one: a stroke with no plate has nothing to keep clear of anything, so it
 * takes no part in the spread. It used to claim a plate's height anyway, on
 * the reasoning that a bare line crossing a name is also worth avoiding — but
 * a plate is drawn on its own opaque ground and covers the line it crosses, so
 * that bought nothing and spent deflection on strokes with nothing to say.
 */
function plateWidth(
  style: Record<string, unknown> | undefined,
  params: MarkParams,
): number {
  const text = style?.labelText;
  if (typeof text !== "string" || !text) return 0;
  // A role is set in the mono face at the same size as chip type, so the
  // face — not the size — says which metrics to measure with. See
  // `roleWidth`. Fanning a role at chip width misstates every spoke on the
  // field.
  return style?.labelFontFamily === FONT_MONO_FAMILY
    ? roleWidth(text, params)
    : chipWidth(text, params);
}

/**
 * The angle each of the held mark's strokes leaves on, once spread.
 *
 * Strokes to the *same* neighbour are one group with one angle. Several claims
 * between the same two referents are drawn on one filament — the first strokes
 * it, the rest ride it with their plates stacked along its normal, and the
 * observer's count rides it too. Spreading them individually would fan one
 * line into several and invent a geometry the tuples do not have.
 */
export function planSpread(
  graph: Graph,
  heldId: string,
  params: MarkParams,
  /** Out-param: whether no fan on this circle could have cleared every pair. */
  report?: { crowded: boolean },
): Map<string, FanWaypoint> {
  const out = new Map<string, FanWaypoint>();
  const held = positionOf(graph, heldId);
  if (!held) return out;
  const heldRim = rimOf(graph, heldId, params);

  const groups = new Map<
    string,
    {
      members: { id: string; fromSource: boolean }[];
      angle: number;
      along: number;
      /**
       * The held mark's own rim on this bearing. A disc's is the same in every
       * direction; a held plate's is not, and a fan that used one number for
       * all of them would start its strokes inside the mark on some bearings
       * and outside it on others.
       */
      heldRadius: number;
      /** The widest name this stroke will carry, which is what has to clear. */
      plate: number;
      /**
       * The furthest out this stroke's plate may ever stand.
       *
       * Half its own filament — past the midpoint a name would cross to the
       * other mark's side and start naming the wrong end, which is the same
       * rule `bondLabelAlong` holds a resting plate to.
       */
      ceiling: number;
    }
  >();
  for (const edge of graph.getRelatedEdgesData(heldId)) {
    const fromSource = String(edge.source) === heldId;
    const otherId = fromSource ? String(edge.target) : String(edge.source);
    const member = { id: String(edge.id), fromSource };
    const style = edge.style as Record<string, unknown> | undefined;
    const plate = plateWidth(style, params);
    // The draw's own station, read back: recomputing it here from the
    // display state would move the fan's plates on selection.
    const want =
      typeof style?.bondAlong === "number" && Number.isFinite(style.bondAlong)
        ? (style.bondAlong as number)
        : BOND_LABEL_ALONG_PX;
    const standing = groups.get(otherId);
    if (standing) {
      standing.members.push(member);
      standing.plate = Math.max(standing.plate, plate);
      // Only a member carrying a name stations the group. A bare stroke —
      // the filament a name rides — states no station of its own, so the
      // default it would bring must not raise the one a name stated: a
      // role at 16px merged under its own stroke's 52 is a pile the
      // solver is then told is not there. It still rides, as a member.
      if (plate > 0) {
        standing.along = Math.min(Math.max(standing.along, want), standing.ceiling);
      }
      continue;
    }
    const other = positionOf(graph, otherId);
    if (!other) continue;
    const dx = other.x - held.x;
    const dy = other.y - held.y;
    const centres = Math.hypot(dx, dy);
    const heldRadius = rimDistance(heldRim, dx, dy);
    const filament =
      centres - heldRadius - rimDistance(rimOf(graph, otherId, params), dx, dy);
    // Nothing to fan along: the two marks are all but touching, and an elbow
    // between them would be a corner with no stroke on either side of it.
    if (!(filament > 4)) continue;
    groups.set(otherId, {
      members: [member],
      angle: Math.atan2(dy, dx),
      // The same station `bondLabelAlong` gives the resting plate, so the
      // spread moves a name sideways and never outward. A bare stroke seeds
      // none: the name that rides it states it when it arrives, whatever
      // order the two stand in — see the merge above.
      along: plate > 0 ? Math.min(want, filament / 2) : 0,
      heldRadius,
      plate,
      ceiling: filament / 2,
    });
  }
  /**
   * Only the strokes carrying a name are in the fan.
   *
   * The fan exists to stop two names sitting on each other, so a stroke with
   * no name neither asks for room nor has to give any, and one that is never
   * moved is one whose neighbour is still exactly where the drawing says. With
   * fewer strokes competing the rest also settle nearer their true bearings,
   * so this makes the spread smaller twice over.
   */
  const keys = [...groups.keys()].filter((key) => groups.get(key)!.plate > 0);
  if (keys.length < 2) return out;

  const spokesOf = () =>
    keys.map((key) => {
      const group = groups.get(key)!;
      return {
        angle: group.angle,
        halfWidth: (group.plate + BOND_LABEL_STACK_GAP) / 2,
        halfHeight: (params.chipHeight + BOND_LABEL_STACK_GAP) / 2,
        station: group.heldRadius + group.along,
      };
    });

  let solved = spreadAngles(spokesOf(), SPREAD_MAX_DEFLECT);

  /**
   * When the circle has no room, give the fan a bigger circle.
   *
   * The arc a plate needs is its width over its radius, so a ring of names is
   * a fixed budget — 2π — being spent at a rate the station sets. Held at
   * `BOND_LABEL_ALONG_PX` that budget runs out at about five names. Measured
   * over random fans at the resting station: three strokes cleared completely
   * in 88% of cases, five in 73%, eight in 39%, twelve in 9% — and the
   * deflection clamp bound in every trial. Relaxing the clamp is not the fix
   * either; at that station an unlimited clamp still only reaches 54% at eight
   * strokes, because the demand exceeds the circle rather than being badly
   * distributed around it. The same sweep at a station of 160px clears 93% at
   * eight and 77% at twelve with the clamp untouched.
   *
   * So radius is the resource, and this spends it against the thing actually
   * being asked for — pairs still overlapping — rather than against a proxy.
   * Each round pushes every station out a step, re-solves, and keeps whichever
   * round left the fewest names on top of each other. It stops the moment none
   * are, so the ordinary two- or three-stroke mark pays for exactly one solve.
   * Each stroke is still capped by its own half-filament, so a name never
   * crosses to the far mark's side and a short stroke simply cannot help.
   *
   * **This gives up "the spread moves a name sideways and never outward",**
   * which the header above claimed and which was true while the fan was
   * angular only. It is given up deliberately: a name that stays at its
   * resting distance and cannot be read has kept a property and lost its job.
   * The far end still never moves, circular order is still kept, and letting
   * go still puts every stroke back on the line it was drawn as.
   */
  let best = solved;
  let bestAlong = keys.map((key) => groups.get(key)!.along);
  for (let round = 0; round < SPREAD_PUSH_ROUNDS && best.collisions > 0; round += 1) {
    let moved = false;
    for (const key of keys) {
      const group = groups.get(key)!;
      const reach = Math.min(group.ceiling, group.along * SPREAD_PUSH_STEP);
      if (reach > group.along + 0.5) {
        group.along = reach;
        moved = true;
      }
    }
    // Every stroke is against its own ceiling. More radius is not on offer.
    if (!moved) break;
    solved = spreadAngles(spokesOf(), SPREAD_MAX_DEFLECT);
    if (solved.collisions < best.collisions) {
      best = solved;
      bestAlong = keys.map((key) => groups.get(key)!.along);
    }
  }
  keys.forEach((key, i) => {
    groups.get(key)!.along = bestAlong[i];
  });
  solved = best;

  const { angles: spread } = solved;
  // What the reader is told is what is true of the drawing in front of them:
  // some of these names are still on top of each other. Not the arc-budget
  // diagnosis, which can be pessimistic about a fan the radius went on to fix.
  if (report) report.crowded = solved.collisions > 0;
  for (let i = 0; i < keys.length; i += 1) {
    const group = groups.get(keys[i])!;
    const angle = spread[i];
    const deflect = Math.abs(wrapAngle(angle - group.angle));
    if (deflect * (group.heldRadius + group.along) < SPREAD_SKIP_PX) continue;
    for (const member of group.members) {
      out.set(member.id, {
        angle,
        along: group.along,
        fromSource: member.fromSource,
        deflect,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The field
 * ------------------------------------------------------------------ */

/**
 * Announced on the graph's container whenever the field writes fan state.
 *
 * Every commit and every animation frame that moves a stroke ends in `apply`,
 * and `apply` writes straight into the renderer, where nothing G6 hears is
 * emitted — no draw, no transform. A selection outline traced before the
 * write would otherwise keep the box from where the label stood, so the
 * field says when it moved something and the outline re-reads. The listener
 * coalesces frames to one retrace each; at rest nothing is announced.
 */
export const SPREAD_FRAME_EVENT = "world:spreadframe";

/**
 * Who owns the fan after a canvas pick lands.
 *
 * A bond picked from an open fan on the canvas keeps its owner: the label
 * the fan revealed must not move under its own selection outline and the
 * pointer that just landed on it. Travel — a roster row, a table row, the
 * finder — does not come through here: arriving somewhere new takes
 * ownership itself, so the old mark's fan closes behind it instead of
 * staying bent. The outline follows the retraction frame by frame off
 * `SPREAD_FRAME_EVENT`, which is what lets travel close what a canvas pick
 * keeps.
 *
 * Only a fan the bond is in: its owner must be one of the bond's ends. A
 * bond off that fan closes it, as it always did.
 *
 * Anything else takes ownership itself: a node opens its own fan, a plate
 * owns one too, and a bond with no fan open names an owner that stands
 * nowhere, which is already what closing looks like.
 */
export function spreadOwnerForSelection(
  selectionId: string,
  bond: { source: string; target: string } | null,
  currentOwner: string | null,
): string {
  if (bond && currentOwner && (bond.source === currentOwner || bond.target === currentOwner)) {
    return currentOwner;
  }
  return selectionId;
}

/**
 * Which presses put the fan down while the pointer owns the field.
 *
 * The fan is solved for the strokes standing on its owner's geometry, so a
 * press that moves that geometry — the owner's own, or a neighbour's, the
 * other endpoint of one of its strokes — retracts it for the gesture and
 * the draw after the drop re-solves it fresh. A stranger's drag touches
 * none of those strokes, so the fan stands through it.
 */
export type SpreadYieldScope = "none" | "owner" | "neighbourhood" | "any";

/** The other endpoints of the owner's strokes — the fan's own neighbourhood. */
function fanNeighbourIds(
  relatedEdges: { source: unknown; target: unknown }[],
  owner: string,
): Set<string> {
  const out = new Set<string>();
  for (const edge of relatedEdges) {
    const source = typeof edge.source === "string" ? edge.source : null;
    const target = typeof edge.target === "string" ? edge.target : null;
    if (source === owner && target !== null && target !== owner) {
      out.add(target);
    } else if (target === owner && source !== null && source !== owner) {
      out.add(source);
    }
  }
  return out;
}

/**
 * Whether this press puts the fan down, under this scope.
 *
 * `relatedEdges` is the owner's related edges — the same strokes the solver
 * fans over, so a neighbour here is exactly a mark the fan stands on. Read
 * off the renderer at press time, because the set on the field is what the
 * gesture is about to move.
 */
export function spreadYieldsToHold(
  scope: SpreadYieldScope,
  owner: string | null,
  pressedId: string,
  relatedEdges: { source: unknown; target: unknown }[],
): boolean {
  if (owner === null) return false;
  if (scope === "any") return true;
  if (pressedId === owner) return scope === "owner" || scope === "neighbourhood";
  return (
    scope === "neighbourhood" && fanNeighbourIds(relatedEdges, owner).has(pressedId)
  );
}

export type SpreadField = {
  /** State what is held. `null` puts every stroke back on its chord. */
  commit: (heldId: string | null) => void;
  /**
   * A pointer owns the field: retract the fan until it lets go.
   *
   * Retract, not drop — this is the spread run backwards, and it is on the
   * pointer's time rather than instant. See `relax`.
   */
  suspend: () => void;
  dispose: () => void;
};

export function createSpreadField(options: {
  graph: Graph;
  params: () => MarkParams;
  motion: () => MotionPlans;
  enabled: () => boolean;
  reduced: () => boolean;
}): SpreadField {
  const { graph } = options;
  let frame = 0;
  const amounts = new Map<string, number>();
  const anims = new Map<
    string,
    { from: number; to: number; started: number; plan: MotionPlan }
  >();
  const standing = new Set<string>();
  const targets = new Map<string, FanWaypoint>();

  const apply = () => {
    if (graph.destroyed) return;
    const ids = new Set([
      ...amounts.keys(),
      ...anims.keys(),
      ...standing,
      ...targets.keys(),
    ]);
    if (!ids.size) return;
    const patches: FilamentFanPatch[] = [];
    for (const id of ids) {
      const amount = amounts.get(id) ?? 0;
      const target = targets.get(id);
      // Forgotten only once nothing is still flying it home. A collapse
      // passes under this threshold a frame or two before it lands; dropping
      // the stroke there left its last frame unpainted, so it kept the bend
      // that frame stated — past the renderer's own cut-off at 0.01 when the
      // frame fell between the two.
      if (amount < 0.02 && !standing.has(id) && !anims.has(id)) {
        amounts.delete(id);
        targets.delete(id);
      }
      patches.push({
        id,
        amount,
        angle: target?.angle ?? 0,
        along: target?.along ?? 0,
        fromSource: target?.fromSource ?? true,
      });
    }
    updateFilamentFans(graph, patches);
    graph.getCanvas().getContainer()?.dispatchEvent(new Event(SPREAD_FRAME_EVENT));
  };

  const forget = () => {
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    anims.clear();
    standing.clear();
    amounts.clear();
    targets.clear();
  };

  const snapOff = () => {
    forget();
    if (!graph.destroyed) clearFilamentFans(graph);
  };

  /**
   * Letting go of the fan, on the same two curves that opened it.
   *
   * `suspend` used to be `snapOff` — instant — and that was defensible while it
   * fired on `dragstart`, where the fan's job was to be gone before the mark
   * started moving. It fires on *hold* now, so the collapse is something a
   * person watches, and an instant collapse against an eased spread reads as
   * two different mechanisms rather than one gesture reversed.
   *
   * `commit(null)` already is the animated collapse: nothing is held, so every
   * standing stroke is aimed at zero, and `aim` picks `absorb` for a value
   * falling — the time reverse of the `emit` that opened it, which is what
   * `styles/motion.ts` means by the pair. The geometry stays in `targets`
   * while the amounts run down, so the strokes retract along the arcs they
   * fanned out on instead of cutting to their chords.
   *
   * `snapOff` stays for the two cases that are not a gesture: disposal, and a
   * field whose spread has been switched off entirely.
   */
  const relax = () => commit(null);

  const tick = (now: number) => {
    frame = 0;
    let running = false;
    for (const [id, anim] of anims) {
      const value =
        anim.from + (anim.to - anim.from) * anim.plan.sample(now - anim.started);
      if (now - anim.started >= anim.plan.durationMs) {
        amounts.set(id, anim.to);
        anims.delete(id);
        if (anim.to < 0.02) amounts.delete(id);
      } else {
        amounts.set(id, value);
        running = true;
      }
    }
    apply();
    if (running && !graph.destroyed) frame = requestAnimationFrame(tick);
  };

  const aim = (id: string, to: number) => {
    const from = amounts.get(id) ?? 0;
    if (Math.abs(from - to) < 0.02 && !anims.has(id)) {
      amounts.set(id, to);
      if (to < 0.02) amounts.delete(id);
      return;
    }
    if (options.reduced()) {
      anims.delete(id);
      if (to < 0.02) amounts.delete(id);
      else amounts.set(id, to);
      return;
    }
    // A stroke already flying at this destination keeps its clock. Re-aiming
    // it restarts the easing mid-flight, and the fresh curve's opening
    // velocity lands as a kick — which is what a commit landing on top of an
    // unfinished reopen looked like. Only a changed destination re-aims.
    if (anims.get(id)?.to === to) return;
    const plans = options.motion();
    anims.set(id, {
      from,
      to,
      started: performance.now(),
      // A stroke opening out is matter leaving its rest and returning to it,
      // so it takes the same two curves everything else on this canvas does —
      // and the lab slowing the spine slows this with it. Run half again as
      // fast as the spine: the fan answers a hold directly, and at spine pace
      // it lags the pointer. Both directions scale together, so the close
      // stays the time reverse of the open.
      plan: scaleMotionPlan(
        to > from ? plans.emit : plans.absorb,
        SPREAD_PACE,
      ),
    });
  };

  const commit = (heldId: string | null) => {
    if (graph.destroyed) return;
    if (!options.enabled()) {
      if (amounts.size || targets.size || standing.size) snapOff();
      return;
    }
    // What is left overlapping is the visibility pass's to settle now — it
    // reads the drawn boxes and dims the losers — so the solver's count is
    // not reported up. `planSpread` keeps its out-param for checkers.
    const next =
      heldId && standingNode(graph, heldId)
        ? planSpread(graph, heldId, options.params())
        : new Map<string, FanWaypoint>();
    standing.clear();
    for (const [id, waypoint] of next) {
      standing.add(id);
      targets.set(id, waypoint);
      aim(id, 1);
    }
    for (const id of [...targets.keys()]) {
      if (!next.has(id)) aim(id, 0);
    }
    apply();
    if (options.reduced()) return;
    if (!frame && anims.size) frame = requestAnimationFrame(tick);
  };

  return { commit, suspend: relax, dispose: forget };
}

/* ------------------------------------------------------------------ *
 * Checkable from outside
 * ------------------------------------------------------------------ *
 *
 * The fan is a solver, and a solver is worth nothing that has not been run
 * against cases nobody drew by hand. These three are exported for that and for
 * nothing else — no surface calls them. They were a `window.__worldSpread`
 * hook first, which meant the only way to check the fan was to have a browser
 * attached to a running plane; as exports the same check is a script.
 */
export { spreadAngles, requiredArc, platesOverlap };
export type { Spoke };

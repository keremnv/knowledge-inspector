/**
 * Absorb, then change, then emit — with a gap in the middle on purpose.
 *
 * `Swap` overlaps its two halves, and that is right when both subjects are
 * painted on the same ground: the outgoing copy and the incoming one are the
 * same kind of thing in the same colours, so seeing both at once reads as one
 * being exchanged for the other.
 *
 * Vocabulary focus is not that. It rewrites `--canvas`, `--panel`, `--ink`,
 * `--ink-muted` and `--rule` to a black field — `GRAPH_DNA_FOCUS` — so in
 * light mode the whole surface inverts. Overlapping the halves there would
 * paint the departing field in its own colours against a ground that had
 * already become the other one's: for the length of the cross-fade, one of the
 * two views is drawn wrong. Sequence those content subjects so they do not
 * overlap against different grounds. This is distinct from appearance selection:
 * the established shell eases its palette tokens after `is-motion-ready`.
 *
 * So the halves are sequenced instead. The old view absorbs to nothing, the
 * change lands while there is nothing drawn to be wrong, and the new view
 * emits. It costs `absorb + emit` rather than `emit`, which is the honest
 * price of a change that has no shared ground to cross over.
 *
 * The value returned is the one to *render*. The caller keeps its own state as
 * the intent — what a person asked for — and reads this for what is on screen,
 * which during the gap is still the old one.
 */

import { useEffect, useRef, useState } from "react";
import { DEFAULT_MOTION_PLANS, type MotionPlans } from "./motion";

export type SequencedSwap<T> = {
  /** What to draw now. Lags `target` by one absorb while the old view leaves. */
  value: T;
  /** False while either half is running with nothing to show. */
  shown: boolean;
};

export function useSequencedSwap<T>(
  target: T,
  motion: MotionPlans = DEFAULT_MOTION_PLANS,
): SequencedSwap<T> {
  const [state, setState] = useState<SequencedSwap<T>>({
    value: target,
    shown: true,
  });
  const pending = useRef<T>(target);
  pending.current = target;

  useEffect(() => {
    if (Object.is(state.value, target)) {
      if (!state.shown) {
        // The new view is mounted but still dark. One frame to let it paint,
        // then it emits — otherwise the emit races the first draw and what
        // fades in is an empty canvas.
        const frame = requestAnimationFrame(() =>
          setState((current) => ({ ...current, shown: true })),
        );
        return () => cancelAnimationFrame(frame);
      }
      return;
    }
    if (state.shown) {
      setState((current) => ({ ...current, shown: false }));
      return;
    }
    // Dark, and the target still differs: the absorb is running. Swap the
    // subject under it, which is where the palette flips.
    const timer = window.setTimeout(() => {
      setState({ value: pending.current, shown: false });
    }, motion.absorb.durationMs);
    return () => window.clearTimeout(timer);
  }, [motion.absorb.durationMs, state.shown, state.value, target]);

  return state;
}

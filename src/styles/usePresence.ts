import { useEffect, useRef, useState } from "react";
import { DEFAULT_MOTION_PLANS } from "./motion";

/**
 * Leave time for anything that must stay mounted through absorb.
 *
 * Read from the spine, not copied. A panel that unmounts on the close frame
 * has no transition to run, which is why OverlayPanel's reader used to snap
 * while the library beside it slid.
 */
const SPINE = DEFAULT_MOTION_PLANS;

export function presenceLeaveMs() {
  return SPINE.absorb.durationMs;
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Keep a node in the tree for the absorb, and park it one frame on enter
 * so a CSS transition has a previous pose.
 *
 * `shown` is the class toggle (`is-in` / `is-open`). `mounted` is whether
 * to render at all. Drawers that keep a handle pass `stayMounted`.
 */
export function usePresence(
  open: boolean,
  options: { stayMounted?: boolean } = {},
) {
  const stayMounted = options.stayMounted === true;
  const [mounted, setMounted] = useState(() => open || stayMounted);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      if (prefersReducedMotion()) {
        setShown(true);
        return;
      }
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }

    setShown(false);
    if (stayMounted) return;
    if (prefersReducedMotion()) {
      setMounted(false);
      return;
    }
    const timer = window.setTimeout(
      () => setMounted(false),
      SPINE.absorb.durationMs + 16,
    );
    return () => window.clearTimeout(timer);
  }, [open, stayMounted]);

  return { mounted: stayMounted || mounted, shown };
}

/** Hold the last non-null value while `alive` (a presence `mounted`) is true. */
export function useHeld<T>(
  value: T | null | undefined,
  alive: boolean,
): T | null {
  const held = useRef<T | null>(value ?? null);
  if (value != null) held.current = value;
  if (!alive) return null;
  return value ?? held.current;
}

/**
 * Start shown, then absorb. Swap uses this so the previous subject has a
 * leave to run instead of unmounting on the same frame the new one arrives.
 *
 * `mounted` is settled during **render**, not in the mount effect, and that
 * is the whole of it. `Swap` clears its own `leaving` in an effect that reads
 * this value, and effects within a component run in hook order: an effect here
 * that only queued `setMounted(true)` was still reporting `false` when Swap's
 * cleanup ran in the same commit, so the outgoing copy was discarded before it
 * had ever been rendered. Every swap in the product was silently a plain emit.
 */
export function useOutgoing(token: string | null) {
  const [live, setLive] = useState<{ token: string | null; mounted: boolean }>(
    () => ({ token, mounted: Boolean(token) }),
  );
  const [shown, setShown] = useState(true);
  // A render-phase update, so the new token is already mounted on this pass.
  if (live.token !== token) setLive({ token, mounted: Boolean(token) });

  useEffect(() => {
    setShown(true);
    if (!token) return;
    if (prefersReducedMotion()) {
      setLive({ token, mounted: false });
      return;
    }
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setShown(false));
    });
    const timer = window.setTimeout(
      () =>
        setLive((current) =>
          current.token === token ? { token, mounted: false } : current,
        ),
      SPINE.absorb.durationMs + 16,
    );
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      window.clearTimeout(timer);
    };
  }, [token]);

  return { mounted: live.mounted, shown };
}

/**
 * Which items appeared since the last render, for the length of one `emit`.
 *
 * A verdict is appended to a record that is already on screen, and the map
 * says `emit` **on the new row only** — the rows above it did not arrive, and
 * animating them would restate history every time someone decides something.
 * The set empties itself once the arrival is over, so a re-render for an
 * unrelated reason does not replay it.
 */
export function useArrivals<T>(
  items: readonly T[],
  idOf: (item: T, index: number) => string,
): ReadonlySet<string> {
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const ids = items.map(idOf);
    // The first list is not an arrival — it was already there when you looked.
    if (known.current === null) {
      known.current = new Set(ids);
      return;
    }
    const seen = known.current;
    const added = ids.filter((id) => !seen.has(id));
    known.current = new Set(ids);
    if (!added.length) return;
    setFresh(new Set(added));
    const timer = window.setTimeout(
      () => setFresh(new Set()),
      SPINE.emit.durationMs + 16,
    );
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  return fresh;
}

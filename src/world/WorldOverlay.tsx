/**
 * A panel docked to an edge of the map, with a handle that never leaves.
 *
 * The map is the product, so every panel over it is borrowed space and has to
 * be returnable. Two ways to do that were on the table:
 *
 *   Vanish entirely, and come back by keyboard. Cheapest to draw, and wrong for
 *   the same reason a hidden menu is wrong — the operator has to already know
 *   the panel exists, and on a touch screen there is no keyboard to know it
 *   with. A closed panel would be indistinguishable from a product that never
 *   had one.
 *
 *   Keep the handle. The panel slides out; its handle stands just clear of the
 *   edge and stays. Costs about 34px of one margin and nothing else, and the
 *   affordance is literally attached to the thing it opens, so it reads as a
 *   drawer rather than as a button that happens to summon a drawer.
 *
 * The handle is the full height of the panel's edge for the same reason: it is
 * a target you can hit without aiming, which is what a touch screen needs and
 * what a trackpad quietly benefits from. It is also the panel's title, so a
 * closed panel still says what it is.
 *
 * ---------------------------------------------------------------------------
 *
 * **This is the only dock.** It did not used to be. The library was an
 * `OverlayPanel`, the node reader was a hand-rolled `<aside>` with its own
 * geometry, its own resize handle and its own close button, and Ask was a third
 * thing again — three components answering the same questions three ways, and
 * disagreeing. The reader's `top: var(--dock-top)` was measured from
 * `.gm__stage`, which already begins below the shell band, so it counted the
 * band twice and the panel visibly failed to reach the top of the window. That
 * was not a number to tune: it was two components disagreeing about what they
 * were positioned against.
 *
 * So `resizable` and `flush` live here rather than in whatever docks next:
 *
 *   `resizable`  the map-facing edge becomes a drag separator. Width is written
 *                straight to the CSS custom property during the drag and only
 *                committed to React state on release, so a resize does not
 *                re-render the canvas sixty times a second.
 *
 *   `flush`      the body stops padding and stacking its children and lets one
 *                child own the full box. A reader with a pinned header, a
 *                scrolling middle and a pinned footer needs the panel to get
 *                out of the way; a list of links wants the padding. Both are
 *                real, so it is a declared mode rather than a fight.
 */

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { presenceLeaveMs, usePresence } from "../styles/usePresence";
import "./WorldOverlay.css";

export type OverlaySide = "left" | "right";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function OverlayPanel({
  id,
  side = "left",
  title,
  open,
  onToggle,
  note = "",
  handle = true,
  handleWhen = "always",
  dismissOnOutsideClick = false,
  width,
  onWidthChange,
  minWidth = 300,
  maxWidth = 720,
  flush = false,
  surface,
  reserve = 0,
  children,
}: {
  id: string;
  side?: OverlaySide;
  title: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  /** Optional short state the handle should carry while closed — a count, a status. */
  note?: string;
  /**
   * Whether this dock keeps a handle.
   *
   * A handle earns its place when the panel is a *place* you go back to — the
   * library is always there and always says "Graphs", so a tab is how you find
   * it. It does not earn its place when the panel is about one subject you
   * already picked: a tab on the node reader would only repeat the title at
   * the top of the column. Closed by closing it; reopened by picking a node.
   */
  handle?: boolean;
  /**
   * When the handle is drawn.
   *
   * `always` is the library: the tab stays on the map-facing edge while the
   * drawer is open, because the drawer is a place you leave and come back to
   * and the tab is how you find it. `closed` is a drawer whose open state is
   * the panel itself — the tab would only repeat the close control already in
   * the body — so it stands on the edge only while the body is off-screen.
   */
  handleWhen?: "always" | "closed";
  /**
   * Whether clicking the map closes this panel.
   *
   * Right for a picker: you came to choose one thing, and clicking away means
   * you are done. Wrong for anything you read *against* the map — the Ask
   * transcript names nodes, and clicking one of them is following the answer,
   * not dismissing it. A panel that closes when you act on what it just told
   * you is a panel that punishes reading it.
   */
  dismissOnOutsideClick?: boolean;
  /** Present makes the map-facing edge a drag separator. */
  width?: number;
  onWidthChange?: (width: number) => void;
  minWidth?: number;
  maxWidth?: number;
  /** Let one child own the whole body box — no padding, no stacking. */
  flush?: boolean;
  /** Paper independently of flush layout; defaults preserve existing docks. */
  surface?: "panel" | "canvas";
  /**
   * Width already claimed by a sibling dock on the opposite edge.
   *
   * The panel is over the map, not in a column, so two open drawers will
   * overlap unless each treats the other as already spent. Written to
   * `--ov-reserve` so the CSS width and the drag ceiling share one number.
   */
  reserve?: number;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState({ size: width ?? 420, max: maxWidth });
  const resizable = typeof width === "number" && Boolean(onWidthChange);

  /**
   * A panel that mounts already-open has nothing to animate *from*.
   *
   * Presence parks one frame, then releases. The library stays mounted for the
   * life of the page (`stayMounted`); the reader is unmounted by the parent
   * after absorb. Same class toggle either way.
   */
  const { shown } = usePresence(open, { stayMounted: true });
  /**
   * A closed-only handle belongs to the settled closed drawer, not to the
   * click that started closing it. Keep its width at zero through absorption
   * and reveal it only once the body has reached the edge.
   */
  const [closedHandleReady, setClosedHandleReady] = useState(() => !open);
  useEffect(() => {
    if (handleWhen !== "closed") return;
    if (open) {
      setClosedHandleReady(false);
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setClosedHandleReady(true);
      return;
    }
    const timer = window.setTimeout(
      () => setClosedHandleReady(true),
      presenceLeaveMs(),
    );
    return () => window.clearTimeout(timer);
  }, [handleWhen, open]);

  useEffect(() => {
    if (!open || !dismissOnOutsideClick) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const target = event.target;
      if (target instanceof Node && root.contains(target)) return;
      onToggle(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [dismissOnOutsideClick, open, onToggle]);

  /** The widest this panel may get and still leave the map worth looking at. */
  const maxForViewport = useCallback(() => {
    const available = rootRef.current?.parentElement?.clientWidth ?? 0;
    const claimed = Math.max(0, reserve);
    const style = rootRef.current ? getComputedStyle(rootRef.current) : null;
    const handleSpace = Number.parseFloat(style?.getPropertyValue('--ov-handle') ?? '') || 0;
    const floatSpace = Number.parseFloat(style?.getPropertyValue('--ov-float') ?? '') || 0;
    const margin = window.matchMedia('(max-width: 560px)').matches
      ? 0 : 3 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    // The CSS cap can be below the usual minimum when both docks share a
    // narrow viewport. Report and operate on that real range, not a hidden
    // preferred width that makes the first key/drag appear to do nothing.
    const cssMax = available ? Math.max(0, available - claimed - handleSpace - floatSpace - margin) : maxWidth;
    return Math.min(cssMax, Math.max(minWidth, Math.min(maxWidth, available ? available - 160 - claimed : maxWidth)));
  }, [maxWidth, minWidth, reserve]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const body = root?.querySelector<HTMLElement>('.ov__body');
    if (!root || !body) return;
    const measure = () => {
      if (document.documentElement.classList.contains('is-panel-resizing')) return;
      const next = { size: Math.round(body.getBoundingClientRect().width), max: Math.round(maxForViewport()) };
      setMeasured((current) => current.size === next.size && current.max === next.max ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    if (root.parentElement) observer.observe(root.parentElement);
    return () => observer.disconnect();
  }, [maxForViewport, width, open]);

  const minimum = () => Math.min(minWidth, maxForViewport());
  const currentWidth = () => rootRef.current?.querySelector('.ov__body')?.getBoundingClientRect().width ?? width ?? 0;
  // A temporary viewport cap may be below the preferred minimum. Never save
  // that emergency width as the person's desktop preference.
  const commitWidth = (value: number) => onWidthChange?.(Math.max(minWidth, value));

  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const handle = event.currentTarget;
    handle.dataset.startX = String(event.clientX);
    handle.dataset.startWidth = String(currentWidth());
    handle.dataset.currentWidth = String(currentWidth());
    handle.setPointerCapture(event.pointerId);
    document.documentElement.classList.add("is-panel-resizing");
    event.preventDefault();
    event.stopPropagation();
  };

  const onResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget;
    if (!handle.hasPointerCapture(event.pointerId)) return;
    const startX = Number(handle.dataset.startX ?? event.clientX);
    const startWidth = Number(handle.dataset.startWidth ?? width ?? 0);
    // The separator is always on the map-facing edge, so which direction
    // widens depends on which edge the panel is docked to.
    const delta =
      side === "right" ? startX - event.clientX : event.clientX - startX;
    const next = clamp(startWidth + delta, minimum(), maxForViewport());
    handle.dataset.currentWidth = String(next);
    handle.setAttribute('aria-valuenow', String(next));
    // Straight to the property the width is derived from. Routing this through
    // React would re-render the canvas on every pointer frame.
    rootRef.current?.style.setProperty("--ov-preferred-width", `${next}px`);
    // The identity and instrument bars are parked in the canvas remainder.
    // Write the dock they are inset from on the same frame, or they lag the
    // drawer by a React commit.
    const shell = rootRef.current?.closest(".product-shell");
    if (shell instanceof HTMLElement) {
      shell.style.setProperty(
        side === "right" ? "--chrome-dock-right" : "--chrome-dock-left",
        `${next}px`,
      );
    }
  };

  const onResizePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget;
    if (handle.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
    document.documentElement.classList.remove("is-panel-resizing");
    const current = Number(handle.dataset.currentWidth ?? width ?? 0);
    if (Number.isFinite(current) && current > 0) commitWidth(current);
  };

  return (
    <div
      ref={rootRef}
      className={`ov ov--${side}${shown ? " is-open" : ""}${
        handle ? "" : " ov--handleless"
      }${handle && handleWhen === "closed" ? " ov--handle-closed" : ""}`}
      data-handle-ready={
        handleWhen !== "closed" || (!open && closedHandleReady) ? true : undefined
      }
      data-overlay={id}
      style={
        {
          ...(resizable ? { "--ov-preferred-width": `${width}px` } : {}),
          ...(resizable ? { "--ov-size-limit": `${measured.max}px` } : {}),
          "--ov-reserve": `${Math.max(0, reserve)}px`,
        } as CSSProperties
      }
    >
      {/* The handle is chrome: a control you act *with*, not the thing you came
          to read. So it recedes with the rest of the chrome and the hide key
          takes it too — the body it opens is a layer and stays. */}
      {handle ? (
        <button
          type="button"
          className="chrome ov__handle"
          aria-expanded={open}
          aria-controls={id}
          aria-hidden={
            handleWhen === "closed" && (open || !closedHandleReady)
              ? true
              : undefined
          }
          tabIndex={
            handleWhen === "closed" && (open || !closedHandleReady)
              ? -1
              : undefined
          }
          onClick={() => onToggle(!open)}
          title={open ? `Hide ${title}` : `Show ${title}`}
        >
          <span className="ov__handle-text">
            <span className="ov__handle-label">{title}</span>
            {note ? <em>{note}</em> : null}
          </span>
        </button>
      ) : null}
      <section
        id={id}
        className={`ov__body${flush ? " ov__body--flush" : ""}${surface ? ` ov__body--${surface}` : ""}`}
        aria-label={title}
        aria-hidden={!open}
        // Not merely invisible: a closed drawer must not be tab-reachable, or
        // keyboard focus disappears into a panel nobody can see.
        inert={!open ? true : undefined}
      >
        {resizable && open ? (
          <div
            className="ov__resize"
            role="separator"
            aria-orientation="vertical"
            aria-label={`Resize ${title}`}
            aria-controls={id}
            aria-valuemin={Math.min(minWidth, measured.max)}
            aria-valuemax={measured.max}
            aria-valuenow={measured.size}
            tabIndex={0}
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            onPointerCancel={onResizePointerUp}
            onLostPointerCapture={() =>
              document.documentElement.classList.remove("is-panel-resizing")
            }
            onDoubleClick={() =>
              commitWidth(clamp(420, minimum(), maxForViewport()))
            }
            onKeyDown={(event) => {
              const step = event.shiftKey ? 48 : 16;
              const grow = side === "right" ? "ArrowLeft" : "ArrowRight";
              const shrink = side === "right" ? "ArrowRight" : "ArrowLeft";
              let next = currentWidth();
              if (event.key === grow) next += step;
              else if (event.key === shrink) next -= step;
              else if (event.key === "Home") next = maxForViewport();
              else if (event.key === "End") next = minimum();
              else return;
              event.preventDefault();
              commitWidth(clamp(next, minimum(), maxForViewport()));
            }}
          />
        ) : null}
        {children}
      </section>
    </div>
  );
}

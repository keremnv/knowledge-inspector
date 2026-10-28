/**
 * When to apply a host size to the renderer.
 *
 * `live` is an ordinary reflow (window, reader overlay). `release` is the end
 * of a panel drag: the CSS grid has been following the pointer, and this is
 * the one moment the graph is allowed to redraw.
 */
export type HostSizeCause = "live" | "release";

/**
 * Hold the renderer still while a panel is being dragged.
 *
 * `html.is-panel-resizing` is set for the gesture. The CSS grid still
 * reflows every move — identity, instrument, and the rail must follow the
 * hand — but G6 `resize` is a redraw, and doing that sixty times a second
 * is both expensive and the source of the jitter. Size is recorded, and
 * applied once the class comes off.
 */
export function observeHostSize(
  host: HTMLElement,
  apply: (width: number, height: number, cause: HostSizeCause) => void,
): () => void {
  let pending: { width: number; height: number } | null = null;
  let last = { width: 0, height: 0 };
  let frame = 0;
  let held = false;

  const resizing = () =>
    document.documentElement.classList.contains("is-panel-resizing");

  const run = (cause: HostSizeCause) => {
    const next = pending;
    pending = null;
    if (!next || !next.width || !next.height) return;
    if (
      cause === "live" &&
      next.width === last.width &&
      next.height === last.height
    ) {
      return;
    }
    last = next;
    apply(next.width, next.height, cause);
  };

  const flush = (cause: HostSizeCause) => {
    if (cause === "release") {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      run(cause);
      return;
    }
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      run("live");
    });
  };

  const observer = new ResizeObserver(() => {
    if (!host.clientWidth || !host.clientHeight) return;
    pending = { width: host.clientWidth, height: host.clientHeight };
    if (resizing()) {
      held = true;
      return;
    }
    flush("live");
  });
  observer.observe(host);

  const classes = new MutationObserver(() => {
    if (resizing()) {
      return;
    }
    // A panel laid over the canvas does not change the host. Merely seeing the
    // resize class used to manufacture a resize on pointer-up, so every drawer
    // drag redrew an otherwise untouched bitmap. Only flush when ResizeObserver
    // actually recorded a host-size change during the gesture.
    if (!held) return;
    held = false;
    if (!pending) return;
    flush("release");
  });
  classes.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });

  return () => {
    if (frame) cancelAnimationFrame(frame);
    observer.disconnect();
    classes.disconnect();
  };
}

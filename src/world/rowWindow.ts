/**
 * The windowing arithmetic, once.
 *
 * Two surfaces draw long lists of rows — a relation's extension and the
 * unresolved frontier — and both do it the same way: a scroller whose spacer is
 * the full height of the list, rows positioned absolutely against it, and only
 * the ones the viewport stands on in the DOM. What differs between them is
 * where the rows come from, which is the interesting part; the index
 * arithmetic is not, and two copies of it would drift the moment one of them
 * grew a bug.
 *
 * The height is observed rather than assumed, because the drawer is sized as a
 * fraction of a stage that changes when the panel or the window does. A window
 * computed against a stale height is a window that stops short of the rows a
 * person is looking at.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

export function useRowWindow(total: number, rowHeight: number, overscan = 8) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(320);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    setHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(total, Math.ceil((scrollTop + height) / rowHeight) + overscan);
  const scrollable = total * rowHeight > height;
  const indices: number[] = [];
  for (let index = first; index < last; index += 1) indices.push(index);

  const onScroll = useCallback(
    (event: { currentTarget: HTMLDivElement }) => setScrollTop(event.currentTarget.scrollTop),
    [],
  );

  // Native scrolling can remove the focused row from the virtual window.
  // Keep focus on its named scroller while the browser pages/scrolls, then
  // Tab can enter the newly visible rows. No custom row-navigation model.
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (scrollable && ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) {
      event.currentTarget.focus({ preventScroll: true });
    }
  }, [scrollable]);

  /** Back to the top — for when the list becomes a list of something else. */
  const reset = useCallback(() => {
    if (ref.current) ref.current.scrollTop = 0;
    setScrollTop(0);
  }, []);

  return { ref, onScroll, onKeyDown, scrollable, first, last, indices, reset };
}

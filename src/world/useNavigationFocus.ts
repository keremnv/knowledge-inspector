import { useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent } from "react";

type Subjects = { reader: string; table: string; readerOpen: boolean; tablesOpen: boolean };

const WORLD_TARGETS = {
  readerPanel: 'world-reader',
  tablePanel: 'world-tables',
  reader: '#world-reader .motion-swap__is [data-focus-subject]',
  table: '#world-tables .motion-swap__is [data-focus-subject], #world-tables .motion-swap__is .table__subjects button',
  readerReturn: '.nodefind__input',
  tableReturn: '[data-overlay="world-tables"] > .ov__handle',
  fallback: '.nodefind__input, .instrument__group[aria-label="Clear focus"] button, .instrument__group[aria-label="Field"] button',
};

const unavailable = (element: HTMLElement) => !element.isConnected || element.matches(':disabled') ||
  !!element.closest('[hidden], [inert]') || !element.getClientRects().length || getComputedStyle(element).visibility === 'hidden';

/** Follow explicit keyboard travel, never a camera move or a passive fetch.
 * Keep the origin through asynchronous navigation; another key or pointer
 * gesture cancels it. Incoming panels may still be emitting, so focus only
 * once their subject is actually visible. No transition duration is copied.
 */
export function useNavigationFocus(subjects: Subjects, targets = WORLD_TARGETS) {
  const root = useRef<HTMLElement | null>(null);
  const previous = useRef(subjects);
  const origin = useRef<HTMLElement | null>(null);
  const originPanel = useRef<string | null>(null);
  const focused = useRef<{ element: HTMLElement; panel: string | null } | null>(null);
  const frame = useRef(0);

  const cancel = () => {
    origin.current = null;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
  };
  const onKeyDownCapture = (event: KeyboardEvent<HTMLElement>) => {
    cancel();
    if (["Enter", " ", "Escape", "Delete", "Backspace"].includes(event.key)) {
      origin.current = event.target as HTMLElement;
      originPanel.current = origin.current.closest('.ov__body')?.id ?? null;
    }
  };
  const onFocusCapture = (event: FocusEvent<HTMLElement>) => {
    const element = event.target as HTMLElement;
    focused.current = element.matches(':focus-visible')
      ? { element, panel: element.closest('.ov__body')?.id ?? null }
      : null;
  };

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = subjects;
    // Tab may move within a subject whose asynchronous replacement is still
    // pending. If that newer focus is removed or hidden, recover it too. A Tab
    // into another panel updates this record and keeps its destination.
    const last = focused.current;
    if (!origin.current && last?.panel && unavailable(last.element)) {
      origin.current = last.element;
      originPanel.current = last.panel;
    }
    const source = origin.current;
    if (!source) return;
    let selector: string | undefined;
    if (subjects.readerOpen && (before.reader !== subjects.reader || !before.readerOpen)) {
      selector = targets.reader;
    } else if (before.table !== subjects.table || (!before.tablesOpen && subjects.tablesOpen)) {
      selector = targets.table;
    } else if (before.readerOpen && !subjects.readerOpen && originPanel.current === targets.readerPanel) {
      selector = targets.readerReturn;
    } else if (before.tablesOpen && !subjects.tablesOpen && originPanel.current === targets.tablePanel) {
      selector = targets.tableReturn;
    } else if (unavailable(source) && !frame.current) {
      // Keep an explicit trip's pending destination when its origin becomes
      // hidden (for example, Tables yielding the compact dock to the Reader).
      selector = originPanel.current === targets.readerPanel && subjects.readerOpen
        ? targets.reader
        : originPanel.current === targets.tablePanel && subjects.tablesOpen
          ? targets.table
          : targets.fallback;
    }
    if (!selector) return;
    cancelAnimationFrame(frame.current);
    const destination = selector;
    const follow = () => {
      frame.current = 0;
      if (origin.current !== source) return;
      // Someone has already moved elsewhere while an async read was pending.
      if (document.activeElement !== source && document.activeElement !== document.body) {
        origin.current = null;
        return;
      }
      const candidates = root.current?.querySelectorAll<HTMLElement>(destination) ?? [];
      const visible = (target: HTMLElement) => {
        const box = target.getBoundingClientRect();
        if (!box.width || !box.height || box.right <= 0 || box.left >= innerWidth) return false;
        for (let item: HTMLElement | null = target; item; item = item.parentElement) {
          const style = getComputedStyle(item);
          if (style.visibility === 'hidden' || Number(style.opacity) === 0 || item.inert) return false;
        }
        return true;
      };
      // Prefer the named subject over the fallback world button. The Finder
      // is intentionally hidden in fielded vocabulary: use its return control.
      const available = Array.from(candidates).filter(visible);
      const target = available.find((item) => item.hasAttribute('data-focus-subject')) ?? available[0];
      if (!target) {
        frame.current = requestAnimationFrame(follow);
        return;
      }
      target.focus({ preventScroll: true });
      origin.current = null;
    };
    frame.current = requestAnimationFrame(follow);
  });

  useLayoutEffect(() => () => cancelAnimationFrame(frame.current), []);
  return { ref: root, onKeyDownCapture, onFocusCapture, onPointerDownCapture: () => { cancel(); focused.current = null; } };
}

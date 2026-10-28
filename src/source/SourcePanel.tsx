import { useCallback, useLayoutEffect, useRef, type ReactNode, type UIEvent } from "react";
import { ReaderContent, ReaderHeader } from "../world/ReaderChrome";

const RESTORED_DETAILS = "details:not([data-own-state])";

export type SourceScrollPosition = { top: number; left: number; openDetails?: number[] };

/** Retained presentation copies keep the viewport that was being read. This
 * state is local to a subject and never authorizes a source read or identity. */
export function useSourceScroll(position: SourceScrollPosition, ready = true) {
  const host = useRef<HTMLDivElement | null>(null);
  const pending = useRef(true);
  const ref = useCallback((element: HTMLDivElement | null) => {
    host.current = element;
    if (element) pending.current = true;
  }, [position]);
  // A disclosure that keeps its own state across records (`data-own-state`,
  // the references, O14.2) is not this position's to save or put back.
  // Back may mount a loading panel before its native disclosures exist. Wait
  // for complete content and restore once, before paint. Later content must
  // leave native scroll anchoring in charge of the evidence being read.
  useLayoutEffect(() => {
    if (!ready || !pending.current || !host.current) return;
    pending.current = false;
    const element = host.current;
    element.querySelectorAll<HTMLDetailsElement>(RESTORED_DETAILS).forEach((details, index) => {
      details.open = position.openDetails?.includes(index) ?? false;
    });
    element.scrollTop = position.top; element.scrollLeft = position.left;
  }, [ready, position]);
  // Interaction with partial content supersedes a pending navigation restore.
  // Loading/layout scroll events alone must not overwrite the saved position.
  const beginReading = useCallback(() => {
    pending.current = false;
    const element = host.current;
    if (!element) return;
    position.top = element.scrollTop; position.left = element.scrollLeft;
    position.openDetails = Array.from(element.querySelectorAll<HTMLDetailsElement>(RESTORED_DETAILS))
      .flatMap((details, index) => details.open ? [index] : []);
  }, [position]);
  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    if (pending.current) return;
    position.top = event.currentTarget.scrollTop;
    position.left = event.currentTarget.scrollLeft;
  }, [position]);
  const onToggleCapture = useCallback((event: UIEvent<HTMLDivElement>) => {
    if (pending.current) return;
    position.openDetails = Array.from(event.currentTarget.querySelectorAll<HTMLDetailsElement>(RESTORED_DETAILS))
      .flatMap((details, index) => details.open ? [index] : []);
  }, [position]);
  return { ref, onScroll, onToggleCapture, onWheelCapture: beginReading, onPointerDownCapture: beginReading,
    onTouchStartCapture: beginReading, onKeyDownCapture: beginReading };
}

export function SourceReaderPanel({ title, caption, onClose, onBack, scroll, ready = true, children, actions }: {
  title: string;
  caption?: string;
  onClose: () => void;
  onBack?: () => void;
  scroll: SourceScrollPosition;
  ready?: boolean;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const viewport = useSourceScroll(scroll, ready);
  return <div className="node-reader">
    <ReaderHeader title={title} subjectLabel={caption ? `${title}, ${caption}` : undefined} meta={caption} onBack={onBack} onClose={onClose} />
    <ReaderContent className="source-reader-body" {...viewport}>{children}</ReaderContent>
    {actions}
  </div>;
}

/** The canonical Reader anatomy, independent of the subject read contract. */
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, Ref } from "react";
import { PanelBack, PanelClose } from "./panelChrome";

export function ReaderHeader({
  title,
  subjectLabel,
  kind,
  stance,
  meta,
  onClose,
  onBack,
  children,
}: {
  title: string;
  /** Exact identity announced with the name when metadata is visually clipped. */
  subjectLabel?: string;
  kind?: string;
  /**
   * The recorded state, beside — never merged into — the origin chip.
   * Absent everywhere except the assertion reader, and for legacy
   * assertions that record no state.
   */
  stance?: { label: string; title: string; state: string } | null;
  meta?: string;
  onClose?: () => void;
  /** Null while there is nowhere back to go — the chip is the offer. */
  onBack?: (() => void) | null;
  /**
   * What this subject *is*, carried above the rule with its name.
   *
   * The rule across a reader separates identity from what you can do next. A
   * referent's own fields are identity — `tool_identity_remap L1` is part of
   * answering "which tool is this", not an action — so below the rule they
   * left the panel's one navigable thing, Expand through, sitting under a
   * paragraph of facts and a gap that read as a mistake whenever there were
   * no facts to print.
   */
  children?: ReactNode;
}) {
  return (
    <div className="world-reader__brow">
    <header className="world-reader__header">
      <div className="world-reader__heading">
        {/*
          * The type sits beside the name because it qualifies it — `checkout`
          * *referent*, `checkout_record` *demanded tuple*. Held out at the far
          * edge it read as a second control next to `close`, and it lined up
          * with neither the name nor the panel's own right edge.
          */}
        <div className="world-reader__title">
          {/*
            * The row cuts all three — name, type, id — so all three repeat on
            * hover. A stubbed id with no way to read it is a label, not an
            * identity.
            */}
          <h2 title={title} aria-label={subjectLabel} tabIndex={-1} data-focus-subject>{title}</h2>
          {kind ? (
            <span className="node-reader__kind" title={kind}>
              {kind}
            </span>
          ) : null}
          {stance ? (
            <span
              className="node-reader__kind"
              data-occurrence-state={stance.state}
              title={stance.title}
            >
              {stance.label}
            </span>
          ) : null}
        </div>
        {meta ? <p title={meta}>{meta}</p> : null}
      </div>
      {onBack ? <PanelBack onBack={onBack} /> : null}
      {onClose ? <PanelClose onClose={onClose} /> : null}
    </header>
      {children}
    </div>
  );
}

export function ReaderContent({ className = "", ...props }: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }) {
  return <div className={`world-reader__content ${className}`} {...props} />;
}

export function ReaderActions({ children, ...props }: HTMLAttributes<HTMLElement>) {
  return <footer className="world-reader__actions" {...props}>{children}</footer>;
}

export function ReaderAction({ className = "", bleed = false, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { bleed?: boolean }) {
  return <button type="button" className={`node-reader__link${bleed ? " node-reader__link--bleed" : ""} ${className}`} {...props} />;
}

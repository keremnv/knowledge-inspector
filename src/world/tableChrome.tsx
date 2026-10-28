/**
 * The TABLES dock's subject chrome.
 *
 * World, the legacy Purpose frontier, and governed Obligations are subjects in
 * one panel, not parallel applications. The handle still says Tables; these
 * buttons say which read contract is open. A relation or derivation is a
 * subject you navigated to — named in the bar, not a third tab.
 */

import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, Ref } from "react";
import { PanelClose } from "./panelChrome";

export type TableSubject = "world" | "frontier" | "governed" | "other";

export type TableChrome = {
  current: TableSubject;
  hasFrontier: boolean;
  hasGovernedObligations: boolean;
  onWorld: () => void;
  onFrontier: () => void;
  onGoverned: () => void;
  onClose: () => void;
};

export function TableBar({
  chrome,
  title,
  meta,
  children,
}: {
  chrome: TableChrome;
  title?: string;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return <TableHeader title={title} meta={meta} onClose={chrome.onClose} actions={children} subjects={
      <nav className="table__subjects" aria-label="Table subject">
        <button
          type="button"
          aria-pressed={chrome.current === "world"}
          onClick={chrome.onWorld}
        >
          world
        </button>
        {chrome.hasFrontier ? (
          <button
            type="button"
            aria-pressed={chrome.current === "frontier"}
            onClick={chrome.onFrontier}
          >
            {/*
              * This is the compatibility surface for Purpose demand. It is
              * named explicitly so it cannot be confused with the governed
              * Obligation collection beside it.
              */}
            purpose frontier
          </button>
        ) : null}
        {chrome.hasGovernedObligations ? (
          <button
            type="button"
            aria-pressed={chrome.current === "governed"}
            onClick={chrome.onGoverned}
          >
            obligations
          </button>
        ) : null}
      </nav>
    } />;
}

export function TableHeader({ title, meta, subjects, actions, onClose, heading = false, className = "" }: {
  title?: string; meta?: ReactNode; subjects?: ReactNode; actions?: ReactNode;
  onClose: () => void; heading?: boolean; className?: string;
}) {
  return <header className={`table__bar ${className}`}>
    {subjects}
    {title || meta ? <div className="table__said">
      {title && (heading ? <h2 tabIndex={-1} data-focus-subject title={title}>{title}</h2> : <b tabIndex={-1} data-focus-subject>{title}</b>)}
      {meta ? <span className="table__meta">{meta}</span> : null}
    </div> : null}
    <div className="table__actions">{actions}<PanelClose onClose={onClose} /></div>
  </header>;
}

/** The existing table-bar chip, for small actions outside the bar as well. */
export function TableAction({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`table__action ${className}`} {...props} />;
}

export function TableFooter({ children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className="table__foot" {...props}>{children}</div>;
}

/** Search is local to the table subject, independent of the global finder. */
export function TableSearch({ value, onChange, label, placeholder = label, inputRef, onClear = () => onChange(""), clearLabel = "clear search", clearable = Boolean(value), maxLength, children }: {
  value: string; onChange: (value: string) => void; label: string; placeholder?: string;
  maxLength?: number; inputRef?: Ref<HTMLInputElement>; onClear?: () => void; clearLabel?: string; clearable?: boolean;
  /** Deliberately submitted retrieval can supply its own action; World remains live. */
  children?: ReactNode;
}) {
  return <div className="table__search">
    <input ref={inputRef} maxLength={maxLength} type="search" aria-label={label} placeholder={placeholder} value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && clearable) {
          event.stopPropagation();
          onClear();
        }
      }} />
    {children}
    {clearable ? <button type="button" onClick={onClear}>{clearLabel}</button> : null}
  </div>;
}

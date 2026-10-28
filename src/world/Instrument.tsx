import type { ReactNode } from "react";
import { chromeClass } from "./worldOverlayChrome";

/** One shell instrument slot and recession behavior; each context supplies verbs. */
export function Instrument({ children }: { children: ReactNode }) {
  return <div className="product-shell__instrument" aria-label="Surface controls">
    <div className={chromeClass("instrument")}>{children}</div>
  </div>;
}

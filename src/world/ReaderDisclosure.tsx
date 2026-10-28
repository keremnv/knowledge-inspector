import type { ComponentPropsWithoutRef, ReactNode } from "react";
import "./ReaderDisclosure.css";

/** The World's source-metadata treatment, with native disclosure behavior.
 * No local open state: Reader snapshots retain the actual details element. */
export function ReaderDisclosure({ label, className = "", children, ...props }:
  ComponentPropsWithoutRef<"details"> & { label: ReactNode }) {
  return <details className={`reader-disclosure ${className}`} {...props}>
    <summary>{label}</summary>
    {children}
  </details>;
}

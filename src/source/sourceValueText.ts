import type { SourceScalar } from "../api/source";

/** INTEGER never enters Number(). Quoted TEXT exposes empty/control characters;
 * REAL display is qualified separately from its binary64 identity. */
export function sourceValueText(value: SourceScalar): string {
  switch (value.storage_class) {
    case "null": return "NULL";
    case "integer": return value.exact;
    case "text": return JSON.stringify(value.exact);
    case "real": return value.display;
    case "blob": return `BLOB · ${value.bytes} bytes · preview only`;
  }
}


import type { SourceScalar } from "../api/source";

import { sourceValueText } from "./sourceValueText";
export { sourceValueText } from "./sourceValueText";

export function SourceValue({ value, detailed = false }: { value: SourceScalar; detailed?: boolean }) {
  return <span className={`source-value source-value--${value.storage_class}`}>
    <code>{sourceValueText(value)}</code>
    {!detailed && value.storage_class === "real" && !value.finite && <small>nonfinite REAL</small>}
    {detailed && <small>SQLite {value.storage_class.toUpperCase()}
      {value.storage_class === "real" && <> · display text; identity is binary64 bits <code>{value.ieee754_hex}</code>{!value.finite && " · nonfinite"}</>}
      {value.storage_class === "blob" && <> · not a complete recoverable value{value.sha256 ? <> · SHA-256 <code>{value.sha256}</code></> : " · digest not computed"}{value.reason && ` · ${value.reason}`}</>}
    </small>}
  </span>;
}

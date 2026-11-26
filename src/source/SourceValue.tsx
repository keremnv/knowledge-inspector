import { useState } from "react";
import type { SourceScalar } from "../api/source";

import { sourceValueText } from "./sourceValueText";
import { visibleRuns } from "./sourceVisibleText";
export { sourceValueText } from "./sourceValueText";

/** A long TEXT shows this many lines, and at most this many characters, in the Reader until "show all". */
export const SOURCE_TEXT_LINES = 12, SOURCE_TEXT_CHARS = 2000;

/** Characters as themselves; invisible ones as marked escapes. */
export function VisibleText({ text }: { text: string }) {
  return <>{visibleRuns(text).map((run, index) => run.escape
    ? <span key={index} className="source-text__escape" data-escape>{run.text}</span> : run.text)}</>;
}

/** Spaces at either end of a TEXT are shown as ␣ and marked, so "a" and "a " look different. */
function Edged({ text }: { text: string }) {
  const lead = text.length - text.trimStart().length, trail = text.length - text.trimEnd().length;
  const mark = (s: string) => Array.from(s, (ch, i) => ch === " "
    ? <span key={i} className="source-text__escape" data-edge>␣</span> : <VisibleText key={i} text={ch} />);
  if (lead === text.length) return <>{mark(text)}</>;
  return <>{mark(text.slice(0, lead))}<VisibleText text={text.slice(lead, text.length - trail)} />{mark(text.slice(text.length - trail))}</>;
}

/**
 * A TEXT shown as its characters, not as a quoted, escaped string. On a line
 * (table cells, reference values) a line break is a marked \n; in the Reader
 * (block) lines break as written, and a long TEXT is shortened until "show
 * all". The empty TEXT is marked "empty"; spaces at either end are marked.
 * The detailed form ("value details") shows the exact TEXT, quoted.
 */
function SourceText({ text, block }: { text: string; block: boolean }) {
  const [all, setAll] = useState(false);
  if (text === "") return <code className="source-text"><span className="source-text__escape" data-empty>empty</span></code>;
  if (!block) return <code className="source-text"><Edged text={text} /></code>;
  const lines = text.split("\n");
  const long = lines.length > SOURCE_TEXT_LINES || text.length > SOURCE_TEXT_CHARS;
  const shown = long && !all ? text.slice(0, SOURCE_TEXT_CHARS).split("\n").slice(0, SOURCE_TEXT_LINES) : lines;
  return <>
    <code className="source-text source-text--block" data-text-lines={lines.length}>
      {shown.map((line, i) => <span key={i} className="source-text__line">{lines.length === 1 ? <Edged text={line} /> : <VisibleText text={line} />}</span>)}
      {long && !all && <span className="source-text__escape" data-shortened>…</span>}
    </code>
    {long && <button type="button" className="source-text__more" aria-expanded={all} onClick={() => setAll(!all)}>
      {all ? "show less" : `show all · ${lines.length} ${lines.length === 1 ? "line" : "lines"}`}</button>}
  </>;
}

export function SourceValue({ value, detailed = false, block = false }: { value: SourceScalar; detailed?: boolean; block?: boolean }) {
  return <span className={`source-value source-value--${value.storage_class}`}>
    {value.storage_class === "text" && !detailed ? <SourceText text={value.exact} block={block} /> : <code>{sourceValueText(value)}</code>}
    {!detailed && value.storage_class === "real" && !value.finite && <small>nonfinite REAL</small>}
    {detailed && <small>SQLite {value.storage_class.toUpperCase()}
      {value.storage_class === "real" && <> · display text; identity is binary64 bits <code>{value.ieee754_hex}</code>{!value.finite && " · nonfinite"}</>}
      {value.storage_class === "blob" && <> · not a complete recoverable value{value.sha256 ? <> · SHA-256 <code>{value.sha256}</code></> : " · digest not computed"}{value.reason && ` · ${value.reason}`}</>}
    </small>}
  </span>;
}

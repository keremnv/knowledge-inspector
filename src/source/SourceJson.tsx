import { useState } from "react";
import { sourceJsonSize, type SourceJsonNode } from "./sourceJsonReading";
import { visibleRuns } from "./sourceVisibleText";

/** Members or items shown at once in one container; the rest come on request. */
export const SOURCE_JSON_PAGE = 100;
/** Containers this deep and shallower start open. */
const OPEN_DEPTH = 2;

/** A string's characters as themselves, invisible ones as marked escapes. */
export function VisibleText({ text }: { text: string }) {
  return <>{visibleRuns(text).map((run, index) => run.escape
    ? <span key={index} className="source-text__escape" data-escape>{run.text}</span> : run.text)}</>;
}

/** Quote marks are faint decoration around a string's content, not escaping. */
const Quote = () => <span className="source-json__quote" aria-hidden="true">"</span>;

function Scalar({ node }: { node: Exclude<SourceJsonNode, { kind: "object" | "array" }> }) {
  if (node.kind === "string") return <span className="source-json__string"><Quote /><VisibleText text={node.value} /><Quote /></span>;
  if (node.kind === "number") return <span className="source-json__number">{node.lexeme}</span>;
  return <span className="source-json__literal">{node.lexeme}</span>;
}

function Branch({ node, depth, label }: { node: Extract<SourceJsonNode, { kind: "object" | "array" }>; depth: number; label?: string }) {
  const [open, setOpen] = useState(depth < OPEN_DEPTH);
  const [shown, setShown] = useState(SOURCE_JSON_PAGE);
  const entries = node.kind === "object" ? node.members : node.items.map((value, index) => ({ key: String(index), value, repeated: false }));
  const [start, end] = node.kind === "object" ? ["{", "}"] : ["[", "]"];
  if (!entries.length) return <span className="source-json__empty">{start}{end}</span>;
  return <span className="source-json__branch">
    <button type="button" className="source-json__toggle" aria-expanded={open}
      aria-label={`${label ? `${label}, ` : ""}${node.kind === "object" ? "object" : "array"}, ${sourceJsonSize(node)}, ${open ? "collapse" : "expand"}`}
      onClick={() => setOpen(!open)}>{start}{open ? "" : "…"}{open ? "" : end}<small>{sourceJsonSize(node)}</small></button>
    {open && <>
      <ul className="source-json__members" data-json-kind={node.kind}>{entries.slice(0, shown).map((entry, index) =>
        <li key={index}>
          <span className={node.kind === "object" ? "source-json__key" : "source-json__index"}>
            {node.kind === "object" ? (entry.key ? <VisibleText text={entry.key} /> : <><Quote /><Quote /></>) : entry.key}</span>
          {node.kind === "object" ? ": " : " "}
          <SourceJsonValue node={entry.value} depth={depth + 1} label={node.kind === "object" ? entry.key : `item ${entry.key}`} />
          {entry.repeated && <small className="source-json__repeated" data-json-repeated title="This key appears more than once in this object; each is shown as recorded.">repeated key</small>}
        </li>)}</ul>
      {entries.length > shown && <button type="button" className="source-json__more" onClick={() => setShown(shown + SOURCE_JSON_PAGE)}>
        show {Math.min(SOURCE_JSON_PAGE, entries.length - shown)} more of {entries.length - shown}</button>}
      <span className="source-json__close">{end}</span>
    </>}
  </span>;
}

export function SourceJsonValue({ node, depth = 0, label }: { node: SourceJsonNode; depth?: number; label?: string }) {
  return node.kind === "object" || node.kind === "array" ? <Branch node={node} depth={depth} label={label} /> : <Scalar node={node} />;
}

/** A TEXT value shown as its JSON reading. The exact TEXT stays under "value details". */
export function SourceJson({ node }: { node: SourceJsonNode }) {
  return <span className="source-value source-value--text source-json" data-json-view><SourceJsonValue node={node} /></span>;
}

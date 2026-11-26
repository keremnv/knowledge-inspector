import { parseTree, type Node, type ParseError } from "jsonc-parser";

/**
 * A TEXT value read as a JSON document, for display only. The recorded value
 * stays the TEXT itself (shown exactly under "value details"); this is a view
 * of it, never a replacement.
 *
 * Exactness, as for every Source value: a number is kept as its lexeme, sliced
 * from the TEXT, so 12345678901234567890 and 1.10 are shown as written and
 * never pass through Number(); object members stay in recorded order and a
 * repeated key is kept, and marked, rather than collapsed. Strings are shown
 * by their decoded value, quoted as Source TEXT is.
 *
 * Only an object or an array is read as JSON: a TEXT such as "5" or "true"
 * stays a TEXT. Anything that is not exactly one strict JSON document (a
 * comment, a trailing comma, trailing content, invalid syntax, nesting too
 * deep to read) is not JSON here, and the value is shown as TEXT.
 */
export type SourceJsonNode =
  | { kind: "object"; members: SourceJsonMember[] }
  | { kind: "array"; items: SourceJsonNode[] }
  | { kind: "string"; value: string }
  | { kind: "number"; lexeme: string }
  | { kind: "literal"; lexeme: "true" | "false" | "null" };
export type SourceJsonMember = { key: string; value: SourceJsonNode; repeated: boolean };

const STRICT = { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false };
/** Deeper nesting is shown as TEXT: a display, not a reason to exhaust the stack. */
export const SOURCE_JSON_MAX_DEPTH = 256;

function convert(text: string, node: Node, depth: number): SourceJsonNode | null {
  if (depth > SOURCE_JSON_MAX_DEPTH) return null;
  switch (node.type) {
    case "object": {
      const seen = new Set<string>(), members: SourceJsonMember[] = [];
      for (const property of node.children ?? []) {
        const [keyNode, valueNode] = property.children ?? [];
        if (!keyNode || !valueNode || typeof keyNode.value !== "string") return null;
        const value = convert(text, valueNode, depth + 1);
        if (!value) return null;
        members.push({ key: keyNode.value, value, repeated: seen.has(keyNode.value) });
        seen.add(keyNode.value);
      }
      return { kind: "object", members };
    }
    case "array": {
      const items: SourceJsonNode[] = [];
      for (const child of node.children ?? []) {
        const item = convert(text, child, depth + 1);
        if (!item) return null;
        items.push(item);
      }
      return { kind: "array", items };
    }
    case "string": return typeof node.value === "string" ? { kind: "string", value: node.value } : null;
    case "number": return { kind: "number", lexeme: text.slice(node.offset, node.offset + node.length) };
    case "boolean": return { kind: "literal", lexeme: node.value ? "true" : "false" };
    case "null": return { kind: "literal", lexeme: "null" };
    default: return null;
  }
}

/** The JSON reading of a TEXT, or null when it is not one strict JSON object or array. */
export function parseSourceJson(text: string): SourceJsonNode | null {
  const start = text.search(/\S/);
  if (start < 0 || (text[start] !== "{" && text[start] !== "[")) return null;
  try {
    const errors: ParseError[] = [];
    const root = parseTree(text, errors, STRICT);
    if (errors.length || !root) return null;
    return convert(text, root, 0);
  } catch {
    return null;                                        // e.g. nesting deep enough to overflow the parser's stack
  }
}

const cache = new Map<string, SourceJsonNode | null>();
/** parseSourceJson, remembering the last few TEXT values, so a Reader re-render does not re-read a large document. */
export function sourceJson(text: string): SourceJsonNode | null {
  if (cache.has(text)) return cache.get(text)!;
  const parsed = parseSourceJson(text);
  cache.set(text, parsed);
  if (cache.size > 16) cache.delete(cache.keys().next().value!);
  return parsed;
}

/** "3 keys", "1 item": the size of a container, as its collapsed line says it. */
export function sourceJsonSize(node: SourceJsonNode): string {
  if (node.kind === "object") return `${node.members.length} ${node.members.length === 1 ? "key" : "keys"}`;
  if (node.kind === "array") return `${node.items.length} ${node.items.length === 1 ? "item" : "items"}`;
  return "";
}

/**
 * The Source canvas, remembered on refresh: in this tab, for one
 * identical capture (owner decisions O8.8, O20, O21).
 * sessionStorage may survive browser session restoration. A new application
 * launch has a fresh namespace, so it never reopens this exploration. This
 * is ephemeral display state, not a saved project or secure deletion.
 *
 * Keyed by the source namespace and the capture's SHA-256, so a different
 * capture never sees another's canvas. What is kept is the arrangement and how
 * to find each record again (its handle, and its table and key for a new
 * generation of the same capture), never the evidence: every record and
 * connection is read and verified again before it stands. Display state only,
 * like World's field memory; it says nothing about the data.
 */
import type { SourceCell, SourceContext } from "../api/source";
import type { RememberedField, SourceField } from "./sourceField";

const PREFIX = "ki.source.field";

// Retire only known Source exploration keys at this origin, without importing
// their values. Other localhost ports are separate origins and are inaccessible.
let legacyCleaned = false;
function sourceSessionStorage(): Storage {
  if (!legacyCleaned) {
    try {
      const local = window.localStorage;
      for (const key of Object.keys(local)) {
        if (["ki.source.field:", "ki.source.naming:", "ki.source.show:"].some((prefix) => key.startsWith(prefix)) ||
            /^worldir\.camera:field:source:src1_[^:]+:[a-f0-9]{64}(?::schema)?:1$/.test(key)) {
          local.removeItem(key);
        }
      }
      legacyCleaned = true;
    } catch {
      // Storage may be blocked; session storage can still be tried independently.
    }
  }
  return window.sessionStorage;
}

export type StoredSourceField = RememberedField & {
  version: 1;
  namespace: string;
  digest: string;
  /** The generation the handles below were minted in. */
  generation: string;
  records: { elementId: string; recordId: string; table: string; key: SourceCell[] }[];
  references: { elementId: string; child: string; parent: string; declarationId: string }[];
};

/** The camera room for this capture, for the shared camera recorder (explicitly using sessionStorage). */
export function sourceCameraRoom(context: SourceContext): string {
  return `source:${context.source_namespace}:${context.capture_digest}`;
}

function keyOf(context: SourceContext): string {
  return `${PREFIX}:${context.source_namespace}:${context.capture_digest}`;
}

/** Put the canvas away; an empty canvas forgets what was kept. */
export function writeSourceField(context: SourceContext, field: SourceField): void {
  try {
    if (!field.records.length) { sourceSessionStorage().removeItem(keyOf(context)); return; }
    const stored: StoredSourceField = {
      version: 1, namespace: context.source_namespace, digest: context.capture_digest, generation: context.generation,
      sequence: field.sequence,
      records: field.records.map(({ elementId, recordId, table, key }) => ({ elementId, recordId, table, key })),
      references: field.references.map(({ elementId, child, parent, observation }) =>
        ({ elementId, child, parent, declarationId: observation.declaration.declaration_id })),
      positions: [...field.positions], depth: [...field.depth], expansions: [...field.expansions],
    };
    sourceSessionStorage().setItem(keyOf(context), JSON.stringify(stored));
  } catch {
    // Private mode or quota: the canvas lives in the tab only.
  }
}

/** Take the canvas kept for this capture back out, or nothing. */
export function readSourceField(context: SourceContext): StoredSourceField | null {
  try {
    const raw = sourceSessionStorage().getItem(keyOf(context));
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<StoredSourceField>;
    if (stored.version !== 1 || stored.namespace !== context.source_namespace || stored.digest !== context.capture_digest ||
        typeof stored.generation !== "string" || typeof stored.sequence !== "number" || !Array.isArray(stored.records) ||
        !Array.isArray(stored.references) || !Array.isArray(stored.positions) || !Array.isArray(stored.depth) ||
        !Array.isArray(stored.expansions)) return null;
    return stored as StoredSourceField;
  } catch {
    return null;
  }
}

/** Which column names each table's records (O17), as the person chose it, for this capture. */
export type SourceNaming = Readonly<Record<string, string>>;
export function readSourceNaming(context: SourceContext): SourceNaming {
  try {
    const stored = JSON.parse(sourceSessionStorage().getItem(`ki.source.naming:${context.source_namespace}:${context.capture_digest}`) ?? "null");
    return stored && typeof stored === "object" && !Array.isArray(stored) &&
      Object.values(stored).every((column) => typeof column === "string") ? stored : {};
  } catch {
    return {};
  }
}
export function writeSourceNaming(context: SourceContext, naming: SourceNaming): void {
  try {
    sourceSessionStorage().setItem(`ki.source.naming:${context.source_namespace}:${context.capture_digest}`, JSON.stringify(naming));
  } catch {
    // The choice lives in the tab only.
  }
}

/** The show filter kept for this capture (O8.10), as World keeps its own per world. */
export function readSourceShow(context: SourceContext): { connections: boolean; hiddenTables: string[]; namedAtRest?: boolean } | null {
  try {
    const stored = JSON.parse(sourceSessionStorage().getItem(`ki.source.show:${context.source_namespace}:${context.capture_digest}`) ?? "null");
    return stored && typeof stored.connections === "boolean" && Array.isArray(stored.hiddenTables) &&
      stored.hiddenTables.every((name: unknown) => typeof name === "string") &&
      (stored.namedAtRest === undefined || typeof stored.namedAtRest === "boolean") ? stored : null;
  } catch {
    return null;
  }
}
export function writeSourceShow(context: SourceContext, show: { connections: boolean; hiddenTables: string[]; namedAtRest?: boolean }): void {
  try {
    sourceSessionStorage().setItem(`ki.source.show:${context.source_namespace}:${context.capture_digest}`, JSON.stringify(show));
  } catch {
    // The filter lives in the tab only.
  }
}

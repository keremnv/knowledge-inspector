/**
 * How a scalar is printed, so that different values never look the same
 * merely because of how a cell or a sentence is drawn.
 *
 * This component is source-neutral. A World may be a SQLite reading, a
 * producer-authored World or anything else behind the same API, and a JSON
 * `null` does not establish SQLite storage (or that any physical row exists),
 * nor an empty string a *stored* one. So it says only what the payload says:
 * a null value, an empty string, a value that was not sent. Where a SQLite
 * source is independently established, the storage class lives in that
 * assertion's source grounding, not here.
 *
 *   NULL            the payload's null
 *   ""              the empty string
 *   "   "           whitespace-only text, quoted so the spaces are visible
 *   not supplied    no value in the payload (never a null)
 *   anything else   exactly as sent: 0, -2.5, text
 *
 * A text value that would read as one of those markers is quoted instead
 * (`"NULL"`, `"null"`, `"not supplied"`, `"—"`, `"\"\""`), in cells and
 * in sentence-like summaries alike. So the visible characters alone, with no
 * tooltip, data attribute or italic, tell a marker from the text that
 * imitates it. Every other string and number is printed as it is.
 *
 * Only the four marker kinds get an element, and it carries an accessible
 * name: a tooltip or a colour alone does not tell a screen reader that `NULL`
 * is not the four-letter text "NULL".
 */
export type ScalarKind =
  | "null"
  | "empty text"
  | "whitespace text"
  | "not supplied"
  | "text"
  | "number"
  | "boolean"
  | "structured";

export function scalarKind(value: unknown): ScalarKind {
  if (value === undefined) return "not supplied";
  if (value === null) return "null";
  if (typeof value === "string") {
    if (value === "") return "empty text";
    return value.trim() === "" ? "whitespace text" : "text";
  }
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "structured";
}

/**
 * Whether this text would read as a marker, or as the dash the interface
 * prints for missing metadata: such text is quoted when it is shown.
 */
function readsAsMarker(text: string): boolean {
  const bare = text.trim().toLowerCase();
  return (
    bare === "null" ||
    bare === "not supplied" ||
    bare === "(not supplied)" ||
    bare === "\u2014" ||
    text.startsWith('"') ||
    text.endsWith('"')
  );
}

/**
 * The value as one line of text. The four marker kinds have their own forms,
 * and a text that imitates one is quoted; nothing else changes.
 */
export function scalarText(value: unknown): string {
  switch (scalarKind(value)) {
    case "not supplied":
      return "not supplied";
    case "null":
      return "NULL";
    case "empty text":
      return '""';
    case "whitespace text":
      // JSON quoting keeps spaces and shows tabs and newlines as escapes.
      return JSON.stringify(value);
    case "structured":
      return JSON.stringify(value);
    case "text":
      return readsAsMarker(value as string) ? JSON.stringify(value) : (value as string);
    default:
      return String(value);
  }
}

/** What the marker says in words; undefined for an ordinary value. */
export function scalarLabel(value: unknown): string | undefined {
  switch (scalarKind(value)) {
    case "null":
      return "null value supplied by the World";
    case "empty text":
      return "empty string value";
    case "whitespace text":
      return `whitespace-only text, ${(value as string).length} character${(value as string).length === 1 ? "" : "s"}`;
    case "not supplied":
      return "value not supplied by the API";
    default:
      return undefined;
  }
}

/** A cell's tooltip: the same words, or the value itself, unquoted. */
export function scalarTitle(value: unknown): string {
  return scalarLabel(value) ?? (typeof value === "string" ? value : scalarText(value));
}

/** The value, with an element (and an accessible name) only where it is a marker. */
export function Scalar({ value }: { value: unknown }) {
  const label = scalarLabel(value);
  if (label === undefined) return <>{scalarText(value)}</>;
  return (
    <span className="scalar" data-scalar-marker={scalarKind(value)} role="img" aria-label={label}>
      {scalarText(value)}
    </span>
  );
}

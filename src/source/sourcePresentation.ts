export type SourcePresentation = {
  direction: 'reader' | 'selected';
  /** `direct` (the default, owner decision O1) also places a selected row's
   * verified record, and shows an inspected addressable reference, on canvas.
   * The explicit show on canvas and show connection actions remain in both modes. */
  placement: 'explicit' | 'direct';
};
/**
 * What the address bar may ask of the Source workspace. Record names are not
 * among them: a person chooses, per table, which column names its records
 * (owner decision O17), and the `?labels=readable&display=chinook-demo`
 * demonstration policy that hard-coded Track→Name and Album→Title is retired.
 * A name is never inferred from a schema.
 */
/** One key component of a linked record, exactly as `mode=primary_key` takes it. */
export type SourceLinkKey = { column: string; storage_class: "integer" | "text"; exact: string };
export type SourceRecordLink = { table: string; key: SourceLinkKey[] };
/**
 * `?record_table=T&record_key=[{"column":..,"storage_class":"text"|"integer","exact":".."}]`
 * asks the workspace to open one record in the Reader. The key is the record's
 * declared primary key in recorded order, in the same JSON the `primary_key`
 * search accepts; it is looked up by that exact search and nothing else, so a
 * label, a substring or a partial key never opens a record. `null`: no link was
 * asked for. `problem`: a link was asked for but cannot be followed as written.
 */
export function sourceRecordLink(search: string): { link: SourceRecordLink } | { problem: string } | null {
  const query = new URLSearchParams(search);
  const table = query.get("record_table"), raw = query.get("record_key");
  if (table === null && raw === null) return null;
  if (query.getAll("record_table").length > 1 || query.getAll("record_key").length > 1) return { problem: "the link repeats a parameter" };
  if (!table || raw === null) return { problem: "the link needs both record_table and record_key" };
  if (table.length > 512 || raw.length > 8192) return { problem: "the link is too long" };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { problem: "record_key is not JSON" }; }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 16) return { problem: "record_key must be a list of key components" };
  const key: SourceLinkKey[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { problem: "a record_key component is not an object" };
    const { column, storage_class, exact, ...rest } = item as Record<string, unknown>;
    if (Object.keys(rest).length || typeof column !== "string" || !column || typeof exact !== "string" ||
        (storage_class !== "text" && storage_class !== "integer") ||
        (storage_class === "integer" && !/^-?(0|[1-9][0-9]*)$/.test(exact))) {
      return { problem: "a record_key component must be exactly {column, storage_class: text|integer, exact}" };
    }
    key.push({ column, storage_class, exact });
  }
  return { link: { table, key } };
}

export function sourcePresentation(search: string): SourcePresentation {
  const query = new URLSearchParams(search);
  return {
    direction: query.get('direction') === 'selected' ? 'selected' : 'reader',
    // Owner decision O1: direct is the default; `?placement=explicit` opts out.
    placement: query.get('placement') === 'explicit' ? 'explicit' : 'direct',
  };
}

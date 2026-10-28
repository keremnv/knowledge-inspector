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
export function sourcePresentation(search: string): SourcePresentation {
  const query = new URLSearchParams(search);
  return {
    direction: query.get('direction') === 'selected' ? 'selected' : 'reader',
    // Owner decision O1: direct is the default; `?placement=explicit` opts out.
    placement: query.get('placement') === 'explicit' ? 'explicit' : 'direct',
  };
}

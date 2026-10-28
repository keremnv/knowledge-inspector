/**
 * The recorded state of one relation occurrence, as its own dimension.
 *
 * This reads `occurrence_state` exclusively. Legacy `assertion_state`
 * values record stored origins, not adoption decisions, so they must
 * never feed this chip: an ASSERTED legacy tuple with no occurrence
 * state shows no chip at all. Unknown explicit states render raw; a
 * missing state renders nothing, so legacy payloads read exactly as
 * before.
 */
export type OccurrenceChip = {
  label: string;
  title: string;
  /** The raw recorded value, for tests and tooltips alike. */
  state: string;
} | null;

export function occurrenceChip(
  state: string | null | undefined,
): OccurrenceChip {
  if (!state) return null;
  switch (state) {
    case "ADOPTED":
      return { label: "adopted", title: "Adopted assertion.", state };
    case "PROPOSED":
      return {
        label: "proposal",
        title: "Recorded proposal: under consideration, not adopted.",
        state,
      };
    case "REJECTED":
      return {
        label: "rejection",
        title: "Recorded rejection: decided against, not adopted.",
        state,
      };
    case "RECORDED":
      return {
        label: "recorded",
        title: "Supplied occurrence state: RECORDED.",
        state,
      };
    default:
      return { label: state.toLowerCase(), title: `Recorded state: ${state}.`, state };
  }
}

/** The compact qualification for a supplied state, or null when absent. */
export function occurrenceLabel(state: string | null | undefined): string | null {
  return occurrenceChip(state)?.label ?? null;
}

/** A relation name qualified by its supplied state, for graph labels. */
export function qualifiedName(name: string, state: string | null | undefined): string {
  const label = occurrenceLabel(state);
  return label ? `${name} · ${label}` : name;
}

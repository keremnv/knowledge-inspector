/**
 * Pointer contact on canvas matter, expressed independently of G6.
 *
 * Selection is deliberately absent. G6 emits click only after a successful
 * press/release, and the World page owns that committed observer state. This
 * machine owns the physical episode before it: load, manipulation and the
 * release back to equilibrium.
 */

export type ContactState =
  | { phase: "idle" }
  | { phase: "pressed"; id: string }
  | { phase: "dragging"; id: string }
  | { phase: "releasing"; id: string };

export type ContactEvent =
  | { type: "press"; id: string }
  | { type: "drag"; id: string }
  | { type: "release" }
  | { type: "settled"; id: string };

export const IDLE_CONTACT: ContactState = Object.freeze({ phase: "idle" });

export function contactId(state: ContactState): string | null {
  return state.phase === "idle" ? null : state.id;
}

export function transitionContact(
  state: ContactState,
  event: ContactEvent,
): ContactState {
  // One observer contact owns the load episode. A second pointer cannot move
  // the load to another body and strand the first one in compression.
  if (event.type === "press") {
    return state.phase === "idle"
      ? { phase: "pressed", id: event.id }
      : state;
  }

  if (event.type === "drag") {
    return state.phase === "pressed" && state.id === event.id
      ? { phase: "dragging", id: event.id }
      : state;
  }

  if (event.type === "release") {
    return state.phase === "pressed" || state.phase === "dragging"
      ? { phase: "releasing", id: state.id }
      : state;
  }

  return state.phase === "releasing" && state.id === event.id
    ? IDLE_CONTACT
    : state;
}

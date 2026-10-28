import { expansionOnField, type WorkingSet } from "./workingSet";

/** The only transient states an expansion request can occupy. */
export type ExpansionRequestState =
  | { value: "loading" }
  | { value: "failed"; message: string };

export type ExpansionRequestEvent =
  | { type: "start"; key: string }
  | { type: "succeed"; key: string }
  | { type: "fail"; key: string; message: string }
  | { type: "reset" };

export type ExpansionRequests = ReadonlyMap<string, ExpansionRequestState>;

/**
 * Request lifecycle for the expansion panel.
 *
 * Successful presence deliberately does not live in this reducer. It is a
 * property of the working set, not of the last button someone happened to
 * click, and is derived by `expansionViewState` below.
 */
export function expansionRequestReducer(
  current: ExpansionRequests,
  event: ExpansionRequestEvent,
): ExpansionRequests {
  if (event.type === "reset") return new Map();
  const next = new Map(current);
  if (event.type === "start") next.set(event.key, { value: "loading" });
  if (event.type === "succeed") next.delete(event.key);
  if (event.type === "fail") {
    next.set(event.key, { value: "failed", message: event.message });
  }
  return next;
}

export type ExpansionViewState =
  | { value: "on-field" }
  | { value: "loading" }
  | { value: "failed"; message: string }
  | { value: "available" };

/** One exhaustive decision for label, disabled state, and click behavior. */
export function expansionViewState({
  set,
  referentId,
  relation,
  count,
  request,
}: {
  set: WorkingSet;
  referentId: string;
  relation: string;
  count: number;
  request?: ExpansionRequestState;
}): ExpansionViewState {
  if (expansionOnField(set, referentId, relation, count)) {
    return { value: "on-field" };
  }
  if (request?.value === "loading") return request;
  if (request?.value === "failed") return request;
  return { value: "available" };
}

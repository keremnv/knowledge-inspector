/**
 * What a bulk placement (add all) or a group expansion (expand through)
 * actually did, kept where the action was asked for until the same action
 * runs again or its result is taken off the canvas. A run that placed nothing
 * says so: no exception reaching the page is not success.
 */
import type { SourceIdentity } from "../api/source";
import { SourceReadError } from "../api/sourceClient";
import { failureSentence, identityExplanation } from "./sourceExplain";

export type BulkOutcome = {
  kind: "add" | "expand";
  /** The action it answers: an expansion key, or the table window an add all read. */
  origin: string;
  table: string;
  state: "complete" | "partial" | "nothing" | "failed" | "stopped";
  /** Newly placed by this run. */
  placed: number;
  /** Offered records that were already on the canvas. */
  already: number;
  /** Rows read without a verified record identity: never placed. */
  skipped: number;
  /** Rows the run did not read because none of them could be placed. */
  unread: boolean;
  identity?: SourceIdentity;
  error?: Error;
  stopped?: "person" | "table_changed";
};

const rows = (n: number) => `${n} ${n === 1 ? "row" : "rows"}`;

export function outcomeSummary(outcome: BulkOutcome): string {
  const { placed, already, skipped } = outcome;
  const parts: string[] = [];
  if (outcome.state === "stopped") parts.push(outcome.stopped === "table_changed" ? "stopped when the table on show changed" : "stopped");
  if (outcome.state === "failed") parts.push("could not finish");
  if (placed || outcome.state === "stopped" || outcome.state === "failed" || outcome.state === "complete" && !already) parts.push(`placed ${placed}`);
  else if (outcome.state === "nothing" || outcome.state === "partial") parts.push("nothing placed");
  if (already) parts.push(placed || outcome.state !== "complete" ? `${already} already on the canvas` : `all ${already} already on the canvas`);
  if (skipped) parts.push(`${rows(skipped)} without a record identity · not placed`);
  if (outcome.state === "nothing" && !skipped && !already) parts.push("no rows were found");
  return parts.join(" · ");
}

export function BulkOutcomeNote({ outcome }: { outcome: BulkOutcome }) {
  const why = outcome.skipped ? identityExplanation(outcome.identity) : null;
  const failed = outcome.state === "failed";
  const blocked = outcome.state === "nothing" || outcome.state === "partial";
  return <div className={`source-outcome source-outcome--${outcome.state}`} data-outcome={outcome.state} data-outcome-origin={outcome.origin}
    role={failed ? "alert" : "status"}>
    <p className={failed || blocked ? "source-limitation" : "source-note"}>{outcomeSummary(outcome)}</p>
    {why && <p className="source-note">{why.sentence}{outcome.unread && " The rest of this group was not read: its rows would not be placeable either."}</p>}
    {failed && outcome.error && <p className="source-note">{failureSentence(outcome.error)}
      {outcome.error instanceof SourceReadError && <> <small>details · <code>{outcome.error.code}</code></small></>}</p>}
    {why && outcome.identity?.reason && <p className="source-note"><small>details · <code>{outcome.identity.status}</code> · <code>{outcome.identity.reason}</code></small></p>}
  </div>;
}

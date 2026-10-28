/**
 * Plain words for the limitation codes a person meets while placing or
 * following records. Each explains what the code means for them; the exact
 * code stays in the details where it is shown. Only the cases met in use are
 * written out; anything else falls back to the code itself.
 */
import type { SourceIdentity } from "../api/source";
import { SourceReadError } from "../api/sourceClient";

export type Explanation = { short: string; sentence: string };

const READABLE = "Its rows can still be read in the table.";

/** Why a table's rows cannot stand on the canvas, or null when nothing stops them yet. */
export function identityExplanation(identity?: SourceIdentity | null): Explanation | null {
  const reason = identity?.reason ?? "";
  switch (identity?.status) {
    case "no_declared_key":
      return { short: "no primary key", sentence: `This table declares no primary key, so its rows have no record identity and cannot be placed or followed. ${READABLE}` };
    case "view_table_only":
      return { short: "computed view output", sentence: `A view's rows are computed output without a record identity, so they cannot be placed. ${READABLE}` };
    case "invalid":
      return reason === "null_primary_key_component"
        ? { short: "primary key contains NULL", sentence: `Some rows have NULL in the declared primary key, so the key does not identify each row. ${READABLE}` }
        : { short: "primary key is not a valid record identity", sentence: `The declared primary key does not identify exactly one row for every value in this file. ${READABLE}` };
    case "unsupported":
      return reason === "unsupported_identity_component"
        ? { short: "key type unsupported", sentence: `Some key values are stored as a type that cannot serve as a record identity. ${READABLE}` }
        : reason === "identity_lookup_plan_unsupported"
          ? { short: "key lookup unsupported", sentence: `The primary key cannot be looked up through an index, so its rows cannot be checked one by one. ${READABLE}` }
          : { short: "identity check unsupported", sentence: `The primary key could not be checked. ${READABLE}` };
    case "budget_exceeded":
      return reason === "identity_registry_budget_exceeded"
        ? { short: "this session's record limit is reached", sentence: `This session has handed out as many records as it can hold, so no more rows can be placed until the file is opened again. Records already placed stay. ${READABLE}` }
        : { short: "key verification incomplete · too large to verify within its limits", sentence: `Checking every key of this table did not finish within its limits, so its rows cannot be placed in this session. ${READABLE}` };
    case "interrupted":
      return { short: "key check cut short", sentence: "Checking this table's keys was cut short by the limit of the request that needed it. Nothing was recorded; opening the table tries again." };
    default:
      return null;
  }
}

/** Identity states that keep every row of a table off the canvas for this session. */
export function identityBlocksPlacement(identity?: SourceIdentity | null): boolean {
  return !!identity && ["no_declared_key", "view_table_only", "invalid", "unsupported", "budget_exceeded"].includes(identity.status);
}

const DECLARATIONS: Record<string, string> = {
  parent_key_not_eligible_unique_constraint: "This foreign key references columns that do not uniquely identify a parent record.",
  missing_parent_table: "This foreign key names a parent table that is not in this file.",
  parent_is_not_base_table: "This foreign key names a parent that is not a table.",
  implicit_parent_key_arity_mismatch: "This foreign key leaves out its parent columns, and the parent's primary key has a different number of columns.",
  missing_constraint_column: "This foreign key names a column that does not exist.",
  duplicate_parent_target_column: "This foreign key names the same parent column more than once.",
  malformed_component_order: "This foreign key's recorded column order is malformed.",
  parent_collation_unavailable: "The parent column's text comparison could not be determined, so matches cannot be checked.",
  implicit_pk_collation_differs_from_column: "The parent key's text comparison differs from its column's, so matches cannot be checked reliably.",
};

/** A declaration's validation reason in plain words; the code itself stays in the details. */
export function declarationExplanation(reason?: string | null): string {
  return (reason && DECLARATIONS[reason]) ?? "This foreign key declaration could not be verified, so it is not followed.";
}

/** A failed placement or expansion, in a person's words. */
export function failureSentence(error: Error): string {
  if (error instanceof SourceReadError) {
    if (error.busy) return "The source service was busy. Nothing more was placed; try again.";
    if (error.status === 0) return "The source service did not answer. Nothing more was placed; run it again once the service answers.";
    if (error.status >= 500 && !error.stopsContext) return "The source service could not complete the read. Nothing more was placed; run it again.";
    if (error.code === "source_query_budget_exceeded") return "Reading the next rows did not finish within the query limit.";
    if (error.code === "source_page_budget_exceeded" || error.code === "source_response_budget_exceeded") return "The next rows were too large to read in one page.";
    if (error.code === "source_context_mismatch" || error.code === "source_reference_mismatch") return "The rows read did not match this capture, so none of that page was placed.";
  }
  return "Reading the rows failed.";
}

/**
 * What a person can do about a failed read. `retry` repeats the same read once,
 * when asked: safe for any read (reads change nothing) and useful only when the
 * cause can pass (busy, unreachable, a server fault). `narrow` and `smaller` ask
 * for a different read instead. `stopped` is a context failure: no read in this
 * workspace can recover it.
 */
export type Recovery = "retry" | "narrow" | "smaller" | "none" | "stopped";
export type ReadFailure = { sentence: string; recovery: Recovery; code: string | null; detail?: string };

const UNCHANGED = "Nothing on the canvas changed";

/** A failed read in a person's words, with the recovery that fits it. The code stays for the details. */
export function readFailure(error: Error): ReadFailure {
  if (!(error instanceof SourceReadError)) return { sentence: "This read failed.", recovery: "none", code: null };
  const { code, status } = error;
  const detail = error.detail;
  const failure = (sentence: string, recovery: Recovery): ReadFailure => ({ sentence, recovery, code, detail });
  if (error.busy) return failure(`The source service is busy with another read. ${UNCHANGED}; try again.`, "retry");
  if (error.stopsContext) {
    return status === 410 ? failure("This source session has ended, so reads have stopped.", "stopped")
      : status === 503 ? failure("The private capture of the file is missing, changed or unreadable, so reads have stopped.", "stopped")
      : failure("The source service answered for a different session, capture or record than this page holds, so reads have stopped.", "stopped");
  }
  // A session description this page cannot read: a different or newer service, not a passing fault.
  if (code === "source_invalid_context") return failure("The source service describes its session in a form this page cannot read. Use the page the service itself prints.", "none");
  if (status === 0) return failure(`The source service did not answer. ${UNCHANGED}. Check that it is still running, then try again.`, "retry");
  if (status >= 500 || code === "source_invalid_response") return failure(`The source service could not complete this read. ${UNCHANGED}. Its terminal may say why; try again.`, "retry");
  if (status === 413) return failure("These rows are too large to read in one page. Choose fewer rows per page.", "smaller");
  if (status === 422 && code.includes("budget")) return failure("This read did not finish within the query limit, so nothing is claimed about what it did not reach.", "narrow");
  if (status === 422) return failure("This read is not supported here.", "none");
  if (status === 404) return failure("Not found in this capture.", "none");
  if (status === 429) return failure("The source service has reached its session limit.", "none");
  return failure("The source service returned an unexpected answer.", "none");
}

/**
 * The manual recovery from a stopped context. Nothing in the page reconnects by
 * itself: a reload asks the service for its current session, and a restarted
 * service captures the file again, starting with an empty canvas.
 */
export function stoppedRecovery(error: Error): string {
  return error instanceof SourceReadError && (error.status === 410 || error.status === 503)
    ? "To continue, restart the source service (for ki, run ki open with the file again) and open the address it prints. The new session starts with an empty canvas."
    : "To continue, reload this page: it asks the source service for its current session and reads every record again. If the service has stopped, restart it first.";
}

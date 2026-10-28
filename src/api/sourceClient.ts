import type {
  SourceSearch, SourceSearchRequest, SourceCatalogue, SourceContext, SourceEnvelope, SourceRecord, SourceRows,
  SourceFKObservation, SourceReferences, SourceGrounding, SourceIncomingReferences, SourceOrder, SourceRecordWindow, SourceGlobalFind,
} from "./source";

/** Temporary refusals: the reader or the server is busy. Never a statement
 * about the capture, whatever the status, so never context-fatal. */
const BUSY = new Set(["source_reader_busy", "source_server_busy"]);

/** Source errors retain the server code; World recovery advice is inappropriate
 * here. In particular, no read retries bootstrap or substitutes a generation,
 * and none retries by itself: a busy read waits for the person to try again. */
export class SourceReadError extends Error {
  constructor(public code: string, public status: number, public detail?: string) {
    const explanation = BUSY.has(code) ? "Source service is busy. Nothing on the canvas changed; try again."
      : status === 410 ? "Source session unavailable or expired. Ask the operator to reopen the source service."
      : status === 409 ? "Source generation or exact record lookup no longer matches. Reads have stopped."
      : status === 503 ? "Captured source unavailable. Check the source service and its private capture."
      : status === 404 ? "Source table, record or endpoint was not found."
      : status === 413 ? "This source window exceeds the value or response budget. Try a smaller window."
      : status === 422 ? "This source operation is unsupported or exceeds its query budget."
      : status === 429 ? "Source service is busy or has reached its session limit."
      : status >= 500 ? "Source server could not complete this read. Check its terminal."
      : status === 0 ? "Cannot reach the source service. Check its address and terminal."
      : "The source service returned an unexpected response.";
    super(`${explanation} (${code})${detail ? ` ${detail}` : ""}`);
  }
  get busy() { return BUSY.has(this.code); }
  get stopsContext() { return !this.busy && ([409, 410, 503].includes(this.status) || this.code === "source_context_mismatch"); }
}

async function read<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { signal, cache: "no-store" });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new SourceReadError("source_disconnected", 0);
  }
  let body: unknown;
  try { body = await response.json(); } catch {
    throw new SourceReadError("source_invalid_response", response.ok ? 502 : response.status);
  }
  if (!response.ok) {
    const failure = body as { error?: unknown; detail?: unknown } | null;
    throw new SourceReadError(typeof failure?.error === "string" ? failure.error : "source_http_error",
      response.status, typeof failure?.detail === "string" ? failure.detail : undefined);
  }
  return body as T;
}

// Compare the complete established context, including full digest and versions.
// Identical labels, handles or bytes in a different session do not authorize it.
const CONTEXT_FIELDS = ["session", "generation", "source_namespace", "capture_digest",
  "capture_version", "projection_version", "captured_at", "time_basis", "sqlite_version"] as const;

/** Content and motion buffers belong to the same complete context as reads. */
export function sourceContextKey(context: SourceContext): string {
  return JSON.stringify(CONTEXT_FIELDS.map((field) => context[field]));
}

export async function sourceSession(signal?: AbortSignal): Promise<SourceContext> {
  const context = await read<SourceContext>("/source/v1/session", signal);
  if (!context || CONTEXT_FIELDS.some((key) => typeof context[key] !== "string" || !context[key]) ||
      context.capture_version !== "sqlite_capture_v1" || context.projection_version !== "sqlite_source_v1") {
    throw new SourceReadError("source_invalid_context", 502);
  }
  return context;
}

/** Capture evidence must agree as well as the response envelope. */
export function sourceGrounded(context: SourceContext, grounding: SourceGrounding): boolean {
  return (["generation", "source_namespace", "capture_digest", "capture_version", "captured_at",
    "time_basis", "sqlite_version"] as const).every((key) => grounding?.[key] === context[key]) &&
    grounding.schema === "main" && grounding.basis === "stored_row_verified_declared_pk";
}

export function sourceClient(context: SourceContext) {
  // Keep a private copy so a caller cannot change the expected tokens mid-read.
  const established = { ...context };
  async function get<T>(route: string, parameters: Record<string, string>, signal?: AbortSignal) {
    const query = new URLSearchParams({ ...parameters, session: established.session, generation: established.generation });
    const envelope = await read<SourceEnvelope<T>>(`/source/v1/${route}?${query}`, signal);
    if (!envelope?.context || CONTEXT_FIELDS.some((key) => envelope.context[key] !== established[key])) {
      throw new SourceReadError("source_context_mismatch", 409);
    }
    return envelope.data;
  }
  const checkObservation = (observation: SourceFKObservation, child: string, fk?: string) => {
    if (!observation?.observation_id || observation.child_record_id !== child ||
        (fk !== undefined && observation.declaration.declaration_id !== fk) ||
        !sourceGrounded(established, observation.grounding) ||
        observation.grounding.table !== observation.declaration.child_table) {
      throw new SourceReadError("source_reference_mismatch", 409);
    }
    return observation;
  };
  const window = (limit: number, offset: number) => ({ limit: String(limit), offset: String(offset) });
  const sorted = (order?: SourceOrder | null): Record<string, string> =>
    order ? { order: order.column, ...(order.desc ? { desc: "1" } : {}) } : {};
  /** The window must be the order asked for: a different sort is a different table. */
  const checkOrder = <T extends { order?: SourceRows["order"] }>(page: T, order?: SourceOrder | null): T => {
    if (order ? page?.order?.column !== order.column || page.order.desc !== order.desc : page?.order) {
      throw new SourceReadError("source_window_mismatch", 409);
    }
    return page;
  };
  const searchParameters = (request: SourceSearchRequest): Record<string, string> => request.mode === "literal"
    ? { mode: request.mode, text: request.text, ...(request.column !== undefined ? { column: request.column } : {}),
        ...(request.case ? { case: request.case } : {}) }
    : request.mode === "primary_key" ? { mode: request.mode, key: JSON.stringify(request.key) }
    : { mode: request.mode, record: request.record, fk: request.fk };
  return {
    overview: (limit = 50, offset = 0, signal?: AbortSignal) => get<SourceCatalogue>("overview", window(limit, offset), signal),
    schema: (limit = 50, offset = 0, signal?: AbortSignal) => get<SourceCatalogue>("schema", window(limit, offset), signal),
    rows: async (table: string, limit = 50, offset = 0, signal?: AbortSignal, order?: SourceOrder | null) =>
      checkOrder(await get<SourceRows>("rows", { table, ...window(limit, offset), ...sorted(order) }, signal), order),
    search: async (table: string, request: SourceSearchRequest, limit = 50, offset = 0, signal?: AbortSignal, order?: SourceOrder | null) => {
      const parameters = searchParameters(request);
      const result = checkOrder(await get<SourceSearch>("search", { table, ...parameters, ...window(limit, offset), ...sorted(order) }, signal), order);
      const actual = result.search;
      if (!actual || actual.mode !== request.mode ||
          (request.mode === "literal"
            ? actual.text !== request.text || actual.column !== (request.column ?? null) || actual.key !== null ||
              actual.case !== (request.case ?? "ignore") ||
              result.text_comparison?.policy !== (request.case === "match" ? "exact_v1" : "casefold_v1")
            : request.mode === "primary_key"
            ? actual.text !== null || actual.column !== null || !Array.isArray(actual.key) ||
              actual.key.length !== request.key.length || actual.key.some((part, i) =>
                part.column !== request.key[i].column || part.storage_class !== request.key[i].storage_class || part.exact !== request.key[i].exact)
            // The rows must be this declaration's children of this record, each
            // carrying an observation identity exactly when it has a handle.
            : actual.text !== null || actual.column !== null || actual.key !== null ||
              actual.record !== request.record || actual.fk !== request.fk ||
              result.reference?.record_id !== request.record || result.reference.declaration?.declaration_id !== request.fk ||
              result.reference.declaration.child_table !== table ||
              (result.rows as { record_id: string | null; observation_id?: string | null }[]).some((row) =>
                row.record_id ? typeof row.observation_id !== "string" : row.observation_id !== null))) {
        throw new SourceReadError("source_search_mismatch", 409);
      }
      return result;
    },
    /**
     * The window `rows` (no request) or `search` would read, as the records
     * single reads return: each one checked here exactly as `record` checks
     * one, and in reference mode with its observation checked as `reference`
     * checks it, against the requested parent and declaration.
     */
    recordWindow: async (table: string, request: SourceSearchRequest | null, limit = 50, offset = 0, signal?: AbortSignal, order?: SourceOrder | null) => {
      const page = checkOrder(await get<SourceRecordWindow>("records",
        { table, ...(request ? searchParameters(request) : {}), ...window(limit, offset), ...sorted(order) }, signal), order);
      if (page?.name !== table || page.offset !== offset || !Array.isArray(page.records) || typeof page.skipped !== "number") {
        throw new SourceReadError("source_window_mismatch", 409);
      }
      for (const { record, observation } of page.records) {
        if (!record?.record_id || record.identity?.status !== "verified" || record.name !== table ||
            record.grounding?.table !== table || !sourceGrounded(established, record.grounding)) {
          throw new SourceReadError("source_context_mismatch", 409);
        }
        if (request?.mode === "reference") {
          if (!observation) throw new SourceReadError("source_reference_mismatch", 409);
          checkObservation(observation, record.record_id, request.fk);
          if (observation.parent?.record_id !== request.record) throw new SourceReadError("source_reference_mismatch", 409);
        } else if (observation) throw new SourceReadError("source_reference_mismatch", 409);
      }
      return page;
    },
    find: async (text: string, cursor: string | null, limit = 20, signal?: AbortSignal) => {
      const page = await get<SourceGlobalFind>("find", { text, limit: String(limit), ...(cursor ? { cursor } : {}) }, signal);
      if (page?.text !== text || page.case !== "ignore" || page.text_comparison?.policy !== "casefold_v1" ||
          !Array.isArray(page.relations) || (cursor !== null && page.relations.length > 0) ||
          !Array.isArray(page.hits) || !Array.isArray(page.skipped) ||
          !["complete", "more", "budget_exceeded"].includes(page.completion) || (page.completion === "complete") !== (page.next_cursor === null)) {
        throw new SourceReadError("source_find_mismatch", 409);
      }
      return page;
    },
    outgoingReferences: async (record: string, limit = 50, offset = 0, signal?: AbortSignal) => {
      const page = await get<SourceReferences>("references", { record, direction: "outgoing", ...window(limit, offset) }, signal);
      if (page?.record_id !== record || page.direction !== "outgoing" || page.offset !== offset ||
          !Array.isArray(page.observations)) throw new SourceReadError("source_reference_mismatch", 409);
      page.observations.forEach((observation) => checkObservation(observation, record));
      return page;
    },
    incomingReferences: async (record: string, limit = 50, offset = 0, signal?: AbortSignal) => {
      const page = await get<SourceIncomingReferences>("references", { record, direction: "incoming", ...window(limit, offset) }, signal);
      if (page?.record_id !== record || page.direction !== "incoming" || page.offset !== offset || !Array.isArray(page.groups) ||
          page.groups.some((group) => !group?.declaration?.declaration_id || !group.count ||
            (group.count.status === "exact") !== (typeof group.count.value === "number"))) {
        throw new SourceReadError("source_reference_mismatch", 409);
      }
      return page;
    },
    reference: async (record: string, fk: string, signal?: AbortSignal) =>
      checkObservation(await get<SourceFKObservation>("reference", { record, fk }, signal), record, fk),
    record: async (id: string, signal?: AbortSignal) => {
      const record = await get<SourceRecord>("record", { id }, signal);
      if (record?.record_id !== id || record.identity?.status !== "verified" ||
          record.name !== record.grounding?.table || !sourceGrounded(established, record.grounding)) {
        throw new SourceReadError("source_context_mismatch", 409);
      }
      return record;
    },
  };
}
export type SourceClient = ReturnType<typeof sourceClient>;

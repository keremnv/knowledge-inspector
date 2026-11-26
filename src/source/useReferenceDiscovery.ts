import { useCallback, useEffect, useMemo, useState } from "react";
import type { SourceFKObservation, SourceIncomingGroup, SourceIncomingReferences, SourceReferences } from "../api/source";
import { SourceReadError } from "../api/sourceClient";

/** Declarations asked for per page, as before; pages are read one after another. */
export const DISCOVERY_PAGE = 10;
/** At most this many pages per record and direction: beyond it, coverage is said to be incomplete. */
export const DISCOVERY_PAGES = 50;

/**
 * Every page of one record's declared references in one direction, read one
 * after another (decision 4, `docs/DECISIONS.md`): what has arrived is usable
 * at once, `done` says every page was read, and a failed page leaves what came
 * before it and says coverage is incomplete. Leaving the record (or the read
 * being disabled) aborts the rest. `retry` resumes from the page that failed.
 */
export type Discovery<T> = { record: string; items: T[]; total: number | null; done: boolean; capped: boolean; error?: Error; retry: () => void };

function useDiscovery<T, P extends { total: number; has_more: boolean; next_offset: number | null }>(
  record: string | null | undefined, enabled: boolean, read: (record: string, offset: number, signal: AbortSignal) => Promise<P>,
  items: (page: P) => T[], onFailure?: (error: SourceReadError) => void): Discovery<T> | null {
  const [attempt, setAttempt] = useState(0);
  // One request per record, enablement and reader: what an earlier request
  // read, even for the same record, is never this one's answer (as useSourceRead).
  const request = useMemo(() => ({ record, enabled, read }), [record, enabled, read]);
  const [state, setState] = useState<{ request: typeof request; record: string; attempt: number; items: T[]; total: number | null; done: boolean; capped: boolean; error?: Error; resume: number } | null>(null);
  useEffect(() => {
    if (!record || !enabled) return;
    const controller = new AbortController();
    let active = true;
    // A retry keeps what arrived and resumes where the failure was.
    const kept = state && state.request === request && state.error ? state : null;
    let collected: T[] = kept ? kept.items : [];
    let offset = kept ? kept.resume : 0;
    let total: number | null = kept ? kept.total : null;
    if (!kept) setState({ request, record, attempt, items: [], total: null, done: false, capped: false, resume: 0 });
    else setState({ ...kept, attempt, error: undefined });
    void (async () => {
      for (let pages = 0; ; pages += 1) {
        if (pages >= DISCOVERY_PAGES) { if (active) setState({ request, record, attempt, items: collected, total, done: true, capped: true, resume: offset }); return; }
        let page: P;
        try { page = await read(record, offset, controller.signal); } catch (error) {
          if (!active) return;
          const failure = error instanceof Error ? error : new Error(String(error));
          setState({ request, record, attempt, items: collected, total, done: false, capped: false, error: failure, resume: offset });
          if (failure instanceof SourceReadError) onFailure?.(failure);
          return;
        }
        if (!active) return;
        collected = [...collected, ...items(page)];
        total = page.total;
        const more = page.has_more && page.next_offset !== null;
        setState({ request, record, attempt, items: collected, total, done: !more, capped: false, resume: page.next_offset ?? offset });
        if (!more) return;
        offset = page.next_offset!;
      }
    })();
    return () => { active = false; controller.abort(); };
    // `state` is read only to resume a failed discovery on retry.
  }, [request, attempt, items, onFailure]);
  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  if (!record || !enabled || !state || state.request !== request) return null;
  return { record, items: state.items, total: state.total, done: state.done, capped: state.capped, error: state.error, retry };
}

const groupsOf = (page: SourceIncomingReferences) => page.groups;
const observationsOf = (page: SourceReferences) => page.observations;

export function useIncomingDiscovery(record: string | null | undefined, enabled: boolean,
  read: (record: string, offset: number, signal: AbortSignal) => Promise<SourceIncomingReferences>, onFailure?: (error: SourceReadError) => void) {
  return useDiscovery<SourceIncomingGroup, SourceIncomingReferences>(record, enabled, read, groupsOf, onFailure);
}

export function useOutgoingDiscovery(record: string | null | undefined, enabled: boolean,
  read: (record: string, offset: number, signal: AbortSignal) => Promise<SourceReferences>, onFailure?: (error: SourceReadError) => void) {
  return useDiscovery<SourceFKObservation, SourceReferences>(record, enabled, read, observationsOf, onFailure);
}

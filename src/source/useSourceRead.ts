import { useCallback, useEffect, useMemo, useState } from "react";
import { SourceReadError } from "../api/sourceClient";

/** A new request hides old data synchronously. Abort plus effect ownership
 * rejects late responses even when a transport ignores cancellation.
 * `retry` repeats the same read once, only when a person asks. */
export function useSourceRead<T>(load: (signal: AbortSignal) => Promise<T>, onFailure?: (error: SourceReadError) => void, enabled = true) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ load: typeof load; attempt: number; data?: T; error?: Error }>();
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let active = true;
    load(controller.signal).then((data) => {
      if (active) setResult({ load, attempt, data });
    }).catch((error: unknown) => {
      if (!active) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      setResult({ load, attempt, error: failure });
      if (failure instanceof SourceReadError) onFailure?.(failure);
    });
    return () => { active = false; controller.abort(); };
  }, [load, onFailure, enabled, attempt]);
  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  const current = enabled && result?.load === load && result.attempt === attempt ? result : undefined;
  return useMemo(() => current && { ...current, retry }, [current, retry]);
}

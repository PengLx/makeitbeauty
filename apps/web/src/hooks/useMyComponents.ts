import { useCallback, useEffect, useState } from "react";
import { listMyComponents, toApiError, type ApiError, type ComponentRecord } from "@/lib/api";

export interface MyComponentsState {
  /** null until the first load resolves (or fails). */
  components: ComponentRecord[] | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Loads GET /v1/components (mine: drafts + published). Same degradation
 * contract as useKit: failures are non-fatal, callers decide between a retry
 * surface (components list view) and silently hiding (editor palette).
 */
export function useMyComponents(): MyComponentsState {
  const [components, setComponents] = useState<ComponentRecord[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    (async () => {
      try {
        setComponents(await listMyComponents(controller.signal));
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(toApiError(e));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [attempt]);

  return { components, error, loading, reload };
}

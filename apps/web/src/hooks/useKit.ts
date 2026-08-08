import { useCallback, useEffect, useState } from "react";

/** Kit palette metadata per architecture.md §8: GET /v1/kit. */
export interface KitProp {
  type: "string" | "number" | "color";
  description?: string;
  default?: unknown;
}

export interface KitComponent {
  /** Registry id, e.g. "kit/stat-card". */
  id: string;
  title: string;
  description?: string;
  frame: { w: number; h: number };
  props: Record<string, KitProp>;
}

export interface KitState {
  components: KitComponent[];
  /** Human-readable load failure; the palette shows a graceful empty state. */
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Loads the official kit for the palette. Failures are non-fatal: the editor
 * still works (text/rect quick-add, code tab) with the API down — the palette
 * just offers a retry.
 */
export function useKit(): KitState {
  const [components, setComponents] = useState<KitComponent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    (async () => {
      try {
        const res = await fetch("/v1/kit", { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body: unknown = await res.json();
        if (!Array.isArray(body)) throw new Error("unexpected /v1/kit shape");
        setComponents(body as KitComponent[]);
        setError(null);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [attempt]);

  return { components, error, loading, reload };
}

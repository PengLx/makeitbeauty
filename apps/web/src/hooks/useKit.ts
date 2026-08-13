import { useCallback, useEffect, useState } from "react";
import type { ComputedEntry, FragmentNode } from "@/lib/component";

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
  /**
   * Palette-menu group slug (schema `category`, omitted when absent).
   * lib/paletteMenu.ts sorts unknown/missing categories into "other".
   */
  category?: string;
  frame: { w: number; h: number };
  props: Record<string, KitProp>;
  /**
   * The component's definition body, served verbatim by /v1/kit — always an
   * array. For native components these are the file's STATIC PREVIEW nodes
   * (possibly []); the renderer's trusted generator supplies the real nodes
   * at render time. The canvas expands these via lib/expandFragment.ts.
   */
  nodes: FragmentNode[];
  /** Computed-geometry rules, present only when the component file declares them. */
  computed?: ComputedEntry[];
  /** Official-kit only: a renderer generator produces the render-time nodes. */
  native?: boolean;
  /** Connector snapshot paths a native component consumes. */
  dataFields?: string[];
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
        // The contract serves `nodes` on every entry; normalize defensively so
        // the canvas can rely on an array against an older API.
        setComponents(
          (body as KitComponent[]).map((c) =>
            Array.isArray(c.nodes) ? c : { ...c, nodes: [] },
          ),
        );
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

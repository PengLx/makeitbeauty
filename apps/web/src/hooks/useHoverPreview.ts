import { useEffect, useRef, useState } from "react";
import {
  renderPreviewEntry,
  resolveShared,
  type HoverPreviewEntry,
  type HoverPreviewError,
} from "@/lib/hoverPreview";
import type { DesignDoc } from "@/lib/design";

/**
 * Hover-preview cache, module-level so every palette section (kit, my
 * components, community search — and the Studio's starter-template cards)
 * shares one pool for the process lifetime. Keys: "kit/{name}" (kit registry
 * id verbatim), "{owner}/{name}@{v}" (pinned community version) or
 * "template/{id}" (lib/hoverPreview key helpers).
 *
 * `settled` holds SVG TEXT (or the render error — errors cache too, so a
 * hover can't hammer a down API), never blob URLs: those are per-mount,
 * created and revoked by the hook below. `inflight` dedupes concurrent
 * hovers on the same entry.
 */
const settled = new Map<string, HoverPreviewEntry>();
const inflight = new Map<string, Promise<HoverPreviewEntry>>();

/**
 * Resolve one preview through the cache. `getDesign` may itself be async
 * (community entries fetch the pinned definition first, via the
 * useComponentDefs version cache); if it throws, the failure settles as a
 * cached {error} entry like any render failure — this promise never rejects.
 */
function getHoverPreviewEntry(
  key: string,
  getDesign: () => DesignDoc | Promise<DesignDoc>,
): Promise<HoverPreviewEntry> {
  return resolveShared(settled, inflight, key, async () => {
    try {
      return await renderPreviewEntry(await getDesign());
    } catch (e) {
      return {
        error: {
          code: "design_unavailable",
          message: e instanceof Error ? e.message : String(e),
        },
      };
    }
  });
}

export interface HoverPreviewState {
  /** Per-mount object URL for the rendered SVG, displayable via <img>. */
  url: string | null;
  /** The rendered canvas size (= the component frame), once known. */
  size: { w: number; h: number } | null;
  /** Settled failure — the card shows a muted "preview unavailable". */
  error: HoverPreviewError | null;
  /** True from card-open until the entry settles (false on a cache hit). */
  loading: boolean;
}

/**
 * Preview for one palette entry, fetched lazily: nothing happens until
 * `active` turns true — wired to HoverCard's onOpenChange, which fires AFTER
 * the openDelay, so skimming the palette never renders anything. A cache hit
 * displays synchronously on the next paint.
 *
 * Blob URLs follow usePreview's hygiene: created per mount from the cached
 * SVG text, revoked on unmount (or entry change), never cached themselves.
 */
export function useHoverPreview(
  key: string,
  getDesign: () => DesignDoc | Promise<DesignDoc>,
  active: boolean,
): HoverPreviewState {
  const [entry, setEntry] = useState<HoverPreviewEntry | null>(
    () => settled.get(key) ?? null,
  );
  const [url, setUrl] = useState<string | null>(null);
  // Latches on first open: a warm cache entry must not allocate a blob URL
  // for every mounted row — only rows the user actually hovered.
  const [everActive, setEverActive] = useState(active);
  useEffect(() => {
    if (active) setEverActive(true);
  }, [active]);
  // Latest producer without retriggering the fetch effect — only key/active
  // decide WHEN to fetch; the closure identity changes every parent render.
  const getDesignRef = useRef(getDesign);
  getDesignRef.current = getDesign;

  // If a mounted card is ever re-keyed, drop to whatever the cache holds.
  useEffect(() => {
    setEntry(settled.get(key) ?? null);
  }, [key]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void getHoverPreviewEntry(key, () => getDesignRef.current()).then((e) => {
      if (!cancelled) setEntry(e);
    });
    return () => {
      cancelled = true;
    };
  }, [key, active]);

  useEffect(() => {
    if (!everActive || entry == null || "error" in entry) return;
    const next = URL.createObjectURL(
      new Blob([entry.svg], { type: "image/svg+xml" }),
    );
    setUrl(next);
    return () => {
      URL.revokeObjectURL(next);
      setUrl(null);
    };
  }, [entry, everActive]);

  return {
    url,
    size: entry != null && "svg" in entry ? { w: entry.width, h: entry.height } : null,
    error: entry != null && "error" in entry ? entry.error : null,
    loading: active && entry == null,
  };
}

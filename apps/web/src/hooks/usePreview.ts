import { useEffect, useRef, useState } from "react";

export interface PreviewError {
  code: string;
  message: string;
}

export interface PreviewState {
  /** Object URL for the latest successfully rendered SVG, displayable via <img>. */
  url: string | null;
  /** Render error from the API's {error:{code,message}} envelope, or a transport error. */
  error: PreviewError | null;
  /** True while a request is in flight. */
  loading: boolean;
}

/**
 * Live preview against POST /v1/preview (proxied to apps/api in dev).
 *
 * - Debounces `design` changes by 500 ms so typing in the code pane doesn't
 *   spam the renderer.
 * - The response body is raw SVG text; we wrap it in a Blob object URL and
 *   display it through <img> because that matches the production Camo context
 *   (no scripts, no external fetches — see docs/architecture.md §2).
 * - Stale object URLs are revoked so long editing sessions don't leak blobs.
 * - Pass `null` while the design JSON is unparseable: the last good preview
 *   stays on screen instead of flickering away.
 */
export function usePreview(design: unknown | null): PreviewState {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<PreviewError | null>(null);
  const [loading, setLoading] = useState(false);
  // Tracked outside state so cleanup can revoke without re-rendering.
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    if (design == null) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch("/v1/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ design }),
          signal: controller.signal,
        });
        const body = await res.text();

        if (!res.ok) {
          // Error envelope per architecture §8: {"error":{"code","message"}}.
          let code = `http_${res.status}`;
          let message = body || res.statusText;
          try {
            const parsed = JSON.parse(body);
            if (parsed?.error?.code) {
              code = parsed.error.code;
              message = parsed.error.message;
            }
          } catch {
            /* non-JSON error body; keep the http_* fallback */
          }
          setError({ code, message });
          return;
        }

        const next = URL.createObjectURL(
          new Blob([body], { type: "image/svg+xml" }),
        );
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = next;
        setUrl(next);
        setError(null);
      } catch (e) {
        if (controller.signal.aborted) return; // superseded by a newer edit
        setError({
          code: "network_error",
          message: e instanceof Error ? e.message : String(e),
        });
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 500);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [design]);

  // Revoke the last object URL when the hook unmounts.
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  return { url, error, loading };
}

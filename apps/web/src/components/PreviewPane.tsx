import type { PreviewState } from "../hooks/usePreview";

interface Props {
  preview: PreviewState;
}

/**
 * Renders the live preview centered on a dotted canvas. The preview is an
 * <img> pointing at a blob: URL of the API-rendered SVG — the same constraint
 * set the final image lives under behind GitHub's Camo proxy.
 */
export function PreviewPane({ preview }: Props) {
  const { url, error, loading } = preview;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div
        className="relative flex flex-1 items-center justify-center overflow-auto p-8
          [background-image:radial-gradient(circle,#21262d_1px,transparent_1px)]
          [background-size:16px_16px]"
      >
        {url ? (
          <img
            src={url}
            alt="Design preview"
            className="max-h-full max-w-full rounded-lg shadow-[0_8px_32px_rgba(1,4,9,0.6)]"
          />
        ) : !error ? (
          <p className="text-sm text-[#7d8590]">
            {loading ? "Rendering…" : "Waiting for first render…"}
          </p>
        ) : null}

        {loading && url && (
          <span className="absolute right-3 top-3 rounded-full bg-[#161b22] px-2.5 py-1 text-[11px] text-[#7d8590]">
            rendering…
          </span>
        )}

        {error && (
          <div className="absolute inset-x-8 bottom-8 rounded-md border border-[#f8514966] bg-[#f851491a] px-4 py-3">
            <p className="text-sm font-medium text-[#f85149]">
              Render failed{" "}
              <span className="font-mono text-xs text-[#f8514999]">
                [{error.code}]
              </span>
            </p>
            <p className="mt-1 text-xs text-[#e6edf3]">{error.message}</p>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-[#30363d] bg-[#010409] px-4 py-2">
        <span className="text-[11px] text-[#484f58]">
          Drag &amp; resize on canvas comes later — edit via the Code tab for now.
        </span>
        <span className="text-[11px] text-[#7d8590]">
          renders via API — preview = production
        </span>
      </div>
    </div>
  );
}

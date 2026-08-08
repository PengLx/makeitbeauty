import type { PreviewState } from "../hooks/usePreview";

interface Props {
  preview: PreviewState;
}

/**
 * Live preview panel (right column). The image is the API-rendered SVG via a
 * blob: URL in an <img> — the same constraint set the final image lives under
 * behind GitHub's Camo proxy. The canvas approximates; this is ground truth.
 */
export function PreviewPane({ preview }: Props) {
  const { url, error, loading } = preview;

  return (
    <div className="flex shrink-0 flex-col border-t">
      <div className="flex items-center justify-between px-4 pt-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Preview
        </h2>
        {loading && (
          <span className="text-[10px] text-muted-foreground">rendering…</span>
        )}
      </div>

      <div
        className="relative m-3 flex min-h-28 items-center justify-center overflow-hidden rounded-lg border p-3
          [background-image:radial-gradient(circle,var(--color-border)_1px,transparent_1px)]
          [background-size:12px_12px]"
      >
        {url ? (
          <img
            src={url}
            alt="Design preview"
            className="max-h-52 max-w-full rounded-md shadow-[0_4px_16px_rgba(0,0,0,0.4)]"
          />
        ) : !error ? (
          <p className="text-xs text-muted-foreground">
            {loading ? "Rendering…" : "Waiting for first render…"}
          </p>
        ) : null}

        {error && (
          <div className="absolute inset-x-2 bottom-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
            <p className="text-xs font-medium text-destructive">
              Render failed{" "}
              <span className="font-mono text-[10px] opacity-70">[{error.code}]</span>
            </p>
            <p className="mt-0.5 line-clamp-3 text-[11px] text-foreground">
              {error.message}
            </p>
          </div>
        )}
      </div>

      <p className="px-4 pb-3 text-[10px] text-muted-foreground">
        preview = production render
      </p>
    </div>
  );
}

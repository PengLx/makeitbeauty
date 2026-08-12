import { useMemo, useState } from "react";
import { usePreview } from "../hooks/usePreview";
import { expandForPreview } from "@/lib/expandForPreview";
import type { ComponentDefinition } from "@/lib/component";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  def: ComponentDefinition;
}

/**
 * Studio preview: the §8 contract has no draft-preview route, so the draft is
 * expanded CLIENT-SIDE (lib/expandForPreview.ts — the renderer's expansion
 * semantics for a frame-sized instance at 0,0) with sample prop values, and
 * the resulting plain-node design goes through the ordinary POST /v1/preview.
 * The caption says exactly what this is: a draft preview over sample values —
 * published components render server-side from their immutable versions.
 */
export function StudioPreview({ def }: Props) {
  // Sample values as raw input strings; merge semantics (numeric coercion,
  // fall back to the declared default) live in expandForPreview.
  const [samples, setSamples] = useState<Record<string, string>>({});

  const expanded = useMemo(
    () => (def.nodes.length > 0 ? expandForPreview(def, samples) : null),
    [def, samples],
  );
  const preview = usePreview(expanded?.design ?? null);
  const propNames = Object.keys(def.props);

  return (
    <div className="flex shrink-0 flex-col border-t">
      <div className="flex items-center justify-between px-4 pt-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Preview
        </h2>
        {preview.loading && (
          <span className="text-[10px] text-muted-foreground">rendering…</span>
        )}
      </div>

      {propNames.length > 0 && (
        <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 px-4 pt-2">
          {propNames.map((name) => {
            const decl = def.props[name];
            return (
              <div key={name} className="min-w-0 space-y-0.5">
                <Label
                  htmlFor={`sample-${name}`}
                  className="block truncate font-mono text-[10px] text-muted-foreground"
                  title={decl.description}
                >
                  {name}
                </Label>
                <Input
                  id={`sample-${name}`}
                  type={decl.type === "number" ? "number" : "text"}
                  value={samples[name] ?? String(decl.default)}
                  spellCheck={false}
                  className="h-7 text-xs"
                  onChange={(e) =>
                    setSamples((prev) => ({ ...prev, [name]: e.target.value }))
                  }
                />
              </div>
            );
          })}
        </div>
      )}

      <div
        className="relative m-3 flex min-h-28 items-center justify-center overflow-hidden rounded-lg border p-3
          [background-image:radial-gradient(circle,var(--color-border)_1px,transparent_1px)]
          [background-size:12px_12px]"
      >
        {def.nodes.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Insert a node to see a preview.
          </p>
        ) : preview.url ? (
          <img
            src={preview.url}
            alt="Component draft preview"
            className="max-h-52 max-w-full rounded-md shadow-[0_4px_16px_rgba(0,0,0,0.4)]"
          />
        ) : !preview.error ? (
          <p className="text-xs text-muted-foreground">
            {preview.loading ? "Rendering…" : "Waiting for first render…"}
          </p>
        ) : null}

        {preview.error && (
          <div className="absolute inset-x-2 bottom-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
            <p className="text-xs font-medium text-destructive">
              Render failed{" "}
              <span className="font-mono text-[10px] opacity-70">
                [{preview.error.code}]
              </span>
            </p>
            <p className="mt-0.5 line-clamp-3 text-[11px] text-foreground">
              {preview.error.message}
            </p>
          </div>
        )}
      </div>

      {expanded && expanded.warnings.length > 0 && (
        <p className="px-4 pb-1 text-[10px] text-amber-500">
          {expanded.warnings[0]}
          {expanded.warnings.length > 1 &&
            ` (+${expanded.warnings.length - 1} more)`}
        </p>
      )}
      <p className="px-4 pb-3 text-[10px] text-muted-foreground">
        draft preview (sample values)
      </p>
    </div>
  );
}

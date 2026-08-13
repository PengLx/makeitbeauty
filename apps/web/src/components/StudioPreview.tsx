import { useEffect, useMemo, useState } from "react";
import { Dices } from "lucide-react";
import { usePreview } from "../hooks/usePreview";
import {
  expandForPreview,
  mergeSampleProps,
  wrapCodeNodesForPreview,
} from "@/lib/expandForPreview";
import { loadSandbox } from "@/lib/sandboxClient";
import type { ComponentDefinition } from "@/lib/component";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  def: ComponentDefinition;
}

/** One settled sandbox execution of the draft's render function. */
interface CodeRun {
  nodes: unknown[];
  /** Bounded in-sandbox console output — author debug lines. */
  logs: string[];
}

/** SandboxError surface: code + message verbatim (written for authors). */
interface CodeError {
  code: string;
  message: string;
}

/**
 * Studio preview: the §8 contract has no draft-preview route, so the draft is
 * expanded CLIENT-SIDE (lib/expandForPreview.ts — the renderer's expansion
 * semantics for a frame-sized instance at 0,0) with sample prop values, and
 * the resulting plain-node design goes through the ordinary POST /v1/preview.
 * The caption says exactly what this is: a draft preview over sample values —
 * published components render server-side from their immutable versions.
 *
 * kind "code" drafts (§7.6) run the render function first — debounced
 * ~500 ms through the SAME @makeitbeauty/sandbox engine the renderer uses —
 * and the returned nodes take the identical local wrap → /v1/preview path,
 * so the pixel-parity story holds for code too. SandboxErrors surface inline
 * with their code + message verbatim; in-sandbox console output shows as
 * muted lines under the preview. Series props have no text input: their
 * sample is the declared default array, and the dice button steps a counter
 * that seeds a DETERMINISTIC variation (the sandbox forbids randomness — the
 * sample bar honours the same rule).
 */
export function StudioPreview({ def }: Props) {
  const isCode = def.kind === "code";

  // Sample values as raw input strings; merge semantics (numeric coercion,
  // fall back to the declared default) live in expandForPreview.
  const [samples, setSamples] = useState<Record<string, string>>({});
  // Per-series-prop randomize counter; 0 = the declared default verbatim.
  const [seriesSeeds, setSeriesSeeds] = useState<Record<string, number>>({});

  // The code path's sandbox state. `run` keeps the last good output while a
  // broken edit shows its error — the CodePane "last valid design" idiom.
  const [run, setRun] = useState<CodeRun | null>(null);
  const [codeError, setCodeError] = useState<CodeError | null>(null);
  const [executing, setExecuting] = useState(false);

  const code = def.code ?? "";

  // The exact sandbox input, shared by the effect and the output wrap.
  const mergedProps = useMemo(
    () => (isCode ? mergeSampleProps(def, samples, [], seriesSeeds) : null),
    [isCode, def, samples, seriesSeeds],
  );
  const mergedJson = useMemo(
    () => (mergedProps ? JSON.stringify(mergedProps) : ""),
    [mergedProps],
  );

  useEffect(() => {
    if (!isCode) return;
    if (code.trim() === "") {
      setRun(null);
      setCodeError(null);
      setExecuting(false); // a cancelled in-flight run must not stick the spinner
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setExecuting(true);
      void (async () => {
        try {
          const sandbox = await loadSandbox();
          const result = await sandbox.executeRender(code, {
            props: JSON.parse(mergedJson) as Record<string, unknown>,
            frame: { w: def.frame.w, h: def.frame.h },
          });
          if (cancelled) return;
          setRun({ nodes: result.nodes, logs: result.warnings });
          setCodeError(null);
        } catch (e) {
          if (cancelled) return;
          // SandboxError carries an author-facing code; anything else is an
          // engine-level failure and says so.
          const thrownCode = (e as { code?: unknown } | null)?.code;
          const sandboxCode =
            e instanceof Error && typeof thrownCode === "string"
              ? thrownCode
              : "engine_error";
          setCodeError({
            code: sandboxCode,
            message: e instanceof Error ? e.message : String(e),
          });
        } finally {
          if (!cancelled) setExecuting(false);
        }
      })();
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isCode, code, def.frame.w, def.frame.h, mergedJson]);

  const expanded = useMemo(() => {
    if (isCode) {
      return run && mergedProps
        ? wrapCodeNodesForPreview(def, mergedProps, run.nodes)
        : null;
    }
    return def.nodes.length > 0 ? expandForPreview(def, samples) : null;
  }, [isCode, def, samples, run, mergedProps]);

  const preview = usePreview(expanded?.design ?? null);
  const propNames = Object.keys(def.props);
  const empty = isCode ? run === null && codeError === null : def.nodes.length === 0;

  return (
    <div className="flex shrink-0 flex-col border-t">
      <div className="flex items-center justify-between px-4 pt-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Preview
        </h2>
        {(preview.loading || executing) && (
          <span className="text-[10px] text-muted-foreground">
            {executing ? "running…" : "rendering…"}
          </span>
        )}
      </div>

      {propNames.length > 0 && (
        <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 px-4 pt-2">
          {propNames.map((name) => {
            const decl = def.props[name];
            if (decl.type === "series") {
              const count = Array.isArray(decl.default) ? decl.default.length : 0;
              const seed = seriesSeeds[name] ?? 0;
              return (
                <div key={name} className="min-w-0 space-y-0.5">
                  <Label
                    className="block truncate font-mono text-[10px] text-muted-foreground"
                    title={decl.description}
                  >
                    {name}
                  </Label>
                  <div className="flex h-7 min-w-0 items-center gap-1">
                    <span className="min-w-0 flex-1 truncate rounded-md border px-2 py-1 text-[10px] text-muted-foreground">
                      {count} item{count === 1 ? "" : "s"}
                      {seed > 0 && ` · v${seed}`}
                    </span>
                    <Button
                      variant="outline"
                      size="icon-xs"
                      aria-label={`Randomize sample for ${name}`}
                      title="Deterministic sample variation (same counter, same picture)"
                      onClick={() =>
                        setSeriesSeeds((prev) => ({
                          ...prev,
                          [name]: (prev[name] ?? 0) + 1,
                        }))
                      }
                    >
                      <Dices />
                    </Button>
                  </div>
                </div>
              );
            }
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

      {/* Sandbox failures speak to the author: code + message verbatim —
          these messages were written for exactly this surface. */}
      {codeError && (
        <div className="mx-3 mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
          <p className="text-xs font-medium text-destructive">
            Sandbox error{" "}
            <span className="font-mono text-[10px] opacity-70">
              [{codeError.code}]
            </span>
          </p>
          <p className="mt-0.5 font-mono text-[11px] whitespace-pre-wrap text-foreground">
            {codeError.message}
          </p>
        </div>
      )}

      <div
        className="relative m-3 flex min-h-28 items-center justify-center overflow-hidden rounded-lg border p-3
          [background-image:radial-gradient(circle,var(--color-border)_1px,transparent_1px)]
          [background-size:12px_12px]"
      >
        {empty ? (
          <p className="text-xs text-muted-foreground">
            {isCode
              ? "Write a render function to see a preview."
              : "Insert a node to see a preview."}
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

      {/* In-sandbox console output — the author's debug channel (§7.6). */}
      {isCode && run != null && run.logs.length > 0 && (
        <div className="space-y-0.5 px-4 pb-1">
          {run.logs.map((line, i) => (
            <p
              key={i}
              className="truncate font-mono text-[10px] text-muted-foreground/70"
              title={line}
            >
              {line}
            </p>
          ))}
        </div>
      )}

      {expanded && expanded.warnings.length > 0 && (
        <p className="px-4 pb-1 text-[10px] text-amber-500">
          {expanded.warnings[0]}
          {expanded.warnings.length > 1 &&
            ` (+${expanded.warnings.length - 1} more)`}
        </p>
      )}
      <p className="px-4 pb-3 text-[10px] text-muted-foreground">
        {isCode
          ? "code draft preview — sandbox output, rendered with sample values"
          : "draft preview (sample values)"}
      </p>
    </div>
  );
}

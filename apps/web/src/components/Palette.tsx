import { Square, Type, RefreshCw } from "lucide-react";
import type { KitComponent, KitState } from "@/hooks/useKit";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

interface Props {
  kit: KitState;
  onInsertComponent: (component: KitComponent) => void;
  onInsertText: () => void;
  onInsertRect: () => void;
}

/** Left column: quick-add primitives + the official kit fetched from GET /v1/kit. */
export function Palette({ kit, onInsertComponent, onInsertText, onInsertRect }: Props) {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-card">
      <div className="px-4 pt-3 pb-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Insert
        </h2>
      </div>
      <div className="grid grid-cols-2 gap-2 px-3 pb-3">
        <Button variant="outline" size="sm" onClick={onInsertText}>
          <Type data-icon="inline-start" />
          Text
        </Button>
        <Button variant="outline" size="sm" onClick={onInsertRect}>
          <Square data-icon="inline-start" />
          Rectangle
        </Button>
      </div>

      <Separator />

      <div className="px-4 pt-3 pb-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Components
        </h2>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-3 pb-3">
          {kit.loading ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">Loading kit…</p>
          ) : kit.error ? (
            <div className="space-y-2 rounded-lg border border-dashed p-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                Kit unavailable — is the API running on :7800?
              </p>
              <Button variant="secondary" size="xs" onClick={kit.reload}>
                <RefreshCw data-icon="inline-start" />
                Retry
              </Button>
            </div>
          ) : kit.components.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">
              The kit registry is empty.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {kit.components.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => onInsertComponent(c)}
                    title={c.description}
                    className="w-full rounded-lg border bg-background px-3 py-2 text-left transition-colors
                      hover:border-ring hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium">{c.title}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {c.frame.w}×{c.frame.h}
                      </span>
                    </div>
                    {c.description && (
                      <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {c.description}
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </ScrollArea>
      <Separator />
      <p className="px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
        Click a card to insert it centered on the canvas.
      </p>
    </aside>
  );
}

import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useHoverPreview } from "@/hooks/useHoverPreview";
import type { DesignDoc } from "@/lib/design";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";

interface Props {
  /** Heading inside the floating card. */
  title: string;
  /**
   * Frame size shown in the header immediately when the caller already knows
   * it (kit metadata, templates); community entries pass nothing and the size
   * fills in from the rendered entry.
   */
  frame?: { w: number; h: number };
  /** Cache key — see hooks/useHoverPreview for the namespaces. */
  previewKey: string;
  /** Builds the §7.5 one-instance preview design; may fetch (community). */
  getDesign: () => DesignDoc | Promise<DesignDoc>;
  /** Optional one-liner under the image, e.g. "renders your live data". */
  caption?: string;
  side?: "right" | "top" | "bottom" | "left";
  children: ReactNode;
}

/**
 * Floating rendered preview for a palette/template card. The trigger wraps
 * the existing insert button unchanged (asChild): clicking inserts exactly as
 * before, with or without the card open, and keyboard focus opens the same
 * card Radix-side (touch simply never opens it — hover previews are an
 * enhancement, not a path to any functionality).
 *
 * Render-storm hygiene: HoverCard's openDelay (200 ms) gates INTENT, and the
 * fetch keys off onOpenChange — which fires after that delay — so skimming
 * the list costs zero renderer calls; a second hover is a cache hit.
 */
export function PreviewHoverCard({
  title,
  frame,
  previewKey,
  getDesign,
  caption,
  side = "right",
  children,
}: Props) {
  const [open, setOpen] = useState(false);
  const preview = useHoverPreview(previewKey, getDesign, open);
  const size = frame ?? preview.size;

  return (
    <HoverCard openDelay={200} closeDelay={100} onOpenChange={setOpen}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      {/* data-hover-preview + pointer-events-none make the floating card
          fully inert (index.css turns off the popper wrapper too): a card
          hanging over the canvas passes clicks/drags straight through, and
          leaving the trigger always closes it — the content can never hold
          it open with its own hover. */}
      <HoverCardContent
        data-hover-preview
        side={side}
        align="start"
        sideOffset={8}
        className="pointer-events-none w-auto max-w-[324px] select-none"
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-xs font-medium">{title}</span>
          {size && (
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {size.w}×{size.h}
            </span>
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-center">
          {preview.url ? (
            <img
              src={preview.url}
              alt={`Rendered preview of ${title}`}
              className="h-auto max-h-56 w-auto max-w-[300px] rounded-md"
            />
          ) : preview.error ? (
            <p className="px-6 py-4 text-[11px] text-muted-foreground">
              preview unavailable
            </p>
          ) : (
            <div className="flex h-16 w-40 items-center justify-center rounded-md bg-muted/50">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
        {caption && preview.url && (
          <p className="mt-1.5 text-[10px] text-muted-foreground">{caption}</p>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

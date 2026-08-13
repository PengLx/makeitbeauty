import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const CHIP_BASE =
  "inline-flex shrink-0 items-center rounded-full border px-1.5 py-px font-mono text-[10px] leading-4";

interface Props {
  /** Lowercase category slug, shown verbatim (slugs read better unmapped). */
  category: string;
  /** Filter-facet state; only meaningful with onToggle. */
  active?: boolean;
  /** When present the chip is a toggle button (community category facet). */
  onToggle?: () => void;
}

/**
 * Tiny muted category chip. Display-only by default (palette "My components"
 * rows, ComponentList cards); with `onToggle` it becomes the community
 * browse's category filter facet — active state is unmistakable (accent
 * border + an × affordance) because toggling changes server results.
 */
export function CategoryChip({ category, active = false, onToggle }: Props) {
  if (!onToggle) {
    return (
      <span className={cn(CHIP_BASE, "text-muted-foreground")}>{category}</span>
    );
  }
  return (
    <button
      type="button"
      aria-pressed={active}
      title={
        active
          ? "Clear category filter"
          : `Show only “${category}” community components`
      }
      onClick={onToggle}
      className={cn(
        CHIP_BASE,
        "transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        active
          ? "border-sky-500 bg-sky-500/10 text-sky-400 hover:bg-sky-500/20"
          : "text-muted-foreground hover:border-ring hover:text-foreground",
      )}
    >
      {category}
      {active && <X className="ml-1 size-2.5" aria-hidden />}
    </button>
  );
}

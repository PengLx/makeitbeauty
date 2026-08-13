import { Braces, Database, Grid3x3, Magnet } from "lucide-react";
import { GRID_SIZES, type SnapSettings } from "@/lib/snapping";
import type { CanvasDisplayMode } from "@/lib/canvasDisplay";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface Props {
  settings: SnapSettings;
  onChange: (next: SnapSettings) => void;
  /**
   * Editor-only Data/Variables canvas display toggle (persisted via
   * useCanvasDisplay). Omit BOTH props to hide it — the Component Studio
   * does: §7.5 keeps connector data out of the Studio, so props resolution
   * there is not toggleable.
   */
  display?: CanvasDisplayMode;
  onDisplayChange?: (next: CanvasDisplayMode) => void;
}

const SHIFT_HINT = "Hold Shift to invert snapping while dragging";

/**
 * Floating canvas controls at the top of the canvas area, shared by the
 * project Editor and the Component Studio (drop it inside any `relative`
 * container wrapping a DesignCanvas). Snap state lives in the parent view via
 * useSnapSettings so both surfaces persist to the same key; the display
 * toggle appears only when the parent wires it (Editor).
 */
export function CanvasToolbar({ settings, onChange, display, onDisplayChange }: Props) {
  return (
    <div
      role="toolbar"
      aria-label="Canvas options"
      className="absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1
        rounded-lg border bg-card/90 p-1 shadow-lg backdrop-blur-sm"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={settings.grid ? "secondary" : "ghost"}
            size="icon-sm"
            aria-pressed={settings.grid}
            aria-label="Snap to grid"
            onClick={() => onChange({ ...settings, grid: !settings.grid })}
          >
            <Grid3x3 className={settings.grid ? undefined : "text-muted-foreground"} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Snap to grid · {SHIFT_HINT}
        </TooltipContent>
      </Tooltip>

      <Select
        value={String(settings.gridSize)}
        onValueChange={(v) =>
          onChange({ ...settings, gridSize: Number(v) as SnapSettings["gridSize"] })
        }
      >
        <SelectTrigger
          size="sm"
          aria-label="Grid size"
          className="w-[4.75rem] font-mono text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {GRID_SIZES.map((size) => (
            <SelectItem key={size} value={String(size)} className="font-mono text-xs">
              {size}px
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Separator orientation="vertical" className="h-4!" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={settings.objects ? "secondary" : "ghost"}
            size="icon-sm"
            aria-pressed={settings.objects}
            aria-label="Snap to objects"
            onClick={() => onChange({ ...settings, objects: !settings.objects })}
          >
            <Magnet
              className={settings.objects ? undefined : "text-muted-foreground"}
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Snap to objects &amp; canvas edges · {SHIFT_HINT}
        </TooltipContent>
      </Tooltip>

      {display !== undefined && onDisplayChange && (
        <>
          <Separator orientation="vertical" className="h-4!" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={display === "data" ? "secondary" : "ghost"}
                size="icon-sm"
                aria-pressed={display === "data"}
                aria-label="Show live data on canvas"
                onClick={() =>
                  onDisplayChange(display === "data" ? "variables" : "data")
                }
              >
                {display === "data" ? (
                  <Database />
                ) : (
                  <Braces className="text-muted-foreground" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {display === "data"
                ? "Showing live data — {{bindings}} render their resolved values, like production. Click for raw variables."
                : "Showing variables — {{bindings}} stay literal for editing. Click for live data."}
            </TooltipContent>
          </Tooltip>
        </>
      )}
    </div>
  );
}

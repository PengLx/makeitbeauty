import { useCallback, useState } from "react";
import {
  CANVAS_DISPLAY_STORAGE_KEY,
  parseCanvasDisplay,
  serializeCanvasDisplay,
  type CanvasDisplayMode,
} from "@/lib/canvasDisplay";

/**
 * The Editor's canvas Data/Variables display toggle, loaded from and
 * persisted to localStorage "mib.canvasData" — the useSnapSettings pattern
 * with its own key. Editor-only: the Component Studio never mounts this
 * (props resolution there is not toggleable, §7.5).
 */
export function useCanvasDisplay(): [CanvasDisplayMode, (next: CanvasDisplayMode) => void] {
  const [mode, setMode] = useState<CanvasDisplayMode>(() => {
    try {
      return parseCanvasDisplay(localStorage.getItem(CANVAS_DISPLAY_STORAGE_KEY));
    } catch {
      return parseCanvasDisplay(null); // storage unavailable
    }
  });
  const update = useCallback((next: CanvasDisplayMode) => {
    setMode(next);
    try {
      localStorage.setItem(CANVAS_DISPLAY_STORAGE_KEY, serializeCanvasDisplay(next));
    } catch {
      /* private mode / quota — the in-memory setting still applies */
    }
  }, []);
  return [mode, update];
}

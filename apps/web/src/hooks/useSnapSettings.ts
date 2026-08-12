import { useCallback, useState } from "react";
import {
  DEFAULT_SNAP_SETTINGS,
  GRID_SIZES,
  type SnapSettings,
} from "@/lib/snapping";

/** One shared key so snap preferences follow the user across Editor and Studio. */
export const SNAP_STORAGE_KEY = "mib.snap";

function loadSnapSettings(): SnapSettings {
  try {
    const raw = localStorage.getItem(SNAP_STORAGE_KEY);
    if (!raw) return DEFAULT_SNAP_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_SNAP_SETTINGS;
    const p = parsed as Record<string, unknown>;
    return {
      grid: typeof p.grid === "boolean" ? p.grid : DEFAULT_SNAP_SETTINGS.grid,
      gridSize: (GRID_SIZES as readonly number[]).includes(p.gridSize as number)
        ? (p.gridSize as SnapSettings["gridSize"])
        : DEFAULT_SNAP_SETTINGS.gridSize,
      objects:
        typeof p.objects === "boolean" ? p.objects : DEFAULT_SNAP_SETTINGS.objects,
    };
  } catch {
    return DEFAULT_SNAP_SETTINGS; // corrupt JSON / storage unavailable
  }
}

/**
 * Snap preferences for one canvas view (Editor or Component Studio), loaded
 * from and persisted to localStorage "mib.snap". State is lifted per view;
 * the shared key means whichever view you tune last wins on next open.
 */
export function useSnapSettings(): [SnapSettings, (next: SnapSettings) => void] {
  const [settings, setSettings] = useState<SnapSettings>(loadSnapSettings);
  const update = useCallback((next: SnapSettings) => {
    setSettings(next);
    try {
      localStorage.setItem(SNAP_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* private mode / quota — the in-memory setting still applies */
    }
  }, []);
  return [settings, update];
}

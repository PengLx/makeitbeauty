/**
 * The Editor canvas's template display mode (the founder ask: show the
 * preview's resolved values ON the canvas, reverting to variable form while
 * editing):
 *
 * - "data" (default): {{connector.*}} templates render their RESOLVED values
 *   from GET /v1/connectors/data — the canvas looks like production.
 * - "variables": templates stay literal ({{github.user.login}}), the honest
 *   editing view when you need to see what is bound where.
 *
 * Editing surfaces (Inspector textarea, prop BindingControls, the Code tab)
 * always show the raw template form regardless of this mode; the mode only
 * affects canvas DISPLAY. The Component Studio has no such toggle — §7.5
 * keeps connector data out of the Studio entirely (props-only).
 *
 * Persistence follows the "mib.snap" pattern (useSnapSettings) under its own
 * key. Parse/serialize are pure so the persistence semantics are testable
 * without a DOM.
 */

export type CanvasDisplayMode = "data" | "variables";

export const CANVAS_DISPLAY_STORAGE_KEY = "mib.canvasData";

export const DEFAULT_CANVAS_DISPLAY: CanvasDisplayMode = "data";

/**
 * Parse a persisted value (localStorage.getItem result) back into a mode.
 * Anything unexpected — null, corrupt JSON, an unknown mode string — falls
 * back to the default rather than throwing.
 */
export function parseCanvasDisplay(raw: string | null): CanvasDisplayMode {
  if (raw === null) return DEFAULT_CANVAS_DISPLAY;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed === "data" || parsed === "variables" ? parsed : DEFAULT_CANVAS_DISPLAY;
  } catch {
    return DEFAULT_CANVAS_DISPLAY;
  }
}

/** Serialize a mode for storage — the JSON inverse of parseCanvasDisplay. */
export function serializeCanvasDisplay(mode: CanvasDisplayMode): string {
  return JSON.stringify(mode);
}

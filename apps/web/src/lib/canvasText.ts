/**
 * Canvas text parity constants — the renderer's text defaults, pinned.
 *
 * KEEP IN SYNC WITH apps/renderer/src/tree.ts (textEl) AND
 * apps/renderer/src/fonts.ts (DEFAULT_FONT_FAMILY). canvasText.test.ts is the
 * tripwire: it asserts these values AND greps the renderer sources, so either
 * side drifting fails the web suite.
 *
 * WHY: the editor chrome uses Geist, but the renderer lays text out in Inter
 * (satori embeds apps/renderer/fonts/*.ttf — Regular + Bold per the repo's
 * `make fonts`). A canvas that measures text in a different face — or
 * inherits the chrome's Tailwind line-height of 1.5 — wraps and sizes text
 * differently from the preview, which is exactly the fidelity gap the canvas
 * exists to avoid. So canvas NODE CONTENT renders in self-hosted Inter
 * (@fontsource/inter latin 400+700, imported in index.css — the same two
 * weights the renderer loads; browsers match other weights to the nearest
 * face just like satori does) with every renderer default pinned explicitly,
 * never inherited from the chrome.
 *
 * Defaults tree.ts does NOT set (satori built-ins) that the canvas must pin
 * anyway because the surrounding chrome would otherwise leak in:
 * - lineHeight: satori resolves "normal" from the font's own metrics; the
 *   browser's "normal" over the same Inter face matches. Left unpinned the
 *   canvas would inherit Tailwind preflight's 1.5.
 * - letterSpacing: satori default is normal (0); pinned against inherited
 *   tracking-* utilities.
 * Overflow stays visible and text wraps at the box width in both satori and
 * the browser — no pin needed.
 */
import type { CSSProperties } from "react";
import type { TextAlign } from "./design";

/** apps/renderer/src/fonts.ts DEFAULT_FONT_FAMILY — the renderer's face. */
export const RENDERER_FONT_FAMILY = "Inter";

/**
 * Canvas font stack: the renderer's face first (self-hosted), generic
 * fallback only — never Geist, so a slow font load degrades to a neutral
 * sans instead of silently measuring in the chrome's face.
 */
export const CANVAS_FONT_STACK = `${RENDERER_FONT_FAMILY}, sans-serif`;

/** tree.ts textEl hard defaults (defaults < tw < frame < structured). */
export const RENDERER_TEXT_FONT_SIZE = 16;
export const RENDERER_TEXT_FONT_WEIGHT = 400;
export const RENDERER_TEXT_COLOR = "#000000";
/** tree.ts: `const align = s.align ?? "left"`. */
export const RENDERER_TEXT_ALIGN_DEFAULT: TextAlign = "left";

/**
 * tree.ts textEl align → flex justify-content mapping:
 * center → center, right → flex-end, left (default) → flex-start.
 */
export function textJustify(align: TextAlign): "flex-start" | "center" | "flex-end" {
  return align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start";
}

/** tree.ts structured letterSpacing: number of px → CSS length. */
export function letterSpacingPx(letterSpacing: number): string {
  return `${letterSpacing}px`;
}

/**
 * The full default layer for a canvas text node — tree.ts textEl's hard
 * defaults plus the satori built-ins pinned per the module comment. Layered
 * UNDER tw and structured styles (§5.6 merge order).
 */
export const CANVAS_TEXT_DEFAULTS: CSSProperties = {
  fontFamily: CANVAS_FONT_STACK,
  fontSize: RENDERER_TEXT_FONT_SIZE,
  fontWeight: RENDERER_TEXT_FONT_WEIGHT,
  color: RENDERER_TEXT_COLOR,
  lineHeight: "normal",
  letterSpacing: "normal",
};

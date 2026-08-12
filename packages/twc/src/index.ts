// @makeitbeauty/twc — deterministic Tailwind-subset compiler.
//
// Contract: docs/architecture.md section 5.6. Nodes and the canvas carry an
// optional `tw` utility string; this module compiles it to a flat style
// object containing only satori-supported, sanitizer-safe CSS properties.
// Shared by renderer and editor so semantics never drift.
//
// Policy:
// - Whitelist: unknown or unsupported classes produce a warning and are
//   dropped — never failures, never passthrough.
// - Conflicts: last class wins per emitted property (Tailwind semantics).
// - Determinism: same input -> deep-equal output. No environment reads, no
//   randomness, no runtime color math (the palette is baked in).
// - Defense in depth: any value containing url(, var(, ";" or a newline is
//   dropped with a warning. The compiler can only emit vetted properties,
//   and the SVG output sanitizer remains the final gate downstream.

import { PALETTE, NAMED_COLORS } from "./palette.js";

export { PALETTE, NAMED_COLORS } from "./palette.js";
export { CATALOG } from "./catalog.js";
export type { CatalogEntry } from "./catalog.js";

export interface CompileResult {
  /** camelCase CSS properties; numbers for fontWeight/lineHeight/opacity. */
  style: Record<string, string | number>;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Static tables
// ---------------------------------------------------------------------------

/** bg-gradient-to-{dir} -> CSS linear-gradient angle in degrees. */
const GRADIENT_ANGLES: Readonly<Record<string, number>> = {
  t: 0,
  tr: 45,
  r: 90,
  br: 135,
  b: 180,
  bl: 225,
  l: 270,
  tl: 315,
};

const FONT_WEIGHTS: Readonly<Record<string, number>> = {
  thin: 100,
  extralight: 200,
  light: 300,
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  extrabold: 800,
  black: 900,
};

/** Tailwind tracking scale (em) converted to px on a 16px basis. */
const TRACKING: Readonly<Record<string, string>> = {
  tighter: "-0.8px",
  tight: "-0.4px",
  normal: "0px",
  wide: "0.4px",
  wider: "0.8px",
  widest: "1.6px",
};

const LEADING: Readonly<Record<string, number>> = {
  none: 1,
  tight: 1.25,
  snug: 1.375,
  normal: 1.5,
  relaxed: 1.625,
  loose: 2,
};

const RADII: Readonly<Record<string, string>> = {
  none: "0px",
  sm: "2px",
  md: "6px",
  lg: "8px",
  xl: "12px",
  "2xl": "16px",
  "3xl": "24px",
  full: "9999px",
};

/** Standard Tailwind box-shadow strings, hardcoded verbatim (deterministic). */
const SHADOWS: Readonly<Record<string, string>> = {
  DEFAULT: "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
  sm: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
  md: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
  lg: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
  xl: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
  "2xl": "0 25px 50px -12px rgb(0 0 0 / 0.25)",
  none: "none",
};

// ---------------------------------------------------------------------------
// Value grammars
// ---------------------------------------------------------------------------

/**
 * Hostile-content gate: url()/var() (function or split by whitespace),
 * declaration separators, newlines. Checked against the raw class token AND
 * the underscore-decoded arbitrary value (defense in depth — the schema color
 * pattern and the SVG sanitizer are downstream gates too).
 */
const HOSTILE = /url\s*\(|var\s*\(|;|[\r\n]/i;

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB_RE = /^rgba?\((?=[^)]*\d)[0-9.,%\s/]+\)$/;
// letters restricted to d/e/g so only unit suffixes like "deg" can appear
const HSL_RE = /^hsla?\((?=[^)]*\d)[0-9.,%\s/deg-]+\)$/;

/** px length, decimals allowed, optionally negative (for letterSpacing). */
const PX_RE = /^-?(?:\d+|\d*\.\d+)px$/;
/** Non-negative px length. */
const POS_PX_RE = /^(?:\d+|\d*\.\d+)px$/;
/** Unitless non-negative number (lineHeight). */
const UNITLESS_RE = /^(?:\d+|\d*\.\d+)$/;
/** 0..100 in steps of 5. */
const OPACITY_STEP_RE = /^(?:100|[1-9]?[05])$/;
/** Fraction 0..1 for opacity-[..]. */
const OPACITY_FRACTION_RE = /^(?:0|1|1\.0|0?\.\d+)$/;
/** Spacing scale index 0..12. */
const PAD_STEP_RE = /^(?:\d|1[0-2])$/;

function isColorValue(v: string): boolean {
  return (
    HEX_RE.test(v) ||
    RGB_RE.test(v) ||
    HSL_RE.test(v) ||
    NAMED_COLORS.has(v.toLowerCase())
  );
}

type Arbitrary = { value: string } | { hostile: true } | null;

/**
 * Decode a Tailwind arbitrary value: `[...]` with `_` meaning space.
 * Returns null when `raw` is not bracketed, `{hostile}` when the decoded
 * content trips the hostile gate, `{value}` otherwise (may still be invalid
 * for the family's grammar — callers validate).
 */
function arbitrary(raw: string): Arbitrary {
  if (!raw.startsWith("[") || !raw.endsWith("]") || raw.length < 3) return null;
  const decoded = raw.slice(1, -1).replace(/_/g, " ").trim();
  if (HOSTILE.test(decoded)) return { hostile: true };
  return { value: decoded };
}

type ColorResult = { ok: string } | { hostile: true } | { bad: true };

/** Resolve a color token: palette name, or bracketed hex/rgb()/hsl()/named. */
function resolveColor(raw: string): ColorResult {
  const arb = arbitrary(raw);
  if (arb !== null) {
    if ("hostile" in arb) return { hostile: true };
    if (isColorValue(arb.value)) return { ok: arb.value.toLowerCase() };
    return { bad: true };
  }
  const hit = PALETTE[raw];
  if (hit !== undefined) return { ok: hit };
  return { bad: true };
}

// ---------------------------------------------------------------------------
// Strict shadow grammar for shadow-[...]
// ---------------------------------------------------------------------------

/**
 * Split at top level (outside parentheses). Separator characters inside
 * rgb()/hsl() are preserved. Returns null on unbalanced parens.
 */
function splitTopLevel(
  v: string,
  isSep: (c: string) => boolean,
  keepEmpty: boolean,
): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of v) {
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth < 0) return null;
    }
    if (depth === 0 && isSep(ch)) {
      if (keepEmpty || cur !== "") parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (depth !== 0) return null;
  if (keepEmpty || cur !== "") parts.push(cur);
  return parts;
}

const SHADOW_LENGTH_RE = /^-?(?:\d+|\d*\.\d+)(?:px|em|rem)?$/;

/** One shadow: optional inset, 2-4 lengths, at most one color. */
function isValidShadow(part: string): boolean {
  const tokens = splitTopLevel(part.trim(), (c) => c === " " || c === "\t", false);
  if (tokens === null || tokens.length === 0) return false;
  let lengths = 0;
  let colors = 0;
  let insets = 0;
  for (const t of tokens) {
    if (t === "inset") {
      insets++;
      continue;
    }
    if (SHADOW_LENGTH_RE.test(t)) {
      // a unitless length is only valid when it is zero
      if (!/(?:px|em|rem)$/.test(t) && parseFloat(t) !== 0) return false;
      lengths++;
      continue;
    }
    if (isColorValue(t)) {
      colors++;
      continue;
    }
    return false; // no other token kind exists in the grammar
  }
  return lengths >= 2 && lengths <= 4 && colors <= 1 && insets <= 1;
}

/** Comma-separated list of shadows, every entry valid. */
function isValidShadowList(v: string): boolean {
  const parts = splitTopLevel(v, (c) => c === ",", true);
  if (parts === null || parts.length === 0) return false;
  return parts.every(isValidShadow);
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

interface GradientState {
  angle: number | null;
  from: string | null;
  via: string | null;
  to: string | null;
}

/**
 * Compile a `tw` utility string into a flat style object.
 *
 * Pure and deterministic: same input -> deep-equal output. Unknown classes
 * and invalid values warn and are dropped; later classes win per property.
 */
export function compileTw(tw: string): CompileResult {
  const style: Record<string, string | number> = {};
  const warnings: string[] = [];
  const grad: GradientState = { angle: null, from: null, via: null, to: null };

  const unknown = (cls: string): void => {
    warnings.push(`unknown or unsupported class: ${cls}`);
  };
  const unsafe = (cls: string): void => {
    warnings.push(`unsafe value dropped: ${cls}`);
  };

  /** Shared handling for the color families (bg-, text-, border-, stops). */
  const applyColor = (cls: string, raw: string, apply: (v: string) => void): void => {
    const res = resolveColor(raw);
    if ("ok" in res) apply(res.ok);
    else if ("hostile" in res) unsafe(cls);
    else unknown(cls);
  };

  for (const cls of tw.split(/\s+/)) {
    if (cls === "") continue;

    // Defense in depth: hostile content anywhere in the token.
    if (HOSTILE.test(cls)) {
      unsafe(cls);
      continue;
    }

    // -- gradients ---------------------------------------------------------
    if (cls.startsWith("bg-gradient-to-")) {
      const angle = GRADIENT_ANGLES[cls.slice("bg-gradient-to-".length)];
      if (angle === undefined) unknown(cls);
      else grad.angle = angle;
      continue;
    }
    if (cls.startsWith("from-")) {
      applyColor(cls, cls.slice(5), (v) => {
        grad.from = v;
      });
      continue;
    }
    if (cls.startsWith("via-")) {
      applyColor(cls, cls.slice(4), (v) => {
        grad.via = v;
      });
      continue;
    }
    if (cls.startsWith("to-")) {
      applyColor(cls, cls.slice(3), (v) => {
        grad.to = v;
      });
      continue;
    }

    // -- colors --------------------------------------------------------------
    if (cls.startsWith("bg-")) {
      applyColor(cls, cls.slice(3), (v) => {
        style.backgroundColor = v;
      });
      continue;
    }
    if (cls.startsWith("text-")) {
      applyColor(cls, cls.slice(5), (v) => {
        style.color = v;
      });
      continue;
    }

    // -- typography ----------------------------------------------------------
    if (cls.startsWith("font-")) {
      const rest = cls.slice(5);
      const named = FONT_WEIGHTS[rest];
      if (named !== undefined) style.fontWeight = named;
      else if (/^[1-9]00$/.test(rest)) style.fontWeight = Number(rest);
      else unknown(cls);
      continue;
    }
    if (cls.startsWith("tracking-")) {
      const rest = cls.slice(9);
      const named = TRACKING[rest];
      if (named !== undefined) {
        style.letterSpacing = named;
        continue;
      }
      const arb = arbitrary(rest);
      if (arb === null) unknown(cls);
      else if ("hostile" in arb) unsafe(cls);
      else if (PX_RE.test(arb.value)) style.letterSpacing = arb.value;
      else unknown(cls);
      continue;
    }
    if (cls.startsWith("leading-")) {
      const rest = cls.slice(8);
      const named = LEADING[rest];
      if (named !== undefined) {
        style.lineHeight = named;
        continue;
      }
      const arb = arbitrary(rest);
      if (arb === null) unknown(cls);
      else if ("hostile" in arb) unsafe(cls);
      else if (UNITLESS_RE.test(arb.value)) style.lineHeight = Number(arb.value);
      else unknown(cls);
      continue;
    }

    // -- radius --------------------------------------------------------------
    if (cls === "rounded") {
      style.borderRadius = "4px";
      continue;
    }
    if (cls.startsWith("rounded-")) {
      const rest = cls.slice(8);
      const named = RADII[rest];
      if (named !== undefined) {
        style.borderRadius = named;
        continue;
      }
      const arb = arbitrary(rest);
      if (arb === null) unknown(cls);
      else if ("hostile" in arb) unsafe(cls);
      else if (POS_PX_RE.test(arb.value)) style.borderRadius = arb.value;
      else unknown(cls);
      continue;
    }

    // -- borders ---------------------------------------------------------------
    if (cls === "border") {
      style.borderWidth = "1px";
      style.borderStyle = "solid";
      continue;
    }
    if (cls.startsWith("border-")) {
      const rest = cls.slice(7);
      if (rest === "0" || rest === "2" || rest === "4" || rest === "8") {
        style.borderWidth = `${rest}px`;
        style.borderStyle = "solid";
        continue;
      }
      applyColor(cls, rest, (v) => {
        style.borderColor = v;
      });
      continue;
    }

    // -- shadows ---------------------------------------------------------------
    if (cls === "shadow") {
      style.boxShadow = SHADOWS.DEFAULT;
      continue;
    }
    if (cls.startsWith("shadow-")) {
      const rest = cls.slice(7);
      const named = rest === "DEFAULT" ? undefined : SHADOWS[rest];
      if (named !== undefined) {
        style.boxShadow = named;
        continue;
      }
      const arb = arbitrary(rest);
      if (arb === null) unknown(cls);
      else if ("hostile" in arb) unsafe(cls);
      else if (isValidShadowList(arb.value)) style.boxShadow = arb.value;
      else unknown(cls);
      continue;
    }

    // -- opacity ------------------------------------------------------------------
    if (cls.startsWith("opacity-")) {
      const rest = cls.slice(8);
      const arb = arbitrary(rest);
      if (arb !== null) {
        if ("hostile" in arb) unsafe(cls);
        else if (OPACITY_FRACTION_RE.test(arb.value)) style.opacity = Number(arb.value);
        else unknown(cls);
      } else if (OPACITY_STEP_RE.test(rest)) {
        style.opacity = Number(rest) / 100;
      } else {
        unknown(cls);
      }
      continue;
    }

    // -- padding -----------------------------------------------------------------
    if (cls.startsWith("p-") || cls.startsWith("px-") || cls.startsWith("py-")) {
      const axis = cls[1] === "-" ? "" : cls[1];
      const rest = cls.slice(axis === "" ? 2 : 3);
      if (!PAD_STEP_RE.test(rest)) {
        unknown(cls);
        continue;
      }
      const px = `${Number(rest) * 4}px`;
      if (axis === "" || axis === "y") {
        style.paddingTop = px;
        style.paddingBottom = px;
      }
      if (axis === "" || axis === "x") {
        style.paddingLeft = px;
        style.paddingRight = px;
      }
      continue;
    }

    unknown(cls);
  }

  // -- assemble the gradient (stop order: from 0%, via 50%, to 100%) --------
  if (grad.angle !== null) {
    if (grad.from === null && grad.via === null && grad.to === null) {
      warnings.push(
        "gradient direction without color stops: add from-/via-/to-",
      );
    } else {
      const stops = [`${grad.from ?? "transparent"} 0%`];
      if (grad.via !== null) stops.push(`${grad.via} 50%`);
      stops.push(`${grad.to ?? "transparent"} 100%`);
      style.backgroundImage = `linear-gradient(${grad.angle}deg, ${stops.join(", ")})`;
    }
  } else if (grad.from !== null || grad.via !== null || grad.to !== null) {
    warnings.push(
      "gradient stops without a direction: add bg-gradient-to-{t|tr|r|br|b|bl|l|tl}",
    );
  }

  return { style, warnings };
}

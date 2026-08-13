/**
 * Font-system client logic (pure — no DOM), shared by the Inspector's family
 * picker, the upload dialog and the canvas parity layer.
 *
 * The contract (docs/architecture.md §5 + the font track): built-in families
 * (Inter/JetBrains Mono/Lora, OFL, embedded server-side) are usable by
 * everyone and are the ONLY families community components may reference; a
 * user's uploaded TTF/OTF/WOFF fonts are private to their own designs. WOFF2
 * is rejected everywhere — satori (the renderer's layout engine) cannot parse
 * it — with a message that explains why, not just "invalid file".
 */
import type { FontList } from "./api";
import type { DesignDoc } from "./design";
import { RENDERER_FONT_FAMILY, CANVAS_FONT_STACK } from "./canvasText";

/** The renderer's default family; a picker value of Inter drops the key. */
export const DEFAULT_FONT_FAMILY = RENDERER_FONT_FAMILY;

/**
 * Built-in families pinned client-side so the picker works with the API down
 * (GET /v1/fonts serves the same list; fontPickerGroups unions defensively).
 * KEEP IN SYNC with the renderer's embedded faces — 400 + 700 each, latin
 * subsets self-hosted for the canvas via @fontsource imports in index.css.
 */
export const BUILTIN_FONTS: { family: string; weights: number[] }[] = [
  { family: "Inter", weights: [400, 700] },
  { family: "JetBrains Mono", weights: [400, 700] },
  { family: "Lora", weights: [400, 700] },
];

/** Server-side limits, mirrored for instant client-side feedback. */
export const FONT_MAX_BYTES = 5 * 1024 * 1024;
export const FONT_MAX_COUNT = 10;
/** The upload input's accept attribute (WOFF2 deliberately absent). */
export const FONT_FILE_ACCEPT = ".ttf,.otf,.woff";

export const WOFF2_MESSAGE =
  "WOFF2 isn't supported: the render pipeline's layout engine (satori) " +
  "cannot parse WOFF2 files. Convert the font to TTF, OTF or WOFF " +
  "(e.g. with fonttools' woff2 decompressor) and upload that instead.";

export type FontFormat = "ttf" | "otf" | "woff" | "woff2";

/**
 * Magic-byte sniff over the file's first four bytes — the same signatures the
 * API validates server-side: 0x00010000 or "true" (Apple sfnt) = TTF,
 * "OTTO" = OTF, "wOFF" = WOFF, "wOF2" = WOFF2. null = not a font we know.
 */
export function sniffFontFormat(bytes: Uint8Array): FontFormat | null {
  if (bytes.length < 4) return null;
  const [b0, b1, b2, b3] = [bytes[0], bytes[1], bytes[2], bytes[3]];
  const tag = String.fromCharCode(b0, b1, b2, b3);
  if ((b0 === 0x00 && b1 === 0x01 && b2 === 0x00 && b3 === 0x00) || tag === "true")
    return "ttf";
  if (tag === "OTTO") return "otf";
  if (tag === "wOFF") return "woff";
  if (tag === "wOF2") return "woff2";
  return null;
}

export interface FontFileError {
  code: string;
  message: string;
}

/**
 * Client-side pre-checks before POST /v1/fonts — the server re-validates all
 * of it (the accept attribute and this function are UX, not a boundary).
 * Checked in order: WOFF2 (by extension OR magic, with the explanatory
 * message), extension, size, magic bytes. null = looks uploadable.
 */
export function validateFontFile(
  name: string,
  size: number,
  bytes: Uint8Array,
): FontFileError | null {
  const format = sniffFontFormat(bytes);
  if (/\.woff2$/i.test(name) || format === "woff2")
    return { code: "woff2_unsupported", message: WOFF2_MESSAGE };
  if (!/\.(ttf|otf|woff)$/i.test(name))
    return {
      code: "bad_extension",
      message: "Choose a .ttf, .otf or .woff file.",
    };
  if (size > FONT_MAX_BYTES)
    return {
      code: "file_too_large",
      message: `This file is ${(size / (1024 * 1024)).toFixed(1)} MB — the limit is 5 MB per font.`,
    };
  if (format === null)
    return {
      code: "unrecognized_font",
      message:
        "This file doesn't look like a font — its signature matches none of TTF, OTF or WOFF.",
    };
  return null;
}

/**
 * Weight/style suffix tokens dropped from filename-derived family names:
 * "Lora-Bold.ttf" prefills "Lora", not "Lora Bold" — the weight select
 * carries that information.
 */
const SUFFIX_TOKENS = new Set([
  "thin", "hairline", "extralight", "ultralight", "light", "regular",
  "normal", "book", "roman", "text", "medium", "semibold", "demibold",
  "bold", "extrabold", "ultrabold", "black", "heavy", "italic", "oblique",
  // Halves left behind when camelCase splitting divides "ExtraBold" etc.
  "extra", "ultra", "semi", "demi",
  "100", "200", "300", "400", "500", "600", "700", "800", "900",
  "variablefont", "vf", "webfont",
]);

/**
 * Prefill for the upload dialog's family field (editable — this only needs
 * to be sane, not perfect): extension off, separators to spaces, camelCase
 * split ("OpenSans-Bold.ttf" → "Open Sans"; the cost is "JetBrainsMono" →
 * "Jet Brains Mono", which the user can fix in one edit), trailing
 * weight/style tokens dropped, all-lowercase words title-cased, quotes and
 * backslashes stripped (they'd complicate CSS font-family values), capped
 * at 64 chars.
 */
export function familyFromFilename(filename: string): string {
  let base = filename.replace(/\.[a-z0-9]+$/i, "");
  base = base.replace(/["'\\]/g, "");
  base = base.replace(/[_\-.+]+/g, " ");
  base = base.replace(/([a-z])([A-Z])/g, "$1 $2");
  const words = base.split(/\s+/).filter(Boolean);
  while (words.length > 1 && SUFFIX_TOKENS.has(words[words.length - 1].toLowerCase())) {
    words.pop();
  }
  return words
    .map((w) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ")
    .slice(0, 64)
    .trim();
}

/**
 * Canvas font stack for a text node's structured fontFamily: the family
 * first, then the renderer-parity Inter stack (lib/canvasText.ts) so an
 * unloaded/unknown face degrades exactly like the renderer's fallback —
 * to Inter, never to the chrome's Geist. Families that aren't simple CSS
 * identifiers get quoted; Inter/absent collapse to the plain stack.
 */
export function fontStackFor(family: string | undefined): string {
  if (!family || family === DEFAULT_FONT_FAMILY) return CANVAS_FONT_STACK;
  const cleaned = family.replace(/["'\\]/g, "");
  const term = /^[a-zA-Z][a-zA-Z0-9-]*$/.test(cleaned) ? cleaned : `"${cleaned}"`;
  return `${term}, ${CANVAS_FONT_STACK}`;
}

/**
 * Unique structured font families referenced by a design's text nodes — the
 * set useDesignFontFaces loads FontFaces for. Walks plain nodes only:
 * instance expansions come from components, which either use built-ins
 * (community isolation rule) or fall back visibly.
 */
export function referencedFontFamilies(design: DesignDoc): string[] {
  const families = new Set<string>();
  for (const node of design.nodes) {
    if (node.type === "text" && node.style?.fontFamily) {
      families.add(node.style.fontFamily);
    }
  }
  return [...families];
}

export interface FontPickerGroups {
  /** Built-in families — the client constant, unioned with the server list. */
  builtin: string[];
  /** The session user's uploaded families, deduped (a family may carry
      multiple weights) and never shadowing a built-in name. */
  mine: string[];
  /** The current value when no offered family matches it (a deleted upload,
      someone else's font) — rendered as an "unavailable" item so the select
      still displays it instead of a blank trigger. */
  missing: string | null;
}

/**
 * Grouping for the Inspector's family select. `builtinOnly` is the Component
 * Studio: community components may reference built-in families only (§7.5
 * isolation — a stranger's design must never depend on a private font), so
 * uploads don't appear there at all. A null list (API down, signed out)
 * degrades to the built-in constant.
 */
export function fontPickerGroups(
  list: FontList | null,
  value: string | undefined,
  opts?: { builtinOnly?: boolean },
): FontPickerGroups {
  const builtin = BUILTIN_FONTS.map((f) => f.family);
  for (const b of list?.builtin ?? []) {
    if (!builtin.includes(b.family)) builtin.push(b.family);
  }
  const mine: string[] = [];
  if (!opts?.builtinOnly) {
    for (const font of list?.mine ?? []) {
      if (!builtin.includes(font.family) && !mine.includes(font.family)) {
        mine.push(font.family);
      }
    }
    mine.sort((a, b) => a.localeCompare(b));
  }
  const offered = new Set([...builtin, ...mine]);
  const missing = value !== undefined && !offered.has(value) ? value : null;
  return { builtin, mine, missing };
}

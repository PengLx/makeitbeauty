/**
 * Server-side font loading (architecture.md §5 step 3) + per-request user fonts.
 *
 * BUILT-INS — fonts live in apps/renderer/fonts/ and stay in renderer memory;
 * satori subsets used glyphs into the output (embedFont), which is what makes
 * CJK practical. Filenames encode family and weight:
 * "Inter-Regular.ttf" → Inter 400, "JetBrainsMono-Bold.ttf" →
 * "JetBrains Mono" 700 (release filenames carry no spaces; FAMILY_ALIASES
 * restores the canonical family name), "Lora-Regular.ttf" → Lora 400.
 * The integration/setup step (`make fonts`) downloads Inter, JetBrains Mono
 * and Lora here. BUILTIN_FAMILIES is THE source of truth for "what families
 * may everyone use" — the server exposes it on GET /internal/fonts for the
 * API to proxy, and community-component validation checks against it.
 *
 * PER-REQUEST USER FONTS — the renderer stays stateless: an owner's uploaded
 * fonts travel INSIDE the render request as base64 TTF/OTF/WOFF
 * (render.schema.json renderRequest.fonts). WOFF2 is rejected — satori
 * cannot parse it. Decoded entries are LRU-cached by sha256(content) so
 * repeated renders reuse one Buffer, merged OVER the built-ins for that
 * request only (never shadowing a built-in family name), and dropped with
 * the request — concurrent requests cannot see each other's fonts.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_FONT_FAMILY = "Inter";

export interface LoadedFont {
  name: string;
  data: Buffer;
  weight: 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
  style: "normal" | "italic";
}

// ../fonts is one level above both src/ (tsx) and dist/ (tsc output).
const FONTS_DIR = fileURLToPath(new URL("../fonts/", import.meta.url));

const WEIGHT_NAMES: Record<string, LoadedFont["weight"]> = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  regular: 400,
  normal: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
};

/**
 * Release filenames have no spaces in the family stem; this restores the
 * canonical family name users reference in designs.
 */
const FAMILY_ALIASES: Record<string, string> = {
  JetBrainsMono: "JetBrains Mono",
};

/** "Inter-BoldItalic.ttf" → { name: "Inter", weight: 700, style: "italic" }. */
export function parseFontFilename(filename: string): Omit<LoadedFont, "data"> {
  const stem = filename.replace(/\.(ttf|otf)$/i, "");
  const dash = stem.lastIndexOf("-");
  const family = dash > 0 ? stem.slice(0, dash) : stem;
  let variant = (dash > 0 ? stem.slice(dash + 1) : "").toLowerCase();

  const italic = variant.includes("italic");
  if (italic) variant = variant.replace("italic", "");

  return {
    name: FAMILY_ALIASES[family] ?? family,
    weight: WEIGHT_NAMES[variant] ?? 400,
    style: italic ? "italic" : "normal",
  };
}

/**
 * Load every .ttf/.otf in fonts/ (sorted by filename for determinism).
 * Exits the process with guidance when the directory is empty — the renderer
 * cannot produce text paths without at least one font.
 */
export function loadFontsOrExit(): LoadedFont[] {
  let filenames: string[] = [];
  try {
    filenames = readdirSync(FONTS_DIR)
      .filter((f) => /\.(ttf|otf)$/i.test(f))
      .sort();
  } catch {
    // fall through to the empty-directory error below
  }

  if (filenames.length === 0) {
    console.error(
      [
        `renderer: no fonts found in ${FONTS_DIR}`,
        "",
        "The renderer embeds text as vector paths and needs at least one",
        ".ttf/.otf font. Project setup fetches fonts into this directory —",
        "run `make fonts` (it downloads Inter, JetBrains Mono and Lora), or",
        'drop in files named like "Inter-Regular.ttf" / "Inter-Bold.ttf"',
        "(filename → family/weight).",
      ].join("\n"),
    );
    process.exit(1);
  }

  return filenames.map((filename) => ({
    ...parseFontFilename(filename),
    data: readFileSync(join(FONTS_DIR, filename)),
  }));
}

// ---------------------------------------------------------------------------
// Built-in family registry — ONE source of truth (fonts/ directory contents).
// The API proxies this list (GET /internal/fonts → GET /v1/fonts "builtin");
// community-component validation rejects families outside it.
// ---------------------------------------------------------------------------

export interface BuiltinFamily {
  family: string;
  weights: number[];
}

function computeBuiltinFamilies(): BuiltinFamily[] {
  let filenames: string[] = [];
  try {
    filenames = readdirSync(FONTS_DIR)
      .filter((f) => /\.(ttf|otf)$/i.test(f))
      .sort();
  } catch {
    // no fonts dir: empty list (loadFontsOrExit still guards server boot)
  }
  const families = new Map<string, Set<number>>();
  for (const filename of filenames) {
    const parsed = parseFontFilename(filename);
    const weights = families.get(parsed.name) ?? new Set<number>();
    weights.add(parsed.weight);
    families.set(parsed.name, weights);
  }
  return [...families.entries()]
    .map(([family, weights]) => ({ family, weights: [...weights].sort((a, b) => a - b) }))
    .sort((a, b) => a.family.localeCompare(b.family));
}

/**
 * Every family available to ALL users, with the weights on disk. Computed
 * once from the fonts directory — the same files loadFontsOrExit serves to
 * satori, so the list can never drift from what actually renders.
 */
export const BUILTIN_FAMILIES: readonly BuiltinFamily[] = computeBuiltinFamilies();

const BUILTIN_FAMILY_NAMES_LOWER = new Set(BUILTIN_FAMILIES.map((f) => f.family.toLowerCase()));

/** Case-insensitive membership test (CSS font-family matching is case-insensitive). */
export function isBuiltinFamily(family: string): boolean {
  return BUILTIN_FAMILY_NAMES_LOWER.has(family.toLowerCase());
}

// ---------------------------------------------------------------------------
// Per-request user fonts (render.schema.json renderRequest.fonts)
// ---------------------------------------------------------------------------

/** A request font failed validation — the HTTP layer maps this to 400 INVALID_FONT. */
export class FontError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FontError";
  }
}

export type FontFormat = "ttf" | "otf" | "woff" | "woff2";

/**
 * Magic-byte sniff (defense in depth — the API validated the upload already):
 * 0x00010000 or "true" → TTF, "OTTO" → OTF, "wOFF" → WOFF, "wOF2" → WOFF2.
 */
export function sniffFontFormat(data: Buffer): FontFormat | null {
  if (data.length < 4) return null;
  const tag = data.readUInt32BE(0);
  if (tag === 0x00010000 || tag === 0x74727565 /* "true" */) return "ttf";
  if (tag === 0x4f54544f /* "OTTO" */) return "otf";
  if (tag === 0x774f4646 /* "wOFF" */) return "woff";
  if (tag === 0x774f4632 /* "wOF2" */) return "woff2";
  return null;
}

/** Mirrors the API's upload limit (POST /v1/fonts): 5 MB per font file. */
export const MAX_FONT_BYTES = 5 * 1024 * 1024;

/** LRU of decoded+validated font bytes, keyed by sha256(content). */
export const FONT_CACHE_CAP = 32;
const fontCache = new Map<string, Buffer>(); // Map preserves insertion order → LRU

/** Cache keys, oldest first — exported for tests. */
export function fontCacheKeys(): string[] {
  return [...fontCache.keys()];
}

/** Empty the request-font cache — exported for tests. */
export function clearFontCache(): void {
  fontCache.clear();
}

/**
 * Decode + validate one request font's base64 payload through the LRU: a
 * cache hit reuses the previously decoded Buffer (and skips re-validation);
 * a miss validates magic bytes and size, then caches by content hash.
 */
function decodeFontData(data: string, context: string): Buffer {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(data, "base64");
  } catch {
    throw new FontError(`${context}: "data" is not valid base64`);
  }
  if (decoded.length === 0) throw new FontError(`${context}: "data" decodes to zero bytes`);

  const hash = createHash("sha256").update(decoded).digest("hex");
  const cached = fontCache.get(hash);
  if (cached) {
    // Refresh recency: delete + re-set moves the key to the Map's tail.
    fontCache.delete(hash);
    fontCache.set(hash, cached);
    return cached;
  }

  if (decoded.length > MAX_FONT_BYTES) {
    throw new FontError(
      `${context}: font is ${decoded.length} bytes — the limit is ${MAX_FONT_BYTES} (5 MB)`,
    );
  }
  const format = sniffFontFormat(decoded);
  if (format === "woff2") {
    throw new FontError(
      `${context}: WOFF2 is not supported — the renderer's text engine (satori) cannot ` +
        `parse WOFF2's Brotli-compressed glyph tables. Upload the font as TTF, OTF or WOFF.`,
    );
  }
  if (format === null) {
    throw new FontError(
      `${context}: "data" is not a TTF, OTF or WOFF font (magic bytes did not match)`,
    );
  }

  fontCache.set(hash, decoded);
  if (fontCache.size > FONT_CACHE_CAP) {
    // Evict the least-recently-used entry (the Map's head).
    const oldest = fontCache.keys().next().value as string;
    fontCache.delete(oldest);
  }
  return decoded;
}

export interface ParsedRequestFonts {
  fonts: LoadedFont[];
  warnings: string[];
}

const REQUEST_FONT_WEIGHTS = new Set([400, 700]);
const REQUEST_FONT_STYLES = new Set(["normal", "italic"]);

/**
 * Validate a renderRequest's fonts[] (render.schema.json): each item is
 * {family, weight? (400|700), style? ("normal"|"italic"), data (base64
 * TTF/OTF/WOFF)}. Throws FontError on the first violation. A font whose
 * family collides with a built-in is DROPPED with a warning — a user font
 * may never shadow a built-in family (the built-in wins), so a design that
 * says "Inter" always renders the same Inter for everyone.
 */
export function parseRequestFonts(raw: unknown): ParsedRequestFonts {
  if (raw === undefined) return { fonts: [], warnings: [] };
  if (!Array.isArray(raw)) {
    throw new FontError('"fonts" must be an array of {family, weight?, style?, data}');
  }

  const fonts: LoadedFont[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const [i, item] of raw.entries()) {
    const context = `fonts[${i}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new FontError(`${context}: must be an object {family, weight?, style?, data}`);
    }
    const { family, weight, style, data } = item as Record<string, unknown>;
    if (typeof family !== "string" || family.trim() === "") {
      throw new FontError(`${context}: "family" must be a non-empty string`);
    }
    if (family.length > 64) {
      throw new FontError(`${context}: "family" must be at most 64 characters`);
    }
    if (weight !== undefined && !REQUEST_FONT_WEIGHTS.has(weight as number)) {
      throw new FontError(`${context}: "weight" must be 400 or 700`);
    }
    if (style !== undefined && !REQUEST_FONT_STYLES.has(style as string)) {
      throw new FontError(`${context}: "style" must be "normal" or "italic"`);
    }
    if (typeof data !== "string" || data === "") {
      throw new FontError(`${context}: "data" must be a base64 string (TTF, OTF or WOFF)`);
    }

    const decoded = decodeFontData(data, context);

    if (isBuiltinFamily(family)) {
      warnings.push(
        `${context}: font family "${family}" shadows a built-in family — ignored, the built-in wins`,
      );
      continue;
    }

    const resolvedWeight = (weight as LoadedFont["weight"] | undefined) ?? 400;
    const resolvedStyle = (style as LoadedFont["style"] | undefined) ?? "normal";
    const key = `${family.toLowerCase()}/${resolvedWeight}/${resolvedStyle}`;
    if (seen.has(key)) {
      warnings.push(
        `${context}: duplicate font "${family}" ${resolvedWeight} ${resolvedStyle} — first one wins`,
      );
      continue;
    }
    seen.add(key);

    fonts.push({ name: family, data: decoded, weight: resolvedWeight, style: resolvedStyle });
  }
  return { fonts, warnings };
}

/**
 * Merge request fonts OVER the built-ins for one request: a fresh array (the
 * built-in list is never mutated), built-ins first so satori's fallback scan
 * prefers them — concurrent requests each get their own merged list, exactly
 * like per-request community components.
 */
export function mergeFonts(
  builtins: readonly LoadedFont[],
  requestFonts: readonly LoadedFont[],
): LoadedFont[] {
  if (requestFonts.length === 0) return [...builtins];
  return [...builtins, ...requestFonts];
}

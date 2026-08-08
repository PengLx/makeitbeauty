/**
 * Server-side font loading (architecture.md §5 step 3).
 *
 * Fonts live in apps/renderer/fonts/ and stay in renderer memory; satori
 * subsets used glyphs into the output (embedFont), which is what makes CJK
 * practical. Filenames encode family and weight: "Inter-Regular.ttf" →
 * Inter 400, "Inter-Bold.ttf" → Inter 700, "Inter-BlackItalic.otf" →
 * Inter 900 italic. The integration/setup step downloads Inter here.
 */
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

/** "Inter-BoldItalic.ttf" → { name: "Inter", weight: 700, style: "italic" }. */
export function parseFontFilename(filename: string): Omit<LoadedFont, "data"> {
  const stem = filename.replace(/\.(ttf|otf)$/i, "");
  const dash = stem.lastIndexOf("-");
  const family = dash > 0 ? stem.slice(0, dash) : stem;
  let variant = (dash > 0 ? stem.slice(dash + 1) : "").toLowerCase();

  const italic = variant.includes("italic");
  if (italic) variant = variant.replace("italic", "");

  return {
    name: family,
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
        "run the repo setup step (it downloads Inter), or drop in files named",
        'like "Inter-Regular.ttf" / "Inter-Bold.ttf" (filename → family/weight).',
      ].join("\n"),
    );
    process.exit(1);
  }

  return filenames.map((filename) => ({
    ...parseFontFilename(filename),
    data: readFileSync(join(FONTS_DIR, filename)),
  }));
}

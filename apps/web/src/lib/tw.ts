/**
 * Editor-side helpers around @makeitbeauty/twc (architecture.md §5.6).
 *
 * The compiler itself is shared with the renderer so semantics never drift;
 * everything in this module is editor UX on top of it: token completion for
 * the Inspector's Styles field, and the style layering the canvas uses to
 * approximate compiled tw live. All pure — tested in tw.test.ts.
 */
import { CATALOG, compileTw, type CatalogEntry } from "@makeitbeauty/twc";
import type { CSSProperties } from "react";

/**
 * Example strings the Styles field cycles through as its hint line.
 * tw.test.ts asserts every one compiles warning-free, so the hints can
 * never teach classes the compiler rejects.
 */
export const TW_EXAMPLES: readonly string[] = [
  "bg-gradient-to-r from-purple-500 to-pink-500",
  "shadow-lg rounded-xl border-2 border-slate-700",
  "text-white font-bold tracking-wide opacity-90",
];

/** Cap on the plain suggestion list under the Styles field. */
export const MAX_TW_SUGGESTIONS = 6;

/**
 * The token currently being typed: the last whitespace-delimited chunk of
 * the field value, or "" right after whitespace (no token started yet).
 */
export function currentToken(value: string): string {
  const match = /\S+$/.exec(value);
  return match ? match[0] : "";
}

/**
 * CATALOG entries whose prefix strictly extends the typed token — a plain
 * prefix autocomplete over the compiler's utility families, deliberately not
 * a value enumerator (values are linted live by compileTw instead). Catalog
 * order is preserved; it is already grouped sensibly by family.
 */
export function suggestCompletions(
  token: string,
  limit: number = MAX_TW_SUGGESTIONS,
): CatalogEntry[] {
  if (token === "") return [];
  const out: CatalogEntry[] = [];
  for (const entry of CATALOG) {
    if (entry.prefix.length > token.length && entry.prefix.startsWith(token)) {
      out.push(entry);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Replace the in-progress last token of `value` with `completion`. */
export function applyCompletion(value: string, completion: string): string {
  return value.replace(/\S+$/, "") + completion;
}

/**
 * Compile a tw string for the canvas approximation: style only, warnings
 * intentionally dropped — the Styles field lints; the canvas just paints
 * whatever does compile. Returns undefined when there is nothing to paint.
 */
export function twApproxStyle(tw: string | undefined): CSSProperties | undefined {
  if (!tw) return undefined;
  return compileTw(tw).style as CSSProperties;
}

/**
 * Merge style layers left → right, skipping undefined layers and undefined
 * VALUES — a `{ color: undefined }` entry must not shadow an earlier layer
 * the way plain object spread would. Callers pass layers in the renderer's
 * §5.6 merge order (apps/renderer/src/tree.ts): defaults < tw < structured,
 * so Inspector edits always win visibly.
 */
export function layerStyles(
  ...layers: (CSSProperties | undefined)[]
): CSSProperties {
  const out: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) out[key] = value;
    }
  }
  return out as CSSProperties;
}

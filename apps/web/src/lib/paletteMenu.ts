/**
 * Pure logic behind the editor palette's component MENU: category grouping,
 * the single search box's matching rules, and the persisted open/closed state
 * of kit category groups. Kept free of React/DOM so it's directly testable —
 * Palette.tsx only wires these to state.
 *
 * Categories are the optional `category` slug on kit/community components
 * (kit-component.schema.json; served by /v1/kit and the component routes).
 * The recommended taxonomy is fixed here in display order; anything outside
 * it — including components with no category at all — lands in "other".
 */

/** Recommended taxonomy (schema description), in palette display order. */
export const KIT_CATEGORIES = [
  "stats",
  "data",
  "banners",
  "cards",
  "decor",
] as const;

/** Catch-all group for uncategorized/unknown-category components. */
export const OTHER_CATEGORY = "other";

/** localStorage key for palette menu preferences ("mib.*" idiom). */
export const PALETTE_STORAGE_KEY = "mib.palette";

/** True when `slug` is one of the recommended taxonomy categories. */
export function isKnownCategory(slug: string): boolean {
  return (KIT_CATEGORIES as readonly string[]).includes(slug);
}

/** The menu group a component belongs to: its known category, else "other". */
export function menuCategory(category: string | undefined): string {
  return category !== undefined && isKnownCategory(category)
    ? category
    : OTHER_CATEGORY;
}

/** Group header label: "stats" → "Stats" (slugs are lowercase by schema). */
export function categoryLabel(category: string): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

// ---- search matching ------------------------------------------------------

/** What every searchable palette entry (kit, mine, community) carries. */
export interface SearchableEntry {
  id: string;
  title: string;
  description?: string;
}

/** Canonical form of the search box's value; "" means "not searching". */
export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase();
}

/**
 * Case-insensitive substring match over id/title/description — the same
 * fields the server's community `q` search scans, so the one search box
 * behaves consistently across client-filtered and server-filtered sources.
 * An empty (normalized) query matches everything.
 */
export function matchesQuery(
  entry: SearchableEntry,
  normalizedQuery: string,
): boolean {
  if (normalizedQuery === "") return true;
  return (
    entry.id.toLowerCase().includes(normalizedQuery) ||
    entry.title.toLowerCase().includes(normalizedQuery) ||
    (entry.description ?? "").toLowerCase().includes(normalizedQuery)
  );
}

// ---- grouping ---------------------------------------------------------------

export interface PaletteGroup<T> {
  /** A KIT_CATEGORIES slug or OTHER_CATEGORY. */
  category: string;
  items: T[];
}

/**
 * Bucket components into menu groups, taxonomy order first and "other" last.
 * Only non-empty groups are returned (an absent category simply doesn't
 * render); item order within a group is preserved from the input.
 */
export function groupByCategory<T extends { category?: string }>(
  items: readonly T[],
): PaletteGroup<T>[] {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = menuCategory(item.category);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  return [...KIT_CATEGORIES, OTHER_CATEGORY]
    .filter((category) => buckets.has(category))
    .map((category) => ({ category, items: buckets.get(category)! }));
}

/**
 * The kit section of the menu under a (normalized) query: filter first, then
 * group — so while searching, groups whose components all miss simply
 * disappear instead of rendering empty shells.
 */
export function buildKitMenu<T extends SearchableEntry & { category?: string }>(
  items: readonly T[],
  normalizedQuery: string,
): PaletteGroup<T>[] {
  return groupByCategory(
    items.filter((item) => matchesQuery(item, normalizedQuery)),
  );
}

// ---- persisted group open/closed state -------------------------------------

/**
 * Parse the "mib.palette" localStorage payload ({collapsed: string[]}) into
 * the set of collapsed category slugs. Groups default OPEN, so only the
 * collapsed set is stored; anything malformed degrades to "all open".
 */
export function parsePalettePrefs(raw: string | null): Set<string> {
  try {
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return new Set();
    const collapsed = (parsed as Record<string, unknown>).collapsed;
    if (!Array.isArray(collapsed)) return new Set();
    return new Set(collapsed.filter((c): c is string => typeof c === "string"));
  } catch {
    return new Set(); // corrupt JSON — all groups open
  }
}

/** Inverse of parsePalettePrefs (sorted for stable storage diffs). */
export function serializePalettePrefs(collapsed: ReadonlySet<string>): string {
  return JSON.stringify({ collapsed: [...collapsed].sort() });
}

/**
 * Whether a category group renders expanded: an active search force-expands
 * every (non-empty) group so matches are never hidden behind a collapsed
 * header; otherwise the user's persisted choice applies.
 */
export function isGroupOpen(
  category: string,
  collapsed: ReadonlySet<string>,
  searching: boolean,
): boolean {
  return searching || !collapsed.has(category);
}

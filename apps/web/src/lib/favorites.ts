/**
 * Pure logic behind the palette's community favorites: the optimistic heart
 * flip and the client-side filter/sort the Favorites view needs (it lists
 * GET /v1/components/favorites, which takes no q/category/sort — the server
 * returns newest-favorite-first and the client composes the rest). Kept free
 * of React/DOM so it's directly testable — Palette.tsx only wires state.
 */

import type { CommunityComponent } from "./api";
import { matchesQuery, type CommunitySort } from "./paletteMenu";

/**
 * Set one row's favorited flag ABSOLUTELY, adjusting favoriteCount by ±1
 * only when the flag actually changes — so applying the same state twice is
 * a no-op, and rolling back an optimistic flip (apply the old flag again) is
 * exact even if a refetch landed in between. Rows without a count treat it
 * as 0; the count never goes negative. Unknown ids return the input as-is.
 */
export function applyFavorite(
  rows: readonly CommunityComponent[],
  id: string,
  favorited: boolean,
): CommunityComponent[] {
  return rows.map((row) => {
    if (row.id !== id || row.favorited === favorited) return row;
    const count = row.favoriteCount ?? 0;
    return {
      ...row,
      favorited,
      favoriteCount: favorited ? count + 1 : Math.max(0, count - 1),
    };
  });
}

/**
 * The palette search box + category facet applied client-side to the
 * favorites list — the same matching rules the server's browse q/category
 * use (matchesQuery mirrors the server's substring fields; category is an
 * exact slug), so toggling Favorites never changes what a query means.
 */
export function filterFavoriteRows(
  rows: readonly CommunityComponent[],
  normalizedQuery: string,
  category: string | null,
): CommunityComponent[] {
  return rows.filter(
    (row) =>
      (category === null || row.category === category) &&
      matchesQuery(row, normalizedQuery),
  );
}

/**
 * Apply the community sort to the favorites list. "newest" keeps the
 * server's order (newest FAVORITE first — for a personal list that beats
 * publish recency); "uses"/"favorites" sort by count descending with the
 * §8 tie-break: publishedAt desc, then id. Missing counts sort as 0 and a
 * missing publishedAt sorts last among ties. The input is never mutated.
 */
export function sortFavoriteRows(
  rows: readonly CommunityComponent[],
  sort: CommunitySort,
): CommunityComponent[] {
  const sorted = [...rows];
  if (sort === "newest") return sorted;
  const count =
    sort === "uses"
      ? (row: CommunityComponent) => row.usageCount ?? 0
      : (row: CommunityComponent) => row.favoriteCount ?? 0;
  return sorted.sort((a, b) => {
    if (count(a) !== count(b)) return count(b) - count(a);
    const pa = a.publishedAt ?? "";
    const pb = b.publishedAt ?? "";
    if (pa !== pb) return pa < pb ? 1 : -1; // ISO strings: desc, absent last
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

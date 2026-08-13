import { describe, expect, it } from "vitest";
import type { CommunityComponent } from "./api";
import { applyFavorite, filterFavoriteRows, sortFavoriteRows } from "./favorites";
import { normalizeQuery } from "./paletteMenu";

const row = (
  id: string,
  extra: Partial<CommunityComponent> = {},
): CommunityComponent => ({
  id,
  owner: id.split("/")[0] ?? "",
  title: id,
  latestVersion: 1,
  ...extra,
});

describe("applyFavorite", () => {
  it("flips the target row on and bumps its count", () => {
    const rows = [
      row("a/x", { favorited: false, favoriteCount: 2 }),
      row("b/y", { favorited: false, favoriteCount: 5 }),
    ];
    const next = applyFavorite(rows, "a/x", true);
    expect(next[0]).toMatchObject({ favorited: true, favoriteCount: 3 });
    expect(next[1]).toBe(rows[1]); // untouched rows keep identity
  });

  it("flips off and decrements", () => {
    const next = applyFavorite(
      [row("a/x", { favorited: true, favoriteCount: 3 })],
      "a/x",
      false,
    );
    expect(next[0]).toMatchObject({ favorited: false, favoriteCount: 2 });
  });

  it("is absolute, not incremental: applying the current state is a no-op", () => {
    const rows = [row("a/x", { favorited: true, favoriteCount: 3 })];
    expect(applyFavorite(rows, "a/x", true)[0]).toBe(rows[0]);
  });

  it("round-trips exactly (optimistic flip + rollback)", () => {
    const rows = [row("a/x", { favorited: false, favoriteCount: 7 })];
    const back = applyFavorite(applyFavorite(rows, "a/x", true), "a/x", false);
    expect(back[0]).toMatchObject({ favorited: false, favoriteCount: 7 });
  });

  it("treats a missing count as 0 and never goes negative", () => {
    expect(applyFavorite([row("a/x")], "a/x", true)[0]).toMatchObject({
      favorited: true,
      favoriteCount: 1,
    });
    expect(
      applyFavorite(
        [row("a/x", { favorited: true, favoriteCount: 0 })],
        "a/x",
        false,
      )[0],
    ).toMatchObject({ favorited: false, favoriteCount: 0 });
  });

  it("leaves unknown ids alone and never mutates the input", () => {
    const rows = [row("a/x", { favorited: false, favoriteCount: 1 })];
    const next = applyFavorite(rows, "nobody/nothing", true);
    expect(next).toEqual(rows);
    expect(rows[0].favoriteCount).toBe(1);
  });
});

describe("filterFavoriteRows", () => {
  const rows = [
    row("ada/stat-card", {
      title: "Stat card",
      description: "One big number",
      category: "stats",
    }),
    row("bo/banner", { title: "Gradient banner", category: "banners" }),
    row("cy/uncategorized", { title: "Mystery" }),
  ];

  it("empty query + no category keeps everything", () => {
    expect(filterFavoriteRows(rows, "", null)).toEqual(rows);
  });

  it("matches id/title/description like the palette search box", () => {
    expect(filterFavoriteRows(rows, normalizeQuery("  Banner "), null)).toEqual([
      rows[1],
    ]);
    expect(filterFavoriteRows(rows, "big number", null)).toEqual([rows[0]]);
    expect(filterFavoriteRows(rows, "ada/", null)).toEqual([rows[0]]);
  });

  it("category is an exact slug filter and composes (AND) with q", () => {
    expect(filterFavoriteRows(rows, "", "stats")).toEqual([rows[0]]);
    expect(filterFavoriteRows(rows, "banner", "stats")).toEqual([]);
    // rows without a category never match an active category facet
    expect(filterFavoriteRows(rows, "", "decor")).toEqual([]);
  });
});

describe("sortFavoriteRows", () => {
  const a = row("a/one", {
    usageCount: 1,
    favoriteCount: 9,
    publishedAt: "2026-01-01T00:00:00Z",
  });
  const b = row("b/two", {
    usageCount: 5,
    favoriteCount: 2,
    publishedAt: "2026-03-01T00:00:00Z",
  });
  const c = row("c/three", {
    usageCount: 5,
    favoriteCount: 2,
    publishedAt: "2026-02-01T00:00:00Z",
  });

  it("newest keeps the server's newest-favorite-first order", () => {
    expect(sortFavoriteRows([b, a, c], "newest")).toEqual([b, a, c]);
  });

  it("uses sorts by usage desc, ties by publishedAt desc", () => {
    expect(sortFavoriteRows([a, c, b], "uses")).toEqual([b, c, a]);
  });

  it("favorites sorts by favorite count desc", () => {
    expect(sortFavoriteRows([b, c, a], "favorites")).toEqual([a, b, c]);
  });

  it("equal counts + equal publishedAt fall back to id asc", () => {
    const x = row("x/same", { favoriteCount: 1, publishedAt: "2026-01-01T00:00:00Z" });
    const y = row("y/same", { favoriteCount: 1, publishedAt: "2026-01-01T00:00:00Z" });
    expect(sortFavoriteRows([y, x], "favorites")).toEqual([x, y]);
  });

  it("missing counts sort as 0 and missing publishedAt sorts last among ties", () => {
    const bare = row("z/bare");
    const dated = row("d/dated", { publishedAt: "2026-01-01T00:00:00Z" });
    expect(sortFavoriteRows([bare, dated, a], "favorites")).toEqual([
      a,
      dated,
      bare,
    ]);
  });

  it("never mutates its input", () => {
    const input = [b, a];
    sortFavoriteRows(input, "uses");
    expect(input).toEqual([b, a]);
  });
});

import { describe, expect, it } from "vitest";
import {
  KIT_CATEGORIES,
  OTHER_CATEGORY,
  buildKitMenu,
  categoryLabel,
  groupByCategory,
  isGroupOpen,
  isKnownCategory,
  matchesQuery,
  menuCategory,
  normalizeQuery,
  parsePalettePrefs,
  serializePalettePrefs,
} from "./paletteMenu";

const entry = (
  id: string,
  title: string,
  category?: string,
  description?: string,
) => ({ id, title, category, description });

describe("normalizeQuery", () => {
  it("trims and lowercases", () => {
    expect(normalizeQuery("  Stat Card  ")).toBe("stat card");
  });

  it("whitespace-only input normalizes to the empty (not-searching) query", () => {
    expect(normalizeQuery("   ")).toBe("");
  });
});

describe("matchesQuery", () => {
  const card = entry(
    "kit/stat-card",
    "Stat card",
    "stats",
    "One large metric with a label",
  );

  it("empty query matches everything", () => {
    expect(matchesQuery(card, "")).toBe(true);
  });

  it("matches case-insensitively on id, title, and description", () => {
    expect(matchesQuery(card, "stat-card")).toBe(true); // id
    expect(matchesQuery(card, "stat card")).toBe(true); // title
    expect(matchesQuery(card, "large metric")).toBe(true); // description
    expect(matchesQuery({ ...card, title: "STAT CARD" }, "stat card")).toBe(true);
  });

  it("misses on unrelated text and treats a missing description as empty", () => {
    expect(matchesQuery(card, "heatmap")).toBe(false);
    expect(matchesQuery(entry("a/b", "B"), "description")).toBe(false);
  });
});

describe("menuCategory / isKnownCategory", () => {
  it("passes taxonomy slugs through", () => {
    for (const c of KIT_CATEGORIES) {
      expect(isKnownCategory(c)).toBe(true);
      expect(menuCategory(c)).toBe(c);
    }
  });

  it('sends unknown slugs and missing categories to "other"', () => {
    expect(menuCategory("widgets")).toBe(OTHER_CATEGORY);
    expect(menuCategory(undefined)).toBe(OTHER_CATEGORY);
    expect(isKnownCategory("widgets")).toBe(false);
    expect(isKnownCategory(OTHER_CATEGORY)).toBe(false); // catch-all, not a slug
  });
});

describe("categoryLabel", () => {
  it("capitalizes the first letter only", () => {
    expect(categoryLabel("stats")).toBe("Stats");
    expect(categoryLabel("other")).toBe("Other");
  });
});

describe("groupByCategory", () => {
  it("orders groups by taxonomy with other last, preserving item order", () => {
    const items = [
      entry("kit/accent-divider", "Accent divider", "decor"),
      entry("kit/stat-card", "Stat card", "stats"),
      entry("kit/mystery", "Mystery", "widgets"), // unknown slug
      entry("kit/stat-trio", "Stat trio", "stats"),
      entry("kit/plain", "Plain"), // no category
    ];
    const groups = groupByCategory(items);
    expect(groups.map((g) => g.category)).toEqual(["stats", "decor", "other"]);
    expect(groups[0].items.map((i) => i.id)).toEqual([
      "kit/stat-card",
      "kit/stat-trio",
    ]);
    // Unknown and uncategorized share the "other" bucket.
    expect(groups[2].items.map((i) => i.id)).toEqual(["kit/mystery", "kit/plain"]);
  });

  it("returns no groups for no items (empty groups never render)", () => {
    expect(groupByCategory([])).toEqual([]);
  });
});

describe("buildKitMenu", () => {
  const kit = [
    entry("kit/stat-card", "Stat card", "stats"),
    entry("kit/glow-stat", "Glow stat", "stats"),
    entry("kit/contribution-heatmap", "Contribution heatmap", "data"),
    entry("kit/terminal-card", "Terminal card", "cards"),
  ];

  it("no query → every non-empty group, full contents", () => {
    const groups = buildKitMenu(kit, "");
    expect(groups.map((g) => g.category)).toEqual(["stats", "data", "cards"]);
    expect(groups[0].items).toHaveLength(2);
  });

  it("a query hides groups whose components all miss", () => {
    const groups = buildKitMenu(kit, "heatmap");
    expect(groups.map((g) => g.category)).toEqual(["data"]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["kit/contribution-heatmap"]);
  });

  it("a query matching nothing yields no groups", () => {
    expect(buildKitMenu(kit, "sparkline")).toEqual([]);
  });

  it("filters within a group without dropping it", () => {
    const groups = buildKitMenu(kit, "glow");
    expect(groups).toHaveLength(1);
    expect(groups[0].category).toBe("stats");
    expect(groups[0].items.map((i) => i.id)).toEqual(["kit/glow-stat"]);
  });
});

describe("palette prefs (mib.palette)", () => {
  it("round-trips a collapsed set through serialize/parse", () => {
    const collapsed = new Set(["decor", "stats"]);
    expect(parsePalettePrefs(serializePalettePrefs(collapsed))).toEqual(collapsed);
  });

  it("serializes sorted for stable storage", () => {
    expect(serializePalettePrefs(new Set(["stats", "data"]))).toBe(
      '{"collapsed":["data","stats"]}',
    );
  });

  it("degrades malformed payloads to all-open", () => {
    expect(parsePalettePrefs(null)).toEqual(new Set());
    expect(parsePalettePrefs("")).toEqual(new Set());
    expect(parsePalettePrefs("not json")).toEqual(new Set());
    expect(parsePalettePrefs('"a string"')).toEqual(new Set());
    expect(parsePalettePrefs('{"collapsed":"stats"}')).toEqual(new Set());
  });

  it("drops non-string entries but keeps valid ones", () => {
    expect(parsePalettePrefs('{"collapsed":["stats",7,null,"decor"]}')).toEqual(
      new Set(["stats", "decor"]),
    );
  });
});

describe("isGroupOpen", () => {
  it("defaults open; collapsed set closes; searching force-opens", () => {
    const collapsed = new Set(["stats"]);
    expect(isGroupOpen("data", collapsed, false)).toBe(true);
    expect(isGroupOpen("stats", collapsed, false)).toBe(false);
    expect(isGroupOpen("stats", collapsed, true)).toBe(true);
  });
});

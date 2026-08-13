/**
 * Connector-wave natives (§5.7 + §6): the dataConnector qualifier — schema
 * shape, subtree dispatch, community rejection — the three new generators
 * (coding-activity, leetcode-solved, blog-latest), the wakatime-badge
 * declarative cross-connector scalar, and pipeline determinism over the
 * extended demo fixture.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { loadFontsOrExit } from "./fonts.js";
import {
  expandInstance,
  kitRegistry,
  parseCommunityComponent,
  parseKitComponent,
} from "./kit.js";
import {
  LEETCODE_COLORS,
  connectorSubtree,
  nativeGenerators,
  truncateTitle,
  type NativeGenerator,
} from "./native.js";
import { repoPath } from "./paths.js";
import { render } from "./pipeline.js";
import type { Design, DesignNode, InstanceNode, RectNode, TextNode } from "./types.js";

const demoData = JSON.parse(
  readFileSync(repoPath("examples", "demo-data.json"), "utf8"),
) as Record<string, unknown>;

function generator(id: string): NativeGenerator {
  const g = nativeGenerators.get(id);
  if (!g) throw new Error(`no generator "${id}"`);
  return g;
}

function byId<T extends DesignNode>(nodes: DesignNode[], id: string): T {
  const found = nodes.find((n) => n.id === id);
  if (!found) throw new Error(`no node "${id}"`);
  return found as T;
}

/** A wakatime days series, oldest → newest ({date, minutes} shape). */
function days(minutes: number[]): { date: string; minutes: number }[] {
  return minutes.map((m, i) => ({ date: `day-${i}`, minutes: m }));
}

// Default props as merged from the kit metadata (mergeProps applies these).
const CODING_PROPS = { label: "CODING ACTIVITY", accent: "#3fb950", background: "#161b22" };
const LEETCODE_PROPS = { label: "LEETCODE SOLVED", trackColor: "#21262d", background: "#161b22" };
const BLOG_PROPS = { label: "BLOG", accent: "#58a6ff", background: "#161b22" };

const CODING_FRAME = { w: 360, h: 110 };
const LEETCODE_FRAME = { w: 320, h: 120 };
const BLOG_FRAME = { w: 480, h: 150 };

describe("kit-component schema: dataConnector", () => {
  const base = {
    id: "test-native",
    title: "Test native",
    frame: { w: 100, h: 50 },
    props: {},
  };

  it("accepts dataConnector on a native and keeps it on the parsed component", () => {
    const parsed = parseKitComponent(
      { ...base, native: true, dataConnector: "wakatime", dataFields: ["stats.days"] },
      "native.json",
    );
    expect(parsed.dataConnector).toBe("wakatime");
  });

  it("accepts a bare top-level dataFields key (rss keeps posts at the root)", () => {
    const parsed = parseKitComponent(
      { ...base, native: true, dataConnector: "rss", dataFields: ["feed.title", "posts"] },
      "native.json",
    );
    expect(parsed.dataFields).toEqual(["feed.title", "posts"]);
  });

  it("still rejects malformed dataFields entries", () => {
    expect(() =>
      parseKitComponent({ ...base, native: true, dataFields: ["calendar!"] }, "native.json"),
    ).toThrow(/invalid kit component/);
  });

  it("rejects a non-slug dataConnector", () => {
    expect(() =>
      parseKitComponent(
        { ...base, native: true, dataConnector: "Waka Time", dataFields: ["stats.days"] },
        "native.json",
      ),
    ).toThrow(/invalid kit component/);
  });

  it("ships the connector natives with their dataConnector (github stays implicit)", () => {
    const expected: Record<string, string | undefined> = {
      "kit/coding-activity": "wakatime",
      "kit/leetcode-solved": "leetcode",
      "kit/blog-latest": "rss",
      "kit/contribution-heatmap": undefined,
      "kit/activity-sparkline": undefined,
    };
    for (const [key, connector] of Object.entries(expected)) {
      const component = kitRegistry().get(key);
      expect(component, key).toBeDefined();
      expect(component?.dataConnector, key).toBe(connector);
    }
    // Every shipped connector native has a registered generator.
    for (const id of ["coding-activity", "leetcode-solved", "blog-latest"]) {
      expect(nativeGenerators.has(id)).toBe(true);
    }
  });

  it("rejects dataConnector on community components (declarative-only)", () => {
    const definition = {
      id: "ada/badge",
      title: "Badge",
      frame: { w: 100, h: 50 },
      props: {},
      dataConnector: "wakatime",
      nodes: [{ id: "bg", type: "rect", x: 0, y: 0, w: 100, h: 50 }],
    };
    expect(() => parseCommunityComponent(definition, "definition")).toThrow(
      /reserved for the official kit/,
    );
  });
});

describe("connectorSubtree", () => {
  it("returns the connector's subtree and {} for anything unusable", () => {
    const wakatime = { stats: { weeklyHours: 12 } };
    expect(connectorSubtree({ wakatime, github: {} }, "wakatime")).toBe(wakatime);
    expect(connectorSubtree({ github: {} }, "wakatime")).toEqual({});
    expect(connectorSubtree({}, "github")).toEqual({});
    expect(connectorSubtree({ rss: "nope" }, "rss")).toEqual({});
    expect(connectorSubtree({ rss: [1, 2] }, "rss")).toEqual({});
    expect(connectorSubtree({ rss: null }, "rss")).toEqual({});
  });
});

describe("dataConnector dispatch (expandInstance)", () => {
  const instance = (component: string, w: number, h: number): InstanceNode => ({
    id: "n",
    type: "instance",
    x: 0,
    y: 0,
    w,
    h,
    component,
  });

  it("hands a wakatime native exactly the wakatime subtree", () => {
    const data = {
      github: { stats: { calendar: [{ date: "d", count: 3 }] } },
      wakatime: { stats: { days: days([60, 30, 0, 120, 90, 100, 110]), weeklyHours: 8.5 } },
    };
    const { items, warnings } = expandInstance(
      instance("kit/coding-activity", 360, 110),
      kitRegistry(),
      data,
    );
    expect(warnings).toEqual([]);
    const nodes = items as DesignNode[];
    expect(nodes.filter((n) => n.id.startsWith("n__bar"))).toHaveLength(7);
    expect(nodes.some((n) => n.id === "n__empty")).toBe(false);
  });

  it("renders the empty state when the component's connector is absent — other connectors never leak in", () => {
    // github has a days-shaped series, but coding-activity is a WAKATIME
    // native: subtree isolation must keep it from reading github's data.
    const data = { github: { stats: { days: days([60, 30, 120]) } } };
    const { items, warnings } = expandInstance(
      instance("kit/coding-activity", 360, 110),
      kitRegistry(),
      data,
    );
    expect(warnings).toEqual([]);
    const empty = byId<TextNode>(items as DesignNode[], "n__empty");
    expect(empty.text).toBe("no coding data yet");
  });

  it("keeps the github default for natives without a dataConnector", () => {
    const data = {
      github: { stats: { calendar: [{ date: "d", count: 2 }] } },
      wakatime: { stats: { days: days([1]) } },
    };
    const { items } = expandInstance(
      instance("kit/activity-sparkline", 360, 100),
      kitRegistry(),
      data,
    );
    const nodes = items as DesignNode[];
    expect(nodes.filter((n) => n.id.startsWith("n__bar"))).toHaveLength(12);
    expect(nodes.some((n) => n.id === "n__empty")).toBe(false);
  });

  it("hands the rss native the rss subtree", () => {
    const data = {
      rss: {
        feed: { title: "Ada's Notebook" },
        posts: [{ title: "Hello", date: "2025-08-02" }],
      },
    };
    const { items, warnings } = expandInstance(
      instance("kit/blog-latest", 480, 150),
      kitRegistry(),
      data,
    );
    expect(warnings).toEqual([]);
    const nodes = items as DesignNode[];
    expect(byId<TextNode>(nodes, "n__label").text).toBe("Ada's Notebook");
    expect(byId<TextNode>(nodes, "n__post0").text).toBe("Hello");
  });
});

describe("coding-activity generator", () => {
  const generate = (data: Record<string, unknown>) =>
    generator("coding-activity")({ props: CODING_PROPS, data, frame: CODING_FRAME });

  it("lays 7 daily bars across the frame, scaled to the busiest day", () => {
    const nodes = generate({ stats: { days: days([60, 30, 0, 120, 90, 100, 110]) } });
    const bars = nodes.filter((n) => n.id.startsWith("bar")) as RectNode[];
    expect(bars).toHaveLength(7);

    // barW = (360 − 32 − 48)/7 = 40; baseline 96; areaH = 62; max = 120.
    expect(bars[0].w).toBe(40);
    expect(bars[0].x).toBe(16);
    expect(bars[1].x).toBe(64);

    expect(bars[3].h).toBe(62); // the max fills the area
    expect(bars[3].y).toBe(34);
    expect(bars[0].h).toBe(31); // round(60·62/120)
    expect(bars[0].y).toBe(65);

    // Idle day: 2px track-colored stub.
    expect(bars[2].h).toBe(2);
    expect(bars[2].style?.fill).toBe("#21262d");
    expect(bars[3].style?.fill).toBe("#3fb950");
  });

  it("keeps active days visible with the 2px floor", () => {
    const bars = generate({ stats: { days: days([1, 0, 0, 0, 0, 0, 1000]) } }).filter((n) =>
      n.id.startsWith("bar"),
    ) as RectNode[];
    expect(bars[0].h).toBe(2);
    expect(bars[0].style?.fill).toBe("#3fb950"); // active → accent, not the stub color
    expect(bars[6].h).toBe(62);
  });

  it("front-pads short series so the newest day lands in the rightmost bar", () => {
    const bars = generate({ stats: { days: days([30, 40, 50]) } }).filter((n) =>
      n.id.startsWith("bar"),
    ) as RectNode[];
    expect(bars.slice(0, 4).every((b) => b.h === 2 && b.style?.fill === "#21262d")).toBe(true);
    expect(bars[6].h).toBe(62); // 50 is the max and the newest
  });

  it("staggers the growY entrance 60ms per bar", () => {
    const bars = generate({ stats: { days: days([1, 2, 3, 4, 5, 6, 7]) } }).filter((n) =>
      n.id.startsWith("bar"),
    );
    bars.forEach((bar, i) => {
      expect(bar.animation).toEqual({ preset: "growY", durationMs: 600, delayMs: i * 60 });
    });
  });

  it("headlines the connector's weeklyHours scalar, right-aligned", () => {
    const nodes = generate({ stats: { days: days([60]), weeklyHours: 32.5 } });
    const hours = byId<TextNode>(nodes, "hours");
    expect(hours.text).toBe("32.5h this week");
    expect(hours.style?.align).toBe("right");
    // Numeric strings coerce (data-bound values arrive as strings), 1dp.
    expect(
      byId<TextNode>(generate({ stats: { days: days([60]), weeklyHours: "12.34" } }), "hours").text,
    ).toBe("12.3h this week");
  });

  it("derives the headline from the shown days when the scalar is missing", () => {
    const nodes = generate({ stats: { days: days([60, 60, 60, 60, 60, 60, 60]) } });
    expect(byId<TextNode>(nodes, "hours").text).toBe("7h this week"); // 420min/60
  });

  it("renders the muted empty state for missing series and stays deterministic", () => {
    for (const data of [{}, { stats: {} }, { stats: { days: [] } }, { stats: { days: 7 } }]) {
      const nodes = generate(data);
      expect(nodes).toHaveLength(3); // bg + label + empty text
      expect(byId<TextNode>(nodes, "empty").text).toBe("no coding data yet");
    }
    const data = { stats: { days: days([10, 20, 30]), weeklyHours: 1 } };
    expect(JSON.stringify(generate(data))).toBe(JSON.stringify(generate(data)));
  });
});

describe("leetcode-solved generator", () => {
  const generate = (data: Record<string, unknown>) =>
    generator("leetcode-solved")({ props: LEETCODE_PROPS, data, frame: LEETCODE_FRAME });
  const solved = { total: 486, easy: 201, medium: 235, hard: 50 };

  it("headlines the declared total and sizes segments proportionally over the 280px track", () => {
    const nodes = generate({ solved });
    expect(byId<TextNode>(nodes, "total").text).toBe("486");

    const sum = 201 + 235 + 50;
    const easy = byId<RectNode>(nodes, "seg-easy");
    const medium = byId<RectNode>(nodes, "seg-medium");
    const hard = byId<RectNode>(nodes, "seg-hard");
    expect(easy.x).toBe(20);
    expect(easy.w).toBeCloseTo((280 * 201) / sum, 10);
    expect(medium.x).toBeCloseTo(20 + easy.w, 10);
    expect(hard.x + hard.w).toBeCloseTo(300, 10); // segments tile the track exactly

    expect(easy.style?.fill).toBe(LEETCODE_COLORS.easy);
    expect(medium.style?.fill).toBe(LEETCODE_COLORS.medium);
    expect(hard.style?.fill).toBe(LEETCODE_COLORS.hard);
  });

  it("rounds only the outer corners via the overlapping-cap trick", () => {
    const nodes = generate({ solved });
    expect(byId<RectNode>(nodes, "seg-easy").style?.radius).toBe(4);
    expect(byId<RectNode>(nodes, "seg-medium").style?.radius).toBe(0);
    expect(byId<RectNode>(nodes, "seg-hard").style?.radius).toBe(4);

    const easy = byId<RectNode>(nodes, "seg-easy");
    const capEasy = byId<RectNode>(nodes, "cap-easy");
    expect(capEasy.x).toBeCloseTo(easy.x + easy.w / 2, 10);
    expect(capEasy.style?.fill).toBe(LEETCODE_COLORS.easy);
    const hard = byId<RectNode>(nodes, "seg-hard");
    expect(byId<RectNode>(nodes, "cap-hard").x).toBeCloseTo(hard.x, 10);
    expect(nodes.filter((n) => n.id.startsWith("cap-"))).toHaveLength(2);
  });

  it("renders all three difficulty counts in their segment colors (zeros included)", () => {
    const nodes = generate({ solved: { easy: 5, medium: 0, hard: 5, total: 10 } });
    expect(byId<TextNode>(nodes, "count-easy").text).toBe("5 easy");
    expect(byId<TextNode>(nodes, "count-medium").text).toBe("0 medium");
    expect(byId<TextNode>(nodes, "count-hard").text).toBe("5 hard");
    expect(byId<TextNode>(nodes, "count-medium").style?.color).toBe(LEETCODE_COLORS.medium);
    // Fixed thirds: x at 20, 20 + 280/3, 20 + 2·280/3.
    expect(byId<TextNode>(nodes, "count-easy").x).toBe(20);
    expect(byId<TextNode>(nodes, "count-medium").x).toBeCloseTo(20 + 280 / 3, 10);
    expect(byId<TextNode>(nodes, "count-hard").x).toBeCloseTo(20 + (2 * 280) / 3, 10);
    // The zero difficulty draws no segment — its neighbors take the track.
    expect(nodes.some((n) => n.id === "seg-medium")).toBe(false);
    expect(byId<RectNode>(nodes, "seg-easy").style?.radius).toBe(4);
    expect(byId<RectNode>(nodes, "seg-hard").style?.radius).toBe(4);
  });

  it("falls back to the difficulty sum when the total is missing", () => {
    const nodes = generate({ solved: { easy: 2, medium: 3, hard: 1 } });
    expect(byId<TextNode>(nodes, "total").text).toBe("6");
  });

  it("gives a lone difficulty the full rounded track, no caps", () => {
    const nodes = generate({ solved: { easy: 7 } });
    const easy = byId<RectNode>(nodes, "seg-easy");
    expect(easy.w).toBeCloseTo(280, 10);
    expect(easy.style?.radius).toBe(4);
    expect(nodes.filter((n) => n.id.startsWith("cap-"))).toHaveLength(0);
  });

  it("renders the muted empty state for missing data and stays deterministic", () => {
    for (const data of [{}, { solved: {} }, { profile: { ranking: 3 } }]) {
      const nodes = generate(data);
      expect(nodes).toHaveLength(3);
      expect(byId<TextNode>(nodes, "empty").text).toBe("no leetcode data yet");
    }
    expect(JSON.stringify(generate({ solved }))).toBe(JSON.stringify(generate({ solved })));
  });
});

describe("blog-latest generator", () => {
  const posts = [
    { title: "Notes on the Analytical Engine", date: "2025-08-02" },
    { title: "Why deterministic renders matter", date: "2025-07-19" },
    { title: "A tour of the connector model", date: "2025-07-05" },
    { title: "Streaks, sparklines, and honest charts", date: "2025-06-21" },
    { title: "Shipping a profile card with live data", date: "2025-06-07" },
  ];
  const generate = (data: Record<string, unknown>) =>
    generator("blog-latest")({ props: BLOG_PROPS, data, frame: BLOG_FRAME });

  it("uses the feed title as the heading, falling back to the label prop", () => {
    const withTitle = generate({ feed: { title: "Ada's Notebook" }, posts });
    expect(byId<TextNode>(withTitle, "label").text).toBe("Ada's Notebook");
    const withoutTitle = generate({ posts });
    expect(byId<TextNode>(withoutTitle, "label").text).toBe("BLOG");
  });

  it("renders exactly the top 3 posts as dot + title + right-aligned date rows", () => {
    const nodes = generate({ feed: { title: "T" }, posts });
    expect(nodes.filter((n) => n.id.startsWith("post"))).toHaveLength(3);
    expect(nodes.some((n) => n.id === "post3")).toBe(false);

    // Row geometry: rows at y 44/76/108; dot column at x 20, title at 34,
    // date column right-aligned at 480 − 20 − 84 = 376.
    const title0 = byId<TextNode>(nodes, "post0");
    expect(title0.text).toBe("Notes on the Analytical Engine");
    expect([title0.x, title0.y, title0.w]).toEqual([34, 44, 334]);
    expect(byId<TextNode>(nodes, "post2").y).toBe(108);

    const date0 = byId<TextNode>(nodes, "date0");
    expect(date0.text).toBe("2025-08-02");
    expect([date0.x, date0.w]).toEqual([376, 84]);
    expect(date0.style?.align).toBe("right");
    expect(date0.style?.color).toBe("#7d8590");

    const dot0 = byId<RectNode>(nodes, "dot0");
    expect([dot0.x, dot0.y, dot0.w, dot0.h]).toEqual([20, 51, 6, 6]);
    expect(dot0.style?.fill).toBe("#58a6ff");
  });

  it("truncates titles to the 38-character width budget with an ellipsis", () => {
    const long = "An exhaustively detailed writeup of the entire rendering pipeline";
    const nodes = generate({ posts: [{ title: long, date: "2025-01-01" }] });
    const title = byId<TextNode>(nodes, "post0").text;
    expect(title.length).toBeLessThanOrEqual(38);
    expect(title.endsWith("…")).toBe(true);
    expect(title).toBe(`${long.slice(0, 37).trimEnd()}…`);

    // The unit itself: short titles unchanged, the cut trims trailing spaces.
    expect(truncateTitle("short", 38)).toBe("short");
    expect(truncateTitle("a".repeat(38), 38)).toBe("a".repeat(38));
    expect(truncateTitle("aaaa bbbb", 6)).toBe("aaaa…");
  });

  it("staggers the whole row's slideUp 90ms per post and keeps dates optional", () => {
    const nodes = generate({
      posts: [
        { title: "With date", date: "2025-08-02" },
        { title: "Undated" },
        { title: "Also dated", date: "2025-06-01" },
      ],
    });
    for (const [i, prefix] of [0, 1, 2].flatMap((n) => [
      [n, "dot"],
      [n, "post"],
    ] as const)) {
      expect(byId(nodes, `${prefix}${i}`).animation).toEqual({
        preset: "slideUp",
        durationMs: 500,
        delayMs: i * 90,
      });
    }
    expect(nodes.some((n) => n.id === "date1")).toBe(false); // no date, no node
    expect(byId(nodes, "date2").animation?.delayMs).toBe(180);
  });

  it("drops entries without a usable title", () => {
    const nodes = generate({
      posts: [{ date: "2025-08-02" }, { title: "" }, { title: "Kept", date: "2025-08-01" }],
    });
    expect(nodes.filter((n) => n.id.startsWith("post"))).toHaveLength(1);
    expect(byId<TextNode>(nodes, "post0").text).toBe("Kept");
  });

  it("renders the muted empty state for missing posts and stays deterministic", () => {
    for (const data of [{}, { feed: { title: "T" } }, { posts: [] }, { posts: "nope" }]) {
      const nodes = generate(data);
      expect(nodes).toHaveLength(3);
      expect(byId<TextNode>(nodes, "empty").text).toBe("no posts yet");
    }
    const data = { feed: { title: "T" }, posts };
    expect(JSON.stringify(generate(data))).toBe(JSON.stringify(generate(data)));
  });
});

describe("wakatime-badge (declarative cross-connector scalar)", () => {
  const instance: InstanceNode = {
    id: "wt",
    type: "instance",
    x: 0,
    y: 0,
    w: 220,
    h: 56,
    component: "kit/wakatime-badge",
  };

  it("resolves {{wakatime.stats.weeklyHours}} straight from the snapshot — zero machinery", () => {
    const { items, warnings } = expandInstance(instance, kitRegistry(), {
      wakatime: { stats: { weeklyHours: 32.5 } },
    });
    expect(warnings).toEqual([]);
    expect(byId<TextNode>(items as DesignNode[], "wt__text").text).toBe("32.5h this week");
  });

  it("degrades to the em-dash placeholder (with a warning) when wakatime data is absent", () => {
    const { items, warnings } = expandInstance(instance, kitRegistry(), {});
    expect(byId<TextNode>(items as DesignNode[], "wt__text").text).toBe("—h this week");
    expect(warnings).toEqual(['unresolved template path "wakatime.stats.weeklyHours"']);
  });
});

describe("pipeline integration (extended demo fixture)", () => {
  const fonts = loadFontsOrExit();

  const design: Design = {
    version: 0,
    name: "connector wave",
    canvas: { width: 520, height: 540, background: "#0d1117" },
    nodes: [
      { id: "code", type: "instance", x: 20, y: 20, w: 360, h: 110, component: "kit/coding-activity" },
      { id: "badge", type: "instance", x: 20, y: 150, w: 220, h: 56, component: "kit/wakatime-badge" },
      { id: "lc", type: "instance", x: 20, y: 226, w: 320, h: 120, component: "kit/leetcode-solved" },
      { id: "blog", type: "instance", x: 20, y: 366, w: 480, h: 150, component: "kit/blog-latest" },
    ],
  };

  // At render time the API namespaces every snapshot under its CONNECTOR
  // slug (data[binding.connector]) — the rss connector's data lives under
  // "rss". The fixture file keys that snapshot "blog" (the fixture-loader
  // key the rss connector reads), so mirror the API's shape here.
  const data = { ...demoData, rss: demoData.blog as Record<string, unknown> };

  it("renders all connector components deterministically, twice", async () => {
    const a = await render(design, data, fonts);
    const b = await render(design, data, fonts);
    expect(a.warnings).toEqual([]);
    expect(a.svg).toBe(b.svg); // determinism is the contract
    // Animated layers: 7 growY coding bars + 1 fadeIn badge text +
    // 3 blog rows × (dot + title + date) slideUp = 17.
    expect(a.svg.match(/<g id="node-/g)).toHaveLength(17);
    expect(a.svg).toContain("@keyframes mib-growY");
    expect(a.svg).toContain("@keyframes mib-slideUp");
    expect(a.svg).toContain("@keyframes mib-fadeIn");
    // WakaTime accent bars, and the LeetCode difficulty palette.
    expect(a.svg).toContain("#3fb950");
    expect(a.svg).toContain(LEETCODE_COLORS.medium);
    expect(a.svg).toContain(LEETCODE_COLORS.hard);
  }, 120000);

  it("renders empty states (never throws) when the snapshot is empty", async () => {
    const { svg, warnings } = await render(design, {}, fonts);
    expect(svg).toContain("<svg");
    // The natives degrade silently; the badge's declarative template is the
    // one legitimate warning (missing path → em-dash placeholder).
    expect(warnings).toEqual(['unresolved template path "wakatime.stats.weeklyHours"']);
  }, 120000);
});

/**
 * Native kit components (§5.7): schema variant, expansion dispatch, the four
 * trusted generators (geometry, bucket math, thresholds, empty states,
 * determinism) and pipeline-level determinism with the demo fixture.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { NodeGroup } from "./animate.js";
import { loadFontsOrExit } from "./fonts.js";
import { expandInstance, kitRegistry, parseKitComponent, type KitComponent } from "./kit.js";
import {
  LANGUAGE_PALETTE,
  contributionLevel,
  languageColor,
  nativeGenerators,
  type NativeGenerator,
} from "./native.js";
import { repoPath } from "./paths.js";
import { render } from "./pipeline.js";
import type { Design, DesignNode, InstanceNode, RectNode, TextNode } from "./types.js";

const demoData = JSON.parse(
  readFileSync(repoPath("examples", "demo-data.json"), "utf8"),
) as Record<string, unknown>;

/** Wrap connector-relative stats into the namespaced snapshot shape. */
function snapshot(stats: Record<string, unknown>): Record<string, unknown> {
  return { github: { stats } };
}

/** A calendar series of daily counts, oldest → newest ({date, count} shape). */
function calendar(counts: number[]): { date: string; count: number }[] {
  return counts.map((count, i) => ({ date: `day-${i}`, count }));
}

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

// Default props as merged from the kit metadata (mergeProps applies these).
const HEATMAP_PROPS = {
  label: "CONTRIBUTIONS",
  accent: "#39d353",
  emptyColor: "#21262d",
  background: "#161b22",
};
const SPARKLINE_PROPS = {
  label: "ACTIVITY",
  accent: "#58a6ff",
  background: "#161b22",
  peakLabel: 1,
};
const LANGUAGE_PROPS = {
  label: "TOP LANGUAGES",
  trackColor: "#21262d",
  background: "#161b22",
};
const STREAK_PROPS = { label: "CURRENT STREAK", accent: "#f78166", background: "#161b22" };

const HEATMAP_FRAME = { w: 720, h: 140 };
const SPARKLINE_FRAME = { w: 360, h: 100 };
const LANGUAGE_FRAME = { w: 720, h: 110 };
const STREAK_FRAME = { w: 360, h: 140 };

describe("kit-component schema: native variant", () => {
  const base = {
    id: "test-native",
    title: "Test native",
    frame: { w: 100, h: 50 },
    props: {},
  };

  it("accepts native with nodes absent, normalizing nodes to []", () => {
    const parsed = parseKitComponent(
      { ...base, native: true, dataFields: ["stats.calendar"] },
      "native.json",
    );
    expect(parsed.native).toBe(true);
    expect(parsed.nodes).toEqual([]);
  });

  it("accepts native with nodes: []", () => {
    const parsed = parseKitComponent(
      { ...base, native: true, dataFields: ["stats.calendar"], nodes: [] },
      "native.json",
    );
    expect(parsed.nodes).toEqual([]);
  });

  it("accepts native with static preview nodes (the shipped metadata shape)", () => {
    const parsed = parseKitComponent(
      {
        ...base,
        native: true,
        dataFields: ["stats.calendar"],
        nodes: [{ id: "bg", type: "rect", x: 0, y: 0, w: 100, h: 50 }],
      },
      "native.json",
    );
    expect(parsed.nodes).toHaveLength(1);
  });

  it("keeps declarative validation as-is: nodes stay required without native", () => {
    expect(() => parseKitComponent(base, "declarative.json")).toThrow(/invalid kit component/);
    expect(() => parseKitComponent({ ...base, nodes: [] }, "declarative.json")).toThrow(
      /invalid kit component/,
    );
  });

  it("requires dataFields with native (and native with dataFields)", () => {
    expect(() => parseKitComponent({ ...base, native: true }, "native.json")).toThrow(
      /invalid kit component/,
    );
    expect(() =>
      parseKitComponent({ ...base, nodes: [], dataFields: ["stats.calendar"] }, "native.json"),
    ).toThrow(/invalid kit component/);
  });

  it("rejects malformed dataFields entries (must be dotted connector paths)", () => {
    expect(() =>
      parseKitComponent({ ...base, native: true, dataFields: ["calendar!"] }, "native.json"),
    ).toThrow(/invalid kit component/);
  });

  it("loads every shipped native with a registered generator", () => {
    for (const component of kitRegistry().values()) {
      if (component.native) {
        expect(component.dataFields?.length).toBeGreaterThan(0);
        expect(nativeGenerators.has(component.id)).toBe(true);
      }
    }
    // The wave's stat components are all native.
    for (const id of ["contribution-heatmap", "activity-sparkline", "language-bar"]) {
      expect(kitRegistry().get(`kit/${id}`)?.native).toBe(true);
    }
  });
});

describe("expansion dispatch", () => {
  it("dispatches a native instance to its generator through scale/offset/id-prefix", () => {
    const node: InstanceNode = {
      id: "heat",
      type: "instance",
      x: 10,
      y: 20,
      w: 360,
      h: 70, // half the 720×140 frame → s = 0.5
      component: "kit/contribution-heatmap",
    };
    const { items, warnings } = expandInstance(
      node,
      kitRegistry(),
      snapshot({ calendar: calendar([3, 0, 5]) }),
    );
    expect(warnings).toEqual([]);
    const nodes = items as DesignNode[];
    // bg + label + 53×7 cells, all id-prefixed.
    expect(nodes).toHaveLength(2 + 53 * 7);
    const bg = byId<RectNode>(nodes, "heat__bg");
    expect([bg.x, bg.y, bg.w, bg.h]).toEqual([10, 20, 360, 70]);
    expect(bg.style?.radius).toBe(6); // 12 × 0.5
    expect(nodes.every((n) => n.id.startsWith("heat__"))).toBe(true);
  });

  it("falls back to the static preview nodes when a native has no generator", () => {
    const mystery: KitComponent = {
      id: "mystery",
      title: "Mystery",
      frame: { w: 100, h: 50 },
      props: {},
      native: true,
      dataFields: ["stats.calendar"],
      nodes: [{ id: "preview", type: "rect", x: 0, y: 0, w: 100, h: 50 }],
    };
    const registry = new Map([["kit/mystery", mystery]]);
    const node: InstanceNode = {
      id: "m",
      type: "instance",
      x: 0,
      y: 0,
      w: 100,
      h: 50,
      component: "kit/mystery",
    };
    const { items, warnings } = expandInstance(node, registry, {});
    expect((items as DesignNode[]).map((n) => n.id)).toEqual(["m__preview"]);
    expect(warnings).toEqual([
      'native component "kit/mystery" has no registered generator — rendering its static preview',
    ]);
  });

  it("degrades to the dashed placeholder when a generator-less native has no preview", () => {
    const mystery: KitComponent = {
      id: "mystery",
      title: "Mystery",
      frame: { w: 100, h: 50 },
      props: {},
      native: true,
      dataFields: ["stats.calendar"],
      nodes: [],
    };
    const registry = new Map([["kit/mystery", mystery]]);
    const node: InstanceNode = {
      id: "m",
      type: "instance",
      x: 0,
      y: 0,
      w: 100,
      h: 50,
      component: "kit/mystery",
    };
    const { items, warnings } = expandInstance(node, registry, {});
    expect(items).toEqual([node]);
    expect(warnings).toEqual([
      'native component "kit/mystery" has no registered generator — rendering placeholder',
    ]);
  });

  it("wraps an animated native instance into one group, stripping generated animations", () => {
    const node: InstanceNode = {
      id: "spark",
      type: "instance",
      x: 0,
      y: 0,
      w: 360,
      h: 100,
      component: "kit/activity-sparkline",
      animation: { preset: "fadeIn", durationMs: 900 },
    };
    const { items, warnings } = expandInstance(
      node,
      kitRegistry(),
      snapshot({ calendar: calendar(new Array(84).fill(1)) }),
    );
    expect(items).toHaveLength(1);
    const group = items[0] as NodeGroup;
    expect(group.kind).toBe("group");
    expect(group.animation).toEqual({ preset: "fadeIn", durationMs: 900 });
    expect(group.nodes.every((n) => n.animation === undefined)).toBe(true);
    expect(warnings).toEqual([
      'instance "spark": generated node animations ignored — an animated instance composes as one layer',
    ]);
  });

  it("lets generated nodes keep their preset animations when the instance is static", () => {
    const node: InstanceNode = {
      id: "spark",
      type: "instance",
      x: 0,
      y: 0,
      w: 360,
      h: 100,
      component: "kit/activity-sparkline",
    };
    const { items } = expandInstance(
      node,
      kitRegistry(),
      snapshot({ calendar: calendar(new Array(84).fill(1)) }),
    );
    const bars = (items as DesignNode[]).filter((n) => n.id.startsWith("spark__bar"));
    expect(bars).toHaveLength(12);
    bars.forEach((bar, i) => {
      expect(bar.animation).toEqual({ preset: "growY", durationMs: 600, delayMs: i * 40 });
    });
  });
});

describe("contribution-heatmap generator", () => {
  const generate = (data: Record<string, unknown>) =>
    generator("contribution-heatmap")({ props: HEATMAP_PROPS, data, frame: HEATMAP_FRAME });

  it("emits bg + label + exactly 53×7 cells sized from the frame", () => {
    const nodes = generate(snapshot({ calendar: calendar(new Array(371).fill(1)) }));
    expect(nodes).toHaveLength(2 + 371);

    // Cell size derivation (see generator): width-limited (720−34−156)/53 = 10,
    // height-limited (140−40−17−18)/7 = 65/7 ≈ 9.286 → the min wins and the
    // grid centers in the frame.
    const cell = Math.min((720 - 34 - 52 * 3) / 53, (140 - 40 - 17 - 18) / 7);
    const gridW = 53 * cell + 52 * 3;
    const first = byId<RectNode>(nodes, "d0");
    expect(first.w).toBeCloseTo(cell, 10);
    expect(first.h).toBeCloseTo(cell, 10);
    expect(first.x).toBeCloseTo((720 - gridW) / 2, 10);
    expect(first.y).toBeCloseTo(40, 10);

    const last = byId<RectNode>(nodes, "d370");
    expect(last.x).toBeCloseTo((720 - gridW) / 2 + 52 * (cell + 3), 10);
    expect(last.y).toBeCloseTo(40 + 6 * (cell + 3), 10);
  });

  it("computes quartile levels with integer math (ceil(4·count/max))", () => {
    // max = 8 → thresholds 2, 4, 6, 8.
    expect(contributionLevel(0, 8)).toBe(0);
    expect(contributionLevel(1, 8)).toBe(1);
    expect(contributionLevel(2, 8)).toBe(1);
    expect(contributionLevel(3, 8)).toBe(2);
    expect(contributionLevel(4, 8)).toBe(2);
    expect(contributionLevel(5, 8)).toBe(3);
    expect(contributionLevel(6, 8)).toBe(3);
    expect(contributionLevel(7, 8)).toBe(4);
    expect(contributionLevel(8, 8)).toBe(4);
    // The max always lands on level 4, even for tiny series.
    expect(contributionLevel(1, 1)).toBe(4);
    // Degenerate input is level 0, never a throw.
    expect(contributionLevel(3, 0)).toBe(0);
    expect(contributionLevel(-1, 8)).toBe(0);
  });

  it("colors zero days with emptyColor and max days with the accent", () => {
    const nodes = generate(snapshot({ calendar: calendar([0, 2, 4]) }));
    // Series right-aligns: last count → last cell.
    expect(byId<RectNode>(nodes, "d370").style?.fill).toBe("#39d353"); // 4 = max → level 4
    expect(byId<RectNode>(nodes, "d368").style?.fill).toBe("#21262d"); // 0 → track
    expect(byId<RectNode>(nodes, "d0").style?.fill).toBe("#21262d"); // front padding
    // The mid count sits on a derived ramp color — neither track nor accent.
    const mid = byId<RectNode>(nodes, "d369").style?.fill;
    expect(mid).not.toBe("#21262d");
    expect(mid).not.toBe("#39d353");
  });

  it("renders the muted empty state for missing or empty series", () => {
    for (const data of [{}, snapshot({}), snapshot({ calendar: [] }), snapshot({ calendar: 7 })]) {
      const nodes = generate(data);
      expect(nodes).toHaveLength(3); // bg + label + empty text
      const empty = byId<TextNode>(nodes, "empty");
      expect(empty.text).toBe("no contribution data yet");
      expect(empty.style?.color).toBe("#7d8590");
    }
  });

  it("is deterministic", () => {
    const data = snapshot({ calendar: calendar([0, 1, 2, 3, 4, 5, 6, 7]) });
    expect(JSON.stringify(generate(data))).toBe(JSON.stringify(generate(data)));
  });
});

describe("activity-sparkline generator", () => {
  const generate = (data: Record<string, unknown>, props = SPARKLINE_PROPS) =>
    generator("activity-sparkline")({ props, data, frame: SPARKLINE_FRAME });

  it("buckets the last 84 days into 12 weekly bars scaled to the max week", () => {
    // Week w contributes 7·w (each of its 7 days counts w) → max = 77.
    const counts = Array.from({ length: 84 }, (_, d) => Math.floor(d / 7));
    const nodes = generate(snapshot({ calendar: calendar(counts) }));
    const bars = nodes.filter((n) => n.id.startsWith("bar")) as RectNode[];
    expect(bars).toHaveLength(12);

    // barW = (360 − 32 − 88)/12 = 20; baseline 86; areaH = 52.
    expect(bars[0].w).toBe(20);
    expect(bars[0].x).toBe(16);
    expect(bars[1].x).toBe(44);

    // Week 0 has zero activity → a 2px track-colored stub.
    expect(bars[0].h).toBe(2);
    expect(bars[0].y).toBe(84);
    expect(bars[0].style?.fill).toBe("#21262d");

    // The busiest week fills the whole area.
    expect(bars[11].h).toBe(52);
    expect(bars[11].y).toBe(34);
    expect(bars[11].style?.fill).toBe("#58a6ff");

    // Interior week scales proportionally: round(7·52/77) = 5.
    expect(bars[1].h).toBe(5);
  });

  it("keeps active weeks visible with the 2px floor", () => {
    // Week 0: a single commit; week 11: a thousand — round() alone would
    // flatten week 0 to 0px.
    const counts = new Array(84).fill(0);
    counts[0] = 1;
    counts[83] = 1000;
    const bars = generate(snapshot({ calendar: calendar(counts) })).filter((n) =>
      n.id.startsWith("bar"),
    ) as RectNode[];
    expect(bars[0].h).toBe(2);
    expect(bars[0].style?.fill).toBe("#58a6ff"); // active → accent, not the stub color
    expect(bars[11].h).toBe(52);
  });

  it("front-pads short series so the newest day lands in the rightmost bar", () => {
    const bars = generate(snapshot({ calendar: calendar([3, 3, 3, 3, 3, 3, 3]) })).filter((n) =>
      n.id.startsWith("bar"),
    ) as RectNode[];
    expect(bars[11].h).toBe(52); // the only active week is the newest
    expect(bars.slice(0, 11).every((b) => b.h === 2)).toBe(true);
  });

  it("staggers the growY entrance 40ms per bar", () => {
    const bars = generate(snapshot({ calendar: calendar(new Array(84).fill(2)) })).filter((n) =>
      n.id.startsWith("bar"),
    );
    bars.forEach((bar, i) => {
      expect(bar.animation).toEqual({ preset: "growY", durationMs: 600, delayMs: i * 40 });
    });
  });

  it("shows the peak-week label unless peakLabel is 0", () => {
    const data = snapshot({ calendar: calendar(new Array(84).fill(1)) }); // every week = 7
    const withLabel = generate(data);
    expect(byId<TextNode>(withLabel, "peak").text).toBe("peak 7");
    const without = generate(data, { ...SPARKLINE_PROPS, peakLabel: 0 });
    expect(without.some((n) => n.id === "peak")).toBe(false);
  });

  it("renders the muted empty state for missing series and stays deterministic", () => {
    const nodes = generate({});
    expect(nodes).toHaveLength(3);
    expect(byId<TextNode>(nodes, "empty").text).toBe("no activity data yet");

    const data = snapshot({ calendar: calendar([1, 2, 3]) });
    expect(JSON.stringify(generate(data))).toBe(JSON.stringify(generate(data)));
  });
});

describe("language-bar generator", () => {
  const languages = [
    { name: "TypeScript", percent: 41 },
    { name: "Go", percent: 27 },
    { name: "Rust", percent: 13 },
    { name: "Python", percent: 9 },
    { name: "Shell", percent: 6 },
  ];
  const generate = (data: Record<string, unknown>) =>
    generator("language-bar")({ props: LANGUAGE_PROPS, data, frame: LANGUAGE_FRAME });

  it("hashes language names onto the fixed palette, stably", () => {
    for (const { name } of languages) {
      expect(LANGUAGE_PALETTE).toContain(languageColor(name));
      expect(languageColor(name)).toBe(languageColor(name));
    }
    // Color follows the NAME, not the position or share.
    expect(languageColor("TypeScript")).toBe(languageColor("TypeScript"));
  });

  it("sizes segments proportionally across the 680px track", () => {
    const nodes = generate(snapshot({ topLanguages: languages }));
    const segs = nodes.filter((n) => n.id.startsWith("seg")) as RectNode[];
    expect(segs).toHaveLength(5);

    const sum = 41 + 27 + 13 + 9 + 6; // 96
    expect(segs[0].x).toBe(20);
    expect(segs[0].w).toBeCloseTo((680 * 41) / sum, 10);
    expect(segs[1].x).toBeCloseTo(20 + (680 * 41) / sum, 10);
    // Segments tile the track exactly.
    const last = segs[4];
    expect(last.x + last.w).toBeCloseTo(700, 10);
    // Every segment wears its language's palette color.
    segs.forEach((seg, i) => expect(seg.style?.fill).toBe(languageColor(languages[i].name)));
  });

  it("rounds only the outer corners via the overlapping-cap trick", () => {
    const nodes = generate(snapshot({ topLanguages: languages }));
    const segs = nodes.filter((n) => n.id.startsWith("seg")) as RectNode[];
    expect(segs[0].style?.radius).toBe(7);
    expect(segs[4].style?.radius).toBe(7);
    expect(segs.slice(1, 4).every((s) => s.style?.radius === 0)).toBe(true);

    // Caps square off the inner halves of the outer segments, same fill.
    const cap0 = byId<RectNode>(nodes, "cap0");
    expect(cap0.style?.fill).toBe(segs[0].style?.fill);
    expect(cap0.x).toBeCloseTo(segs[0].x + segs[0].w / 2, 10);
    const cap4 = byId<RectNode>(nodes, "cap4");
    expect(cap4.x).toBeCloseTo(segs[4].x, 10);
    expect(nodes.filter((n) => n.id.startsWith("cap"))).toHaveLength(2);

    // A single language needs no caps — one fully rounded segment.
    const solo = generate(snapshot({ topLanguages: [{ name: "Go", percent: 100 }] }));
    expect(solo.filter((n) => n.id.startsWith("seg"))).toHaveLength(1);
    expect(solo.filter((n) => n.id.startsWith("cap"))).toHaveLength(0);
    expect(byId<RectNode>(solo, "seg0").style?.radius).toBe(7);
  });

  it("renders a legend of 'name pct%' recomputed over the shown shares", () => {
    const nodes = generate(snapshot({ topLanguages: languages }));
    const texts = nodes.filter((n) => n.id.startsWith("lang")) as TextNode[];
    expect(texts.map((t) => t.text)).toEqual([
      "TypeScript 43%", // round(41/96·100)
      "Go 28%",
      "Rust 14%",
      "Python 9%",
      "Shell 6%",
    ]);
    // Each legend dot matches its segment color.
    const dots = nodes.filter((n) => n.id.startsWith("dot")) as RectNode[];
    dots.forEach((dot, i) => expect(dot.style?.fill).toBe(languageColor(languages[i].name)));
  });

  it("orders by share desc then name asc, deterministically", () => {
    const nodes = generate(
      snapshot({
        topLanguages: [
          { name: "beta", percent: 10 },
          { name: "alpha", percent: 10 },
          { name: "gamma", percent: 30 },
        ],
      }),
    );
    const texts = nodes.filter((n) => n.id.startsWith("lang")) as TextNode[];
    expect(texts.map((t) => t.text.split(" ")[0])).toEqual(["gamma", "alpha", "beta"]);
  });

  it("renders the muted empty state for missing data and stays deterministic", () => {
    for (const data of [{}, snapshot({}), snapshot({ topLanguages: [] })]) {
      const nodes = generate(data);
      expect(byId<TextNode>(nodes, "empty").text).toBe("no language data yet");
    }
    const data = snapshot({ topLanguages: languages });
    expect(JSON.stringify(generate(data))).toBe(JSON.stringify(generate(data)));
  });
});

describe("streak-flame generator", () => {
  const generate = (data: Record<string, unknown>) =>
    generator("streak-flame")({ props: STREAK_PROPS, data, frame: STREAK_FRAME });

  it("renders current + longest streak with the pulsing accent tick", () => {
    const nodes = generate(snapshot({ currentStreak: 4, longestStreak: 9 }));
    expect(byId<TextNode>(nodes, "count").text).toBe("4");
    expect(byId<TextNode>(nodes, "count").style?.color).toBe("#f78166");
    expect(byId<TextNode>(nodes, "best").text).toBe("best: 9");
    const tick = byId<RectNode>(nodes, "tick");
    expect(tick.animation).toEqual({ preset: "pulse", durationMs: 1600, loop: true });
  });

  it("omits the best line when longestStreak is missing", () => {
    const nodes = generate(snapshot({ currentStreak: 2 }));
    expect(byId<TextNode>(nodes, "count").text).toBe("2");
    expect(nodes.some((n) => n.id === "best")).toBe(false);
  });

  it("renders the muted empty state when currentStreak is missing", () => {
    const nodes = generate(snapshot({}));
    expect(nodes).toHaveLength(3);
    expect(byId<TextNode>(nodes, "empty").text).toBe("no streak data yet");
  });
});

describe("pipeline integration (extended demo fixture)", () => {
  const fonts = loadFontsOrExit();

  const design: Design = {
    version: 0,
    name: "native stats",
    canvas: { width: 760, height: 470, background: "#0d1117" },
    nodes: [
      { id: "heat", type: "instance", x: 20, y: 20, w: 720, h: 140, component: "kit/contribution-heatmap" },
      { id: "spark", type: "instance", x: 20, y: 180, w: 360, h: 100, component: "kit/activity-sparkline" },
      { id: "streak", type: "instance", x: 400, y: 180, w: 340, h: 132, component: "kit/streak-flame" },
      { id: "langs", type: "instance", x: 20, y: 340, w: 720, h: 110, component: "kit/language-bar" },
    ],
  };

  it("renders all native stat components deterministically, twice", async () => {
    const a = await render(design, demoData, fonts);
    const b = await render(design, demoData, fonts);
    expect(a.warnings).toEqual([]);
    expect(a.svg).toBe(b.svg); // determinism is the contract
    // 12 staggered sparkline bars + the pulsing streak tick = 13 layers.
    expect(a.svg.match(/<g id="node-/g)).toHaveLength(13);
    expect(a.svg).toContain("@keyframes mib-growY");
    expect(a.svg).toContain("@keyframes mib-pulse");
    // Heatmap accent (level-4 cells) and sparkline accent made it to the SVG.
    expect(a.svg).toContain("#39d353");
    expect(a.svg).toContain("#58a6ff");
  }, 60000);

  it("renders the tasteful empty state (never throws) when the snapshot is empty", async () => {
    const { svg, warnings } = await render(design, {}, fonts);
    expect(svg).toContain("<svg");
    expect(warnings).toEqual([]);
  }, 60000);
});

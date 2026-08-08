import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { NodeGroup } from "./animate.js";
import { loadFontsOrExit } from "./fonts.js";
import {
  KitError,
  expandInstance,
  kitRegistry,
  parseKitComponent,
  type KitComponent,
} from "./kit.js";
import { repoPath } from "./paths.js";
import { render } from "./pipeline.js";
import { resolveNodeTemplates } from "./template.js";
import type { Design, DesignNode, InstanceNode, RectNode, TextNode } from "./types.js";

const data = {
  github: {
    user: { name: "Ada Lovelace", login: "ada", followers: 1234 },
    stats: { totalStars: 5678, topLanguage: "TypeScript" },
  },
};

/** Minimal component exercising strings, colors, numbers and computed geometry. */
const gauge: KitComponent = {
  id: "gauge",
  title: "Gauge",
  frame: { w: 100, h: 50 },
  props: {
    label: { type: "string", default: "CPU" },
    percent: { type: "number", default: 50 },
    accent: { type: "string", default: "#58a6ff" },
  },
  nodes: [
    {
      id: "bg",
      type: "rect",
      x: 0, y: 0, w: 100, h: 50,
      style: { fill: "#161b22", radius: 8, stroke: "#21262d", strokeWidth: 2 },
    },
    {
      id: "label",
      type: "text",
      x: 10, y: 5, w: 80, h: 10,
      text: "{{props.label}}",
      style: { fontSize: 10, color: "{{props.accent}}", letterSpacing: 1 },
    },
    {
      id: "fill",
      type: "rect",
      x: 10, y: 30, w: 40, h: 10,
      style: { fill: "{{props.accent}}" },
    },
  ],
  computed: [{ node: "fill", field: "w", prop: "percent", scale: 0.8, clamp: [0, 80] }],
};

const registry = new Map([["kit/gauge", gauge]]);

function instance(over: Partial<InstanceNode> = {}): InstanceNode {
  return { id: "inst", type: "instance", x: 20, y: 40, w: 100, h: 50, component: "kit/gauge", ...over };
}

function byId(nodes: DesignNode[], id: string): DesignNode {
  const found = nodes.find((n) => n.id === id);
  if (!found) throw new Error(`no node "${id}"`);
  return found;
}

describe("expandInstance scaling", () => {
  it("uniform-scales positions, sizes, fontSize, radii and strokeWidth, top-left aligned", () => {
    // Box 50×25 on a 100×50 frame → s = 0.5 on both axes.
    const { items, warnings } = expandInstance(instance({ w: 50, h: 25 }), registry, data);
    expect(warnings).toEqual([]);
    const nodes = items as DesignNode[];

    const bg = byId(nodes, "inst__bg") as RectNode;
    expect([bg.x, bg.y, bg.w, bg.h]).toEqual([20, 40, 50, 25]);
    expect(bg.style?.radius).toBe(4);
    expect(bg.style?.strokeWidth).toBe(1);

    const label = byId(nodes, "inst__label") as TextNode;
    expect([label.x, label.y, label.w, label.h]).toEqual([25, 42.5, 40, 5]);
    expect(label.style?.fontSize).toBe(5);
    expect(label.style?.letterSpacing).toBe(0.5);
  });

  it("uses min(w/frame.w, h/frame.h) — a wide box does not stretch content", () => {
    // 400×25 on 100×50 → s = min(4, 0.5) = 0.5, top-left aligned.
    const { items } = expandInstance(instance({ w: 400, h: 25 }), registry, data);
    const bg = byId(items as DesignNode[], "inst__bg") as RectNode;
    expect([bg.w, bg.h]).toEqual([50, 25]);
  });

  it("resolves {{props.*}} in text and colors, merging instance props over defaults", () => {
    const { items, warnings } = expandInstance(
      instance({ props: { label: "GPU", accent: "#3fb950" } }),
      registry,
      data,
    );
    expect(warnings).toEqual([]);
    const nodes = items as DesignNode[];
    expect((byId(nodes, "inst__label") as TextNode).text).toBe("GPU");
    expect((byId(nodes, "inst__label") as TextNode).style?.color).toBe("#3fb950");
    expect((byId(nodes, "inst__fill") as RectNode).style?.fill).toBe("#3fb950");
  });

  it("expands data-bound props after the pipeline's template step resolves them", () => {
    // The pipeline resolves instance props against the data snapshot first
    // (template.ts resolveNodeTemplates), then expands — mirror that here.
    const bound = instance({ props: { label: "{{github.stats.topLanguage}}" } });
    const resolved = resolveNodeTemplates(bound, data).value as InstanceNode;
    const { items, warnings } = expandInstance(resolved, registry, data);
    expect(warnings).toEqual([]);
    expect((byId(items as DesignNode[], "inst__label") as TextNode).text).toBe("TypeScript");
  });
});

describe("expandInstance id prefixing", () => {
  it("keeps ids unique across two instances of the same component", () => {
    const a = expandInstance(instance({ id: "a" }), registry, data).items as DesignNode[];
    const b = expandInstance(instance({ id: "b" }), registry, data).items as DesignNode[];
    const ids = [...a, ...b].map((n) => n.id);
    expect(ids).toEqual(["a__bg", "a__label", "a__fill", "b__bg", "b__label", "b__fill"]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("expandInstance computed", () => {
  function fillWidth(percent: unknown): number {
    const { items } = expandInstance(instance({ props: { percent } }), registry, data);
    return (byId(items as DesignNode[], "inst__fill") as RectNode).w;
  }

  it("maps the prop linearly (prop × scale) before scaling", () => {
    expect(fillWidth(50)).toBe(40); // 50 × 0.8 = 40, s = 1
  });

  it("clamps to [min, max]", () => {
    expect(fillWidth(200)).toBe(80); // 160 → clamped to 80
    expect(fillWidth(-50)).toBe(0); // -40 → clamped to 0
  });

  it("coerces numeric strings (data-bound props) and falls back to the default otherwise", () => {
    expect(fillWidth("75")).toBe(60);
    const { items, warnings } = expandInstance(
      instance({ props: { percent: "—" } }), // an unresolved binding placeholder
      registry,
      data,
    );
    expect((byId(items as DesignNode[], "inst__fill") as RectNode).w).toBe(40); // default 50 × 0.8
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('prop "percent" expects a number');
  });
});

describe("expandInstance fallbacks", () => {
  it("passes the instance through (dashed placeholder) with a warning for an unknown component", () => {
    const node = instance({ component: "kit/nope" });
    const { items, warnings } = expandInstance(node, registry, data);
    expect(items).toEqual([node]);
    expect(warnings).toEqual(['unknown component "kit/nope" — rendering placeholder']);
  });

  it("warns about unknown props and ignores them", () => {
    const { warnings } = expandInstance(instance({ props: { nope: 1 } }), registry, data);
    expect(warnings.some((w) => w.includes('unknown prop "nope"'))).toBe(true);
  });
});

describe("expandInstance animation grouping", () => {
  it("wraps an animated instance's nodes into one NodeGroup keyed by the instance id", () => {
    const { items } = expandInstance(
      instance({ animation: { preset: "fadeIn", durationMs: 900 } }),
      registry,
      data,
    );
    expect(items).toHaveLength(1);
    const group = items[0] as NodeGroup;
    expect(group.kind).toBe("group");
    expect(group.id).toBe("inst");
    expect(group.animation).toEqual({ preset: "fadeIn", durationMs: 900 });
    expect(group.nodes.map((n) => n.id)).toEqual(["inst__bg", "inst__label", "inst__fill"]);
  });
});

describe("expandInstance determinism", () => {
  it("produces an identical expansion for identical input", () => {
    const node = instance({ props: { percent: 62, label: "{{github.user.login}}" } });
    const a = expandInstance(node, registry, data);
    const b = expandInstance(node, registry, data);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("does not mutate the component or the instance node", () => {
    const before = JSON.stringify(gauge);
    const node = instance({ props: { percent: 99 } });
    const nodeBefore = JSON.stringify(node);
    expandInstance(node, registry, data);
    expect(JSON.stringify(gauge)).toBe(before);
    expect(JSON.stringify(node)).toBe(nodeBefore);
  });
});

describe("kit loading", () => {
  it("loads the official components keyed kit/{id}", () => {
    const loaded = kitRegistry();
    expect([...loaded.keys()].sort()).toEqual([
      "kit/progress-bar",
      "kit/stat-card",
      "kit/text-banner",
    ]);
    for (const component of loaded.values()) expect(component.nodes.length).toBeGreaterThan(0);
  });

  it("rejects nested instance nodes at load time", () => {
    const bad = {
      ...structuredClone(gauge),
      nodes: [
        { id: "n", type: "instance", x: 0, y: 0, w: 10, h: 10, component: "kit/stat-card" },
      ],
    };
    expect(() => parseKitComponent(bad, "bad.json")).toThrow(/nested instance/);
  });

  it("rejects computed entries referencing unknown nodes or non-number props", () => {
    const unknownNode = structuredClone(gauge) as Record<string, unknown>;
    unknownNode.computed = [{ node: "nope", prop: "percent", field: "w", scale: 1, clamp: [0, 1] }];
    expect(() => parseKitComponent(unknownNode, "bad.json")).toThrow(KitError);

    const stringProp = structuredClone(gauge) as Record<string, unknown>;
    stringProp.computed = [{ node: "fill", prop: "label", field: "w", scale: 1, clamp: [0, 1] }];
    expect(() => parseKitComponent(stringProp, "bad.json")).toThrow(/type "number"/);
  });

  it("rejects prop declarations outside string|number (schema is the contract)", () => {
    const bad = structuredClone(gauge) as { props: Record<string, unknown> };
    bad.props.accent = { type: "color", default: "#fff" };
    expect(() => parseKitComponent(bad, "bad.json")).toThrow(KitError);
  });
});

describe("pipeline integration", () => {
  const design = JSON.parse(
    readFileSync(repoPath("examples", "demo-kit-design.json"), "utf8"),
  ) as Design;
  const demoData = JSON.parse(readFileSync(repoPath("examples", "demo-data.json"), "utf8"));
  const fonts = loadFontsOrExit();

  it("renders the kit demo deterministically with the animated instance as one layer", async () => {
    const a = await render(design, demoData, fonts);
    const b = await render(design, demoData, fonts);
    expect(a.svg).toBe(b.svg); // same input → identical output string
    expect(a.warnings).toEqual([]);
    // The animated instance composes as ONE <g> layer with the preset class.
    expect(a.svg).toContain('<g id="node-banner" class="mib-fadeIn"');
    expect(a.svg.match(/<g id="node-/g)).toHaveLength(1);
  }, 30000);

  it("renders an unknown component as a placeholder with a warning — never fails", async () => {
    const broken: Design = {
      version: 0,
      canvas: { width: 100, height: 60 },
      nodes: [
        { id: "x", type: "instance", x: 0, y: 0, w: 100, h: 60, component: "kit/does-not-exist" },
      ],
    };
    const { svg, warnings } = await render(broken, {}, fonts);
    expect(svg).toContain("<svg");
    expect(warnings).toEqual(['unknown component "kit/does-not-exist" — rendering placeholder']);
  }, 30000);
});

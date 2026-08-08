import { describe, expect, it } from "vitest";

import {
  animationStyle,
  buildStyleBlock,
  composeSvg,
  namespaceIds,
  splitNodes,
  stripSvgWrapper,
} from "./animate.js";
import type { Canvas, DesignNode } from "./types.js";

const canvas: Canvas = { width: 800, height: 260 };

function rect(id: string, animation?: DesignNode["animation"]): DesignNode {
  return { id, type: "rect", x: 0, y: 0, w: 10, h: 10, animation };
}

describe("splitNodes", () => {
  it("partitions animated nodes while preserving node order", () => {
    const nodes = [rect("a"), rect("b", { preset: "fadeIn" }), rect("c"), rect("d", { preset: "pulse" })];
    const { staticNodes, animatedNodes } = splitNodes(nodes);
    expect(staticNodes.map((n) => n.id)).toEqual(["a", "c"]);
    expect(animatedNodes.map((n) => n.id)).toEqual(["b", "d"]);
  });
});

describe("stripSvgWrapper", () => {
  it("removes the outer svg element only", () => {
    expect(stripSvgWrapper('<svg width="1" height="1"><rect/></svg>')).toBe("<rect/>");
  });

  it("throws on non-svg input", () => {
    expect(() => stripSvgWrapper("<div/>")).toThrow();
  });
});

describe("buildStyleBlock", () => {
  it("emits only the keyframes for presets actually used", () => {
    const css = buildStyleBlock(["fadeIn"]);
    expect(css).toContain("@keyframes mib-fadeIn");
    expect(css).not.toContain("mib-pulse");
    expect(css).not.toContain("mib-float");
  });

  it("wraps everything in a prefers-reduced-motion guard", () => {
    expect(buildStyleBlock(["pulse"])).toContain("@media (prefers-reduced-motion: no-preference){");
  });

  it("emits presets in stable order regardless of input order and duplicates", () => {
    const css = buildStyleBlock(["float", "fadeIn", "float"]);
    expect(css.indexOf("mib-fadeIn")).toBeGreaterThan(-1);
    expect(css.indexOf("mib-fadeIn")).toBeLessThan(css.indexOf("mib-float"));
    expect(css.match(/@keyframes mib-float/g)).toHaveLength(1);
  });

  it("is empty when nothing animates", () => {
    expect(buildStyleBlock([])).toBe("");
  });
});

describe("animationStyle", () => {
  it("carries duration and delay in ms", () => {
    const css = animationStyle({ preset: "fadeIn", durationMs: 900, delayMs: 150 });
    expect(css).toContain("animation-duration:900ms");
    expect(css).toContain("animation-delay:150ms");
    expect(css).toContain("animation-iteration-count:1");
  });

  it("defaults loop to false per design.schema.json, honoring explicit loop:true", () => {
    expect(animationStyle({ preset: "pulse" })).toContain("animation-iteration-count:1");
    expect(animationStyle({ preset: "float" })).toContain("animation-iteration-count:1");
    expect(animationStyle({ preset: "pulse", loop: true })).toContain("animation-iteration-count:infinite");
    expect(animationStyle({ preset: "fadeIn", loop: true })).toContain("animation-iteration-count:infinite");
  });
});

describe("namespaceIds", () => {
  it("prefixes ids and every reference to them", () => {
    const inner =
      '<clipPath id="satori_cp0"/><rect clip-path="url(#satori_cp0)"/><use href="#satori_cp0"/>';
    expect(namespaceIds(inner, "mib-a-")).toBe(
      '<clipPath id="mib-a-satori_cp0"/><rect clip-path="url(#mib-a-satori_cp0)"/><use href="#mib-a-satori_cp0"/>',
    );
  });
});

describe("composeSvg", () => {
  it("composes base + per-node groups + one style block, deterministically", () => {
    const layers = [
      { node: rect("accent", { preset: "fadeIn", durationMs: 900 }), inner: "<rect id='l1'/>" },
      { node: rect("orb", { preset: "float" }), inner: "<rect id='l2'/>" },
    ];
    const a = composeSvg(canvas, "<rect id='base'/>", layers);
    const b = composeSvg(canvas, "<rect id='base'/>", layers);
    expect(a).toBe(b); // deterministic

    expect(a.startsWith('<svg width="800" height="260" viewBox="0 0 800 260"')).toBe(true);
    expect(a).toContain('<g id="node-accent" class="mib-fadeIn"');
    expect(a).toContain('<g id="node-orb" class="mib-float"');
    // base renders under the animated layers; style block comes last
    expect(a.indexOf("id='base'")).toBeLessThan(a.indexOf("node-accent"));
    expect(a.indexOf("node-accent")).toBeLessThan(a.indexOf("node-orb"));
    expect(a.match(/<style>/g)).toHaveLength(1);
    expect(a).toContain("@keyframes mib-fadeIn");
    expect(a).toContain("@keyframes mib-float");
    expect(a).not.toContain("@keyframes mib-pulse");
  });

  it("emits no style block for a fully static design", () => {
    const svg = composeSvg(canvas, "<rect/>", []);
    expect(svg).not.toContain("<style>");
  });
});

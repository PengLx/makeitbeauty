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

  it("keeps the original trio byte-identical (determinism regression contract)", () => {
    // Existing deployed designs must re-render to the exact same bytes.
    // These strings are the pre-expansion output — do not reformat them.
    expect(buildStyleBlock(["fadeIn", "pulse", "float"])).toBe(
      "<style>@media (prefers-reduced-motion: no-preference){" +
        ".mib-fadeIn{animation-name:mib-fadeIn}" +
        ".mib-pulse{animation-name:mib-pulse}" +
        ".mib-float{animation-name:mib-float}" +
        "@keyframes mib-fadeIn{from{opacity:0}to{opacity:1}}" +
        "@keyframes mib-pulse{0%,100%{opacity:1}50%{opacity:0.55}}" +
        "@keyframes mib-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}" +
        "}</style>",
    );
  });

  it("emits growX keyframes with fill-box transform-box and left-center origin", () => {
    const css = buildStyleBlock(["growX"]);
    expect(css).toContain("@keyframes mib-growX{from{transform:scaleX(0)}to{transform:scaleX(1)}}");
    expect(css).toContain(
      ".mib-growX{animation-name:mib-growX;transform-box:fill-box;transform-origin:left center}",
    );
  });

  it("emits growY keyframes with fill-box transform-box and center-bottom origin", () => {
    const css = buildStyleBlock(["growY"]);
    expect(css).toContain("@keyframes mib-growY{from{transform:scaleY(0)}to{transform:scaleY(1)}}");
    expect(css).toContain(
      ".mib-growY{animation-name:mib-growY;transform-box:fill-box;transform-origin:center bottom}",
    );
  });

  it("emits slideUp/slideLeft keyframes with fill-box transform-box", () => {
    const up = buildStyleBlock(["slideUp"]);
    expect(up).toContain(
      "@keyframes mib-slideUp{from{transform:translateY(8px);opacity:0}to{transform:none;opacity:1}}",
    );
    expect(up).toContain(".mib-slideUp{animation-name:mib-slideUp;transform-box:fill-box}");

    const left = buildStyleBlock(["slideLeft"]);
    expect(left).toContain(
      "@keyframes mib-slideLeft{from{transform:translateX(8px);opacity:0}to{transform:none;opacity:1}}",
    );
    expect(left).toContain(".mib-slideLeft{animation-name:mib-slideLeft;transform-box:fill-box}");
  });

  it("emits blink keyframes with per-keyframe step-end timing, no transform extras", () => {
    const css = buildStyleBlock(["blink"]);
    expect(css).toContain(
      "@keyframes mib-blink{0%{opacity:1;animation-timing-function:step-end}" +
        "50%{opacity:0;animation-timing-function:step-end}100%{opacity:1}}",
    );
    expect(css).toContain(".mib-blink{animation-name:mib-blink}");
    expect(css).not.toContain(".mib-blink{animation-name:mib-blink;transform");
  });

  it("keeps opacity-only presets free of transform-box", () => {
    expect(buildStyleBlock(["fadeIn", "pulse", "blink"])).not.toContain("transform-box");
  });

  it("orders new presets stably after the original trio", () => {
    const css = buildStyleBlock(["blink", "growX", "slideUp", "fadeIn", "growY", "slideLeft"]);
    const order = ["mib-fadeIn", "mib-growX", "mib-growY", "mib-slideUp", "mib-slideLeft", "mib-blink"];
    const positions = order.map((name) => css.indexOf(`@keyframes ${name}{`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("emits only the new presets actually used", () => {
    const css = buildStyleBlock(["growX"]);
    for (const other of ["growY", "slideUp", "slideLeft", "blink", "fadeIn", "pulse", "float"]) {
      expect(css).not.toContain(`mib-${other}`);
    }
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

  it("composes a design using every new preset deterministically", () => {
    const layers = [
      { node: rect("bar", { preset: "growX" as const, durationMs: 900 }), inner: "<rect/>" },
      { node: rect("col", { preset: "growY" as const }), inner: "<rect/>" },
      { node: rect("txt", { preset: "slideUp" as const, delayMs: 120 }), inner: "<rect/>" },
      { node: rect("row", { preset: "slideLeft" as const }), inner: "<rect/>" },
      { node: rect("cur", { preset: "blink" as const, loop: true }), inner: "<rect/>" },
    ];
    const a = composeSvg(canvas, "<rect/>", layers);
    const b = composeSvg(canvas, "<rect/>", layers);
    expect(a).toBe(b);
    for (const p of ["growX", "growY", "slideUp", "slideLeft", "blink"]) {
      expect(a).toContain(`@keyframes mib-${p}`);
      expect(a).toContain(`class="mib-${p}"`);
    }
    expect(a).toContain("transform-box:fill-box");
    expect(a).toContain('<g id="node-cur" class="mib-blink"');
    expect(a).toContain("animation-iteration-count:infinite");
  });
});

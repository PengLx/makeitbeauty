/**
 * §5.6 tw styling engine: compile-and-merge in the tree builder, warnings
 * through the pipeline channel, gradients/shadows in real satori output, and
 * the sanitizer still gating the final SVG.
 */
import { describe, expect, it } from "vitest";

import { loadFontsOrExit } from "./fonts.js";
import { render } from "./pipeline.js";
import { buildCanvas, buildNode } from "./tree.js";
import type { Design, RectNode, TextNode } from "./types.js";

const fonts = loadFontsOrExit();

function rect(over: Partial<RectNode> = {}): RectNode {
  return { id: "r", type: "rect", x: 0, y: 0, w: 100, h: 50, ...over };
}

function text(over: Partial<TextNode> = {}): TextNode {
  return { id: "t", type: "text", x: 0, y: 0, w: 100, h: 20, text: "hi", ...over };
}

describe("tree merge order (defaults < tw < frame < structured)", () => {
  it("compiles rect tw into the style object", () => {
    const el = buildNode(rect({ tw: "bg-blue-500 rounded-xl shadow-lg" }));
    expect(el.props.style?.backgroundColor).toBe("#2b7fff");
    expect(el.props.style?.borderRadius).toBe("12px");
    expect(el.props.style?.boxShadow).toContain("0 10px 15px");
  });

  it("puts tw gradients on backgroundImage", () => {
    const el = buildNode(rect({ tw: "bg-gradient-to-r from-cyan-400 to-fuchsia-500" }));
    expect(el.props.style?.backgroundImage).toBe(
      "linear-gradient(90deg, #00d3f2 0%, #e12afb 100%)",
    );
  });

  it("lets structured rect fields override tw", () => {
    const el = buildNode(
      rect({ tw: "bg-blue-500 rounded-xl border-4 border-red-500", style: { fill: "#ff0000", radius: 3, stroke: "#00ff00", strokeWidth: 2 } }),
    );
    expect(el.props.style?.backgroundColor).toBe("#ff0000");
    expect(el.props.style?.borderRadius).toBe(3);
    expect(el.props.style?.borderWidth).toBe("2px");
    expect(el.props.style?.borderColor).toBe("#00ff00");
  });

  it("lets tw set text color/weight/leading but structured fields win", () => {
    const styled = buildNode(text({ tw: "text-white font-bold leading-tight" }));
    expect(styled.props.style?.color).toBe("#ffffff");
    expect(styled.props.style?.fontWeight).toBe(700);
    expect(styled.props.style?.lineHeight).toBe(1.25);

    const overridden = buildNode(
      text({ tw: "text-white font-bold", style: { color: "#123456", fontWeight: 300 } }),
    );
    expect(overridden.props.style?.color).toBe("#123456");
    expect(overridden.props.style?.fontWeight).toBe(300);
  });

  it("keeps text defaults when tw does not touch them", () => {
    const el = buildNode(text({ tw: "tracking-wide" }));
    expect(el.props.style?.fontSize).toBe(16);
    expect(el.props.style?.fontWeight).toBe(400);
    expect(el.props.style?.color).toBe("#000000");
    expect(el.props.style?.letterSpacing).toBe("0.4px");
  });

  it("applies tw padding to the text box", () => {
    const el = buildNode(text({ tw: "px-4 py-2" }));
    expect(el.props.style?.paddingLeft).toBe("16px");
    expect(el.props.style?.paddingRight).toBe("16px");
    expect(el.props.style?.paddingTop).toBe("8px");
    expect(el.props.style?.paddingBottom).toBe("8px");
  });

  it("lets the node frame beat tw (structured opacity wins over opacity-*)", () => {
    expect(buildNode(rect({ tw: "opacity-50" })).props.style?.opacity).toBe(0.5);
    expect(buildNode(rect({ tw: "opacity-50", opacity: 0.9 })).props.style?.opacity).toBe(0.9);
  });

  it("prefixes compiler warnings with the node id", () => {
    const warnings: string[] = [];
    buildNode(rect({ id: "hero", tw: "bg-doesnotexist flex" }), warnings);
    expect(warnings).toEqual([
      "hero: unknown or unsupported class: bg-doesnotexist",
      "hero: unknown or unsupported class: flex",
    ]);
  });
});

describe("canvas tw", () => {
  it("compiles a canvas gradient, structured background/radius override", () => {
    const warnings: string[] = [];
    const el = buildCanvas(
      { width: 100, height: 50, tw: "bg-gradient-to-b from-slate-900 to-indigo-950 bg-blue-500 rounded-lg", background: "#0d1117", radius: 16 },
      [],
      false,
      warnings,
    );
    expect(el.props.style?.backgroundImage).toBe(
      "linear-gradient(180deg, #0f172b 0%, #1e1a4d 100%)",
    );
    expect(el.props.style?.backgroundColor).toBe("#0d1117"); // structured wins over bg-blue-500
    expect(el.props.style?.borderRadius).toBe(16); // structured wins over rounded-lg
    expect(warnings).toEqual([]);
  });

  it("skips canvas tw entirely on transparent (animated-layer) passes", () => {
    const warnings: string[] = [];
    const el = buildCanvas(
      { width: 100, height: 50, tw: "bg-gradient-to-b from-slate-900 to-indigo-950 bg-doesnotexist" },
      [],
      true,
      warnings,
    );
    expect(el.props.style?.backgroundImage).toBeUndefined();
    expect(el.props.style?.backgroundColor).toBe("transparent");
    expect(warnings).toEqual([]); // no duplicate warnings from layer passes
  });

  it("prefixes canvas compiler warnings with 'canvas'", () => {
    const warnings: string[] = [];
    buildCanvas({ width: 100, height: 50, tw: "bg-gradient-to-r" }, [], false, warnings);
    expect(warnings).toEqual([
      "canvas: gradient direction without color stops: add from-/via-/to-",
    ]);
  });
});

describe("pipeline integration", () => {
  const design: Design = {
    version: 0,
    canvas: {
      width: 400,
      height: 200,
      radius: 12,
      tw: "bg-gradient-to-br from-indigo-950 via-purple-900 to-slate-900",
    },
    nodes: [
      {
        id: "accent",
        type: "rect",
        x: 20, y: 20, w: 200, h: 6,
        tw: "bg-gradient-to-r from-cyan-400 to-fuchsia-500 rounded-full",
      },
      {
        id: "card",
        type: "rect",
        x: 20, y: 40, w: 360, h: 100,
        tw: "bg-white rounded-2xl shadow-2xl",
      },
      {
        id: "title",
        type: "text",
        x: 40, y: 60, w: 320, h: 30,
        text: "Hello {{user.name}}",
        tw: "text-slate-900 font-bold tracking-wide px-2",
      },
    ],
  };
  const data = { user: { name: "Ada" } };

  it("renders tw gradients as SVG linearGradient stops (rect and canvas)", async () => {
    const { svg, warnings } = await render(design, data, fonts);
    expect(warnings).toEqual([]);
    expect(svg).toContain("linearGradient");
    // accent bar stops
    expect(svg).toContain('stop-color="#00d3f2"');
    expect(svg).toContain('stop-color="#e12afb"');
    // canvas gradient stops (background gradient on the root)
    expect(svg).toContain('stop-color="#1e1a4d"');
    expect(svg).toContain('stop-color="#59168b"');
    expect(svg).toContain('stop-color="#0f172b"');
  }, 30000);

  it("renders tw shadows (satori emits a blur filter)", async () => {
    const { svg } = await render(design, data, fonts);
    expect(svg).toContain("feGaussianBlur");
  }, 30000);

  it("structured style overrides tw in the final SVG", async () => {
    const override: Design = {
      version: 0,
      canvas: { width: 100, height: 60 },
      nodes: [
        { id: "r", type: "rect", x: 0, y: 0, w: 100, h: 60, tw: "bg-blue-500", style: { fill: "#ff0000" } },
      ],
    };
    const { svg, warnings } = await render(override, {}, fonts);
    expect(warnings).toEqual([]);
    expect(svg).toContain("#ff0000");
    expect(svg).not.toContain("#2b7fff"); // the tw color lost, invisibly
  }, 30000);

  it("surfaces compiler warnings prefixed with the node id — never fails", async () => {
    const warned: Design = {
      version: 0,
      canvas: { width: 100, height: 60, tw: "bg-gradient-to-r" },
      nodes: [
        { id: "r", type: "rect", x: 0, y: 0, w: 100, h: 60, tw: "bg-blue-500 bg-doesnotexist" },
      ],
    };
    const { svg, warnings } = await render(warned, {}, fonts);
    expect(svg).toContain("<svg");
    expect(warnings).toEqual([
      "r: unknown or unsupported class: bg-doesnotexist",
      "canvas: gradient direction without color stops: add from-/via-/to-",
    ]);
  }, 30000);

  it("warns that tw on instance nodes is not supported", async () => {
    const withInstance: Design = {
      version: 0,
      canvas: { width: 400, height: 100 },
      nodes: [
        {
          id: "badge",
          type: "instance",
          x: 0, y: 0, w: 200, h: 56,
          component: "kit/metric-badge",
          tw: "shadow-lg",
        },
      ],
    };
    const { warnings } = await render(withInstance, {}, fonts);
    expect(warnings).toEqual(["badge: tw on instance nodes is not supported"]);
  }, 30000);

  it("renders deterministically (byte-identical across runs)", async () => {
    const a = await render(design, data, fonts);
    const b = await render(design, data, fonts);
    expect(a.svg).toBe(b.svg);
    expect(a.warnings).toEqual(b.warnings);
  }, 30000);

  it("passes the sanitizer: no external url() can appear in tw output", async () => {
    const hostile: Design = {
      version: 0,
      canvas: { width: 100, height: 60 },
      nodes: [
        {
          id: "r",
          type: "rect",
          x: 0, y: 0, w: 100, h: 60,
          // hostile attempts: dropped by the compiler, gated by the sanitizer
          tw: "bg-[url(https://evil.example/x)] shadow-[0_0_4px_url(https://evil.example)] bg-gradient-to-r from-cyan-400 to-fuchsia-500",
        },
      ],
    };
    const { svg, warnings } = await render(hostile, {}, fonts);
    expect(warnings).toEqual([
      "r: unsafe value dropped: bg-[url(https://evil.example/x)]",
      "r: unsafe value dropped: shadow-[0_0_4px_url(https://evil.example)]",
    ]);
    // Every url() in the output is an internal #fragment reference.
    expect(svg).not.toMatch(/url\((?!#)/);
    expect(svg).not.toContain("evil.example");
  }, 30000);

  it("renders the tw example design end to end with zero warnings", async () => {
    const { readFileSync } = await import("node:fs");
    const { repoPath } = await import("./paths.js");
    const example = JSON.parse(
      readFileSync(repoPath("examples", "demo-tw-design.json"), "utf8"),
    ) as Design;
    const exampleData = JSON.parse(readFileSync(repoPath("examples", "demo-data.json"), "utf8"));
    const a = await render(example, exampleData, fonts);
    const b = await render(example, exampleData, fonts);
    expect(a.warnings).toEqual([]);
    expect(a.svg).toBe(b.svg);
    expect(a.svg).toContain("linearGradient");
    expect(a.svg).toContain("feGaussianBlur"); // shadow-2xl / shadow-lg pills
    expect(a.svg).toContain("@keyframes mib-growX"); // animated gradient accent bar
  }, 30000);
});

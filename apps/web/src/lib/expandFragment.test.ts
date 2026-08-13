import { describe, expect, it } from "vitest";
import type { ComponentDefinition } from "./component";
import type { RectNode, TextNode, ImageNode } from "./design";
import {
  expandFragment,
  mergeInstanceProps,
  type ExpandableDefinition,
} from "./expandFragment";

/** A 200×100 definition exercising every node type + computed geometry. */
function makeDef(): ComponentDefinition {
  return {
    id: "me/card",
    title: "Card",
    frame: { w: 200, h: 100 },
    props: {
      label: { type: "string", default: "hello" },
      accent: { type: "string", default: "#58a6ff" },
      pct: { type: "number", default: 40 },
    },
    nodes: [
      {
        id: "bg",
        type: "rect",
        x: 0,
        y: 0,
        w: 200,
        h: 100,
        style: { fill: "#161b22", radius: 8, stroke: "{{props.accent}}", strokeWidth: 2 },
      },
      {
        id: "title",
        type: "text",
        x: 10,
        y: 20,
        w: 180,
        h: 20,
        text: "{{props.label}} · {{github.stars}}",
        style: { fontSize: 20, letterSpacing: 2 },
      },
      // No style at all — exercises the renderer's fontSize-pin-to-16.
      { id: "bare", type: "text", x: 10, y: 44, w: 180, h: 20, text: "plain" },
      { id: "pic", type: "image", x: 150, y: 10, w: 40, h: 40, src: "data:,", radius: 10 },
      { id: "bar", type: "rect", x: 10, y: 80, w: 0, h: 8, style: { radius: 4 } },
    ],
    computed: [{ node: "bar", prop: "pct", field: "w", scale: 1.8, clamp: [0, 180] }],
  };
}

/** Frame-sized instance at the origin — the identity-geometry case. */
const IDENTITY = { x: 0, y: 0, w: 200, h: 100 };

describe("mergeInstanceProps", () => {
  const def = makeDef();

  it("fills declared defaults for missing props", () => {
    expect(mergeInstanceProps(def, {})).toEqual({
      label: "hello",
      accent: "#58a6ff",
      pct: 40,
    });
  });

  it("coerces numeric strings for number props (kit.ts mergeProps)", () => {
    expect(mergeInstanceProps(def, { pct: "55" }).pct).toBe(55);
    expect(mergeInstanceProps(def, { pct: 12.5 }).pct).toBe(12.5);
  });

  it("falls back to the default with a warning on a bad number", () => {
    const warnings: string[] = [];
    expect(mergeInstanceProps(def, { pct: "wat" }, warnings).pct).toBe(40);
    expect(warnings).toEqual([
      'prop "pct" expects a number, got "wat" — using default 40',
    ]);
  });

  it("stringifies scalar values for string props; non-scalars fall back", () => {
    const warnings: string[] = [];
    const merged = mergeInstanceProps(
      def,
      { label: 7, accent: { r: 1 } },
      warnings,
    );
    expect(merged.label).toBe("7");
    expect(merged.accent).toBe("#58a6ff");
    expect(warnings).toEqual([
      'prop "accent" expects a string, got a non-scalar — using default',
    ]);
  });

  it("warns and ignores undeclared props", () => {
    const warnings: string[] = [];
    const merged = mergeInstanceProps(def, { nope: "x" }, warnings);
    expect("nope" in merged).toBe(false);
    expect(warnings).toEqual(['unknown prop "nope" — ignored']);
  });

  it("degrades an absent default (loose palette metadata) to the type's zero value", () => {
    const loose: ExpandableDefinition = {
      frame: { w: 10, h: 10 },
      props: { a: { type: "string" }, n: { type: "number" } },
      nodes: [],
    };
    expect(mergeInstanceProps(loose, {})).toEqual({ a: "", n: 0 });
  });
});

describe("expandFragment — template resolution", () => {
  it("resolves {{props.*}} against merged props", () => {
    const { nodes } = expandFragment(makeDef(), { label: "Stars" }, IDENTITY);
    const title = nodes.find((n) => n.id === "title") as TextNode;
    expect(title.text).toBe("Stars · {{github.stars}}");
    const bg = nodes.find((n) => n.id === "bg") as RectNode;
    expect(bg.style?.stroke).toBe("#58a6ff");
  });

  it("leaves non-props templates LITERAL without warning — data preview is the API's job", () => {
    const { nodes, warnings } = expandFragment(makeDef(), {}, IDENTITY);
    const title = nodes.find((n) => n.id === "title") as TextNode;
    expect(title.text).toBe("hello · {{github.stars}}");
    expect(warnings).toEqual([]);
  });

  it("em-dashes an unresolvable props path with a warning (template.ts semantics)", () => {
    const def = makeDef();
    (def.nodes[1] as TextNode).text = "{{props.missing}}";
    const { nodes, warnings } = expandFragment(def, {}, IDENTITY);
    expect((nodes[1] as TextNode).text).toBe("—");
    expect(warnings).toEqual(['unresolved template path "props.missing"']);
  });

  it("does not mutate the definition (deep copy per fragment)", () => {
    const def = makeDef();
    const before = structuredClone(def);
    expandFragment(def, { pct: 90 }, { x: 5, y: 5, w: 100, h: 50 });
    expect(def).toEqual(before);
  });
});

describe("expandFragment — computed geometry", () => {
  it("applies node[field] = clamp(prop × scale) in frame coordinates", () => {
    const { nodes } = expandFragment(makeDef(), { pct: 50 }, IDENTITY);
    const bar = nodes.find((n) => n.id === "bar") as RectNode;
    expect(bar.w).toBe(90); // 50 × 1.8
  });

  it("clamps to the declared range", () => {
    const { nodes } = expandFragment(makeDef(), { pct: 500 }, IDENTITY);
    expect((nodes.find((n) => n.id === "bar") as RectNode).w).toBe(180);
  });
});

describe("expandFragment — scaling (kit.ts scaleAndOffset semantics)", () => {
  // 200×100 frame into a 100×100 box at (30, 40): s = min(0.5, 1) = 0.5,
  // top-left aligned, offset by the instance origin.
  const FRAME = { x: 30, y: 40, w: 100, h: 100 };

  it("computes s = min(w/frame.w, h/frame.h) and reports it", () => {
    expect(expandFragment(makeDef(), {}, FRAME).scale).toBe(0.5);
    expect(expandFragment(makeDef(), {}, { x: 0, y: 0, w: 400, h: 150 }).scale).toBe(1.5);
  });

  it("scales positions/sizes and offsets by the instance origin", () => {
    const { nodes } = expandFragment(makeDef(), {}, FRAME);
    const title = nodes.find((n) => n.id === "title") as TextNode;
    expect([title.x, title.y, title.w, title.h]).toEqual([35, 50, 90, 10]);
  });

  it("scales fontSize and letterSpacing on text nodes", () => {
    const { nodes } = expandFragment(makeDef(), {}, FRAME);
    const title = nodes.find((n) => n.id === "title") as TextNode;
    expect(title.style?.fontSize).toBe(10); // 20 × 0.5
    expect(title.style?.letterSpacing).toBe(1); // 2 × 0.5
  });

  it("pins an unset fontSize to 16 before scaling (the renderer's nuance)", () => {
    const { nodes } = expandFragment(makeDef(), {}, FRAME);
    const bare = nodes.find((n) => n.id === "bare") as TextNode;
    expect(bare.style?.fontSize).toBe(8); // (unset → 16) × 0.5
    expect(bare.style?.letterSpacing).toBeUndefined(); // unset stays unset
  });

  it("writes the 16px pin even at s = 1 — exactly like the renderer", () => {
    const { nodes } = expandFragment(makeDef(), {}, IDENTITY);
    const bare = nodes.find((n) => n.id === "bare") as TextNode;
    expect(bare.style?.fontSize).toBe(16);
    // …while geometry is untouched.
    expect([bare.x, bare.y, bare.w, bare.h]).toEqual([10, 44, 180, 20]);
  });

  it("scales rect radius and strokeWidth", () => {
    const { nodes } = expandFragment(makeDef(), {}, FRAME);
    const bg = nodes.find((n) => n.id === "bg") as RectNode;
    expect(bg.style?.radius).toBe(4); // 8 × 0.5
    expect(bg.style?.strokeWidth).toBe(1); // 2 × 0.5
  });

  it("scales image radius", () => {
    const { nodes } = expandFragment(makeDef(), {}, FRAME);
    const pic = nodes.find((n) => n.id === "pic") as ImageNode;
    expect(pic.radius).toBe(5); // 10 × 0.5
    expect([pic.x, pic.y, pic.w, pic.h]).toEqual([105, 45, 20, 20]);
  });

  it("applies computed BEFORE scaling — frame coordinates, then × s", () => {
    const { nodes } = expandFragment(makeDef(), { pct: 40 }, FRAME);
    const bar = nodes.find((n) => n.id === "bar") as RectNode;
    expect(bar.w).toBe(36); // clamp(40 × 1.8) = 72, then × 0.5
  });

  it("keeps node ids verbatim and opacity/rotation untouched", () => {
    const def = makeDef();
    (def.nodes[0] as RectNode).opacity = 0.5;
    (def.nodes[0] as RectNode).rotation = 45;
    const { nodes } = expandFragment(def, {}, FRAME);
    expect(nodes.map((n) => n.id)).toEqual(["bg", "title", "bare", "pic", "bar"]);
    expect(nodes[0].opacity).toBe(0.5);
    expect(nodes[0].rotation).toBe(45);
  });
});

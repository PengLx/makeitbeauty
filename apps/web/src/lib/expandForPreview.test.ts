/**
 * Locks the Studio's client-side draft expansion — this output shape was
 * verified byte-identical to the renderer's expansion for the Studio's s = 1
 * case, so these tests are a regression fence: the generalized canvas
 * expansion (expandFragment.ts) must never change what the Studio sends to
 * POST /v1/preview.
 */
import { describe, expect, it } from "vitest";
import type { ComponentDefinition } from "./component";
import type { RectNode, TextNode } from "./design";
import {
  PREVIEW_BACKGROUND,
  expandForPreview,
  mergeSampleProps,
  seriesVariant,
  wrapCodeNodesForPreview,
} from "./expandForPreview";

function makeDef(): ComponentDefinition {
  return {
    id: "me/card",
    title: "Card",
    frame: { w: 200, h: 100 },
    props: {
      label: { type: "string", default: "hello" },
      pct: { type: "number", default: 40 },
    },
    nodes: [
      { id: "bg", type: "rect", x: 0, y: 0, w: 200, h: 100, style: { fill: "#161b22", radius: 8 } },
      // No style — the s = 1 shortcut must NOT write a fontSize pin here.
      { id: "title", type: "text", x: 10, y: 20, w: 180, h: 20, text: "{{props.label}}" },
      { id: "bound", type: "text", x: 10, y: 44, w: 180, h: 20, text: "{{github.stars}}" },
      { id: "bar", type: "rect", x: 10, y: 80, w: 0, h: 8 },
    ],
    computed: [{ node: "bar", prop: "pct", field: "w", scale: 1.8, clamp: [0, 180] }],
  };
}

describe("mergeSampleProps", () => {
  const def = makeDef();

  it("merges samples over declared defaults, coercing numbers", () => {
    expect(mergeSampleProps(def, {})).toEqual({ label: "hello", pct: 40 });
    expect(mergeSampleProps(def, { label: "Stars", pct: "55" })).toEqual({
      label: "Stars",
      pct: 55,
    });
  });

  it("falls back to the default with the exact warning on a bad number", () => {
    const warnings: string[] = [];
    expect(mergeSampleProps(def, { pct: "wat" }, warnings).pct).toBe(40);
    expect(warnings).toEqual([
      'sample for "pct" expects a number, got "wat" — using default 40',
    ]);
  });

  it("ignores undeclared samples (stale keys fall away)", () => {
    expect("gone" in mergeSampleProps(def, { gone: "x" })).toBe(false);
  });

  it("series props sample as the declared default array, varied by seed", () => {
    const withSeries: ComponentDefinition = {
      ...makeDef(),
      props: {
        ...makeDef().props,
        calendar: { type: "series", default: [1, 2, 3] },
      },
    };
    // Seed absent/0: the default verbatim (same reference — no needless copy).
    expect(mergeSampleProps(withSeries, {}).calendar).toEqual([1, 2, 3]);
    // A text sample for a series prop is meaningless and ignored.
    expect(
      mergeSampleProps(withSeries, { calendar: "[9]" }).calendar,
    ).toEqual([1, 2, 3]);
    // Seeded: the deterministic variant.
    const varied = mergeSampleProps(withSeries, {}, [], { calendar: 2 });
    expect(varied.calendar).toEqual(seriesVariant([1, 2, 3], 2));
  });
});

describe("seriesVariant", () => {
  const base = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  it("seed 0 is the identity", () => {
    expect(seriesVariant(base, 0)).toBe(base);
  });

  it("is deterministic: same (base, seed) → same output, always", () => {
    expect(seriesVariant(base, 3)).toEqual(seriesVariant(base, 3));
    expect(seriesVariant(base, 3)).toEqual(seriesVariant([...base], 3));
  });

  it("different seeds vary the picture", () => {
    expect(seriesVariant(base, 1)).not.toEqual(seriesVariant(base, 2));
  });

  it("varies {count} objects and leaves other shapes untouched", () => {
    const days = [
      { date: "2026-01-01", count: 4 },
      { date: "2026-01-02", label: "no count" },
      "opaque",
    ];
    const out = seriesVariant(days, 5) as typeof days;
    expect((out[0] as { date: string }).date).toBe("2026-01-01");
    expect(typeof (out[0] as { count: number }).count).toBe("number");
    expect(out[1]).toEqual(days[1]);
    expect(out[2]).toBe("opaque");
    // Pure: the base is never mutated.
    expect((days[0] as { count: number }).count).toBe(4);
  });

  it("produces only non-negative numbers for numeric entries", () => {
    for (const seed of [1, 2, 7, 40]) {
      for (const v of seriesVariant(base, seed) as number[]) {
        expect(typeof v).toBe("number");
        expect(v).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});

describe("wrapCodeNodesForPreview", () => {
  it("wraps sandbox output in the frame-sized preview design, resolving props-only", () => {
    const def = makeDef();
    const { design, warnings } = wrapCodeNodesForPreview(
      def,
      { label: "Stars" },
      [
        { id: "t", type: "text", x: 0, y: 0, w: 100, h: 20, text: "{{props.label}}" },
        // §7.6 consent: a data template EMITTED BY CODE must em-dash, exactly
        // like the renderer's props-only output scope.
        { id: "leak", type: "text", x: 0, y: 20, w: 100, h: 20, text: "{{github.stars}}" },
      ],
    );
    expect(design.canvas).toEqual({
      width: 200,
      height: 100,
      background: PREVIEW_BACKGROUND,
    });
    expect((design.nodes[0] as TextNode).text).toBe("Stars");
    expect((design.nodes[1] as TextNode).text).toBe("—");
    expect(warnings).toEqual(['unresolved template path "github.stars"']);
  });
});

describe("expandForPreview", () => {
  it("wraps the expansion in a frame-sized design with the Studio background", () => {
    const { design } = expandForPreview(makeDef(), {});
    expect(design.version).toBe(0);
    expect(design.canvas).toEqual({
      width: 200,
      height: 100,
      background: PREVIEW_BACKGROUND,
    });
    expect(design.nodes.map((n) => n.id)).toEqual(["bg", "title", "bound", "bar"]);
  });

  it("resolves {{props.*}} and applies computed geometry", () => {
    const { design } = expandForPreview(makeDef(), { label: "Stars", pct: "50" });
    expect((design.nodes[1] as TextNode).text).toBe("Stars");
    expect((design.nodes[3] as RectNode).w).toBe(90); // 50 × 1.8, clamped
  });

  it("em-dashes NON-props paths with a warning — unlike the canvas expansion", () => {
    const { design, warnings } = expandForPreview(makeDef(), {});
    expect((design.nodes[2] as TextNode).text).toBe("—");
    expect(warnings).toEqual(['unresolved template path "github.stars"']);
  });

  it("stays byte-identical to the s = 1 shortcut: no fontSize pin, geometry verbatim", () => {
    const def = makeDef();
    const { design } = expandForPreview(def, {});
    // The scaleAndOffset step is skipped entirely, so a style-less text node
    // remains style-less (the renderer would write fontSize: 16, which is
    // satori's default anyway — render-identical, byte-different).
    expect((design.nodes[1] as TextNode).style).toBeUndefined();
    const bg = design.nodes[0] as RectNode;
    expect([bg.x, bg.y, bg.w, bg.h]).toEqual([0, 0, 200, 100]);
    expect(bg.style?.radius).toBe(8);
  });

  it("does not mutate the draft definition", () => {
    const def = makeDef();
    const before = structuredClone(def);
    expandForPreview(def, { pct: "90" });
    expect(def).toEqual(before);
  });
});

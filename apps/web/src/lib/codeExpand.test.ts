/**
 * Pure parts of the canvas's code-instance expansion (§7.6) — prop
 * resolution with the series sole-template rule, the renderer's mergeProps
 * series matrix, and instance-box scaling. The async sandbox plumbing rides
 * the same engine the renderer proves; these fences keep the browser-side
 * marshalling honest.
 */
import { describe, expect, it } from "vitest";
import type { FragmentNode } from "./component";
import {
  mergeCodeProps,
  resolveCodeInstanceProps,
  scaleCodeNodes,
  type CodeDefinition,
} from "./codeExpand";

const DATA = {
  github: {
    user: { login: "octocat", followers: 42 },
    stats: { calendar: [0, 1, 2, 3] },
  },
};

function makeDef(): CodeDefinition {
  return {
    code: "function render() { return []; }",
    frame: { w: 100, h: 50 },
    props: {
      label: { type: "string", default: "hi" },
      pct: { type: "number", default: 10 },
      calendar: { type: "series", default: [9, 9] },
    },
    nodes: [],
  };
}

describe("resolveCodeInstanceProps", () => {
  it("passes values through untouched with no connector data", () => {
    const given = { calendar: "{{github.stats.calendar}}", label: "x" };
    expect(resolveCodeInstanceProps(given, null, [])).toEqual(given);
  });

  it("resolves a SOLE template to the RAW array — the series binding path", () => {
    const out = resolveCodeInstanceProps(
      { calendar: "{{github.stats.calendar}}" },
      DATA,
      [],
    );
    expect(out.calendar).toEqual([0, 1, 2, 3]);
  });

  it("resolves scalar templates like the standard engine", () => {
    const warnings: string[] = [];
    const out = resolveCodeInstanceProps(
      {
        label: "hi {{github.user.login}}",
        pct: "{{github.user.followers}}",
        missing: "{{github.nope}}",
      },
      DATA,
      warnings,
    );
    expect(out.label).toBe("hi octocat");
    expect(out.pct).toBe("42"); // sole scalar template stringifies; merge coerces
    expect(out.missing).toBe("—");
    expect(warnings).toHaveLength(1);
  });

  it("em-dashes a NON-sole template of an array (template.ts parity)", () => {
    const warnings: string[] = [];
    const out = resolveCodeInstanceProps(
      { calendar: "days: {{github.stats.calendar}}" },
      DATA,
      warnings,
    );
    expect(out.calendar).toBe("days: —");
    expect(warnings).toHaveLength(1);
  });
});

describe("mergeCodeProps", () => {
  it("merges defaults for absent props, series arrays included", () => {
    const merged = mergeCodeProps(makeDef(), {}, []);
    expect(merged).toEqual({ label: "hi", pct: 10, calendar: [9, 9] });
  });

  it("accepts a raw array for a series prop", () => {
    const merged = mergeCodeProps(makeDef(), { calendar: [1, 2, 3] }, []);
    expect(merged.calendar).toEqual([1, 2, 3]);
  });

  it("falls back to the declared default for a non-array series value, never stringifying", () => {
    const warnings: string[] = [];
    const merged = mergeCodeProps(makeDef(), { calendar: "—" }, warnings);
    expect(merged.calendar).toEqual([9, 9]);
    expect(warnings.some((w) => w.includes('"calendar"'))).toBe(true);
  });

  it("keeps the renderer's scalar rules: numeric strings coerce, unknown props warn", () => {
    const warnings: string[] = [];
    const merged = mergeCodeProps(
      makeDef(),
      { pct: "42", label: 7, ghost: 1 },
      warnings,
    );
    expect(merged.pct).toBe(42);
    expect(merged.label).toBe("7");
    expect("ghost" in merged).toBe(false);
    expect(warnings.some((w) => w.includes('"ghost"'))).toBe(true);
  });
});

describe("scaleCodeNodes", () => {
  const nodes: FragmentNode[] = [
    {
      id: "t",
      type: "text",
      x: 10,
      y: 20,
      w: 80,
      h: 10,
      text: "x",
      style: { letterSpacing: 2 },
    },
    { id: "r", type: "rect", x: 0, y: 0, w: 100, h: 50, style: { radius: 4 } },
  ];
  const frame = { w: 100, h: 50 };

  it("uniform-scales by min(w/frame.w, h/frame.h) and pins fontSize (kit.ts parity)", () => {
    const out = scaleCodeNodes(nodes, frame, { w: 50, h: 50 }); // s = 0.5
    const t = out[0] as Extract<FragmentNode, { type: "text" }>;
    expect([t.x, t.y, t.w, t.h]).toEqual([5, 10, 40, 5]);
    expect(t.style?.fontSize).toBe(8); // satori default 16 × 0.5
    expect(t.style?.letterSpacing).toBe(1);
    const r = out[1] as Extract<FragmentNode, { type: "rect" }>;
    expect(r.style?.radius).toBe(2);
  });

  it("clones — cached nodes are never mutated by scaling", () => {
    scaleCodeNodes(nodes, frame, { w: 200, h: 100 });
    const t = nodes[0] as Extract<FragmentNode, { type: "text" }>;
    expect(t.x).toBe(10);
    expect(t.style).toEqual({ letterSpacing: 2 });
  });
});

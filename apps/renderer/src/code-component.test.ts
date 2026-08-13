/**
 * Code components (architecture.md §7.6): the kind:"code" schema shape,
 * series prop resolution, sandboxed expansion through the pipeline, the
 * output gates (fragment schema, no instances, unique ids, built-in fonts,
 * props-only resolution scope), publish-time double execution, the compile
 * LRU, and the HTTP endpoints.
 */
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { NodeGroup } from "./animate.js";
import { loadFontsOrExit } from "./fonts.js";
import { createRendererServer } from "./http.js";
import {
  KitError,
  clearCodeCompileCache,
  codeCompileCacheKeys,
  expandCodeInstance,
  expandInstance,
  mergeProps,
  parseCommunityComponent,
  parseKitComponent,
  parseRequestComponents,
  runCodePublishChecks,
  validateCodeOutputNodes,
  type KitComponent,
} from "./kit.js";
import { repoPath } from "./paths.js";
import { render } from "./pipeline.js";
import { resolveNodeTemplates } from "./template.js";
import type { Design, DesignNode, InstanceNode, RectNode, TextNode } from "./types.js";

const heatmapDef = JSON.parse(
  readFileSync(repoPath("examples", "demo-code-component.json"), "utf8"),
) as Record<string, unknown>;

const data = {
  github: {
    user: { login: "ada" },
    stats: { days: [1, 4, 0, 2, 9, 3, 5, 0, 1, 2, 7, 8, 2, 1] },
  },
};

/** A minimal code component; override `code` (and anything else) per test. */
function codeComp(over: Partial<KitComponent> = {}): KitComponent {
  return {
    id: "ada/coded@1",
    title: "Coded",
    kind: "code",
    frame: { w: 100, h: 50 },
    props: {
      label: { type: "string", default: "hi" },
      values: { type: "series", default: [1, 2, 3] },
    },
    code:
      "function render({ props, frame }) {\n" +
      '  return [{ id: "bg", type: "rect", x: 0, y: 0, w: frame.w, h: frame.h, style: { fill: "#161b22" } }];\n' +
      "}",
    nodes: [],
    ...over,
  };
}

function instance(over: Partial<InstanceNode> = {}): InstanceNode {
  return { id: "inst", type: "instance", x: 10, y: 20, w: 100, h: 50, component: "ada/coded@1", ...over };
}

function designWith(...nodes: DesignNode[]): Design {
  return { version: 0, canvas: { width: 320, height: 120 }, nodes };
}

// ---------------------------------------------------------------------------
// Schema / kind shape
// ---------------------------------------------------------------------------

describe("kind:code definition shape", () => {
  it("accepts the demo heatmap example with no warnings", () => {
    const { component, warnings } = parseCommunityComponent(heatmapDef, "definition");
    expect(component.kind).toBe("code");
    expect(typeof component.code).toBe("string");
    expect(warnings).toEqual([]);
  });

  it("accepts kind:code with nodes absent (normalized to []) — the preview is optional", () => {
    const def = codeComp() as unknown as Record<string, unknown>;
    delete def.nodes;
    const { component } = parseCommunityComponent(def, "definition");
    expect(component.nodes).toEqual([]);
  });

  it('requires a non-empty "code" string for kind:code', () => {
    for (const bad of [undefined, "", 42]) {
      const def = codeComp() as unknown as Record<string, unknown>;
      if (bad === undefined) delete def.code;
      else def.code = bad;
      expect(() => parseCommunityComponent(def, "definition")).toThrow(
        /kind "code" requires a non-empty "code" string/,
      );
    }
  });

  it('rejects "code" without kind:code — code never rides along on another variant', () => {
    const def = codeComp() as unknown as Record<string, unknown>;
    delete def.kind;
    def.nodes = [
      { id: "bg", type: "rect", x: 0, y: 0, w: 10, h: 10 },
    ];
    expect(() => parseCommunityComponent(def, "definition")).toThrow(/"code" requires kind "code"/);
  });

  it("rejects computed on kind:code — computed stays declarative-only", () => {
    const def = codeComp({
      props: { label: { type: "string", default: "hi" }, n: { type: "number", default: 1 } },
      computed: [{ node: "bg", prop: "n", field: "w", scale: 1, clamp: [0, 1] }],
    });
    expect(() => parseCommunityComponent(def, "definition")).toThrow(/"computed" is declarative-only/);
  });

  it("rejects native+code as mutually exclusive (official loader path)", () => {
    const def = {
      ...codeComp({ id: "coded" }),
      native: true,
      dataFields: ["stats.calendar"],
    } as unknown as Record<string, unknown>;
    expect(() => parseKitComponent(def, "bad.json")).toThrow(/mutually exclusive/);
  });

  it("rejects a series default that is not an array (schema is the contract)", () => {
    const def = codeComp() as unknown as { props: Record<string, unknown> };
    def.props.values = { type: "series", default: "1,2,3" };
    expect(() => parseCommunityComponent(def, "definition")).toThrow(KitError);
  });

  it("rejects code over the 64KB source cap", () => {
    const def = codeComp({ code: `function render() { return [] }// ${"x".repeat(66000)}` });
    expect(() => parseCommunityComponent(def, "definition")).toThrow(/invalid component/);
  });

  it("does not run the props-only template rule against the code source", () => {
    // JavaScript legitimately contains "{{…}}"-looking strings; the source
    // never passes through the template engine (output resolves props-only).
    const def = codeComp({
      code:
        "function render({ props }) {\n" +
        '  var s = "{{github.user.login}}"; // looks like a template, is just a string\n' +
        "  return [];\n" +
        "}",
    });
    const { warnings } = parseCommunityComponent(def, "definition");
    expect(warnings).toEqual([]);
  });

  it("still applies the props-only rule to the static preview nodes", () => {
    const def = codeComp({
      nodes: [
        {
          id: "t",
          type: "text",
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          text: "{{github.user.login}}",
        },
      ],
    });
    expect(() => parseCommunityComponent(def, "definition")).toThrow(/only reference props\.\*/);
  });

  it("accepts a code definition in a render request when version-pinned", () => {
    const { components } = parseRequestComponents([codeComp()]);
    expect(components[0].kind).toBe("code");
    expect(() => parseRequestComponents([codeComp({ id: "ada/coded" })])).toThrow(
      /pin a published version/,
    );
  });
});

// ---------------------------------------------------------------------------
// Series prop resolution matrix (§7.6)
// ---------------------------------------------------------------------------

describe("series prop resolution", () => {
  const seriesComponent = codeComp({
    props: {
      values: { type: "series", default: [9, 9] },
      label: { type: "string", default: "x" },
      percent: { type: "number", default: 50 },
    },
  });

  /** Run the real two-step pipeline treatment: template step, then merge (both warning sets). */
  function resolveAndMerge(props: Record<string, unknown>): {
    merged: Record<string, unknown>;
    warnings: string[];
  } {
    const step = resolveNodeTemplates(instance({ props }), data);
    const warnings = [...step.warnings];
    const merged = mergeProps(step.value as InstanceNode, seriesComponent, warnings);
    return { merged, warnings };
  }

  it("resolves a SOLE {{path}} template on a series prop to the RAW array, untouched", () => {
    const { merged, warnings } = resolveAndMerge({ values: "{{github.stats.days}}" });
    expect(merged.values).toEqual(data.github.stats.days);
    expect(warnings).toEqual([]);
  });

  it("tolerates whitespace inside the sole template", () => {
    const { merged } = resolveAndMerge({ values: "{{  github.stats.days  }}" });
    expect(merged.values).toEqual(data.github.stats.days);
  });

  it("passes a literal array through", () => {
    const { merged, warnings } = resolveAndMerge({ values: [5, 6, 7] });
    expect(merged.values).toEqual([5, 6, 7]);
    expect(warnings).toEqual([]);
  });

  it("uses the declared default when the prop is omitted (no warning)", () => {
    const { merged, warnings } = resolveAndMerge({});
    expect(merged.values).toEqual([9, 9]);
    expect(warnings).toEqual([]);
  });

  it("warns + defaults on a missing path — never the em-dash string", () => {
    const { merged, warnings } = resolveAndMerge({ values: "{{github.stats.nope}}" });
    expect(merged.values).toEqual([9, 9]);
    expect(warnings.some((w) => w.includes('unresolved template path "github.stats.nope"'))).toBe(true);
    expect(warnings.some((w) => w.includes('prop "values" expects a series'))).toBe(true);
  });

  it("warns + defaults on a NON-sole template (series never stringifies)", () => {
    const { merged, warnings } = resolveAndMerge({ values: "days: {{github.stats.days}}" });
    expect(merged.values).toEqual([9, 9]);
    expect(warnings.some((w) => w.includes('prop "values" expects a series'))).toBe(true);
  });

  it("warns + defaults on a scalar value", () => {
    const { merged, warnings } = resolveAndMerge({ values: 7 });
    expect(merged.values).toEqual([9, 9]);
    expect(warnings.some((w) => w.includes('prop "values" expects a series'))).toBe(true);
  });

  it("a raw array never leaks into a STRING prop (warning + default)", () => {
    const { merged, warnings } = resolveAndMerge({ label: "{{github.stats.days}}" });
    expect(merged.label).toBe("x");
    expect(warnings.some((w) => w.includes('prop "label" expects a string'))).toBe(true);
  });

  it("a raw array never leaks into a NUMBER prop (warning + default)", () => {
    const { merged, warnings } = resolveAndMerge({ percent: "{{github.stats.days}}" });
    expect(merged.percent).toBe(50);
    expect(warnings.some((w) => w.includes('prop "percent" expects a number'))).toBe(true);
  });

  it("declarative fragments do NOT interpolate series values ({{props.x}} of an array em-dashes)", () => {
    const declarative: KitComponent = {
      id: "ada/decl@1",
      title: "Decl",
      frame: { w: 100, h: 50 },
      props: { values: { type: "series", default: [1, 2] } },
      nodes: [{ id: "t", type: "text", x: 0, y: 0, w: 100, h: 20, text: "{{props.values}}" }],
    };
    const { items, warnings } = expandInstance(
      instance({ component: "ada/decl@1", props: { values: [1, 2, 3] } }),
      new Map([["ada/decl@1", declarative]]),
      data,
    );
    expect((items[0] as TextNode).text).toBe("—");
    expect(warnings.some((w) => w.includes("non-scalar"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Expansion (render path)
// ---------------------------------------------------------------------------

describe("expandCodeInstance", () => {
  beforeEach(() => clearCodeCompileCache());

  it("executes render() and pushes output through scale/offset/id-prefix", async () => {
    const { component } = parseCommunityComponent(heatmapDef, "definition");
    // Instance box 260×80 on a 260×80 frame → s = 1; offset (10, 20).
    const node = instance({
      component: component.id,
      w: 260,
      h: 80,
      props: { values: "{{github.stats.days}}", label: "GPU" },
    });
    const resolved = resolveNodeTemplates(node, data).value as InstanceNode;
    const { items, warnings } = await expandCodeInstance(resolved, component);
    expect(warnings).toEqual([]);
    const nodes = items as DesignNode[];
    // 1 label + 14 cells, ids prefixed with the instance id.
    expect(nodes).toHaveLength(1 + data.github.stats.days.length);
    expect(nodes[0].id).toBe("inst__label");
    expect((nodes[0] as TextNode).text).toBe("GPU");
    const cell0 = nodes[1] as RectNode;
    expect(cell0.id).toBe("inst__cell-0");
    // Code emitted (0, 24); s=1, offset (10, 20) → (10, 44).
    expect([cell0.x, cell0.y, cell0.w, cell0.h]).toEqual([10, 44, 14, 14]);
  });

  it("uniform-scales code output exactly like declarative fragments", async () => {
    const component = codeComp({
      code:
        "function render({ frame }) {\n" +
        '  return [{ id: "t", type: "text", x: 10, y: 10, w: 40, h: 20, text: "hi",\n' +
        "    style: { fontSize: 10, letterSpacing: 2 } }];\n" +
        "}",
    });
    // Box 50×25 on a 100×50 frame → s = 0.5.
    const { items } = await expandCodeInstance(instance({ w: 50, h: 25 }), component);
    const t = items[0] as TextNode;
    expect([t.x, t.y, t.w, t.h]).toEqual([15, 25, 20, 10]);
    expect(t.style?.fontSize).toBe(5);
    expect(t.style?.letterSpacing).toBe(1);
  });

  it("resolves output templates against a PROPS-ONLY scope — connector data is unreachable", async () => {
    // A hostile component emits a data template into its output text; if the
    // scope carried the snapshot this would leak fields the component never
    // received as props. It must die as the unresolved placeholder instead.
    const component = codeComp({
      code:
        "function render() {\n" +
        '  return [{ id: "t", type: "text", x: 0, y: 0, w: 100, h: 20,\n' +
        '    text: "{{github.user.login}} / {{props.label}}" }];\n' +
        "}",
    });
    const { items, warnings } = await expandCodeInstance(
      instance({ props: { label: "ok" } }),
      component,
    );
    expect((items[0] as TextNode).text).toBe("— / ok");
    expect(warnings.some((w) => w.includes('unresolved template path "github.user.login"'))).toBe(true);
  });

  it("wraps an animated code instance into ONE NodeGroup and strips node animations", async () => {
    const component = codeComp({
      code:
        "function render({ frame }) {\n" +
        '  return [{ id: "bg", type: "rect", x: 0, y: 0, w: frame.w, h: frame.h,\n' +
        '    animation: { preset: "growX" } }];\n' +
        "}",
    });
    const { items, warnings } = await expandCodeInstance(
      instance({ animation: { preset: "fadeIn", durationMs: 700 } }),
      component,
    );
    expect(items).toHaveLength(1);
    const group = items[0] as NodeGroup;
    expect(group.kind).toBe("group");
    expect(group.id).toBe("inst");
    expect(group.frame).toEqual({ x: 10, y: 20, w: 100, h: 50 });
    expect(group.nodes[0].animation).toBeUndefined();
    expect(warnings.some((w) => w.includes("animated instance composes as one layer"))).toBe(true);
  });

  it("degrades a compile error to the placeholder + warning", async () => {
    const node = instance();
    const { items, warnings } = await expandCodeInstance(
      node,
      codeComp({ code: "function render( {" }),
    );
    expect(items).toEqual([node]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('instance "inst"');
    expect(warnings[0]).toContain("failed to compile");
    expect(warnings[0]).toContain("rendering placeholder");
  });

  it("degrades a runtime throw to the placeholder + warning naming the error", async () => {
    const node = instance();
    const { items, warnings } = await expandCodeInstance(
      node,
      codeComp({ code: 'function render() { throw new Error("boom") }' }),
    );
    expect(items).toEqual([node]);
    expect(warnings[0]).toContain("(runtime_error)");
    expect(warnings[0]).toContain("boom");
  });

  it("degrades an infinite loop to the placeholder via the cpu budget", async () => {
    const node = instance();
    const { items, warnings } = await expandCodeInstance(
      node,
      codeComp({ code: "function render() { while (true) {} }" }),
    );
    expect(items).toEqual([node]);
    expect(warnings[0]).toContain("(timeout)");
  });

  it("rejects an instance node in the output — nested expansion from code is never allowed", async () => {
    const node = instance();
    const { items, warnings } = await expandCodeInstance(
      node,
      codeComp({
        code:
          "function render() {\n" +
          '  return [{ id: "n", type: "instance", x: 0, y: 0, w: 10, h: 10, component: "kit/stat-card" }];\n' +
          "}",
      }),
    );
    expect(items).toEqual([node]);
    expect(warnings[0]).toContain("returned an instance node");
    expect(warnings[0]).toContain("rendering placeholder");
  });

  it("rejects output nodes that fail the fragment schema", async () => {
    const node = instance();
    const { items, warnings } = await expandCodeInstance(
      node,
      // w: -5 violates the design-schema minimum.
      codeComp({ code: 'function render() { return [{ id: "r", type: "rect", x: 0, y: 0, w: -5, h: 10 }] }' }),
    );
    expect(items).toEqual([node]);
    expect(warnings[0]).toContain("failed node validation");
  });

  it("rejects duplicate ids within one output", async () => {
    const node = instance();
    const { warnings } = await expandCodeInstance(
      node,
      codeComp({
        code:
          "function render() { return [" +
          '{ id: "r", type: "rect", x: 0, y: 0, w: 1, h: 1 },' +
          '{ id: "r", type: "rect", x: 2, y: 0, w: 1, h: 1 }' +
          "] }",
      }),
    );
    expect(warnings[0]).toContain('duplicate node id "r"');
  });

  it("rejects a non-built-in fontFamily in output — code output uses built-ins only", async () => {
    const node = instance();
    const { items, warnings } = await expandCodeInstance(
      node,
      codeComp({
        code:
          "function render() {\n" +
          '  return [{ id: "t", type: "text", x: 0, y: 0, w: 10, h: 10, text: "x",\n' +
          '    style: { fontFamily: "Papyrus" } }];\n' +
          "}",
      }),
    );
    expect(items).toEqual([node]);
    expect(warnings[0]).toContain('"Papyrus"');
    expect(warnings[0]).toContain("built-in");
  });

  it("accepts a built-in fontFamily in output", async () => {
    const { items, warnings } = await expandCodeInstance(
      instance(),
      codeComp({
        code:
          "function render() {\n" +
          '  return [{ id: "t", type: "text", x: 0, y: 0, w: 10, h: 10, text: "x",\n' +
          '    style: { fontFamily: "JetBrains Mono" } }];\n' +
          "}",
      }),
    );
    expect(warnings).toEqual([]);
    expect((items[0] as TextNode).style?.fontFamily).toBe("JetBrains Mono");
  });

  it("surfaces in-sandbox console output as warnings prefixed with the instance id", async () => {
    const { warnings } = await expandCodeInstance(
      instance(),
      codeComp({ code: 'function render() { console.log("hello from the box"); return [] }' }),
    );
    expect(warnings).toEqual(['instance "inst": hello from the box']);
  });

  it("caches the compile verdict by source hash (fonts-style LRU)", async () => {
    expect(codeCompileCacheKeys()).toHaveLength(0);
    const component = codeComp();
    await expandCodeInstance(instance(), component);
    expect(codeCompileCacheKeys()).toHaveLength(1);
    const [key] = codeCompileCacheKeys();
    await expandCodeInstance(instance(), component);
    expect(codeCompileCacheKeys()).toEqual([key]); // same entry, no growth
    // A failing source caches its verdict too — the second hit never
    // spins the sandbox up again.
    const bad = codeComp({ code: "function render( {" });
    await expandCodeInstance(instance(), bad);
    await expandCodeInstance(instance(), bad);
    expect(codeCompileCacheKeys()).toHaveLength(2);
  });

  it("sync expandInstance degrades a code component to the placeholder (async path required)", () => {
    const component = codeComp();
    const node = instance();
    const { items, warnings } = expandInstance(node, new Map([[component.id, component]]), data);
    expect(items).toEqual([node]);
    expect(warnings[0]).toContain("async");
  });
});

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------

describe("render pipeline with code components", () => {
  const fonts = loadFontsOrExit();

  it("renders the demo heatmap over a bound series deterministically (×2 byte-equal)", async () => {
    const { component } = parseCommunityComponent(heatmapDef, "definition");
    const design = designWith(
      instance({ component: component.id, w: 260, h: 80, props: { values: "{{github.stats.days}}" } }),
    );
    const a = await render(design, data, fonts, {}, [component]);
    const b = await render(design, data, fonts, {}, [component]);
    expect(a.warnings).toEqual([]);
    expect(a.svg).toContain("<svg");
    expect(a.svg).toBe(b.svg);
    // The grid actually made it into the output: accent-colored cells exist.
    expect(a.svg).toContain("#3fb950");
  }, 30000);

  it("renders the placeholder + warning when the sandbox fails — render never fails", async () => {
    const broken = codeComp({ code: 'function render() { throw new Error("boom") }' });
    const design = designWith(instance());
    const { svg, warnings } = await render(design, data, fonts, {}, [broken]);
    expect(svg).toContain("<svg");
    expect(svg).toContain("stroke-dasharray"); // the dashed placeholder outline rendered
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("boom");
  }, 30000);
});

// ---------------------------------------------------------------------------
// Publish-time validation (§7.6)
// ---------------------------------------------------------------------------

describe("runCodePublishChecks", () => {
  it("passes a deterministic component and returns its sample-render console output", async () => {
    const { component } = parseCommunityComponent(heatmapDef, "definition");
    await expect(runCodePublishChecks(component, "definition")).resolves.toEqual([]);

    const chatty = codeComp({
      code: 'function render() { console.log("sampled"); return [] }',
    });
    await expect(runCodePublishChecks(chatty, "definition")).resolves.toEqual([
      "definition: sample render: sampled",
    ]);
  });

  // WHY THERE IS NO "nondeterminism rejected" HAPPY-CASE TEST: nondeterminism
  // is impossible by construction — Date is excluded at the QuickJS intrinsic
  // level, Math.random throws, async is rejected, and each execution runs in
  // a FRESH context so no state (module globals included) survives between
  // the two publish runs. There is no input we could feed the real sandbox to
  // make the byte-compare fire. The double-run stays as cheap defense in
  // depth against future sandbox regressions; the tests below pin the
  // invariants that make it unreachable today.
  it("rejects the nondeterminism ESCAPE HATCHES themselves (Math.random / Date throw)", async () => {
    const random = codeComp({ code: "function render() { return [Math.random()] }" });
    await expect(runCodePublishChecks(random, "definition")).rejects.toThrow(
      /Math\.random is disabled/,
    );
    const date = codeComp({ code: "function render() { return [Date.now()] }" });
    await expect(runCodePublishChecks(date, "definition")).rejects.toThrow(/runtime_error/);
  });

  it("proves globals reset between the two runs (stateful-counter output stays identical)", async () => {
    // A module-global counter would differ between runs if state survived;
    // publish must PASS because each execution gets a fresh context.
    const counter = codeComp({
      code:
        "var calls = 0;\n" +
        "function render() {\n" +
        "  calls += 1;\n" +
        '  return [{ id: "t", type: "text", x: 0, y: 0, w: 10, h: 10, text: "run " + calls }];\n' +
        "}",
    });
    await expect(runCodePublishChecks(counter, "definition")).resolves.toEqual([]);
  });

  it("rejects a compile error with the sandbox message", async () => {
    await expect(
      runCodePublishChecks(codeComp({ code: "function render( {" }), "definition"),
    ).rejects.toThrow(/code failed to compile/);
  });

  it("rejects a missing render function", async () => {
    await expect(
      runCodePublishChecks(codeComp({ code: "var x = 1" }), "definition"),
    ).rejects.toThrow(/not_a_function/);
  });

  it("rejects a timeout under full limits", async () => {
    await expect(
      runCodePublishChecks(codeComp({ code: "function render() { while (true) {} }" }), "definition"),
    ).rejects.toThrow(/timeout/);
  });

  it("rejects too many output nodes (sandbox node cap)", async () => {
    const many = codeComp({
      code:
        "function render() {\n" +
        "  var out = [];\n" +
        "  for (var i = 0; i < 513; i++) out.push({ id: 'r' + i, type: 'rect', x: 0, y: 0, w: 1, h: 1 });\n" +
        "  return out;\n" +
        "}",
    });
    await expect(runCodePublishChecks(many, "definition")).rejects.toThrow(/output_too_large/);
  });

  it("rejects an instance node in the sample output", async () => {
    const nested = codeComp({
      code:
        "function render() {\n" +
        '  return [{ id: "n", type: "instance", x: 0, y: 0, w: 10, h: 10, component: "kit/stat-card" }];\n' +
        "}",
    });
    await expect(runCodePublishChecks(nested, "definition")).rejects.toThrow(
      /returned an instance node/,
    );
  });

  it("applies the built-in font check to the sample output", async () => {
    const face = codeComp({
      code:
        "function render() {\n" +
        '  return [{ id: "t", type: "text", x: 0, y: 0, w: 10, h: 10, text: "x",\n' +
        '    style: { fontFamily: "Wingdings" } }];\n' +
        "}",
    });
    await expect(runCodePublishChecks(face, "definition")).rejects.toThrow(/built-in/);
  });

  it("executes against the declared prop defaults (series default included)", async () => {
    // render() indexes the series default; a wrong sample input would throw.
    const usesDefaults = codeComp({
      props: { values: { type: "series", default: [7] } },
      code:
        "function render({ props }) {\n" +
        '  if (!Array.isArray(props.values) || props.values[0] !== 7) throw new Error("wrong defaults");\n' +
        '  return [{ id: "r", type: "rect", x: 0, y: 0, w: 1, h: 1 }];\n' +
        "}",
    });
    await expect(runCodePublishChecks(usesDefaults, "definition")).resolves.toEqual([]);
  });
});

describe("validateCodeOutputNodes", () => {
  it("returns typed nodes for a valid output array", () => {
    const nodes = validateCodeOutputNodes(
      [{ id: "r", type: "rect", x: 0, y: 0, w: 1, h: 1 }],
      "ctx",
    );
    expect(nodes[0].type).toBe("rect");
  });

  it("names the failing index for a non-node value", () => {
    expect(() => validateCodeOutputNodes([{ id: "r", type: "rect", x: 0, y: 0, w: 1, h: 1 }, 42], "ctx")).toThrow(
      /output \[1\] is not a text\/rect\/image node/,
    );
  });
});

// ---------------------------------------------------------------------------
// HTTP endpoints
// ---------------------------------------------------------------------------

describe("HTTP endpoints (code components)", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createRendererServer(loadFontsOrExit());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(
    () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  );

  function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("validate-component accepts the demo code component: 200 {ok:true}", async () => {
    const res = await post("/internal/validate-component", { definition: heatmapDef });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, warnings: [] });
  });

  it("validate-component surfaces sample-render console output as warnings", async () => {
    const res = await post("/internal/validate-component", {
      definition: codeComp({ code: 'function render() { console.log("hi"); return [] }' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; warnings: string[] };
    expect(body.ok).toBe(true);
    expect(body.warnings).toEqual(["definition: sample render: hi"]);
  });

  it("validate-component rejects a throwing component with 422 and the reason", async () => {
    const res = await post("/internal/validate-component", {
      definition: codeComp({ code: 'function render() { throw new Error("kaput") }' }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_component");
    expect(body.error.message).toContain("kaput");
  });

  it("validate-component rejects computed-on-code with 422", async () => {
    const res = await post("/internal/validate-component", {
      definition: codeComp({
        props: { n: { type: "number", default: 1 } },
        computed: [{ node: "bg", prop: "n", field: "w", scale: 1, clamp: [0, 1] }],
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("declarative-only");
  });

  it("render executes a per-request code definition end to end", async () => {
    const res = await post("/internal/render", {
      design: designWith(
        instance({ component: "demo/mini-heatmap@1", w: 260, h: 80, props: { values: "{{github.stats.days}}" } }),
      ),
      data,
      components: [heatmapDef],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { svg: string; warnings: string[] };
    expect(body.svg).toContain("<svg");
    expect(body.warnings).toEqual([]);
  }, 30000);

  it("render degrades a failing code definition to the placeholder, still 200", async () => {
    const res = await post("/internal/render", {
      design: designWith(instance()),
      data,
      components: [codeComp({ code: "function render() { while (true) {} }" })],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warnings: string[] };
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toContain("(timeout)");
  }, 30000);
});

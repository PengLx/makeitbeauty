/**
 * Locks the pure machinery behind the palette hover previews: cache-key
 * derivation, the §7.5 one-instance preview design (incl. default-prop
 * materialization and the template-inlining path), the settled/in-flight
 * dedupe, and /v1/preview envelope handling.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPONENT_TEMPLATES } from "./componentTemplates";
import { PREVIEW_BACKGROUND } from "./expandForPreview";
import type { DesignDoc, InstanceNode, TextNode } from "./design";
import {
  PREVIEW_CANVAS_RADIUS,
  buildInstancePreviewDesign,
  buildTemplatePreviewDesign,
  materializeDefaultProps,
  pinnedPreviewKey,
  renderPreviewEntry,
  resolveShared,
  templatePreviewKey,
} from "./hoverPreview";

describe("cache keys", () => {
  it("pins community keys to '{owner}/{name}@{v}' — the insertable ref", () => {
    expect(pinnedPreviewKey("mona/stat-card", 3)).toBe("mona/stat-card@3");
  });

  it("namespaces template keys so no source can collide", () => {
    expect(templatePreviewKey("badge")).toBe("template/badge");
    // Kit keys are registry ids verbatim ("kit/…"); pinned refs always carry
    // "@"; template keys are "template/…" — three disjoint shapes.
    expect(templatePreviewKey("badge")).not.toBe("kit/badge");
    expect(templatePreviewKey("badge")).not.toBe(pinnedPreviewKey("template/badge", 1));
  });
});

describe("materializeDefaultProps", () => {
  it("collects declared defaults of both types", () => {
    expect(
      materializeDefaultProps({
        label: { default: "Stars" },
        pct: { default: 40 },
      }),
    ).toEqual({ label: "Stars", pct: 40 });
  });

  it("omits declarations without a default (optional in kit metadata)", () => {
    expect(materializeDefaultProps({ label: {}, n: { default: 0 } })).toEqual({
      n: 0,
    });
  });

  it("returns {} for a component with no props", () => {
    expect(materializeDefaultProps({})).toEqual({});
  });
});

describe("buildInstancePreviewDesign", () => {
  const frame = { w: 320, h: 180 };

  it("builds the one-instance design: frame-sized dark rounded canvas, full-frame instance at (0,0)", () => {
    const design = buildInstancePreviewDesign("kit/stat-card", frame, {
      label: "Stars",
    });
    expect(design.version).toBe(0);
    expect(design.canvas).toEqual({
      width: 320,
      height: 180,
      background: PREVIEW_BACKGROUND,
      radius: PREVIEW_CANVAS_RADIUS,
    });
    expect(design.nodes).toHaveLength(1);
    const node = design.nodes[0] as InstanceNode;
    expect(node).toEqual({
      id: "preview",
      type: "instance",
      component: "kit/stat-card",
      x: 0,
      y: 0,
      w: 320,
      h: 180,
      props: { label: "Stars" },
    });
  });

  it("serializes empty props away (renderer merges defaults regardless)", () => {
    const design = buildInstancePreviewDesign("mona/badge@2", frame, {});
    expect("props" in design.nodes[0]).toBe(false);
    expect((design.nodes[0] as InstanceNode).component).toBe("mona/badge@2");
  });
});

describe("buildTemplatePreviewDesign", () => {
  const statCard = COMPONENT_TEMPLATES.find((t) => t.id === "stat-card")!;

  it("inlines the seed nodes with declared defaults substituted", () => {
    const design = buildTemplatePreviewDesign(statCard.frame, statCard.seed!);
    expect(design.canvas).toEqual({
      width: statCard.frame.w,
      height: statCard.frame.h,
      background: PREVIEW_BACKGROUND,
      radius: PREVIEW_CANVAS_RADIUS,
    });
    expect(design.nodes).toHaveLength(statCard.seed!.nodes.length);
    const label = design.nodes.find((n) => n.id === "label") as TextNode;
    expect(label.text).toBe("Monthly revenue");
    // Nothing unresolved leaves the client: the design is plain nodes.
    expect(JSON.stringify(design)).not.toContain("{{");
  });

  it("keeps animations (the preview plays them like production)", () => {
    const design = buildTemplatePreviewDesign(statCard.frame, statCard.seed!);
    const accent = design.nodes.find((n) => n.id === "accent");
    expect(accent?.animation).toEqual({ preset: "growX", durationMs: 900 });
  });

  it("never mutates the shared template objects", () => {
    const before = structuredClone(statCard.seed);
    buildTemplatePreviewDesign(statCard.frame, statCard.seed!);
    expect(statCard.seed).toEqual(before);
    expect((statCard.seed!.nodes[1] as TextNode).text).toBe("{{props.label}}");
  });
});

describe("resolveShared", () => {
  function maps() {
    return {
      settled: new Map<string, { v: number }>(),
      inflight: new Map<string, Promise<{ v: number }>>(),
    };
  }

  it("dedupes concurrent requests for one key onto a single produce call", async () => {
    const { settled, inflight } = maps();
    let calls = 0;
    let release!: (v: { v: number }) => void;
    const produce = () => {
      calls++;
      return new Promise<{ v: number }>((r) => {
        release = r;
      });
    };
    const a = resolveShared(settled, inflight, "k", produce);
    const b = resolveShared(settled, inflight, "k", produce);
    expect(calls).toBe(1);
    release({ v: 1 });
    expect(await a).toBe(await b);
    expect(inflight.size).toBe(0);
  });

  it("serves settled values without re-producing", async () => {
    const { settled, inflight } = maps();
    let calls = 0;
    const produce = () => {
      calls++;
      return Promise.resolve({ v: calls });
    };
    expect(await resolveShared(settled, inflight, "k", produce)).toEqual({ v: 1 });
    expect(await resolveShared(settled, inflight, "k", produce)).toEqual({ v: 1 });
    expect(calls).toBe(1);
    expect(settled.get("k")).toEqual({ v: 1 });
  });

  it("keeps keys independent", async () => {
    const { settled, inflight } = maps();
    await resolveShared(settled, inflight, "a", () => Promise.resolve({ v: 1 }));
    await resolveShared(settled, inflight, "b", () => Promise.resolve({ v: 2 }));
    expect(settled.get("a")).toEqual({ v: 1 });
    expect(settled.get("b")).toEqual({ v: 2 });
  });

  it("caches nothing on rejection and clears the in-flight slot for a retry", async () => {
    const { settled, inflight } = maps();
    let calls = 0;
    const produce = () => {
      calls++;
      return calls === 1
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({ v: 2 });
    };
    await expect(resolveShared(settled, inflight, "k", produce)).rejects.toThrow(
      "boom",
    );
    expect(settled.size).toBe(0);
    expect(inflight.size).toBe(0);
    expect(await resolveShared(settled, inflight, "k", produce)).toEqual({ v: 2 });
  });
});

describe("renderPreviewEntry", () => {
  const design: DesignDoc = {
    version: 0,
    canvas: { width: 320, height: 180, background: PREVIEW_BACKGROUND, radius: 8 },
    nodes: [],
  };

  afterEach(() => vi.unstubAllGlobals());

  it("resolves the SVG text with the canvas size on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<svg/>", { status: 200 })),
    );
    expect(await renderPreviewEntry(design)).toEqual({
      svg: "<svg/>",
      width: 320,
      height: 180,
    });
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe("/v1/preview");
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ design });
  });

  it("resolves the §8 error envelope as an {error} entry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "invalid_design", message: "canvas too big" },
            }),
            { status: 422 },
          ),
      ),
    );
    expect(await renderPreviewEntry(design)).toEqual({
      error: { code: "invalid_design", message: "canvas too big" },
    });
  });

  it("falls back to http_{status} for a non-JSON error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad gateway", { status: 502 })),
    );
    expect(await renderPreviewEntry(design)).toEqual({
      error: { code: "http_502", message: "bad gateway" },
    });
  });

  it("resolves transport failures as network_error — it never throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    expect(await renderPreviewEntry(design)).toEqual({
      error: { code: "network_error", message: "fetch failed" },
    });
  });
});

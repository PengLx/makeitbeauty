/**
 * Community components (§7.5): request-time validation, the props-only
 * template rule, the per-request merged lookup, qualified-id expansion and
 * the /internal/validate-component endpoint.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadFontsOrExit } from "./fonts.js";
import { createRendererServer } from "./http.js";
import {
  KitError,
  expandInstance,
  kitRegistry,
  mergeComponentRegistry,
  parseCommunityComponent,
  parseRequestComponents,
  type KitComponent,
} from "./kit.js";
import { render } from "./pipeline.js";
import type { Design, DesignNode, InstanceNode, RectNode, TextNode } from "./types.js";

const data = { github: { user: { login: "ada" } } };

/** A minimal valid community definition, pinned to a published version. */
function badge(over: Partial<KitComponent> = {}): KitComponent {
  return {
    id: "ada/badge@1",
    title: "Badge",
    frame: { w: 100, h: 40 },
    props: {
      label: { type: "string", default: "hello" },
      accent: { type: "string", default: "#ff0000" },
    },
    nodes: [
      { id: "bg", type: "rect", x: 0, y: 0, w: 100, h: 40, style: { fill: "{{props.accent}}" } },
      {
        id: "label",
        type: "text",
        x: 10,
        y: 10,
        w: 80,
        h: 20,
        text: "{{props.label}}",
        style: { fontSize: 12 },
      },
    ],
    ...over,
  };
}

function instance(over: Partial<InstanceNode> = {}): InstanceNode {
  return { id: "inst", type: "instance", x: 10, y: 10, w: 100, h: 40, component: "ada/badge@1", ...over };
}

function designWith(...nodes: DesignNode[]): Design {
  return { version: 0, canvas: { width: 120, height: 60 }, nodes };
}

describe("parseCommunityComponent", () => {
  it("accepts a valid pinned definition with no warnings", () => {
    const { component, warnings } = parseCommunityComponent(badge(), "definition");
    expect(component.id).toBe("ada/badge@1");
    expect(warnings).toEqual([]);
  });

  it("accepts a draft id without a version pin (publish-time validation)", () => {
    const { component } = parseCommunityComponent(badge({ id: "ada/badge" }), "definition");
    expect(component.id).toBe("ada/badge");
  });

  it("requires the version pin for render-request definitions", () => {
    expect(() =>
      parseCommunityComponent(badge({ id: "ada/badge" }), "components[0]", { requireVersion: true }),
    ).toThrow(/pin a published version/);
  });

  it('rejects the reserved "kit/" namespace', () => {
    expect(() => parseCommunityComponent(badge({ id: "kit/badge@1" }), "definition")).toThrow(
      /reserved for the official kit/,
    );
  });

  it("rejects native components — natives are reserved for the official kit", () => {
    expect(() =>
      parseCommunityComponent(
        { ...badge(), native: true, dataFields: ["stats.calendar"] },
        "definition",
      ),
    ).toThrow(/never native/);
    // dataFields alone is just as much a native claim.
    expect(() =>
      parseCommunityComponent({ ...badge(), dataFields: ["stats.calendar"] }, "definition"),
    ).toThrow(/never native/);
  });

  it("rejects malformed ids with the expected shape in the message", () => {
    for (const id of ["badge", "Ada/Badge@1", "ada/badge@x", "ada/badge@1@2", 7 as never]) {
      expect(() => parseCommunityComponent(badge({ id: id as string }), "definition")).toThrow(
        /\{owner\}\/\{name\}/,
      );
    }
  });

  it("rejects a non-object definition", () => {
    for (const bad of [null, "x", 4, [badge()]]) {
      expect(() => parseCommunityComponent(bad, "definition")).toThrow(/JSON object/);
    }
  });

  it("runs the kit loader's schema check (ajv)", () => {
    const noTitle = badge() as Record<string, unknown>;
    delete noTitle.title;
    expect(() => parseCommunityComponent(noTitle, "definition")).toThrow(/invalid component/);
  });

  it("rejects nested instance nodes", () => {
    const nested = badge({
      nodes: [{ id: "n", type: "instance", x: 0, y: 0, w: 10, h: 10, component: "kit/stat-card" }],
    } as never);
    expect(() => parseCommunityComponent(nested, "definition")).toThrow(/nested instance/);
  });

  it("rejects duplicate node ids", () => {
    const dup = badge();
    dup.nodes = [dup.nodes[0], { ...dup.nodes[0] }];
    expect(() => parseCommunityComponent(dup, "definition")).toThrow(/duplicate node id "bg"/);
  });

  it("rejects computed entries referencing unknown nodes or non-number props", () => {
    const unknownNode = badge({
      computed: [{ node: "nope", prop: "label", field: "w", scale: 1, clamp: [0, 1] }],
    });
    expect(() => parseCommunityComponent(unknownNode, "definition")).toThrow(/unknown node/);

    const stringProp = badge({
      computed: [{ node: "bg", prop: "label", field: "w", scale: 1, clamp: [0, 1] }],
    });
    expect(() => parseCommunityComponent(stringProp, "definition")).toThrow(/type "number"/);
  });
});

describe("props-only template rule (§7.5)", () => {
  it("accepts {{props.x}} templates", () => {
    const { warnings } = parseCommunityComponent(badge(), "definition");
    expect(warnings).toEqual([]);
  });

  it("rejects a connector-data template in node text, naming the offender", () => {
    const leaky = badge();
    (leaky.nodes[1] as TextNode).text = "{{github.user.login}}";
    expect(() => parseCommunityComponent(leaky, "definition")).toThrow(
      /template "\{\{github\.user\.login\}\}" is not allowed — community component templates may only reference props\.\*/,
    );
  });

  it("rejects templates hidden in style values and points at the path", () => {
    const leaky = badge();
    (leaky.nodes[0] as RectNode).style = { fill: "{{data.color}}" };
    expect(() => parseCommunityComponent(leaky, "definition")).toThrow(/nodes\[0\]\.style\.fill/);
  });

  it("rejects a bare {{props}} reference (must be props.*)", () => {
    const bare = badge();
    (bare.nodes[1] as TextNode).text = "{{props}}";
    expect(() => parseCommunityComponent(bare, "definition")).toThrow(/only reference props\.\*/);
  });

  it("warns (not rejects) on a reference to an undeclared prop", () => {
    const undeclared = badge();
    (undeclared.nodes[1] as TextNode).text = "{{props.nope}}";
    const { warnings } = parseCommunityComponent(undeclared, "definition");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('undeclared prop "nope"');
  });
});

describe("parseRequestComponents", () => {
  it("returns an empty set when components is omitted", () => {
    expect(parseRequestComponents(undefined)).toEqual({ components: [], warnings: [] });
  });

  it("rejects a non-array", () => {
    expect(() => parseRequestComponents({})).toThrow(/must be an array/);
  });

  it("names the failing item in the error", () => {
    expect(() => parseRequestComponents([badge(), badge({ id: "ada/badge" })])).toThrow(
      /components\[1\]/,
    );
  });

  it("rejects duplicate qualified ids within one request", () => {
    expect(() => parseRequestComponents([badge(), badge()])).toThrow(
      /duplicate definition for "ada\/badge@1"/,
    );
  });

  it("rejects a native definition inside a render request (natives ship with the kit)", () => {
    expect(() =>
      parseRequestComponents([{ ...badge(), native: true, dataFields: ["stats.calendar"] }]),
    ).toThrow(/never native/);
    expect(() =>
      parseRequestComponents([{ ...badge(), dataFields: ["stats.calendar"] }]),
    ).toThrow(/never native/);
  });
});

describe("mergeComponentRegistry", () => {
  it("returns the kit registry itself when the request brings no definitions", () => {
    const kit = kitRegistry();
    expect(mergeComponentRegistry(kit, [])).toBe(kit);
  });

  it("adds request definitions keyed by their qualified id", () => {
    const merged = mergeComponentRegistry(kitRegistry(), [badge()]);
    expect(merged.get("ada/badge@1")?.title).toBe("Badge");
    expect(merged.has("kit/stat-card")).toBe(true);
  });

  it("never lets a request definition override a kit entry", () => {
    const kit = kitRegistry();
    const impostor = badge({ id: "kit/stat-card", title: "Impostor" });
    const merged = mergeComponentRegistry(kit, [impostor]);
    expect(merged.get("kit/stat-card")).toBe(kit.get("kit/stat-card"));
    expect(merged.get("kit/stat-card")?.title).not.toBe("Impostor");
  });

  it("does not mutate the module-level kit registry", () => {
    mergeComponentRegistry(kitRegistry(), [badge()]);
    expect(kitRegistry().has("ada/badge@1")).toBe(false);
  });
});

describe("qualified-id expansion", () => {
  it("expands an instance referencing {owner}/{name}@{n} via the merged lookup", () => {
    const merged = mergeComponentRegistry(kitRegistry(), [badge()]);
    const { items, warnings } = expandInstance(
      instance({ props: { label: "GPU", accent: "#3fb950" } }),
      merged,
      data,
    );
    expect(warnings).toEqual([]);
    const nodes = items as DesignNode[];
    expect(nodes.map((n) => n.id)).toEqual(["inst__bg", "inst__label"]);
    expect((nodes[1] as TextNode).text).toBe("GPU");
    expect((nodes[0] as RectNode).style?.fill).toBe("#3fb950");
  });

  it("keeps the dashed-placeholder behavior for an unknown qualified ref", () => {
    const merged = mergeComponentRegistry(kitRegistry(), [badge()]);
    const node = instance({ component: "ada/missing@2" });
    const { items, warnings } = expandInstance(node, merged, data);
    expect(items).toEqual([node]);
    expect(warnings).toEqual(['unknown component "ada/missing@2" — rendering placeholder']);
  });
});

describe("render integration", () => {
  const fonts = loadFontsOrExit();
  const design = designWith(instance());

  it("renders a design using a per-request definition, deterministically", async () => {
    const a = await render(design, data, fonts, {}, [badge()]);
    const b = await render(design, data, fonts, {}, [badge()]);
    expect(a.svg).toContain("<svg");
    expect(a.warnings).toEqual([]);
    expect(a.svg).toBe(b.svg);
  }, 30000);

  it("isolates concurrent requests that carry different definitions for the same id", async () => {
    // Same qualified id, structurally different fragments — each render must
    // see only its own definition, and the shared kit registry stays clean.
    const wide = badge();
    const narrow = badge();
    (narrow.nodes[0] as RectNode).w = 50;
    const [a, b, a2, b2] = await Promise.all([
      render(design, data, fonts, {}, [wide]),
      render(design, data, fonts, {}, [narrow]),
      render(design, data, fonts, {}, [wide]),
      render(design, data, fonts, {}, [narrow]),
    ]);
    expect(a.svg).not.toBe(b.svg); // each saw its own definition
    expect(a.svg).toBe(a2.svg); // and deterministically so
    expect(b.svg).toBe(b2.svg);
    expect(kitRegistry().has("ada/badge@1")).toBe(false);
  }, 30000);

  it("renders a placeholder + warning when the request lacks a referenced definition", async () => {
    const { svg, warnings } = await render(designWith(instance()), data, fonts, {}, []);
    expect(svg).toContain("<svg");
    expect(warnings).toEqual(['unknown component "ada/badge@1" — rendering placeholder']);
  }, 30000);
});

describe("HTTP endpoints", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createRendererServer(loadFontsOrExit());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));

  function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  describe("POST /internal/validate-component", () => {
    it("accepts a valid definition: 200 {ok:true, warnings:[]}", async () => {
      const res = await post("/internal/validate-component", { definition: badge() });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, warnings: [] });
    });

    it("surfaces non-fatal issues as warnings", async () => {
      const undeclared = badge();
      (undeclared.nodes[1] as TextNode).text = "{{props.nope}}";
      const res = await post("/internal/validate-component", { definition: undeclared });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; warnings: string[] };
      expect(body.ok).toBe(true);
      expect(body.warnings).toHaveLength(1);
      expect(body.warnings[0]).toContain('undeclared prop "nope"');
    });

    it("rejects a data-template with 422 invalid_component and the precise reason", async () => {
      const leaky = badge();
      (leaky.nodes[1] as TextNode).text = "{{github.user.login}}";
      const res = await post("/internal/validate-component", { definition: leaky });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("invalid_component");
      expect(body.error.message).toContain("{{github.user.login}}");
      expect(body.error.message).toContain("props.*");
    });

    it("rejects a schema violation with 422 invalid_component", async () => {
      const res = await post("/internal/validate-component", {
        definition: badge({ frame: { w: 0, h: 40 } }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_component");
    });

    it("rejects a native definition with 422 — natives ship with MakeItBeauty itself", async () => {
      const res = await post("/internal/validate-component", {
        definition: { ...badge(), native: true, dataFields: ["stats.calendar"] },
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("invalid_component");
      expect(body.error.message).toContain("never native");
    });

    it("requires the definition field (400, request-shape error)", async () => {
      const res = await post("/internal/validate-component", {});
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_REQUEST");
    });

    it("only accepts POST", async () => {
      const res = await fetch(`${base}/internal/validate-component`);
      expect(res.status).toBe(405);
    });
  });

  describe("POST /internal/render with components[]", () => {
    it("renders using per-request definitions", async () => {
      const res = await post("/internal/render", {
        design: designWith(instance()),
        data,
        components: [badge()],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { svg: string; warnings: string[] };
      expect(body.svg).toContain("<svg");
      expect(body.warnings).toEqual([]);
    }, 30000);

    it("rejects an invalid request definition with 400 INVALID_COMPONENT", async () => {
      const leaky = badge();
      (leaky.nodes[1] as TextNode).text = "{{github.user.login}}";
      const res = await post("/internal/render", {
        design: designWith(instance()),
        data,
        components: [leaky],
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INVALID_COMPONENT");
      expect(body.error.message).toContain("components[0]");
    });

    it("rejects an unpinned request definition with 400 INVALID_COMPONENT", async () => {
      const res = await post("/internal/render", {
        design: designWith(instance()),
        data,
        components: [badge({ id: "ada/badge" })],
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_COMPONENT");
    });

    it("still renders (placeholder + warning) when a referenced definition is missing", async () => {
      const res = await post("/internal/render", {
        design: designWith(instance({ component: "ada/missing@2" })),
        data,
        components: [badge()],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { warnings: string[] };
      expect(body.warnings).toEqual(['unknown component "ada/missing@2" — rendering placeholder']);
    }, 30000);
  });
});

/**
 * The starter templates are teaching material — these tests pin the
 * invariants that make them trustworthy: schema-shaped, props-only,
 * warning-free tw, inside the frame, exactly one animation each.
 */
import { describe, expect, it } from "vitest";
import { compileTw } from "@makeitbeauty/twc";
import { COMPONENT_TEMPLATES, seedDefinition } from "./componentTemplates";
import { TEMPLATE_RE } from "./component";
import { ANIMATION_PRESETS } from "./design";

/** Schema nodeBase id pattern (design.schema.json). */
const NODE_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

const PRESETS = new Set(ANIMATION_PRESETS.map((p) => p.value));

const seededTemplates = COMPONENT_TEMPLATES.filter((t) => t.seed != null);

/** Every {{...}} path in every string of a value, collected recursively. */
function templatePaths(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    for (const match of value.matchAll(TEMPLATE_RE)) out.push(match[1].trim());
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) templatePaths(item, out);
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) templatePaths(item, out);
  }
  return out;
}

describe("COMPONENT_TEMPLATES", () => {
  it("offers Blank first, then three seeded starters", () => {
    expect(COMPONENT_TEMPLATES.map((t) => t.id)).toEqual([
      "blank",
      "gradient-banner",
      "stat-card",
      "badge",
    ]);
    expect(COMPONENT_TEMPLATES[0].seed).toBeNull();
    expect(seededTemplates).toHaveLength(3);
  });

  it.each(seededTemplates.map((t) => [t.id, t] as const))(
    "%s: every tw string (nodes + swatch) compiles warning-free",
    (_id, t) => {
      const strings = [t.swatchTw, ...t.seed!.nodes.map((n) => n.tw ?? "")];
      for (const tw of strings) {
        if (tw === "") continue;
        expect(compileTw(tw).warnings, tw).toEqual([]);
      }
    },
  );

  it.each(seededTemplates.map((t) => [t.id, t] as const))(
    "%s: node ids are unique and schema-shaped",
    (_id, t) => {
      const ids = t.seed!.nodes.map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(NODE_ID_RE);
    },
  );

  it.each(seededTemplates.map((t) => [t.id, t] as const))(
    "%s: every template reference is a declared props.* path (§7.5)",
    (_id, t) => {
      const declared = new Set(Object.keys(t.seed!.props));
      const paths = templatePaths(t.seed!.nodes);
      expect(paths.length).toBeGreaterThan(0); // each starter teaches slots
      for (const path of paths) {
        const [head, prop, ...rest] = path.split(".");
        expect(head, path).toBe("props");
        expect(rest, path).toEqual([]);
        expect(declared.has(prop), path).toBe(true);
      }
    },
  );

  it.each(seededTemplates.map((t) => [t.id, t] as const))(
    "%s: nodes lie inside the frame",
    (_id, t) => {
      for (const n of t.seed!.nodes) {
        expect(n.x, n.id).toBeGreaterThanOrEqual(0);
        expect(n.y, n.id).toBeGreaterThanOrEqual(0);
        expect(n.x + n.w, n.id).toBeLessThanOrEqual(t.frame.w);
        expect(n.y + n.h, n.id).toBeLessThanOrEqual(t.frame.h);
      }
    },
  );

  it.each(seededTemplates.map((t) => [t.id, t] as const))(
    "%s: exactly one animated node, with a valid preset and duration",
    (_id, t) => {
      const animated = t.seed!.nodes.filter((n) => n.animation != null);
      expect(animated).toHaveLength(1);
      const anim = animated[0].animation!;
      expect(PRESETS.has(anim.preset)).toBe(true);
      expect(anim.durationMs ?? 800).toBeGreaterThanOrEqual(1);
      expect(anim.durationMs ?? 800).toBeLessThanOrEqual(60000);
    },
  );

  it.each(seededTemplates.map((t) => [t.id, t] as const))(
    "%s: teaches a gradient and a shadow via tw",
    (_id, t) => {
      const allTw = t.seed!.nodes.map((n) => n.tw ?? "").join(" ");
      expect(allTw).toMatch(/\bbg-gradient-to-/);
      expect(allTw).toMatch(/(^|\s)shadow(-\w+)?(\s|$)/);
    },
  );

  it.each(seededTemplates.map((t) => [t.id, t] as const))(
    "%s: prop defaults match their declared type",
    (_id, t) => {
      for (const [name, decl] of Object.entries(t.seed!.props)) {
        expect(typeof decl.default, name).toBe(decl.type);
      }
    },
  );
});

describe("seedDefinition", () => {
  it("returns null for the blank template", () => {
    expect(seedDefinition(COMPONENT_TEMPLATES[0], "me/blank", "Blank")).toBeNull();
  });

  it("materializes a full, deep-cloned definition", () => {
    const banner = COMPONENT_TEMPLATES[1];
    const def = seedDefinition(banner, "me/hero", "Hero")!;
    expect(def.id).toBe("me/hero");
    expect(def.title).toBe("Hero");
    expect(def.frame).toEqual(banner.frame);
    expect(def.nodes).toEqual(banner.seed!.nodes);

    // Mutating the materialized draft must never leak into the template.
    def.nodes[0].x = 999;
    def.props[Object.keys(def.props)[0]].default = "mutated";
    def.frame.w = 1;
    expect(banner.seed!.nodes[0].x).toBe(0);
    expect(banner.frame.w).toBe(600);
    expect(
      Object.values(banner.seed!.props).some((p) => p.default === "mutated"),
    ).toBe(false);
  });
});

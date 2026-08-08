import { describe, expect, it } from "vitest";

import { lookupPath, resolveNodeTemplates, resolveTemplate } from "./template.js";
import type { InstanceNode, TextNode } from "./types.js";

const data = {
  github: {
    user: { name: "Ada Lovelace", login: "ada", followers: 1234 },
    stats: { totalStars: 5678, topLanguage: "TypeScript" },
  },
};

describe("lookupPath", () => {
  it("resolves nested paths", () => {
    expect(lookupPath(data, "github.user.name")).toBe("Ada Lovelace");
    expect(lookupPath(data, "github.stats.totalStars")).toBe(5678);
  });

  it("returns undefined for any missing segment", () => {
    expect(lookupPath(data, "github.nope.name")).toBeUndefined();
    expect(lookupPath(data, "github.user.name.deeper")).toBeUndefined();
  });
});

describe("resolveTemplate", () => {
  it("substitutes multiple templates in one string", () => {
    const r = resolveTemplate("@{{github.user.login}} · {{github.user.followers}} followers", data);
    expect(r.value).toBe("@ada · 1234 followers");
    expect(r.warnings).toEqual([]);
  });

  it("passes plain text through untouched", () => {
    const r = resolveTemplate("made with MakeItBeauty", data);
    expect(r.value).toBe("made with MakeItBeauty");
    expect(r.warnings).toEqual([]);
  });

  it("tolerates whitespace inside braces", () => {
    expect(resolveTemplate("{{ github.user.login }}", data).value).toBe("ada");
  });

  it("replaces a missing path with an em dash and warns — never throws", () => {
    const r = resolveTemplate("Hi {{github.user.nickname}}!", data);
    expect(r.value).toBe("Hi —!");
    expect(r.warnings).toEqual(['unresolved template path "github.user.nickname"']);
  });

  it("treats non-scalar values as unresolved", () => {
    const r = resolveTemplate("{{github.user}}", data);
    expect(r.value).toBe("—");
    expect(r.warnings).toHaveLength(1);
  });
});

describe("resolveNodeTemplates", () => {
  it("resolves text-node text without mutating the input", () => {
    const node: TextNode = {
      id: "t",
      type: "text",
      x: 0,
      y: 0,
      w: 100,
      h: 20,
      text: "Hi, I'm {{github.user.name}}",
    };
    const r = resolveNodeTemplates(node, data);
    expect((r.value as TextNode).text).toBe("Hi, I'm Ada Lovelace");
    expect(node.text).toBe("Hi, I'm {{github.user.name}}");
  });

  it("resolves instance props recursively", () => {
    const node: InstanceNode = {
      id: "i",
      type: "instance",
      x: 0,
      y: 0,
      w: 100,
      h: 50,
      component: "kit/stat-card",
      props: { label: "Stars", value: "{{github.stats.totalStars}}", nested: ["{{github.user.login}}"] },
    };
    const r = resolveNodeTemplates(node, data);
    expect((r.value as InstanceNode).props).toEqual({
      label: "Stars",
      value: "5678",
      nested: ["ada"],
    });
    expect(r.warnings).toEqual([]);
  });
});

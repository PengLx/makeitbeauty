import { describe, expect, it } from "vitest";
import { compileTw } from "@makeitbeauty/twc";
import {
  applyCompletion,
  currentToken,
  layerStyles,
  MAX_TW_SUGGESTIONS,
  suggestCompletions,
  twApproxStyle,
  TW_EXAMPLES,
} from "./tw";

describe("currentToken", () => {
  it("returns the empty string for an empty value", () => {
    expect(currentToken("")).toBe("");
  });

  it("returns the whole value while typing the first token", () => {
    expect(currentToken("bg-")).toBe("bg-");
  });

  it("returns the last token of a multi-class value", () => {
    expect(currentToken("shadow-lg rounded")).toBe("rounded");
  });

  it("returns empty right after whitespace (no token started)", () => {
    expect(currentToken("shadow-lg ")).toBe("");
    expect(currentToken("   ")).toBe("");
  });

  it("treats any whitespace as a separator", () => {
    expect(currentToken("a\n\tb")).toBe("b");
  });
});

describe("suggestCompletions", () => {
  it("suggests nothing for an empty token", () => {
    expect(suggestCompletions("")).toEqual([]);
  });

  it("lists catalog prefixes extending the token, in catalog order", () => {
    expect(suggestCompletions("b").map((e) => e.prefix)).toEqual([
      "bg-",
      "bg-gradient-to-",
      "border",
    ]);
  });

  it("keeps suggesting longer families past a complete shorter prefix", () => {
    expect(suggestCompletions("bg-").map((e) => e.prefix)).toEqual([
      "bg-gradient-to-",
    ]);
  });

  it("goes quiet once the token matches a family exactly", () => {
    // "border" is a complete class; values after it are compileTw's job.
    expect(suggestCompletions("border")).toEqual([]);
  });

  it("returns nothing for tokens outside every family", () => {
    expect(suggestCompletions("zzz")).toEqual([]);
    expect(suggestCompletions("BG")).toEqual([]); // classes are lowercase
  });

  it("respects the limit", () => {
    expect(suggestCompletions("b", 2)).toHaveLength(2);
    for (const token of ["b", "t", "p", "s", "f", "r", "o", "l"]) {
      expect(
        suggestCompletions(token).length,
      ).toBeLessThanOrEqual(MAX_TW_SUGGESTIONS);
    }
  });
});

describe("applyCompletion", () => {
  it("replaces the in-progress last token", () => {
    expect(applyCompletion("bg-gradient-to-r fr", "from-")).toBe(
      "bg-gradient-to-r from-",
    );
  });

  it("appends to an empty value", () => {
    expect(applyCompletion("", "bg-")).toBe("bg-");
  });

  it("appends after trailing whitespace without eating earlier tokens", () => {
    expect(applyCompletion("shadow-lg ", "rounded")).toBe("shadow-lg rounded");
  });

  it("preserves inner whitespace exactly", () => {
    expect(applyCompletion("a  b", "text-")).toBe("a  text-");
  });
});

describe("twApproxStyle", () => {
  it("returns undefined for missing or empty tw", () => {
    expect(twApproxStyle(undefined)).toBeUndefined();
    expect(twApproxStyle("")).toBeUndefined();
  });

  it("compiles a gradient to a backgroundImage", () => {
    const style = twApproxStyle("bg-gradient-to-r from-purple-500 to-pink-500");
    expect(String(style?.backgroundImage)).toContain("linear-gradient(90deg");
  });
});

describe("layerStyles", () => {
  it("merges later layers over earlier ones", () => {
    expect(layerStyles({ color: "red" }, { color: "blue" })).toEqual({
      color: "blue",
    });
  });

  it("skips undefined layers", () => {
    expect(layerStyles(undefined, { opacity: 0.5 }, undefined)).toEqual({
      opacity: 0.5,
    });
  });

  it("never lets an undefined VALUE shadow an earlier layer", () => {
    // Plain object spread would produce { color: undefined } here and the
    // tw color would vanish — the exact bug this helper exists to prevent.
    expect(
      layerStyles({ color: "#fff", fontWeight: 700 }, { color: undefined }),
    ).toEqual({ color: "#fff", fontWeight: 700 });
  });

  it("returns an empty object with no layers", () => {
    expect(layerStyles()).toEqual({});
  });
});

describe("TW_EXAMPLES (the Styles field hint line)", () => {
  it("has 2-3 examples, every one compiling warning-free", () => {
    expect(TW_EXAMPLES.length).toBeGreaterThanOrEqual(2);
    expect(TW_EXAMPLES.length).toBeLessThanOrEqual(3);
    for (const example of TW_EXAMPLES) {
      expect(compileTw(example).warnings, example).toEqual([]);
    }
  });
});

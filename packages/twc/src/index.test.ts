import { describe, expect, it } from "vitest";
import { CATALOG, PALETTE, compileTw } from "./index.js";

const ok = (tw: string) => {
  const res = compileTw(tw);
  expect(res.warnings).toEqual([]);
  return res.style;
};

describe("background color", () => {
  it("resolves palette shades to the baked Tailwind v4 hex values", () => {
    expect(ok("bg-blue-500")).toEqual({ backgroundColor: "#2b7fff" });
    expect(ok("bg-red-500")).toEqual({ backgroundColor: "#fb2c36" });
    expect(ok("bg-slate-50")).toEqual({ backgroundColor: "#f8fafc" });
    expect(ok("bg-rose-950")).toEqual({ backgroundColor: "#4d0218" });
    expect(ok("bg-zinc-50")).toEqual({ backgroundColor: "#fafafa" });
  });

  it("covers every family x shade in the palette", () => {
    const families = [
      "slate", "gray", "zinc", "neutral", "stone", "red", "orange", "amber",
      "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue",
      "indigo", "violet", "purple", "fuchsia", "pink", "rose",
    ];
    const shades = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];
    for (const f of families) {
      for (const s of shades) {
        const { style, warnings } = compileTw(`bg-${f}-${s}`);
        expect(warnings, `bg-${f}-${s}`).toEqual([]);
        expect(style.backgroundColor, `bg-${f}-${s}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
    // 22 families x 11 shades + black + white + transparent
    expect(Object.keys(PALETTE)).toHaveLength(245);
  });

  it("supports base colors", () => {
    expect(ok("bg-black")).toEqual({ backgroundColor: "#000000" });
    expect(ok("bg-white")).toEqual({ backgroundColor: "#ffffff" });
    expect(ok("bg-transparent")).toEqual({ backgroundColor: "transparent" });
  });

  it("accepts arbitrary hex values (3/4/6/8 digits), lowercased", () => {
    expect(ok("bg-[#abc]")).toEqual({ backgroundColor: "#abc" });
    expect(ok("bg-[#abcd]")).toEqual({ backgroundColor: "#abcd" });
    expect(ok("bg-[#1E293B]")).toEqual({ backgroundColor: "#1e293b" });
    expect(ok("bg-[#1e293bff]")).toEqual({ backgroundColor: "#1e293bff" });
  });

  it("rejects malformed hex", () => {
    for (const cls of ["bg-[#12]", "bg-[#12345]", "bg-[#1234567]", "bg-[#zzz]"]) {
      const { style, warnings } = compileTw(cls);
      expect(style).toEqual({});
      expect(warnings).toEqual([`unknown or unsupported class: ${cls}`]);
    }
  });

  it("accepts rgb()/hsl() grammars, including underscore-decoded spaces", () => {
    expect(ok("bg-[rgb(30,41,59)]")).toEqual({ backgroundColor: "rgb(30,41,59)" });
    expect(ok("bg-[rgba(0,0,0,0.5)]")).toEqual({ backgroundColor: "rgba(0,0,0,0.5)" });
    expect(ok("bg-[rgb(30_41_59)]")).toEqual({ backgroundColor: "rgb(30 41 59)" });
    expect(ok("bg-[rgb(0_0_0_/_0.4)]")).toEqual({ backgroundColor: "rgb(0 0 0 / 0.4)" });
    expect(ok("bg-[hsl(210,40%,50%)]")).toEqual({ backgroundColor: "hsl(210,40%,50%)" });
    expect(ok("bg-[hsl(210deg_40%_50%)]")).toEqual({ backgroundColor: "hsl(210deg 40% 50%)" });
  });

  it("accepts CSS named colors in arbitrary values", () => {
    expect(ok("bg-[tomato]")).toEqual({ backgroundColor: "tomato" });
    expect(ok("bg-[rebeccapurple]")).toEqual({ backgroundColor: "rebeccapurple" });
    expect(ok("bg-[Tomato]")).toEqual({ backgroundColor: "tomato" });
  });

  it("warns on unknown palette names", () => {
    const { style, warnings } = compileTw("bg-notacolor bg-blue-475");
    expect(style).toEqual({});
    expect(warnings).toEqual([
      "unknown or unsupported class: bg-notacolor",
      "unknown or unsupported class: bg-blue-475",
    ]);
  });
});

describe("gradients", () => {
  it.each([
    ["t", 0],
    ["tr", 45],
    ["r", 90],
    ["br", 135],
    ["b", 180],
    ["bl", 225],
    ["l", 270],
    ["tl", 315],
  ])("maps bg-gradient-to-%s to %ddeg", (dir, angle) => {
    const style = ok(`bg-gradient-to-${dir} from-blue-500 to-purple-500`);
    expect(style.backgroundImage).toBe(
      `linear-gradient(${angle}deg, #2b7fff 0%, ${PALETTE["purple-500"]} 100%)`,
    );
  });

  it("orders stops from 0%, via 50%, to 100%", () => {
    const style = ok("bg-gradient-to-r from-red-500 via-amber-400 to-emerald-500");
    expect(style.backgroundImage).toBe(
      `linear-gradient(90deg, ${PALETTE["red-500"]} 0%, ${PALETTE["amber-400"]} 50%, ${PALETTE["emerald-500"]} 100%)`,
    );
  });

  it("defaults a missing from/to stop to transparent", () => {
    expect(ok("bg-gradient-to-b to-cyan-400").backgroundImage).toBe(
      `linear-gradient(180deg, transparent 0%, ${PALETTE["cyan-400"]} 100%)`,
    );
    expect(ok("bg-gradient-to-b from-cyan-400").backgroundImage).toBe(
      `linear-gradient(180deg, ${PALETTE["cyan-400"]} 0%, transparent 100%)`,
    );
  });

  it("accepts arbitrary colors as stops", () => {
    expect(ok("bg-gradient-to-tr from-[#0f172a] to-[rgb(255,0,128)]").backgroundImage).toBe(
      "linear-gradient(45deg, #0f172a 0%, rgb(255,0,128) 100%)",
    );
  });

  it("keeps backgroundColor and backgroundImage independent", () => {
    const style = ok("bg-slate-900 bg-gradient-to-r from-blue-500 to-cyan-400");
    expect(style.backgroundColor).toBe(PALETTE["slate-900"]);
    expect(style.backgroundImage).toContain("linear-gradient(90deg");
  });

  it("warns on a direction without stops", () => {
    const { style, warnings } = compileTw("bg-gradient-to-r");
    expect(style).toEqual({});
    expect(warnings).toEqual([
      "gradient direction without color stops: add from-/via-/to-",
    ]);
  });

  it("warns on stops without a direction", () => {
    const { style, warnings } = compileTw("from-blue-500 to-cyan-400");
    expect(style).toEqual({});
    expect(warnings).toEqual([
      "gradient stops without a direction: add bg-gradient-to-{t|tr|r|br|b|bl|l|tl}",
    ]);
  });

  it("warns on an unknown direction", () => {
    const { warnings } = compileTw("bg-gradient-to-x from-blue-500 to-cyan-400");
    expect(warnings).toContain("unknown or unsupported class: bg-gradient-to-x");
  });

  it("lets the last repeated stop win", () => {
    expect(ok("bg-gradient-to-r from-red-500 from-blue-500 to-white").backgroundImage).toBe(
      `linear-gradient(90deg, ${PALETTE["blue-500"]} 0%, #ffffff 100%)`,
    );
  });
});

describe("text color and typography", () => {
  it("maps text-{color} to color", () => {
    expect(ok("text-slate-100")).toEqual({ color: PALETTE["slate-100"] });
    expect(ok("text-[#fff]")).toEqual({ color: "#fff" });
  });

  it("rejects text sizes (unsupported)", () => {
    const { style, warnings } = compileTw("text-lg");
    expect(style).toEqual({});
    expect(warnings).toEqual(["unknown or unsupported class: text-lg"]);
  });

  it.each([
    ["thin", 100],
    ["extralight", 200],
    ["light", 300],
    ["normal", 400],
    ["medium", 500],
    ["semibold", 600],
    ["bold", 700],
    ["extrabold", 800],
    ["black", 900],
  ])("maps font-%s to numeric weight %d", (name, weight) => {
    expect(ok(`font-${name}`)).toEqual({ fontWeight: weight });
  });

  it("accepts numeric weights 100..900", () => {
    expect(ok("font-100")).toEqual({ fontWeight: 100 });
    expect(ok("font-600")).toEqual({ fontWeight: 600 });
    expect(ok("font-900")).toEqual({ fontWeight: 900 });
    expect(compileTw("font-450").warnings).toEqual([
      "unknown or unsupported class: font-450",
    ]);
  });

  it.each([
    ["tighter", "-0.8px"],
    ["tight", "-0.4px"],
    ["normal", "0px"],
    ["wide", "0.4px"],
    ["wider", "0.8px"],
    ["widest", "1.6px"],
  ])("maps tracking-%s to %s (16px em basis)", (name, px) => {
    expect(ok(`tracking-${name}`)).toEqual({ letterSpacing: px });
  });

  it("accepts arbitrary px tracking, including negative", () => {
    expect(ok("tracking-[2px]")).toEqual({ letterSpacing: "2px" });
    expect(ok("tracking-[-0.5px]")).toEqual({ letterSpacing: "-0.5px" });
    expect(compileTw("tracking-[2em]").warnings).toEqual([
      "unknown or unsupported class: tracking-[2em]",
    ]);
  });

  it.each([
    ["none", 1],
    ["tight", 1.25],
    ["snug", 1.375],
    ["normal", 1.5],
    ["relaxed", 1.625],
    ["loose", 2],
  ])("maps leading-%s to %d", (name, lh) => {
    expect(ok(`leading-${name}`)).toEqual({ lineHeight: lh });
  });

  it("accepts arbitrary unitless line height", () => {
    expect(ok("leading-[1.8]")).toEqual({ lineHeight: 1.8 });
    expect(compileTw("leading-[18px]").warnings).toEqual([
      "unknown or unsupported class: leading-[18px]",
    ]);
  });
});

describe("radius", () => {
  it.each([
    ["rounded", "4px"],
    ["rounded-none", "0px"],
    ["rounded-sm", "2px"],
    ["rounded-md", "6px"],
    ["rounded-lg", "8px"],
    ["rounded-xl", "12px"],
    ["rounded-2xl", "16px"],
    ["rounded-3xl", "24px"],
    ["rounded-full", "9999px"],
    ["rounded-[10px]", "10px"],
  ])("maps %s to %s", (cls, px) => {
    expect(ok(cls)).toEqual({ borderRadius: px });
  });

  it("rejects negative or unitless arbitrary radii", () => {
    expect(compileTw("rounded-[-4px]").warnings).toHaveLength(1);
    expect(compileTw("rounded-[10]").warnings).toHaveLength(1);
  });
});

describe("borders", () => {
  it.each([
    ["border", "1px"],
    ["border-0", "0px"],
    ["border-2", "2px"],
    ["border-4", "4px"],
    ["border-8", "8px"],
  ])("maps %s to width %s with solid style", (cls, px) => {
    expect(ok(cls)).toEqual({ borderWidth: px, borderStyle: "solid" });
  });

  it("rejects non-scale widths", () => {
    expect(compileTw("border-3").warnings).toEqual([
      "unknown or unsupported class: border-3",
    ]);
  });

  it("maps border colors", () => {
    expect(ok("border-red-500")).toEqual({ borderColor: PALETTE["red-500"] });
    expect(ok("border-[#0f0]")).toEqual({ borderColor: "#0f0" });
  });

  it("combines width and color", () => {
    expect(ok("border-2 border-slate-700")).toEqual({
      borderWidth: "2px",
      borderStyle: "solid",
      borderColor: PALETTE["slate-700"],
    });
  });
});

describe("shadows", () => {
  it.each([
    ["shadow", "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)"],
    ["shadow-sm", "0 1px 2px 0 rgb(0 0 0 / 0.05)"],
    ["shadow-md", "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)"],
    ["shadow-lg", "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)"],
    ["shadow-xl", "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)"],
    ["shadow-2xl", "0 25px 50px -12px rgb(0 0 0 / 0.25)"],
    ["shadow-none", "none"],
  ])("maps %s to the standard Tailwind string", (cls, value) => {
    expect(ok(cls)).toEqual({ boxShadow: value });
  });

  it("passes through arbitrary shadows matching the strict grammar", () => {
    expect(ok("shadow-[0_4px_6px_rgba(0,0,0,0.3)]")).toEqual({
      boxShadow: "0 4px 6px rgba(0,0,0,0.3)",
    });
    expect(ok("shadow-[0_0_20px_rgb(43_127_255_/_0.6)]")).toEqual({
      boxShadow: "0 0 20px rgb(43 127 255 / 0.6)",
    });
    expect(ok("shadow-[inset_0_2px_4px_#00000040]")).toEqual({
      boxShadow: "inset 0 2px 4px #00000040",
    });
    expect(ok("shadow-[0_1px_2px_black,0_4px_12px_rgba(0,0,0,0.2)]")).toEqual({
      boxShadow: "0 1px 2px black,0 4px 12px rgba(0,0,0,0.2)",
    });
    expect(ok("shadow-[0_0.5px_1.5px_tomato]")).toEqual({
      boxShadow: "0 0.5px 1.5px tomato",
    });
  });

  it("rejects shadows outside the grammar", () => {
    for (const cls of [
      "shadow-[foo]",
      "shadow-[0px]", // one length is not a shadow
      "shadow-[0_1px_2px_3px_4px]", // five lengths
      "shadow-[0_1px_red_blue]", // two colors
      "shadow-[1_2]", // nonzero unitless lengths
      "shadow-[0_1px_2px_red,]", // empty list entry
      "shadow-[0_1px_2px_rgb(0,0]", // unbalanced parens
    ]) {
      const { style, warnings } = compileTw(cls);
      expect(style, cls).toEqual({});
      expect(warnings, cls).toEqual([`unknown or unsupported class: ${cls}`]);
    }
  });
});

describe("opacity", () => {
  it("accepts the 0..100 step-of-5 scale", () => {
    expect(ok("opacity-0")).toEqual({ opacity: 0 });
    expect(ok("opacity-5")).toEqual({ opacity: 0.05 });
    expect(ok("opacity-60")).toEqual({ opacity: 0.6 });
    expect(ok("opacity-95")).toEqual({ opacity: 0.95 });
    expect(ok("opacity-100")).toEqual({ opacity: 1 });
  });

  it("rejects off-scale steps", () => {
    for (const cls of ["opacity-42", "opacity-05", "opacity-101", "opacity--5"]) {
      expect(compileTw(cls).warnings, cls).toEqual([
        `unknown or unsupported class: ${cls}`,
      ]);
    }
  });

  it("accepts arbitrary fractions", () => {
    expect(ok("opacity-[0.35]")).toEqual({ opacity: 0.35 });
    expect(ok("opacity-[.5]")).toEqual({ opacity: 0.5 });
    expect(ok("opacity-[1]")).toEqual({ opacity: 1 });
    expect(ok("opacity-[0]")).toEqual({ opacity: 0 });
    expect(compileTw("opacity-[1.5]").warnings).toEqual([
      "unknown or unsupported class: opacity-[1.5]",
    ]);
  });
});

describe("padding", () => {
  it("maps p-{n} on the 4px scale to all four sides", () => {
    expect(ok("p-0")).toEqual({
      paddingTop: "0px",
      paddingBottom: "0px",
      paddingLeft: "0px",
      paddingRight: "0px",
    });
    expect(ok("p-4")).toEqual({
      paddingTop: "16px",
      paddingBottom: "16px",
      paddingLeft: "16px",
      paddingRight: "16px",
    });
    expect(ok("p-12").paddingTop).toBe("48px");
  });

  it("maps px-/py- to their axes only", () => {
    expect(ok("px-2")).toEqual({ paddingLeft: "8px", paddingRight: "8px" });
    expect(ok("py-3")).toEqual({ paddingTop: "12px", paddingBottom: "12px" });
  });

  it("rejects values beyond the 0..12 scale", () => {
    for (const cls of ["p-13", "p-100", "px-1.5", "p--1", "p-[3px]"]) {
      expect(compileTw(cls).warnings, cls).toEqual([
        `unknown or unsupported class: ${cls}`,
      ]);
    }
  });

  it("resolves axis overrides positionally (last wins per side)", () => {
    expect(ok("p-4 px-2")).toEqual({
      paddingTop: "16px",
      paddingBottom: "16px",
      paddingLeft: "8px",
      paddingRight: "8px",
    });
    expect(ok("px-2 p-4")).toEqual({
      paddingTop: "16px",
      paddingBottom: "16px",
      paddingLeft: "16px",
      paddingRight: "16px",
    });
  });
});

describe("hostile input", () => {
  it.each([
    "bg-[url(https://evil.example/x.png)]",
    "bg-[url(javascript:alert(1))]",
    "text-[var(--steal)]",
    "shadow-[0_0_4px_url(http://x)]",
    "bg-[red;position:fixed]",
    "border-[VAR(--x)]",
    "shadow-[0_0_4px_red;top:0]",
  ])("drops %s with an unsafe warning and emits no style", (cls) => {
    const { style, warnings } = compileTw(cls);
    expect(style).toEqual({});
    expect(warnings).toEqual([`unsafe value dropped: ${cls}`]);
  });

  it("catches underscore-obfuscated url()/var() after decoding", () => {
    for (const cls of ["bg-[url_(http://x)]", "bg-[var_(--x)]"]) {
      const { style, warnings } = compileTw(cls);
      expect(style, cls).toEqual({});
      expect(warnings, cls).toEqual([`unsafe value dropped: ${cls}`]);
    }
  });

  it("never emits style from tokens containing newlines", () => {
    const { style, warnings } = compileTw("bg-[#fff\nfoo]");
    expect(style).toEqual({});
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("keeps compiling safe classes around hostile ones", () => {
    const { style, warnings } = compileTw("bg-[url(http://x)] text-white p-2");
    expect(style).toEqual({
      color: "#ffffff",
      paddingTop: "8px",
      paddingBottom: "8px",
      paddingLeft: "8px",
      paddingRight: "8px",
    });
    expect(warnings).toEqual(["unsafe value dropped: bg-[url(http://x)]"]);
  });
});

describe("unknown classes", () => {
  it("warns and drops layout/unsupported utilities", () => {
    const { style, warnings } = compileTw("flex mt-4 w-full grid-cols-2");
    expect(style).toEqual({});
    expect(warnings).toEqual([
      "unknown or unsupported class: flex",
      "unknown or unsupported class: mt-4",
      "unknown or unsupported class: w-full",
      "unknown or unsupported class: grid-cols-2",
    ]);
  });

  it("returns empty output for empty or blank input", () => {
    expect(compileTw("")).toEqual({ style: {}, warnings: [] });
    expect(compileTw("   \t ")).toEqual({ style: {}, warnings: [] });
  });
});

describe("conflict resolution (last wins per property)", () => {
  it("resolves repeated properties positionally", () => {
    expect(ok("bg-red-500 bg-blue-500")).toEqual({
      backgroundColor: PALETTE["blue-500"],
    });
    expect(ok("font-bold font-light")).toEqual({ fontWeight: 300 });
    expect(ok("shadow-lg shadow-none")).toEqual({ boxShadow: "none" });
    expect(ok("rounded-full rounded-sm")).toEqual({ borderRadius: "2px" });
    expect(ok("opacity-100 opacity-25")).toEqual({ opacity: 0.25 });
  });

  it("does not let an invalid later class clobber a valid earlier one", () => {
    const { style, warnings } = compileTw("bg-blue-500 bg-notreal");
    expect(style).toEqual({ backgroundColor: PALETTE["blue-500"] });
    expect(warnings).toEqual(["unknown or unsupported class: bg-notreal"]);
  });
});

const KITCHEN_SINK =
  "bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 " +
  "text-white font-bold tracking-wide leading-snug rounded-2xl " +
  "border-2 border-[#ffffff33] shadow-2xl opacity-95 p-6 px-8 " +
  "flex bg-[url(http://evil)] text-[#fafafa]";

describe("determinism", () => {
  it("returns deep-equal output for repeated compilation", () => {
    const a = compileTw(KITCHEN_SINK);
    const b = compileTw(KITCHEN_SINK);
    expect(a).toEqual(b);
    // JSON serialization captures property insertion order as well.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("compiles the kitchen sink to the expected style", () => {
    const { style, warnings } = compileTw(KITCHEN_SINK);
    expect(style).toEqual({
      backgroundImage: `linear-gradient(135deg, ${PALETTE["indigo-500"]} 0%, ${PALETTE["purple-500"]} 50%, ${PALETTE["pink-500"]} 100%)`,
      color: "#fafafa",
      fontWeight: 700,
      letterSpacing: "0.4px",
      lineHeight: 1.375,
      borderRadius: "16px",
      borderWidth: "2px",
      borderStyle: "solid",
      borderColor: "#ffffff33",
      boxShadow: "0 25px 50px -12px rgb(0 0 0 / 0.25)",
      opacity: 0.95,
      paddingTop: "24px",
      paddingBottom: "24px",
      paddingLeft: "32px",
      paddingRight: "32px",
    });
    expect(warnings).toEqual([
      "unknown or unsupported class: flex",
      "unsafe value dropped: bg-[url(http://evil)]",
    ]);
  });
});

describe("CATALOG", () => {
  it("matches the snapshot (editor autocomplete contract)", () => {
    expect(CATALOG).toMatchSnapshot();
  });

  it("documents every supported family exactly once", () => {
    const prefixes = CATALOG.map((e) => e.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(prefixes).toEqual([
      "bg-",
      "bg-gradient-to-",
      "from-",
      "via-",
      "to-",
      "text-",
      "font-",
      "tracking-",
      "leading-",
      "rounded",
      "border",
      "shadow",
      "opacity-",
      "p-",
      "px-",
      "py-",
    ]);
  });
});

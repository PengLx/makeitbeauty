/**
 * Pure font-system logic (lib/fonts.ts): magic-byte sniffing and upload
 * pre-checks (the WOFF2 rejection must EXPLAIN itself), the upload dialog's
 * family prefill, the canvas font stack, referenced-family extraction and
 * the Inspector picker's grouping (built-in / mine / missing, Studio
 * isolation).
 */
import { describe, expect, it } from "vitest";
import type { DesignDoc } from "./design";
import { CANVAS_FONT_STACK } from "./canvasText";
import {
  BUILTIN_FONTS,
  DEFAULT_FONT_FAMILY,
  FONT_MAX_BYTES,
  WOFF2_MESSAGE,
  familyFromFilename,
  fontPickerGroups,
  fontStackFor,
  referencedFontFamilies,
  sniffFontFormat,
  validateFontFile,
} from "./fonts";

/** ASCII tag + padding, the way real sfnt/woff headers start. */
function bytesFor(tag: string): Uint8Array {
  return new Uint8Array([...tag].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0]));
}

const TTF = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00, 0x0f]);

describe("sniffFontFormat", () => {
  it("recognizes the four magic signatures the server validates", () => {
    expect(sniffFontFormat(TTF)).toBe("ttf");
    expect(sniffFontFormat(bytesFor("true"))).toBe("ttf"); // Apple sfnt
    expect(sniffFontFormat(bytesFor("OTTO"))).toBe("otf");
    expect(sniffFontFormat(bytesFor("wOFF"))).toBe("woff");
    expect(sniffFontFormat(bytesFor("wOF2"))).toBe("woff2");
  });

  it("returns null for junk and truncated buffers", () => {
    expect(sniffFontFormat(bytesFor("GIF8"))).toBeNull();
    expect(sniffFontFormat(new Uint8Array([0x00, 0x01]))).toBeNull();
    expect(sniffFontFormat(new Uint8Array())).toBeNull();
    // Case matters: "WOFF"/"otto" are not the signatures.
    expect(sniffFontFormat(bytesFor("WOFF"))).toBeNull();
    expect(sniffFontFormat(bytesFor("otto"))).toBeNull();
  });
});

describe("validateFontFile", () => {
  it("accepts a plausible ttf/otf/woff", () => {
    expect(validateFontFile("Lora-Bold.ttf", 1024, TTF)).toBeNull();
    expect(validateFontFile("font.otf", 1024, bytesFor("OTTO"))).toBeNull();
    expect(validateFontFile("font.woff", 1024, bytesFor("wOFF"))).toBeNull();
    expect(validateFontFile("FONT.TTF", 1024, TTF)).toBeNull(); // ext case-blind
  });

  it("rejects WOFF2 by magic with the satori explanation", () => {
    const err = validateFontFile("sneaky.ttf", 1024, bytesFor("wOF2"));
    expect(err?.code).toBe("woff2_unsupported");
    expect(err?.message).toBe(WOFF2_MESSAGE);
    expect(err?.message).toMatch(/satori/);
    expect(err?.message).toMatch(/TTF, OTF or WOFF/);
  });

  it("rejects a .woff2 extension the same way, before other checks", () => {
    const err = validateFontFile("font.woff2", 1024, TTF);
    expect(err?.code).toBe("woff2_unsupported");
  });

  it("rejects other extensions", () => {
    expect(validateFontFile("font.zip", 1024, TTF)?.code).toBe("bad_extension");
  });

  it("enforces the 5MB limit", () => {
    expect(validateFontFile("big.ttf", FONT_MAX_BYTES + 1, TTF)?.code).toBe(
      "file_too_large",
    );
    expect(validateFontFile("big.ttf", FONT_MAX_BYTES, TTF)).toBeNull();
  });

  it("rejects files whose bytes match no font signature", () => {
    const err = validateFontFile("font.ttf", 1024, bytesFor("GIF8"));
    expect(err?.code).toBe("unrecognized_font");
  });
});

describe("familyFromFilename", () => {
  it("strips the extension and splits separators and camelCase", () => {
    expect(familyFromFilename("OpenSans-Bold.ttf")).toBe("Open Sans");
    expect(familyFromFilename("space_grotesk.otf")).toBe("Space Grotesk");
  });

  it("drops trailing weight/style tokens (the weight select carries them)", () => {
    expect(familyFromFilename("Lora-Bold.ttf")).toBe("Lora");
    expect(familyFromFilename("lora-700.woff")).toBe("Lora");
    expect(familyFromFilename("Inter-Regular.ttf")).toBe("Inter");
    expect(familyFromFilename("Inter-ExtraBold.otf")).toBe("Inter");
  });

  it("never empties a name that is ONLY a weight token", () => {
    expect(familyFromFilename("bold.ttf")).toBe("Bold");
  });

  it("title-cases lowercase words but leaves mixed case as typed", () => {
    expect(familyFromFilename("ibm-plex-mono.ttf")).toBe("Ibm Plex Mono");
    // Known camelCase-split cost, editable in one keystroke (lib/fonts.ts).
    expect(familyFromFilename("JetBrainsMono-Bold.ttf")).toBe("Jet Brains Mono");
  });

  it("strips quotes/backslashes and caps at 64 chars", () => {
    expect(familyFromFilename(`Fancy"Font'.ttf`)).toBe("Fancy Font");
    expect(familyFromFilename(`${"a".repeat(80)}.ttf`).length).toBeLessThanOrEqual(64);
  });
});

describe("fontStackFor (canvas parity)", () => {
  it("keeps the plain Inter stack for the default/absent family", () => {
    expect(fontStackFor(undefined)).toBe(CANVAS_FONT_STACK);
    expect(fontStackFor(DEFAULT_FONT_FAMILY)).toBe(CANVAS_FONT_STACK);
  });

  it("prepends the family with the Inter stack as fallback", () => {
    expect(fontStackFor("Lora")).toBe(`Lora, ${CANVAS_FONT_STACK}`);
  });

  it("quotes families that aren't simple CSS identifiers", () => {
    expect(fontStackFor("JetBrains Mono")).toBe(`"JetBrains Mono", ${CANVAS_FONT_STACK}`);
    expect(fontStackFor("My 2nd Font")).toBe(`"My 2nd Font", ${CANVAS_FONT_STACK}`);
  });

  it("strips quote characters so a family can't break the CSS value", () => {
    // Once cleaned, "Evil" is a simple identifier — no quoting needed.
    expect(fontStackFor(`Ev"il`)).toBe(`Evil, ${CANVAS_FONT_STACK}`);
    expect(fontStackFor(`Ev"il Font`)).toBe(`"Evil Font", ${CANVAS_FONT_STACK}`);
  });
});

function designWith(nodes: DesignDoc["nodes"]): DesignDoc {
  return { version: 0, canvas: { width: 800, height: 400 }, nodes };
}

describe("referencedFontFamilies", () => {
  it("collects unique families from text nodes only", () => {
    const design = designWith([
      { id: "t1", type: "text", x: 0, y: 0, w: 10, h: 10, text: "a", style: { fontFamily: "Lora" } },
      { id: "t2", type: "text", x: 0, y: 0, w: 10, h: 10, text: "b", style: { fontFamily: "Lora" } },
      { id: "t3", type: "text", x: 0, y: 0, w: 10, h: 10, text: "c", style: { fontFamily: "My Font" } },
      { id: "t4", type: "text", x: 0, y: 0, w: 10, h: 10, text: "d" },
      { id: "r1", type: "rect", x: 0, y: 0, w: 10, h: 10 },
    ]);
    expect(referencedFontFamilies(design).sort()).toEqual(["Lora", "My Font"]);
  });

  it("is empty for designs without explicit families", () => {
    expect(referencedFontFamilies(designWith([]))).toEqual([]);
  });
});

const LIST = {
  builtin: BUILTIN_FONTS,
  mine: [
    { id: "f2", family: "Zilla", weight: 400, format: "ttf", size: 1 },
    { id: "f1", family: "Custom Sans", weight: 400, format: "ttf", size: 1 },
    { id: "f3", family: "Custom Sans", weight: 700, format: "ttf", size: 1 },
  ],
};

describe("fontPickerGroups", () => {
  it("offers the pinned built-ins even with no list (API down)", () => {
    const groups = fontPickerGroups(null, undefined);
    expect(groups.builtin).toEqual(["Inter", "JetBrains Mono", "Lora"]);
    expect(groups.mine).toEqual([]);
    expect(groups.missing).toBeNull();
  });

  it("dedupes my families across weights and sorts them", () => {
    const groups = fontPickerGroups(LIST, undefined);
    expect(groups.mine).toEqual(["Custom Sans", "Zilla"]);
  });

  it("never lets an upload shadow a built-in name", () => {
    const list = {
      builtin: [],
      mine: [{ id: "x", family: "Inter", weight: 400, format: "ttf", size: 1 }],
    };
    expect(fontPickerGroups(list, undefined).mine).toEqual([]);
  });

  it("unions extra server-side builtins after the pinned ones", () => {
    const list = { builtin: [{ family: "Noto Sans CJK", weights: [400] }], mine: [] };
    expect(fontPickerGroups(list, undefined).builtin).toEqual([
      "Inter",
      "JetBrains Mono",
      "Lora",
      "Noto Sans CJK",
    ]);
  });

  it("builtinOnly (Studio isolation) hides uploads entirely", () => {
    const groups = fontPickerGroups(LIST, undefined, { builtinOnly: true });
    expect(groups.mine).toEqual([]);
  });

  it("flags an unoffered current value as missing", () => {
    expect(fontPickerGroups(LIST, "Ghost Grotesk").missing).toBe("Ghost Grotesk");
    // In the Studio, a design referencing MY font is missing by design.
    expect(
      fontPickerGroups(LIST, "Custom Sans", { builtinOnly: true }).missing,
    ).toBe("Custom Sans");
  });

  it("does not flag offered values or the implicit default", () => {
    expect(fontPickerGroups(LIST, undefined).missing).toBeNull();
    expect(fontPickerGroups(LIST, "Inter").missing).toBeNull();
    expect(fontPickerGroups(LIST, "Custom Sans").missing).toBeNull();
  });
});

/**
 * Tripwire for canvas↔renderer text drift (lib/canvasText.ts).
 *
 * Two layers of defense:
 * 1. Value assertions — the constants ARE the renderer's tree.ts defaults.
 * 2. Source greps against apps/renderer/src/{tree,fonts}.ts — if the renderer
 *    changes a default (or the mapping), this suite fails and points at the
 *    constant to update, instead of the canvas silently mis-measuring text.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CANVAS_FONT_STACK,
  CANVAS_TEXT_DEFAULTS,
  RENDERER_FONT_FAMILY,
  RENDERER_TEXT_ALIGN_DEFAULT,
  RENDERER_TEXT_COLOR,
  RENDERER_TEXT_FONT_SIZE,
  RENDERER_TEXT_FONT_WEIGHT,
  letterSpacingPx,
  textJustify,
} from "./canvasText";

const rendererSrc = (file: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../renderer/src/${file}`, import.meta.url)),
    "utf8",
  );

describe("canvas text constants (tree.ts textEl defaults)", () => {
  it("pin the renderer's hard defaults", () => {
    expect(RENDERER_FONT_FAMILY).toBe("Inter");
    expect(RENDERER_TEXT_FONT_SIZE).toBe(16);
    expect(RENDERER_TEXT_FONT_WEIGHT).toBe(400);
    expect(RENDERER_TEXT_COLOR).toBe("#000000");
    expect(RENDERER_TEXT_ALIGN_DEFAULT).toBe("left");
  });

  it("CANVAS_TEXT_DEFAULTS carries the pins, Inter-first, chrome-proof", () => {
    expect(CANVAS_FONT_STACK.split(",")[0].trim()).toBe(RENDERER_FONT_FAMILY);
    expect(CANVAS_FONT_STACK).not.toMatch(/geist/i); // chrome font must not leak in
    expect(CANVAS_TEXT_DEFAULTS).toEqual({
      fontFamily: CANVAS_FONT_STACK,
      fontSize: RENDERER_TEXT_FONT_SIZE,
      fontWeight: RENDERER_TEXT_FONT_WEIGHT,
      color: RENDERER_TEXT_COLOR,
      // satori built-ins pinned so Tailwind preflight's 1.5 line-height and
      // any inherited tracking never reach canvas text.
      lineHeight: "normal",
      letterSpacing: "normal",
    });
  });

  it("maps align → justify-content exactly like tree.ts", () => {
    expect(textJustify("left")).toBe("flex-start");
    expect(textJustify("center")).toBe("center");
    expect(textJustify("right")).toBe("flex-end");
  });

  it("formats structured letterSpacing as tree.ts does", () => {
    expect(letterSpacingPx(1)).toBe("1px");
    expect(letterSpacingPx(-0.5)).toBe("-0.5px");
  });
});

describe("renderer source tripwire", () => {
  it("fonts.ts still declares Inter as the default family", () => {
    expect(rendererSrc("fonts.ts")).toContain(
      `DEFAULT_FONT_FAMILY = "${RENDERER_FONT_FAMILY}"`,
    );
  });

  it("tree.ts textEl still uses the pinned defaults and align mapping", () => {
    const tree = rendererSrc("tree.ts");
    expect(tree).toContain(`fontSize: ${RENDERER_TEXT_FONT_SIZE},`);
    expect(tree).toContain(`fontWeight: ${RENDERER_TEXT_FONT_WEIGHT},`);
    expect(tree).toContain(`color: "${RENDERER_TEXT_COLOR}",`);
    expect(tree).toContain('const align = s.align ?? "left"');
    expect(tree).toContain(
      'align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start"',
    );
    expect(tree).toContain("letterSpacing = `${s.letterSpacing}px`");
    // No default lineHeight in tree.ts — the canvas pin of "normal" mirrors
    // satori's own font-metrics default. If the renderer ever sets one, this
    // trips and canvasText.ts must follow.
    expect(tree).not.toMatch(/lineHeight:\s*[\d"']/);
  });
});

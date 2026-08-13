/**
 * Design nodes → satori element tree (architecture.md §5 step 3).
 *
 * Satori supports flexbox + absolute positioning only (no grid, no calc(),
 * no z-index). The canvas is a relatively-positioned root div; every node is
 * an absolutely-positioned child. Stacking order = node order.
 *
 * §5.6 `tw`: nodes and the canvas may carry a Tailwind-subset utility string
 * compiled by @makeitbeauty/twc. Merge order is fixed: hard defaults, then the
 * compiled tw styles, then the node frame, then explicit structured style
 * fields — Inspector edits always win visibly. Compiler warnings surface
 * through the pipeline's warnings channel prefixed with the node id.
 */
import { compileTw } from "@makeitbeauty/twc";

import { DEFAULT_FONT_FAMILY } from "./fonts.js";
import type { Canvas, DesignNode, El, ImageNode, InstanceNode, RectNode, TextNode } from "./types.js";

type Style = Record<string, string | number>;

/**
 * Compile a tw string (when present) into a style object, forwarding compiler
 * warnings prefixed with the owner's id ("canvas" for the canvas itself).
 */
function compiledTw(tw: string | undefined, owner: string, warnings: string[]): Style {
  if (!tw) return {};
  const result = compileTw(tw);
  for (const w of result.warnings) warnings.push(`${owner}: ${w}`);
  return result.style;
}

/** Shared absolute-positioning frame for every node. Always beats tw. */
function baseStyle(node: DesignNode): Style {
  const style: Style = {
    position: "absolute",
    left: node.x,
    top: node.y,
    width: node.w,
    height: node.h,
  };
  if (node.opacity !== undefined) style.opacity = node.opacity;
  if (node.rotation) style.transform = `rotate(${node.rotation}deg)`;
  return style;
}

function textEl(node: TextNode, warnings: string[], families?: ReadonlySet<string>): El {
  const s = node.style ?? {};
  const align = s.align ?? "left";
  const justify = align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start";

  // Explicit structured fields only — these override tw (§5.6 merge order).
  const structured: Style = {};
  if (s.fontFamily !== undefined) {
    // Unknown families never reach satori (its silent fallback would pick an
    // arbitrary loaded font): warn and render the default face instead.
    // `families` holds lowercased names of every font loaded for THIS request
    // (built-ins + request fonts) — CSS family matching is case-insensitive.
    if (families !== undefined && !families.has(s.fontFamily.toLowerCase())) {
      warnings.push(
        `${node.id}: unknown font family "${s.fontFamily}" — falling back to ${DEFAULT_FONT_FAMILY}`,
      );
      structured.fontFamily = DEFAULT_FONT_FAMILY;
    } else {
      structured.fontFamily = s.fontFamily;
    }
  }
  if (s.fontSize !== undefined) structured.fontSize = s.fontSize;
  if (s.fontWeight !== undefined) structured.fontWeight = s.fontWeight;
  if (s.color !== undefined) structured.color = s.color;
  if (s.lineHeight !== undefined) structured.lineHeight = s.lineHeight;
  if (s.letterSpacing !== undefined) structured.letterSpacing = `${s.letterSpacing}px`;

  return {
    type: "div",
    props: {
      style: {
        // defaults < tw < frame < structured
        fontFamily: DEFAULT_FONT_FAMILY,
        fontSize: 16,
        fontWeight: 400,
        color: "#000000",
        ...compiledTw(node.tw, node.id, warnings), // padding applies to the text box
        ...baseStyle(node),
        display: "flex",
        justifyContent: justify,
        textAlign: align,
        ...structured,
      },
      children: node.text,
    },
  };
}

function rectEl(node: RectNode, warnings: string[]): El {
  const s = node.style ?? {};

  const structured: Style = {};
  if (s.fill !== undefined) structured.backgroundColor = s.fill;
  if (s.radius !== undefined) structured.borderRadius = s.radius;
  if (s.stroke && s.strokeWidth) {
    // Longhands (matching the twc compiler's output) so a structured stroke
    // deterministically overrides tw border classes.
    structured.borderWidth = `${s.strokeWidth}px`;
    structured.borderStyle = "solid";
    structured.borderColor = s.stroke;
  }

  return {
    type: "div",
    props: {
      style: {
        backgroundColor: "transparent",
        ...compiledTw(node.tw, node.id, warnings), // gradients land on backgroundImage
        ...baseStyle(node),
        ...structured,
      },
    },
  };
}

function imageEl(node: ImageNode, warnings: string[]): El {
  const structured: Style = {};
  if (node.radius !== undefined) structured.borderRadius = node.radius;
  const style: Style = {
    ...compiledTw(node.tw, node.id, warnings),
    ...baseStyle(node),
    objectFit: node.fit ?? "cover",
    ...structured,
  };
  // src is a data: URI by schema; the sanitizer re-checks the final output.
  return { type: "img", props: { src: node.src, style } };
}

/**
 * v0 placeholder: instances render as a labeled dashed outline until the kit
 * expands them. tw on an instance applies to nothing yet — the pipeline warns
 * before expansion; the placeholder ignores it too.
 */
function instanceEl(node: InstanceNode): El {
  return {
    type: "div",
    props: {
      style: {
        ...baseStyle(node),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "2px dashed #8b949e",
        borderRadius: 6,
        color: "#8b949e",
        fontFamily: DEFAULT_FONT_FAMILY,
        fontSize: 12,
      },
      children: node.component,
    },
  };
}

export function buildNode(
  node: DesignNode,
  warnings: string[] = [],
  families?: ReadonlySet<string>,
): El {
  switch (node.type) {
    case "text":
      return textEl(node, warnings, families);
    case "rect":
      return rectEl(node, warnings);
    case "image":
      return imageEl(node, warnings);
    case "instance":
      return instanceEl(node);
  }
}

/**
 * Canvas root. `transparent: true` is used for per-animated-node passes so the
 * layer composites cleanly over the static base (same canvas geometry, no
 * fill) — canvas tw is skipped there too, otherwise a tw background gradient
 * would repaint on every animated layer (and its warnings would duplicate).
 */
export function buildCanvas(
  canvas: Canvas,
  children: El[],
  transparent = false,
  warnings: string[] = [],
): El {
  const structured: Style = {};
  if (canvas.background !== undefined) structured.backgroundColor = canvas.background;
  if (canvas.radius !== undefined) structured.borderRadius = canvas.radius;

  const style: Style = transparent
    ? { backgroundColor: "transparent" }
    : {
        backgroundColor: "transparent",
        ...compiledTw(canvas.tw, "canvas", warnings),
        ...structured,
      };
  style.display = "flex";
  style.position = "relative";
  style.width = canvas.width;
  style.height = canvas.height;
  return { type: "div", props: { style, children } };
}

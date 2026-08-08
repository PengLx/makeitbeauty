/**
 * Design nodes → satori element tree (architecture.md §5 step 3).
 *
 * Satori supports flexbox + absolute positioning only (no grid, no calc(),
 * no z-index). The canvas is a relatively-positioned root div; every node is
 * an absolutely-positioned child. Stacking order = node order.
 */
import { DEFAULT_FONT_FAMILY } from "./fonts.js";
import type { Canvas, DesignNode, El, ImageNode, InstanceNode, RectNode, TextNode } from "./types.js";

/** Shared absolute-positioning frame for every node. */
function baseStyle(node: DesignNode): Record<string, string | number> {
  const style: Record<string, string | number> = {
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

function textEl(node: TextNode): El {
  const s = node.style ?? {};
  const align = s.align ?? "left";
  const justify = align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start";
  return {
    type: "div",
    props: {
      style: {
        ...baseStyle(node),
        display: "flex",
        justifyContent: justify,
        textAlign: align,
        fontFamily: s.fontFamily ?? DEFAULT_FONT_FAMILY,
        fontSize: s.fontSize ?? 16,
        fontWeight: s.fontWeight ?? 400,
        color: s.color ?? "#000000",
        ...(s.lineHeight !== undefined ? { lineHeight: s.lineHeight } : {}),
        ...(s.letterSpacing !== undefined ? { letterSpacing: `${s.letterSpacing}px` } : {}),
      },
      children: node.text,
    },
  };
}

function rectEl(node: RectNode): El {
  const s = node.style ?? {};
  const style: Record<string, string | number> = {
    ...baseStyle(node),
    backgroundColor: s.fill ?? "transparent",
  };
  if (s.radius !== undefined) style.borderRadius = s.radius;
  if (s.stroke && s.strokeWidth) style.border = `${s.strokeWidth}px solid ${s.stroke}`;
  return { type: "div", props: { style } };
}

function imageEl(node: ImageNode): El {
  const style: Record<string, string | number> = {
    ...baseStyle(node),
    objectFit: node.fit ?? "cover",
  };
  if (node.radius !== undefined) style.borderRadius = node.radius;
  // src is a data: URI by schema; the sanitizer re-checks the final output.
  return { type: "img", props: { src: node.src, style } };
}

/** v0 placeholder: instances render as a labeled dashed outline until the kit lands. */
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

export function buildNode(node: DesignNode): El {
  switch (node.type) {
    case "text":
      return textEl(node);
    case "rect":
      return rectEl(node);
    case "image":
      return imageEl(node);
    case "instance":
      return instanceEl(node);
  }
}

/**
 * Canvas root. `transparent: true` is used for per-animated-node passes so the
 * layer composites cleanly over the static base (same canvas geometry, no fill).
 */
export function buildCanvas(canvas: Canvas, children: El[], transparent = false): El {
  const style: Record<string, string | number> = {
    display: "flex",
    position: "relative",
    width: canvas.width,
    height: canvas.height,
    backgroundColor: transparent ? "transparent" : canvas.background ?? "transparent",
  };
  if (!transparent && canvas.radius !== undefined) style.borderRadius = canvas.radius;
  return { type: "div", props: { style, children } };
}

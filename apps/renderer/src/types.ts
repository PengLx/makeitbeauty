/**
 * TypeScript mirror of packages/schema/design.schema.json (v0).
 * The schema is the contract; these types exist so the pipeline is
 * strictly typed after ajv has validated the input.
 */

export type AnimationPreset =
  | "fadeIn"
  | "pulse"
  | "float"
  | "growX"
  | "growY"
  | "slideUp"
  | "slideLeft"
  | "blink";

export interface Animation {
  preset: AnimationPreset;
  delayMs?: number;
  durationMs?: number;
  loop?: boolean;
}

export interface NodeBase {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  opacity?: number;
  rotation?: number;
  animation?: Animation;
  /** Tailwind-subset utility string (§5.6) — compiled by @makeitbeauty/twc; structured style fields override it. */
  tw?: string;
}

export interface TextNode extends NodeBase {
  type: "text";
  text: string;
  style?: {
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
    color?: string;
    align?: "left" | "center" | "right";
    lineHeight?: number;
    letterSpacing?: number;
  };
}

export interface RectNode extends NodeBase {
  type: "rect";
  style?: {
    fill?: string;
    radius?: number;
    stroke?: string;
    strokeWidth?: number;
  };
}

export interface ImageNode extends NodeBase {
  type: "image";
  src: string; // data: URI only (schema-enforced)
  fit?: "contain" | "cover" | "fill";
  radius?: number;
}

export interface InstanceNode extends NodeBase {
  type: "instance";
  component: string; // e.g. "kit/stat-card"
  props?: Record<string, unknown>;
}

export type DesignNode = TextNode | RectNode | ImageNode | InstanceNode;

export interface Canvas {
  width: number;
  height: number;
  background?: string;
  radius?: number;
  /** Tailwind-subset utility string (§5.6) — e.g. a background gradient on the root. */
  tw?: string;
}

export interface Design {
  version: 0;
  name?: string;
  canvas: Canvas;
  nodes: DesignNode[];
}

export interface RenderOptions {
  theme?: "auto" | "light" | "dark";
}

/** Satori-compatible element tree node (we do not use JSX). */
export interface El {
  type: string;
  props: {
    style?: Record<string, string | number>;
    children?: El[] | string;
    src?: string;
  };
}

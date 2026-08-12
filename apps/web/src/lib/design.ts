/**
 * TypeScript view of packages/schema/design.schema.json (v0).
 *
 * The editor mutates plain objects of these shapes; the API re-validates
 * against the JSON Schema on every preview/render, so these types are a
 * convenience, not a security boundary.
 */

// Keep in sync with packages/schema/design.schema.json $defs.animation.preset
// and the renderer's preset registry (apps/renderer/src/animate.ts).
export type AnimationPreset =
  | "fadeIn"
  | "pulse"
  | "float"
  | "growX"
  | "growY"
  | "slideUp"
  | "slideLeft"
  | "blink";

/** Preset list for the Inspector dropdown, with a short effect hint. */
export const ANIMATION_PRESETS: { value: AnimationPreset; hint: string }[] = [
  { value: "fadeIn", hint: "fade in" },
  { value: "pulse", hint: "opacity pulse (loop it)" },
  { value: "float", hint: "gentle vertical float (loop it)" },
  { value: "growX", hint: "grow from the left" },
  { value: "growY", hint: "grow from the bottom" },
  { value: "slideUp", hint: "slide up + fade in" },
  { value: "slideLeft", hint: "slide left + fade in" },
  { value: "blink", hint: "terminal-cursor blink (loop it)" },
];

export interface DesignAnimation {
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
  animation?: DesignAnimation;
  /**
   * Tailwind-subset utility string compiled by @makeitbeauty/twc (§5.6).
   * Compiles first; explicit structured style fields override it.
   */
  tw?: string;
}

export type TextAlign = "left" | "center" | "right";
export type FontWeight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;

export interface TextStyle {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: FontWeight;
  color?: string;
  align?: TextAlign;
  lineHeight?: number;
  letterSpacing?: number;
}

export interface TextNode extends NodeBase {
  type: "text";
  text: string;
  style?: TextStyle;
}

export interface RectStyle {
  fill?: string;
  radius?: number;
  stroke?: string;
  strokeWidth?: number;
}

export interface RectNode extends NodeBase {
  type: "rect";
  style?: RectStyle;
}

export type ImageFit = "contain" | "cover" | "fill";

export interface ImageNode extends NodeBase {
  type: "image";
  src: string;
  fit?: ImageFit;
  radius?: number;
}

export interface InstanceNode extends NodeBase {
  type: "instance";
  component: string;
  props?: Record<string, unknown>;
}

export type DesignNode = TextNode | RectNode | ImageNode | InstanceNode;

export interface DesignCanvasSpec {
  width: number;
  height: number;
  background?: string;
  radius?: number;
  /** Canvas-level tw string (§5.6) — same semantics as NodeBase.tw. */
  tw?: string;
}

export interface DesignDoc {
  version: 0;
  name?: string;
  canvas: DesignCanvasSpec;
  nodes: DesignNode[];
}

/** Node boxes can never shrink below this (matches the canvas resize handles). */
export const MIN_NODE_SIZE = 8;

/**
 * Loose structural check so the Code tab only promotes JSON that plausibly is
 * a design document. The API's JSON Schema validation is the real gate.
 */
export function isDesignDoc(v: unknown): v is DesignDoc {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    d.version === 0 &&
    typeof d.canvas === "object" &&
    d.canvas !== null &&
    Array.isArray(d.nodes)
  );
}

/**
 * Immutably replace the node with `id` by applying `patch` over it.
 * Keys patched to `undefined` are dropped (e.g. removing an animation), so
 * the document serializes clean in the Code tab.
 */
export function updateNode(
  design: DesignDoc,
  id: string,
  patch: Partial<DesignNode>,
): DesignDoc {
  return {
    ...design,
    nodes: design.nodes.map((n) => {
      if (n.id !== id) return n;
      const merged = { ...n, ...patch } as unknown as Record<string, unknown>;
      for (const key of Object.keys(merged)) {
        if (merged[key] === undefined) delete merged[key];
      }
      return merged as unknown as DesignNode;
    }),
  };
}

export function removeNode(design: DesignDoc, id: string): DesignDoc {
  return { ...design, nodes: design.nodes.filter((n) => n.id !== id) };
}

export function addNode(design: DesignDoc, node: DesignNode): DesignDoc {
  return { ...design, nodes: [...design.nodes, node] };
}

export function findNode(design: DesignDoc, id: string | null): DesignNode | null {
  if (id == null) return null;
  return design.nodes.find((n) => n.id === id) ?? null;
}

/**
 * Smallest unused `${prefix}-N` id (schema: must start with a letter,
 * [a-zA-Z0-9_-]* after). Prefixes derived from component ids like
 * "kit/stat-card" must be slash-stripped by the caller.
 */
export function nextNodeId(design: DesignDoc, prefix: string): string {
  const taken = new Set(design.nodes.map((n) => n.id));
  for (let i = 1; ; i++) {
    const candidate = `${prefix}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Center a w×h box on the canvas, clamped to non-negative integer coords. */
export function centeredPosition(
  canvas: DesignCanvasSpec,
  w: number,
  h: number,
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.round((canvas.width - w) / 2)),
    y: Math.max(0, Math.round((canvas.height - h) / 2)),
  };
}

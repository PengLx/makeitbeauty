/**
 * Animation compositing (architecture.md §5 step 4).
 *
 * Satori output is flattened/anonymous, so animated nodes are rendered in
 * separate passes (transparent background, same canvas) and composed as
 * <g id="node-{id}"> layers over the static base. One injected <style> block
 * carries only the @keyframes for presets actually used, guarded by
 * prefers-reduced-motion. Everything here is pure and deterministic:
 * no timestamps, no randomness, ordering follows node order.
 */
import type { Animation, AnimationPreset, Canvas, DesignNode } from "./types.js";

/**
 * Stable emission order for keyframes blocks. New presets are strictly
 * APPENDED: the emitted CSS for a design using only the original trio must
 * stay byte-identical (renders are deterministic; Actions diff outputs).
 */
const PRESET_ORDER: AnimationPreset[] = [
  "fadeIn",
  "pulse",
  "float",
  "growX",
  "growY",
  "slideUp",
  "slideLeft",
  "blink",
];

const KEYFRAMES: Record<AnimationPreset, string> = {
  fadeIn: "@keyframes mib-fadeIn{from{opacity:0}to{opacity:1}}",
  pulse: "@keyframes mib-pulse{0%,100%{opacity:1}50%{opacity:0.55}}",
  float: "@keyframes mib-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}",
  growX: "@keyframes mib-growX{from{transform:scaleX(0)}to{transform:scaleX(1)}}",
  growY: "@keyframes mib-growY{from{transform:scaleY(0)}to{transform:scaleY(1)}}",
  slideUp:
    "@keyframes mib-slideUp{from{transform:translateY(8px);opacity:0}to{transform:none;opacity:1}}",
  slideLeft:
    "@keyframes mib-slideLeft{from{transform:translateX(8px);opacity:0}to{transform:none;opacity:1}}",
  // step-end timing lives INSIDE the keyframes (per-keyframe timing function)
  // so the hard on/off cut survives the ease-in-out set on the layer itself.
  blink:
    "@keyframes mib-blink{0%{opacity:1;animation-timing-function:step-end}" +
    "50%{opacity:0;animation-timing-function:step-end}100%{opacity:1}}",
};

/**
 * The frame of one animated layer in canvas coordinates: a plain node's own
 * {x,y,w,h}, or the instance node's frame for a grouped layer. Nodes expanded
 * out of instances carry post-scale/offset geometry, so these are always
 * final view-box user units.
 */
export interface LayerFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Format a user-unit coordinate: round to 2 decimals (kills float noise), deterministic. */
function px(n: number): string {
  return `${Math.round(n * 100) / 100}px`;
}

/**
 * Absolute per-layer transform-origin for scale presets, in view-box user
 * units (undefined for presets that need none — opacity presets and the pure
 * translates slideUp/slideLeft are origin-independent).
 *
 * Why absolute instead of `transform-box:fill-box` + a relative origin: every
 * animated layer is a full-canvas satori pass, and satori emits a full-canvas
 * transparent background <rect> for the pass's root div. That rect is rendered
 * geometry, so it inflates the composed <g>'s fill-box bounding box to the
 * whole canvas and a "left center" origin lands on the canvas edge — a bar at
 * x=300 then scales in from x=0, visually entering from outside the component.
 * Compose time knows every layer's exact frame, so we pin the origin to it in
 * user units (the SVG CSS default transform-box is view-box, where px values
 * are user units from the view-box origin). This also sidesteps WebKit
 * fill-box quirks entirely.
 */
export function transformOrigin(preset: AnimationPreset, frame: LayerFrame): string | undefined {
  switch (preset) {
    case "growX":
      return `${px(frame.x)} ${px(frame.y + frame.h / 2)}`; // left center: bar grows out rightwards
    case "growY":
      return `${px(frame.x + frame.w / 2)} ${px(frame.y + frame.h)}`; // center bottom: column grows upwards
    default:
      return undefined;
  }
}

export interface SplitNodes {
  staticNodes: DesignNode[];
  animatedNodes: DesignNode[];
}

/** Partition nodes into the single static pass vs one pass per animated node. */
export function splitNodes(nodes: DesignNode[]): SplitNodes {
  const staticNodes: DesignNode[] = [];
  const animatedNodes: DesignNode[] = [];
  for (const node of nodes) (node.animation ? animatedNodes : staticNodes).push(node);
  return { staticNodes, animatedNodes };
}

/**
 * Several nodes that animate together as ONE composed layer — produced by
 * instance expansion when the instance itself carries an animation
 * (architecture.md §5.7: the expanded group is one <g id="node-{instanceId}">).
 */
export interface NodeGroup {
  kind: "group";
  id: string;
  animation: Animation;
  /** The instance node's frame — the whole group scales/slides around it. */
  frame: LayerFrame;
  nodes: DesignNode[];
}

/** Pipeline item after instance expansion: a plain node, or an animated group. */
export type RenderItem = DesignNode | NodeGroup;

/** One transparent satori pass composed as one <g id="node-{id}"> layer. */
export interface LayerSpec {
  id: string;
  animation: Animation;
  /** Layer frame in canvas coordinates — anchors transform-origin for scale presets. */
  frame: LayerFrame;
  nodes: DesignNode[];
}

export interface SplitRenderItems {
  staticNodes: DesignNode[];
  layers: LayerSpec[];
}

/**
 * Group-aware generalization of splitNodes: plain nodes keep the existing
 * per-node behavior (each animated node is its own single-node layer), while
 * a NodeGroup becomes one multi-node layer. Ordering follows item order.
 */
export function splitRenderItems(items: RenderItem[]): SplitRenderItems {
  const staticNodes: DesignNode[] = [];
  const layers: LayerSpec[] = [];
  for (const item of items) {
    if ("kind" in item) {
      layers.push({ id: item.id, animation: item.animation, frame: item.frame, nodes: item.nodes });
    } else if (item.animation) {
      const { x, y, w, h } = item;
      layers.push({ id: item.id, animation: item.animation, frame: { x, y, w, h }, nodes: [item] });
    } else {
      staticNodes.push(item);
    }
  }
  return { staticNodes, layers };
}

/** Remove satori's outer <svg …>…</svg> wrapper, keeping the inner markup. */
export function stripSvgWrapper(svg: string): string {
  const match = svg.match(/^\s*<svg[^>]*>([\s\S]*)<\/svg>\s*$/);
  if (!match) throw new Error("unexpected satori output: missing <svg> wrapper");
  return match[1];
}

/**
 * Per-node inline animation timing. Defaults follow design.schema.json:
 * durationMs 800, delayMs 0, loop false — designs opt into looping with an
 * explicit `loop: true` (typical for pulse/float).
 */
export function animationStyle(anim: Animation): string {
  const durationMs = anim.durationMs ?? 800;
  const delayMs = anim.delayMs ?? 0;
  const loop = anim.loop ?? false;
  return (
    `animation-duration:${durationMs}ms;` +
    `animation-delay:${delayMs}ms;` +
    `animation-iteration-count:${loop ? "infinite" : 1};` +
    "animation-timing-function:ease-in-out;" +
    "animation-fill-mode:both"
  );
}

/**
 * <style> block with only the used presets. animation-name is assigned inside
 * the media query, so reduced-motion users get a fully static image.
 */
export function buildStyleBlock(presets: Iterable<AnimationPreset>): string {
  const usedSet = new Set(presets);
  const used = PRESET_ORDER.filter((p) => usedSet.has(p));
  if (used.length === 0) return "";
  // Classes carry only animation-name. Scale presets get their transform-origin
  // per layer, inline (see transformOrigin) — never here, where one shared class
  // could not know any layer's frame.
  const classes = used.map((p) => `.mib-${p}{animation-name:mib-${p}}`).join("");
  const frames = used.map((p) => KEYFRAMES[p]).join("");
  return `<style>@media (prefers-reduced-motion: no-preference){${classes}${frames}}</style>`;
}

export interface AnimatedLayer {
  /** The animated node — or, for an expanded instance group, its id + animation. */
  node: Pick<DesignNode, "id" | "animation">;
  /** Layer frame in canvas coordinates — anchors transform-origin for scale presets. */
  frame: LayerFrame;
  /** Inner SVG markup of this layer's transparent satori pass (wrapper stripped). */
  inner: string;
}

/**
 * Each satori pass numbers its internal ids (clip paths, defs) from scratch,
 * so independently rendered layers would collide once composed into one
 * document. Prefix every id — and every url(#)/href="#" reference to one —
 * with a deterministic per-layer namespace. Satori emits double-quoted
 * attributes, which is all this needs to handle.
 */
export function namespaceIds(markup: string, prefix: string): string {
  return markup
    .replace(/\bid="([^"]*)"/g, (_m, id: string) => `id="${prefix}${id}"`)
    .replace(/url\(#([^)]*)\)/g, (_m, id: string) => `url(#${prefix}${id})`)
    .replace(/\bhref="#([^"]*)"/g, (_m, id: string) => `href="#${prefix}${id}"`);
}

/** Compose the final SVG: base layer + one <g> per animated node + style block. */
export function composeSvg(canvas: Canvas, baseInner: string, layers: AnimatedLayer[]): string {
  const { width, height } = canvas;
  const groups = layers
    .map(({ node, frame, inner }) => {
      const anim = node.animation;
      if (!anim) throw new Error(`node "${node.id}" in animated layer without animation`);
      const origin = transformOrigin(anim.preset, frame);
      const style = animationStyle(anim) + (origin ? `;transform-origin:${origin}` : "");
      return (
        `<g id="node-${node.id}" class="mib-${anim.preset}" style="${style}">` +
        `${namespaceIds(inner, `mib-${node.id}-`)}</g>`
      );
    })
    .join("");
  const style = buildStyleBlock(layers.map((l) => l.node.animation!.preset));
  return (
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ` +
    `xmlns="http://www.w3.org/2000/svg">${namespaceIds(baseInner, "mib-base-")}${groups}${style}</svg>`
  );
}

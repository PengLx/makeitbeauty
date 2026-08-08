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

/** Stable emission order for keyframes blocks. */
const PRESET_ORDER: AnimationPreset[] = ["fadeIn", "pulse", "float"];

const KEYFRAMES: Record<AnimationPreset, string> = {
  fadeIn: "@keyframes mib-fadeIn{from{opacity:0}to{opacity:1}}",
  pulse: "@keyframes mib-pulse{0%,100%{opacity:1}50%{opacity:0.55}}",
  float: "@keyframes mib-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}",
};

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
  const classes = used.map((p) => `.mib-${p}{animation-name:mib-${p}}`).join("");
  const frames = used.map((p) => KEYFRAMES[p]).join("");
  return `<style>@media (prefers-reduced-motion: no-preference){${classes}${frames}}</style>`;
}

export interface AnimatedLayer {
  node: DesignNode;
  /** Inner SVG markup of this node's transparent satori pass (wrapper stripped). */
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
    .map(({ node, inner }) => {
      const anim = node.animation;
      if (!anim) throw new Error(`node "${node.id}" in animated layer without animation`);
      return (
        `<g id="node-${node.id}" class="mib-${anim.preset}" style="${animationStyle(anim)}">` +
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

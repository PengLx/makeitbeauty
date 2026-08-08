/**
 * Render pipeline orchestration (architecture.md §5).
 * (design, data, options) → { svg, warnings }. Pure given its inputs — the
 * output is deterministic (byte-identical for identical input), which lets
 * the GitHub Action skip commits when nothing changed.
 */
import satori from "satori";

import { composeSvg, splitNodes, stripSvgWrapper, type AnimatedLayer } from "./animate.js";
import type { LoadedFont } from "./fonts.js";
import { sanitizeSvg } from "./sanitize.js";
import { resolveNodeTemplates } from "./template.js";
import { buildCanvas, buildNode } from "./tree.js";
import type { Design, DesignNode, RenderOptions } from "./types.js";

export interface RenderResult {
  svg: string;
  warnings: string[];
}

export async function render(
  design: Design,
  data: Record<string, unknown>,
  fonts: LoadedFont[],
  _options: RenderOptions = {}, // theme: reserved for v1 (auto/light/dark output variants)
): Promise<RenderResult> {
  const warnings: string[] = [];

  // Step 2: resolve {{path}} bindings (missing paths warn, never fail).
  const resolved: DesignNode[] = design.nodes.map((node) => {
    const r = resolveNodeTemplates(node, data);
    warnings.push(...r.warnings);
    return r.value;
  });

  // Step 3+4: one satori pass for the static set (canvas background included),
  // one transparent pass per animated node on the same canvas geometry.
  const { staticNodes, animatedNodes } = splitNodes(resolved);
  const satoriOptions = {
    width: design.canvas.width,
    height: design.canvas.height,
    fonts,
    embedFont: true, // text → paths: no client-side font dependency
  };

  const basePass = await satori(
    buildCanvas(design.canvas, staticNodes.map(buildNode)) as never,
    satoriOptions,
  );

  const layers: AnimatedLayer[] = [];
  for (const node of animatedNodes) {
    const pass = await satori(
      buildCanvas(design.canvas, [buildNode(node)], /* transparent */ true) as never,
      satoriOptions,
    );
    layers.push({ node, inner: stripSvgWrapper(pass) });
  }

  const svg = composeSvg(design.canvas, stripSvgWrapper(basePass), layers);

  // Step 5: security boundary — throws SanitizeError on any violation.
  return { svg: sanitizeSvg(svg), warnings };
}

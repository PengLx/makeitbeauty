/**
 * Render pipeline orchestration (architecture.md §5).
 * (design, data, options) → { svg, warnings }. Pure given its inputs — the
 * output is deterministic (byte-identical for identical input), which lets
 * the GitHub Action skip commits when nothing changed.
 */
import satori from "satori";

import {
  composeSvg,
  splitRenderItems,
  stripSvgWrapper,
  type AnimatedLayer,
  type RenderItem,
} from "./animate.js";
import type { LoadedFont } from "./fonts.js";
import { expandInstance, kitRegistry, mergeComponentRegistry, type KitComponent } from "./kit.js";
import { sanitizeSvg } from "./sanitize.js";
import { resolveNodeTemplates } from "./template.js";
import { buildCanvas, buildNode } from "./tree.js";
import type { Design, RenderOptions } from "./types.js";

export interface RenderResult {
  svg: string;
  warnings: string[];
}

export async function render(
  design: Design,
  data: Record<string, unknown>,
  fonts: LoadedFont[],
  _options: RenderOptions = {}, // theme: reserved for v1 (auto/light/dark output variants)
  components: readonly KitComponent[] = [], // per-request community definitions (§7.5), pre-validated
): Promise<RenderResult> {
  const warnings: string[] = [];
  // Community definitions merge under the built-in kit for THIS request only —
  // kit entries always win and the module-level registry is never mutated, so
  // concurrent renders cannot see each other's components.
  const registry = mergeComponentRegistry(kitRegistry(), components);

  // Step 2: resolve {{path}} bindings (missing paths warn, never fail), then
  // step 7 (§5.7): expand instances BEFORE the static/animated split, so
  // animation compositing and the sanitizer only ever see plain nodes. An
  // animated instance expands to one NodeGroup = one composed layer.
  const items: RenderItem[] = [];
  for (const node of design.nodes) {
    const r = resolveNodeTemplates(node, data);
    warnings.push(...r.warnings);
    if (r.value.type === "instance") {
      const expansion = expandInstance(r.value, registry, data);
      warnings.push(...expansion.warnings);
      items.push(...expansion.items);
    } else {
      items.push(r.value);
    }
  }

  // Step 3+4: one satori pass for the static set (canvas background included),
  // one transparent pass per animated layer on the same canvas geometry.
  const { staticNodes, layers } = splitRenderItems(items);
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

  const animated: AnimatedLayer[] = [];
  for (const layer of layers) {
    const pass = await satori(
      buildCanvas(design.canvas, layer.nodes.map(buildNode), /* transparent */ true) as never,
      satoriOptions,
    );
    animated.push({
      node: { id: layer.id, animation: layer.animation },
      inner: stripSvgWrapper(pass),
    });
  }

  const svg = composeSvg(design.canvas, stripSvgWrapper(basePass), animated);

  // Step 5: security boundary — throws SanitizeError on any violation.
  return { svg: sanitizeSvg(svg), warnings };
}

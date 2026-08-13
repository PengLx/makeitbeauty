/**
 * Local draft expansion for the Component Studio preview.
 *
 * WHY THIS EXISTS: POST /v1/preview accepts only {design, data} — there is no
 * draft-preview route in the §8 contract, and the per-request community
 * definitions (§7.5 render path) are an API↔renderer internal, not exposed to
 * the browser. So the Studio previews a draft by expanding it CLIENT-SIDE
 * into plain nodes with sample prop values substituted, and sends that as an
 * ordinary design. Published components never take this path — designs
 * reference them by pinned id and the server expands them.
 *
 * The transform mirrors apps/renderer/src/kit.ts expandInstance semantics for
 * the exact case the Studio produces — a single instance filling a canvas the
 * same size as the component frame, at (0,0):
 *
 *   s  = min(instance.w / frame.w, instance.h / frame.h) = 1
 *   dx = dy = 0
 *
 * With s = 1 the renderer's scaleAndOffset step is the identity (its fontSize
 * pinning writes 16 where unset, which is satori's default anyway), so the
 * mirrored steps that remain are, in renderer order:
 *
 *   1. deep-copy each fragment node;
 *   2. resolve every {{template}} string against {props} with the standard
 *      engine's exact semantics (template.ts): missing/non-scalar paths warn
 *      and render an em dash — never fail;
 *   3. apply computed geometry: node[field] = clamp(props[prop] × scale,
 *      clamp[0], clamp[1]), in frame coordinates.
 *
 * The shared expansion machinery lives in expandFragment.ts (the canvas's
 * generalized instance expansion); this module keeps the Studio-specific
 * pieces — sample-string prop merging, the "all" template mode (any non-props
 * path warns + em-dashes) and the s = 1 shortcut that skips scaleAndOffset,
 * keeping the expanded design byte-identical to what it always produced.
 *
 * Node ids are kept verbatim (renderer prefixes "{instanceId}__" purely for
 * cross-instance uniqueness; one instance needs none). Node animations pass
 * through untouched — they are part of the component model and the preview
 * design animates them exactly like production will.
 */

import type { DesignDoc } from "./design";
import type { ComponentDefinition, FragmentNode } from "./component";
import { applyComputed, resolveDeep } from "./expandFragment";

/** Background matches the Studio's frame chrome; §7.5 preview design spec. */
export const PREVIEW_BACKGROUND = "#0d1117";

export interface ExpandedPreview {
  design: DesignDoc;
  /** Renderer-style warnings (unresolved templates, bad sample numbers). */
  warnings: string[];
}

/**
 * Merge sample inputs over declared defaults — the renderer's mergeProps
 * contract: number props accept a number or a numeric string, anything else
 * warns and falls back to the declared default; string props stringify.
 * Undeclared samples are ignored (the Studio never produces them; stale keys
 * after a prop rename/delete just fall away).
 */
export function mergeSampleProps(
  def: ComponentDefinition,
  samples: Record<string, string>,
  warnings: string[] = [],
): Record<string, string | number> {
  const merged: Record<string, string | number> = {};
  for (const [name, decl] of Object.entries(def.props)) {
    const raw = samples[name];
    if (raw === undefined) {
      merged[name] = decl.default;
    } else if (decl.type === "number") {
      const num = raw.trim() === "" ? NaN : Number(raw);
      if (Number.isFinite(num)) {
        merged[name] = num;
      } else {
        warnings.push(
          `sample for "${name}" expects a number, got ${JSON.stringify(raw)} — using default ${decl.default}`,
        );
        merged[name] = decl.default;
      }
    } else {
      merged[name] = raw;
    }
  }
  return merged;
}

/**
 * Expand a draft definition into a plain preview design, per the module
 * comment above. Deterministic and pure; the caller memoizes on
 * (definition, samples).
 */
export function expandForPreview(
  def: ComponentDefinition,
  samples: Record<string, string>,
): ExpandedPreview {
  const warnings: string[] = [];
  const props = mergeSampleProps(def, samples, warnings);
  // Studio-authored templates only ever reference props.*; the scope carries
  // nothing else, so any other path warns + em-dashes — the same outcome the
  // publish-time props-only rule enforces, surfaced early.
  const scope = { props };

  const nodes = def.nodes.map((fragment) => {
    const copy = resolveDeep(
      structuredClone(fragment),
      scope,
      warnings,
      "all",
    ) as FragmentNode;

    applyComputed(copy, fragment.id, def.computed, props);

    // scaleAndOffset(copy, s = 1, dx = 0, dy = 0) — identity; skipped.
    return copy;
  });

  return {
    design: {
      version: 0,
      canvas: {
        width: def.frame.w,
        height: def.frame.h,
        background: PREVIEW_BACKGROUND,
      },
      nodes,
    },
    warnings,
  };
}

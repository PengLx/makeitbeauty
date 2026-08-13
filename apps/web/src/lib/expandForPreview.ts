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

/**
 * 32-bit integer hash (a finalizer round of MurmurHash3) — the deterministic
 * "entropy" behind sample-series variations. The sandbox forbids Math.random
 * by construction; the sample bar honours the same rule so the preview stays
 * reproducible: the same randomize-counter always shows the same picture.
 */
export function hash32(x: number): number {
  let h = x | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * A deterministic variation of a declared series default, for the Studio's
 * "randomize sample" button. seed 0 is the identity (the declared default);
 * any other seed varies numeric entries — bare numbers and {count} objects,
 * the §7.6 series shapes — through hash32, leaving everything else (dates,
 * labels, unknown shapes) untouched. Pure: (base, seed) → the same output,
 * always.
 */
export function seriesVariant(base: unknown[], seed: number): unknown[] {
  if (seed === 0) return base;
  const varied = (n: number, h: number): number => {
    if (h % 7 === 0) return 0; // some entries go quiet
    return Math.max(0, Math.round(((h % 100) / 50) * Math.max(n, 1)));
  };
  return base.map((item, i) => {
    const h = hash32(Math.imul(seed, 0x9e3779b1) + i);
    if (typeof item === "number") return varied(item, h);
    if (
      item !== null &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      typeof (item as Record<string, unknown>).count === "number"
    ) {
      return {
        ...(item as Record<string, unknown>),
        count: varied((item as Record<string, number>).count, h),
      };
    }
    return item;
  });
}

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
 *
 * Series props (§7.6) have no text input — their sample IS the declared
 * default array, optionally varied deterministically by `seriesSeeds` (the
 * randomize-sample counter; 0/absent = the default verbatim). In template
 * scopes an array value resolves like production: {{props.x}} of a series
 * warns and em-dashes — only code consumes the raw array.
 */
export function mergeSampleProps(
  def: ComponentDefinition,
  samples: Record<string, string>,
  warnings: string[] = [],
  seriesSeeds: Record<string, number> = {},
): Record<string, string | number | unknown[]> {
  const merged: Record<string, string | number | unknown[]> = {};
  for (const [name, decl] of Object.entries(def.props)) {
    const raw = samples[name];
    if (decl.type === "series") {
      const base = Array.isArray(decl.default) ? decl.default : [];
      merged[name] = seriesVariant(base, seriesSeeds[name] ?? 0);
    } else if (raw === undefined) {
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

/**
 * Wrap a code draft's SANDBOX OUTPUT into the same plain preview design.
 * Mirrors the renderer's expandCodeInstance treatment for the Studio's
 * s = 1 / (0,0) case: output nodes resolve against a PROPS-ONLY scope (§7.6
 * consent — code's output gets no more data than the code itself; any
 * {{connector.*}} a render function emits em-dashes exactly like production),
 * computed is skipped (schema-forbidden for kind "code"), scaleAndOffset is
 * the identity. Output structure is NOT validated here — the design goes
 * through POST /v1/preview, whose renderer-side validation 400s with the
 * author-facing message the error panel surfaces verbatim.
 */
export function wrapCodeNodesForPreview(
  def: ComponentDefinition,
  props: Record<string, unknown>,
  rawNodes: unknown[],
): ExpandedPreview {
  const warnings: string[] = [];
  const nodes = rawNodes.map(
    (raw) => resolveDeep(raw, { props }, warnings, "all") as FragmentNode,
  );
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

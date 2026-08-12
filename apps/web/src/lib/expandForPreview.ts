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
 * Node ids are kept verbatim (renderer prefixes "{instanceId}__" purely for
 * cross-instance uniqueness; one instance needs none). Node animations pass
 * through untouched — they are part of the component model and the preview
 * design animates them exactly like production will.
 */

import type { DesignDoc } from "./design";
import {
  TEMPLATE_RE,
  type ComponentDefinition,
  type FragmentNode,
} from "./component";

/** Renderer placeholder for unresolvable template paths (template.ts). */
const PLACEHOLDER = "—"; // em dash

/** Background matches the Studio's frame chrome; §7.5 preview design spec. */
export const PREVIEW_BACKGROUND = "#0d1117";

export interface ExpandedPreview {
  design: DesignDoc;
  /** Renderer-style warnings (unresolved templates, bad sample numbers). */
  warnings: string[];
}

/** Dot-path lookup; returns undefined for any missing segment (template.ts). */
function lookupPath(data: unknown, path: string): unknown {
  let current: unknown = data;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Substitute every {{path}} in a string — exact template.ts semantics. */
function resolveTemplate(
  input: string,
  data: unknown,
  warnings: string[],
): string {
  return input.replace(TEMPLATE_RE, (_match, path: string) => {
    const found = lookupPath(data, path.trim());
    if (found === undefined || found === null) {
      warnings.push(`unresolved template path "${path.trim()}"`);
      return PLACEHOLDER;
    }
    if (typeof found === "object") {
      warnings.push(`template path "${path.trim()}" resolved to a non-scalar value`);
      return PLACEHOLDER;
    }
    return String(found);
  });
}

/** Recursively resolve templates in every string of a value (template.ts resolveDeep). */
function resolveDeep(value: unknown, data: unknown, warnings: string[]): unknown {
  if (typeof value === "string") return resolveTemplate(value, data, warnings);
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, data, warnings));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveDeep(v, data, warnings)]),
    );
  }
  return value;
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
    ) as FragmentNode;

    for (const entry of def.computed ?? []) {
      if (entry.node !== fragment.id) continue;
      const value = props[entry.prop];
      // mergeSampleProps guarantees a number for number props; a computed
      // entry pointing at a string prop is invalid input — skip, don't NaN.
      if (typeof value !== "number") continue;
      copy[entry.field] = Math.min(
        Math.max(value * entry.scale, entry.clamp[0]),
        entry.clamp[1],
      );
    }

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

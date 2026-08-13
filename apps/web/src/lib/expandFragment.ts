/**
 * Client-side component expansion, generalized from the Studio's
 * expandForPreview so the DESIGN CANVAS can draw instance nodes as their
 * actual content instead of placeholder boxes.
 *
 * This module mirrors apps/renderer/src/kit.ts expandInstance step by step —
 * the renderer stays the truth; every function here is a browser-side
 * approximation of the corresponding renderer step and carries a pointer to
 * it:
 *
 *   1. merge given props over declared defaults      → kit.ts mergeProps
 *   2. deep-copy each fragment node                  → structuredClone
 *   3. resolve {{template}} strings                  → template.ts resolveDeep
 *   4. apply computed geometry (clamped)             → kit.ts expandInstance
 *   5. uniform scale s = min(w/frame.w, h/frame.h),
 *      top-left aligned, offset by instance x/y      → kit.ts scaleAndOffset
 *
 * Two template modes exist because two consumers need different scopes:
 *
 * - "all" (Studio preview + the canvas's live-data display): every path
 *   resolves against the given scope; missing/non-scalar paths warn and
 *   render an em dash — template.ts semantics verbatim. The Studio's scope
 *   carries only {props}, so anything else em-dashes, surfacing the
 *   publish-time props-only rule early. The Editor canvas with connector
 *   data loaded (GET /v1/connectors/data) passes {...data, props} — the
 *   renderer's expandInstance scope — so {{github.*}} shows live values.
 * - "props-only" (canvas without data / Variables display): only {{props.*}}
 *   resolves; any other template ({{github.stars}}, …) stays LITERAL in the
 *   output. With no connector data (signed out, fetch failed, Variables
 *   toggle) showing the raw binding text is honest, not a failure.
 *
 * Node ids are kept verbatim (the renderer prefixes "{instanceId}__" purely
 * for cross-instance uniqueness on one flat canvas; the canvas renders each
 * expansion inside its own instance subtree, where fragment ids are already
 * unique). All pure and deterministic — callers memoize.
 */

import type { ComputedEntry, FragmentNode } from "./component";

/** Renderer placeholder for unresolvable template paths (template.ts). */
export const PLACEHOLDER = "—"; // em dash

/** Mirrors the renderer's template syntax (apps/renderer/src/template.ts). */
const TEMPLATE_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export type TemplateMode = "all" | "props-only";

/**
 * The merged connector data the canvas resolves against — the shape of
 * GET /v1/connectors/data ({"github": {...}}). null means "no data": signed
 * out, fetch failed, or the Variables display toggle is active.
 */
export type ConnectorData = Record<string, unknown> | null;

/** True when a string contains at least one {{...}} template reference. */
export function containsTemplate(value: string): boolean {
  TEMPLATE_RE.lastIndex = 0; // the shared regex is /g — reset between uses
  return TEMPLATE_RE.test(value);
}

/**
 * Resolve a plain (non-instance) text node's content for canvas display.
 * With connector data: template.ts semantics verbatim against that data —
 * exactly what production does to node.text, so {{github.user.login}} shows
 * the live value and a missing path shows the renderer's em dash. Without
 * data the text passes through untouched (templates stay literal).
 * Warnings are discarded: this is display-only — the API preview surfaces
 * render warnings.
 */
export function resolveCanvasText(text: string, data: ConnectorData | undefined): string {
  if (data == null || !containsTemplate(text)) return text;
  return resolveTemplate(text, data, [], "all");
}

/**
 * The minimal definition shape the expansion needs — satisfied by both the
 * Studio's ComponentDefinition and the /v1/kit palette entries (whose prop
 * metadata is looser: `default` is typed unknown there, and absent defaults
 * degrade to ""/0 instead of crashing).
 */
export interface ExpandablePropDecl {
  type: string; // "string" | "number" per the schema
  description?: string;
  default?: unknown; // schema-required; tolerated absent for looser metadata
}

export interface ExpandableDefinition {
  frame: { w: number; h: number };
  props: Record<string, ExpandablePropDecl>;
  nodes: FragmentNode[];
  computed?: ComputedEntry[];
}

/** The box an instance occupies on its canvas (design-node x/y/w/h). */
export interface InstanceFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ExpandedFragment {
  /** Expanded plain nodes in canvas coordinates (offset by the instance x/y). */
  nodes: FragmentNode[];
  /** The uniform scale applied: min(w/frame.w, h/frame.h). */
  scale: number;
  /** Renderer-style warnings (bad prop values, unresolved props templates). */
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

/**
 * Substitute {{path}} occurrences in a string — template.ts semantics for
 * every path the mode resolves; "props-only" leaves other templates literal.
 */
function resolveTemplate(
  input: string,
  data: unknown,
  warnings: string[],
  mode: TemplateMode,
): string {
  return input.replace(TEMPLATE_RE, (match, path: string) => {
    const trimmed = path.trim();
    if (mode === "props-only" && trimmed.split(".")[0] !== "props") {
      return match; // literal — the canvas shows the raw binding text
    }
    const found = lookupPath(data, trimmed);
    if (found === undefined || found === null) {
      warnings.push(`unresolved template path "${trimmed}"`);
      return PLACEHOLDER;
    }
    if (typeof found === "object") {
      warnings.push(`template path "${trimmed}" resolved to a non-scalar value`);
      return PLACEHOLDER;
    }
    return String(found);
  });
}

/** Recursively resolve templates in every string of a value (template.ts resolveDeep). */
export function resolveDeep(
  value: unknown,
  data: unknown,
  warnings: string[],
  mode: TemplateMode,
): unknown {
  if (typeof value === "string") return resolveTemplate(value, data, warnings, mode);
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, data, warnings, mode));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveDeep(v, data, warnings, mode)]),
    );
  }
  return value;
}

/**
 * Merge instance props over declared defaults — the renderer's mergeProps
 * contract (kit.ts): number props accept a number or a numeric string,
 * anything else warns and falls back to the declared default; string props
 * take strings verbatim and stringify number/boolean scalars; non-scalars
 * warn and fall back. Undeclared given props warn and are ignored.
 */
export function mergeInstanceProps(
  def: ExpandableDefinition,
  given: Record<string, unknown>,
  warnings: string[] = [],
): Record<string, string | number> {
  const merged: Record<string, string | number> = {};
  for (const [name, decl] of Object.entries(def.props)) {
    const value = given[name];
    // Loose palette metadata may omit the (schema-required) default; degrade
    // to the type's zero value rather than injecting "undefined" into text.
    const fallback =
      decl.type === "number"
        ? typeof decl.default === "number"
          ? decl.default
          : 0
        : typeof decl.default === "string"
          ? decl.default
          : decl.default === undefined
            ? ""
            : String(decl.default);
    if (value === undefined || value === null) {
      merged[name] = fallback;
    } else if (decl.type === "number") {
      const num =
        typeof value === "number"
          ? value
          : typeof value === "string" && value.trim() !== ""
            ? Number(value)
            : NaN;
      if (Number.isFinite(num)) {
        merged[name] = num;
      } else {
        warnings.push(
          `prop "${name}" expects a number, got ${JSON.stringify(value)} — ` +
            `using default ${String(decl.default)}`,
        );
        merged[name] = fallback;
      }
    } else if (typeof value === "string") {
      merged[name] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      merged[name] = String(value);
    } else {
      warnings.push(`prop "${name}" expects a string, got a non-scalar — using default`);
      merged[name] = fallback;
    }
  }
  for (const name of Object.keys(given)) {
    if (!(name in def.props)) warnings.push(`unknown prop "${name}" — ignored`);
  }
  return merged;
}

/**
 * Apply computed geometry to one expanded node, in frame coordinates (before
 * scaling): node[field] = clamp(props[prop] × scale, clamp[0], clamp[1]) —
 * kit.ts expandInstance. mergeInstanceProps guarantees a number for number
 * props; a computed entry pointing at a string prop is invalid input — skip,
 * don't NaN.
 */
export function applyComputed(
  node: FragmentNode,
  fragmentId: string,
  computed: ComputedEntry[] | undefined,
  props: Record<string, unknown>,
): void {
  for (const entry of computed ?? []) {
    if (entry.node !== fragmentId) continue;
    const value = props[entry.prop];
    if (typeof value !== "number") continue;
    node[entry.field] = Math.min(
      Math.max(value * entry.scale, entry.clamp[0]),
      entry.clamp[1],
    );
  }
}

/**
 * Uniform scale + translate one expanded node in place — an EXACT mirror of
 * apps/renderer/src/kit.ts scaleAndOffset. Positions and sizes multiply by s;
 * so do the visual metrics that must track geometry: fontSize (pinned to
 * satori's 16px default when unset, so it scales too), letterSpacing, radii
 * and strokeWidth.
 */
export function scaleAndOffset(node: FragmentNode, s: number, dx: number, dy: number): void {
  node.x = node.x * s + dx;
  node.y = node.y * s + dy;
  node.w *= s;
  node.h *= s;
  switch (node.type) {
    case "text": {
      const style = (node.style ??= {});
      style.fontSize = (style.fontSize ?? 16) * s;
      if (style.letterSpacing !== undefined) style.letterSpacing *= s;
      break;
    }
    case "rect": {
      if (node.style?.radius !== undefined) node.style.radius *= s;
      if (node.style?.strokeWidth !== undefined) node.style.strokeWidth *= s;
      break;
    }
    case "image": {
      if (node.radius !== undefined) node.radius *= s;
      break;
    }
  }
}

/**
 * Expand a component definition into plain nodes positioned inside (and
 * scaled to) `instanceFrame`, per the module comment — the renderer's
 * expandInstance for one instance, minus id prefixing (ids stay verbatim).
 *
 * `data` selects the template treatment:
 * - null/undefined (Studio, or the Editor without data): "props-only" —
 *   {{props.*}} resolves against the merged props, data templates stay
 *   LITERAL.
 * - connector data (the Editor's live-data display): the renderer's exact
 *   pipeline order — the instance's OWN prop values resolve against `data`
 *   first (template.ts resolveNodeTemplates: a prop bound to
 *   "{{github.user.followers}}" becomes "42" BEFORE number coercion), then
 *   fragments resolve in "all" mode against {...data, props} (kit.ts
 *   expandInstance's scope), so missing paths em-dash like production.
 *
 * The Studio's expandForPreview does NOT route through this function: its
 * proven s = 1 shortcut skips scaleAndOffset entirely (identity except for
 * the fontSize-pin, which writes satori's default anyway), keeping its
 * expanded design byte-identical — it shares the resolve/computed steps
 * instead.
 */
export function expandFragment(
  def: ExpandableDefinition,
  props: Record<string, unknown> | undefined,
  instanceFrame: InstanceFrame,
  data?: ConnectorData,
): ExpandedFragment {
  const warnings: string[] = [];
  const given =
    data == null
      ? (props ?? {})
      : (resolveDeep(props ?? {}, data, warnings, "all") as Record<string, unknown>);
  const merged = mergeInstanceProps(def, given, warnings);
  const mode: TemplateMode = data == null ? "props-only" : "all";
  const scope = data == null ? { props: merged } : { ...data, props: merged };
  const s = Math.min(instanceFrame.w / def.frame.w, instanceFrame.h / def.frame.h);

  const nodes = def.nodes.map((fragment) => {
    const copy = resolveDeep(structuredClone(fragment), scope, warnings, mode) as FragmentNode;
    applyComputed(copy, fragment.id, def.computed, merged);
    scaleAndOffset(copy, s, instanceFrame.x, instanceFrame.y);
    return copy;
  });

  return { nodes, scale: s, warnings };
}

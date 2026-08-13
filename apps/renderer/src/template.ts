/**
 * Binding resolution (architecture.md §5 step 2).
 *
 * `{{path.to.field}}` templates in node text/props are substituted from the
 * connector data snapshot. A missing or non-scalar value produces a warning
 * and an em-dash placeholder — NEVER a render failure. Pure functions.
 */
import type { DesignNode } from "./types.js";

const TEMPLATE_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
/** A string that is EXACTLY one {{path}} template — nothing before or after. */
const SOLE_TEMPLATE_RE = /^\{\{\s*([^{}]+?)\s*\}\}$/;
const PLACEHOLDER = "—"; // em dash

export interface Resolved<T> {
  value: T;
  warnings: string[];
}

/** Dot-path lookup; returns undefined for any missing segment. */
export function lookupPath(data: unknown, path: string): unknown {
  let current: unknown = data;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Substitute every {{path}} in a string against the data snapshot. */
export function resolveTemplate(input: string, data: unknown): Resolved<string> {
  const warnings: string[] = [];
  const value = input.replace(TEMPLATE_RE, (_match, path: string) => {
    const found = lookupPath(data, path);
    if (found === undefined || found === null) {
      warnings.push(`unresolved template path "${path}"`);
      return PLACEHOLDER;
    }
    if (typeof found === "object") {
      warnings.push(`template path "${path}" resolved to a non-scalar value`);
      return PLACEHOLDER;
    }
    return String(found);
  });
  return { value, warnings };
}

/** Recursively resolve templates in every string of an arbitrary value (instance props). */
export function resolveDeep(value: unknown, data: unknown, warnings: string[]): unknown {
  if (typeof value === "string") {
    const r = resolveTemplate(value, data);
    warnings.push(...r.warnings);
    return r.value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, data, warnings));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveDeep(v, data, warnings)]),
    );
  }
  return value;
}

/**
 * resolveDeep for INSTANCE PROPS, with one extra rule for series bindings
 * (§7.6): a string that is a SOLE "{{path}}" template whose path resolves to
 * an ARRAY passes the raw array through untouched — never the em-dash
 * stringification. Resolution here is type-free (the declared prop types live
 * in the component the instance references, looked up later at expansion);
 * kit.ts mergeProps then enforces the declared type: a raw array only ever
 * reaches code via a prop DECLARED "series" — for string/number props it
 * falls back to the declared default with a warning. Everything else behaves
 * exactly like resolveDeep, so non-sole templates ("total: {{path}}") still
 * stringify scalar-only (an array there warns and em-dashes as always).
 *
 * Declarative FRAGMENTS deliberately do not get this treatment (they resolve
 * via resolveDeep): only code components consume series values in v1.
 */
export function resolvePropsDeep(value: unknown, data: unknown, warnings: string[]): unknown {
  if (typeof value === "string") {
    const sole = SOLE_TEMPLATE_RE.exec(value);
    if (sole) {
      const found = lookupPath(data, sole[1].trim());
      if (Array.isArray(found)) return found;
    }
    const r = resolveTemplate(value, data);
    warnings.push(...r.warnings);
    return r.value;
  }
  if (Array.isArray(value)) return value.map((v) => resolvePropsDeep(v, data, warnings));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolvePropsDeep(v, data, warnings)]),
    );
  }
  return value;
}

/** Return a copy of the node with all templated fields resolved. */
export function resolveNodeTemplates(node: DesignNode, data: unknown): Resolved<DesignNode> {
  const warnings: string[] = [];
  switch (node.type) {
    case "text": {
      const r = resolveTemplate(node.text, data);
      return { value: { ...node, text: r.value }, warnings: r.warnings };
    }
    case "instance": {
      const props = node.props
        ? (resolvePropsDeep(node.props, data, warnings) as Record<string, unknown>)
        : undefined;
      return { value: { ...node, props }, warnings };
    }
    default:
      return { value: node, warnings };
  }
}

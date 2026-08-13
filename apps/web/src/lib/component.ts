/**
 * TypeScript view of packages/schema/kit-component.schema.json (v0) plus the
 * community-component id rules from docs/architecture.md §7.5.
 *
 * A user component is the kit-component format with a namespaced id:
 * "{owner}/{name}" while it's a mutable draft, "{owner}/{name}@{n}" once a
 * version is frozen by publishing. The Studio edits these shapes directly;
 * the API/renderer re-validate on publish, so — exactly like lib/design.ts —
 * these types are a convenience, not a security boundary.
 */

import type { DesignNode, InstanceNode } from "./design";

/** Kit fragments may use every design node type except instance (no nesting in v0). */
export type FragmentNode = Exclude<DesignNode, InstanceNode>;

export interface ComponentPropDecl {
  /**
   * "series" (§7.6) declares a JSON-array prop (a contribution calendar,
   * hours per day, …). Only code components consume series values in v1 —
   * a {{props.x}} template of one resolves to the em-dash placeholder.
   */
  type: "string" | "number" | "series";
  description?: string;
  default: string | number | unknown[];
}

/** Schema cap for series defaults (kit-component.schema.json propDecl). */
export const SERIES_MAX_ITEMS = 1024;

/**
 * Source-size cap for kind "code" components — kit-component.schema.json's
 * `code` maxLength, which mirrors the sandbox's maxSourceBytes. Mirrored here
 * (instead of importing @makeitbeauty/sandbox's DEFAULT_LIMITS) so the code
 * editor's counter never drags the ~1.5 MB wasm chunk into the main bundle.
 */
export const CODE_MAX_BYTES = 65536;

/** UTF-8 byte length — the unit both the schema and the sandbox cap in. */
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Parse the Studio's series-default JSON textarea: must parse as JSON to an
 * array of at most SERIES_MAX_ITEMS elements (element shape is unconstrained
 * JSON, per the schema). Returns a typed result instead of throwing so the
 * editor can render inline validation.
 */
export function parseSeriesJson(
  text: string,
): { ok: true; value: unknown[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error: `a series default must be a JSON array (got ${
        parsed === null ? "null" : typeof parsed
      })`,
    };
  }
  if (parsed.length > SERIES_MAX_ITEMS) {
    return {
      ok: false,
      error: `a series default may have at most ${SERIES_MAX_ITEMS} items (got ${parsed.length})`,
    };
  }
  return { ok: true, value: parsed };
}

/** Linear map from a numeric prop onto node geometry (schema: computedEntry). */
export interface ComputedEntry {
  node: string;
  prop: string;
  field: "x" | "y" | "w" | "h";
  scale: number;
  clamp: [number, number];
}

export interface ComponentDefinition {
  /** "{owner}/{name}" for drafts; "{owner}/{name}@{n}" for published versions. */
  id: string;
  title: string;
  description?: string;
  /** Optional palette-menu category slug (schema `category`); absent = none. */
  category?: string;
  /**
   * Component variant (§7.6). Absent means declarative. "code": `code` holds
   * the sandboxed render function and `nodes` is only the optional static
   * palette preview; `computed` is forbidden (compute geometry in render()).
   */
  kind?: "declarative" | "code";
  /** kind "code" only: source of render({ props, frame }) => nodes (≤64 KiB). */
  code?: string;
  frame: { w: number; h: number };
  props: Record<string, ComponentPropDecl>;
  nodes: FragmentNode[];
  computed?: ComputedEntry[];
}

/** True when a definition executes as a sandboxed code component (§7.6). */
export function isCodeDefinition(
  def: Pick<ComponentDefinition, "kind">,
): boolean {
  return def.kind === "code";
}

/** Schema propertyNames pattern for prop declarations. */
export const PROP_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/** Component name slug (the {name} in "{owner}/{name}"), per the §8 contract. */
export const COMPONENT_NAME_RE = /^[a-z0-9-]+$/;

/** Mirrors the renderer's template syntax (apps/renderer/src/template.ts). */
export const TEMPLATE_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** "{owner}/{name}" → its two segments; returns null when not that shape. */
export function splitComponentId(
  id: string,
): { owner: string; name: string } | null {
  const match = /^([a-z0-9-]+)\/([a-z0-9-]+)(?:@[0-9]+)?$/.exec(id);
  if (!match) return null;
  return { owner: match[1], name: match[2] };
}

/** True for instance refs that are NOT the official kit ("kit/…"). */
export function isUserComponentRef(component: string): boolean {
  return !component.startsWith("kit/");
}

/** Loose structural check, same idiom as isDesignDoc (the API is the real gate). */
export function isComponentDefinition(v: unknown): v is ComponentDefinition {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.frame === "object" &&
    d.frame !== null &&
    typeof d.props === "object" &&
    d.props !== null &&
    Array.isArray(d.nodes)
  );
}

/**
 * Everywhere a prop is still referenced: {{props.name}} templates in any
 * string of any node, plus computed entries driven by it. Human-readable
 * locations, used by the props editor's delete warning.
 */
export function propReferences(
  def: ComponentDefinition,
  name: string,
): string[] {
  const refs: string[] = [];
  const scan = (value: unknown, path: string) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(TEMPLATE_RE)) {
        const segments = match[1].trim().split(".");
        if (segments[0] === "props" && segments[1] === name) refs.push(path);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => scan(item, `${path}[${i}]`));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        scan(item, path ? `${path}.${key}` : key);
      }
    }
  };
  for (const node of def.nodes) scan(node, `node "${node.id}"`);
  for (const entry of def.computed ?? []) {
    if (entry.prop === name) {
      refs.push(`computed mapping on node "${entry.node}"`);
    }
  }
  return refs;
}

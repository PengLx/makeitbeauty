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
  type: "string" | "number";
  description?: string;
  default: string | number;
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
  frame: { w: number; h: number };
  props: Record<string, ComponentPropDecl>;
  nodes: FragmentNode[];
  computed?: ComputedEntry[];
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

/**
 * Kit instance expansion (architecture.md §5.7).
 *
 * Kit components are declarative design fragments (packages/kit/components),
 * format pinned by packages/schema/kit-component.schema.json. Components load
 * and ajv-validate once at boot; expansion of an instance node is pure and
 * deterministic: deep-copy fragment nodes → resolve {{props.*}} (and any
 * remaining data templates) → apply computed geometry (clamped) → uniform
 * scale s = min(w/frame.w, h/frame.h) into the instance box (top-left
 * aligned) → offset by instance x/y → prefix node ids with "{instanceId}__".
 * An unknown component id degrades to the dashed placeholder with a warning —
 * never a render failure. Nested instances are rejected at load time (v0).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ajv ships CJS; under NodeNext the class must be imported as a named export,
// and the ajv-formats CJS default needs a type assertion to be callable.
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsExport, { type FormatsPlugin } from "ajv-formats";

const addFormats = addFormatsExport as unknown as FormatsPlugin;

import type { NodeGroup, RenderItem } from "./animate.js";
import { repoPath } from "./paths.js";
import { resolveDeep } from "./template.js";
import type { DesignNode, InstanceNode } from "./types.js";

/** Kit fragments may use every design node type except instance (no nesting in v0). */
export type KitFragmentNode = Exclude<DesignNode, InstanceNode>;

export interface KitProp {
  type: "string" | "number";
  description?: string;
  default: string | number;
}

export interface ComputedEntry {
  node: string;
  prop: string;
  field: "x" | "y" | "w" | "h";
  scale: number;
  clamp: [number, number];
}

/** TypeScript mirror of packages/schema/kit-component.schema.json (v0). */
export interface KitComponent {
  id: string;
  title: string;
  description?: string;
  frame: { w: number; h: number };
  props: Record<string, KitProp>;
  nodes: KitFragmentNode[];
  computed?: ComputedEntry[];
}

/** A kit component failed validation — a boot-time programming error, not user input. */
export class KitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KitError";
  }
}

// The kit schema $refs design.schema.json's node defs by $id, so both schemas
// live in one ajv instance — the fragment format can never drift from designs.
const designSchema = JSON.parse(
  readFileSync(repoPath("packages/schema", "design.schema.json"), "utf8"),
);
const kitSchema = JSON.parse(
  readFileSync(repoPath("packages/schema", "kit-component.schema.json"), "utf8"),
);

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(designSchema);

const validateFn: ValidateFunction<KitComponent> = ajv.compile<KitComponent>(kitSchema);

/**
 * Validate one raw component (schema + semantic checks) or throw KitError.
 * `context` names the source (filename) in error messages.
 */
export function parseKitComponent(raw: unknown, context: string): KitComponent {
  // Ahead of ajv (whose oneOf error is opaque) so the one structural v0 rule
  // gets a clear message.
  const rawNodes = (raw as { nodes?: unknown } | null)?.nodes;
  if (
    Array.isArray(rawNodes) &&
    rawNodes.some((n) => (n as { type?: unknown } | null)?.type === "instance")
  ) {
    throw new KitError(`${context}: nested instance nodes are not supported in kit v0`);
  }

  if (!validateFn(raw)) {
    const errors = (validateFn.errors ?? []).map(
      (e) => `${e.instancePath || "/"}: ${e.message ?? "invalid"}`,
    );
    throw new KitError(`${context}: invalid kit component:\n  ${errors.join("\n  ")}`);
  }
  const component = raw;

  const ids = new Set<string>();
  for (const node of component.nodes) {
    if (ids.has(node.id)) throw new KitError(`${context}: duplicate node id "${node.id}"`);
    ids.add(node.id);
  }
  for (const entry of component.computed ?? []) {
    if (!ids.has(entry.node)) {
      throw new KitError(`${context}: computed references unknown node "${entry.node}"`);
    }
    const decl = component.props[entry.prop];
    if (!decl) {
      throw new KitError(`${context}: computed references undeclared prop "${entry.prop}"`);
    }
    if (decl.type !== "number") {
      throw new KitError(`${context}: computed prop "${entry.prop}" must have type "number"`);
    }
    if (entry.clamp[0] > entry.clamp[1]) {
      throw new KitError(`${context}: computed clamp [${entry.clamp.join(", ")}] has min > max`);
    }
  }
  return component;
}

const COMPONENTS_DIR = repoPath("packages/kit", "components");

/** Load + validate every component in packages/kit/components, keyed "kit/{id}". */
export function loadKitRegistry(dir: string = COMPONENTS_DIR): Map<string, KitComponent> {
  const registry = new Map<string, KitComponent>();
  const filenames = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort(); // sorted for determinism
  for (const filename of filenames) {
    const raw = JSON.parse(readFileSync(join(dir, filename), "utf8"));
    const component = parseKitComponent(raw, filename);
    const key = `kit/${component.id}`;
    if (registry.has(key)) throw new KitError(`${filename}: duplicate component id "${key}"`);
    registry.set(key, component);
  }
  return registry;
}

let cachedRegistry: Map<string, KitComponent> | null = null;

/** The process-wide registry, loaded once (server boot calls this to fail fast). */
export function kitRegistry(): ReadonlyMap<string, KitComponent> {
  cachedRegistry ??= loadKitRegistry();
  return cachedRegistry;
}

export interface Expansion {
  items: RenderItem[];
  warnings: string[];
}

/**
 * Merge instance props over declared defaults. Number props accept a number
 * or a numeric string (a prop bound to connector data arrives as a string);
 * anything else warns and falls back to the declared default.
 */
function mergeProps(
  node: InstanceNode,
  component: KitComponent,
  warnings: string[],
): Record<string, string | number> {
  const given = node.props ?? {};
  const merged: Record<string, string | number> = {};
  for (const [name, decl] of Object.entries(component.props)) {
    const value = given[name];
    if (value === undefined || value === null) {
      merged[name] = decl.default;
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
          `instance "${node.id}": prop "${name}" expects a number, got ` +
            `${JSON.stringify(value)} — using default ${decl.default}`,
        );
        merged[name] = decl.default;
      }
    } else if (typeof value === "string") {
      merged[name] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      merged[name] = String(value);
    } else {
      warnings.push(
        `instance "${node.id}": prop "${name}" expects a string, got a non-scalar — using default`,
      );
      merged[name] = decl.default;
    }
  }
  for (const name of Object.keys(given)) {
    if (!(name in component.props)) {
      warnings.push(`instance "${node.id}": unknown prop "${name}" for ${node.component} — ignored`);
    }
  }
  return merged;
}

/**
 * Uniform scale + translate one expanded node in place. Positions and sizes
 * multiply by s; so do the visual metrics that must track geometry: fontSize
 * (pinned to satori's 16px default when unset, so it scales too),
 * letterSpacing, radii and strokeWidth.
 */
function scaleAndOffset(node: KitFragmentNode, s: number, dx: number, dy: number): void {
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
 * Expand one instance node into plain nodes (architecture.md §5.7). The
 * instance's props are assumed data-resolved already (pipeline step 2); any
 * template remaining in the fragment resolves here against {…data, props},
 * so {{props.*}} slots and direct {{data.path}} references both work. When
 * the instance carries an animation, the expansion is one NodeGroup — the
 * whole component animates as a single composed layer.
 */
export function expandInstance(
  node: InstanceNode,
  registry: ReadonlyMap<string, KitComponent>,
  data: Record<string, unknown>,
): Expansion {
  const component = registry.get(node.component);
  if (!component) {
    // Never fail: the dashed placeholder (tree.ts instanceEl) renders instead.
    return {
      items: [node],
      warnings: [`unknown component "${node.component}" — rendering placeholder`],
    };
  }

  const warnings: string[] = [];
  const props = mergeProps(node, component, warnings);
  const scope = { ...data, props };
  const s = Math.min(node.w / component.frame.w, node.h / component.frame.h);

  const nodes = component.nodes.map((fragment) => {
    // Deep copy, then resolve every templated string (text, colors) with the
    // standard engine — missing paths warn and em-dash, never fail.
    const copy = resolveDeep(structuredClone(fragment), scope, warnings) as KitFragmentNode;

    // Computed geometry, in frame coordinates (before scaling).
    for (const entry of component.computed ?? []) {
      if (entry.node !== fragment.id) continue;
      const value = (props[entry.prop] as number) * entry.scale;
      copy[entry.field] = Math.min(Math.max(value, entry.clamp[0]), entry.clamp[1]);
    }

    scaleAndOffset(copy, s, node.x, node.y);

    // Id-uniqueness across two instances of the same component.
    copy.id = `${node.id}__${fragment.id}`;

    if (node.animation && copy.animation) {
      warnings.push(
        `instance "${node.id}": node "${fragment.id}" animation ignored — ` +
          "an animated instance composes as one layer",
      );
      delete copy.animation;
    }
    return copy;
  });

  if (node.animation) {
    const group: NodeGroup = { kind: "group", id: node.id, animation: node.animation, nodes };
    return { items: [group], warnings };
  }
  return { items: nodes, warnings };
}

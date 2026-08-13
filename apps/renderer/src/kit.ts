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
 *
 * Components whose metadata declares {native: true, dataFields} skip the
 * declarative fragment: a TRUSTED generator (src/native.ts) produces the
 * nodes from (props, data, frame) — see the dispatch inside expandInstance.
 * Community components can never be native (§7.5).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ajv ships CJS; under NodeNext the class must be imported as a named export,
// and the ajv-formats CJS default needs a type assertion to be callable.
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsExport, { type FormatsPlugin } from "ajv-formats";

const addFormats = addFormatsExport as unknown as FormatsPlugin;

import type { NodeGroup, RenderItem } from "./animate.js";
import { connectorSubtree, nativeGenerators } from "./native.js";
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
  /**
   * Official-kit only: a trusted renderer generator produces this component's
   * nodes from (props, data, frame); the declared nodes are the static
   * fallback/palette preview. Community publish validation rejects the flag.
   */
  native?: true;
  /**
   * The connector whose snapshot subtree a native component's dataFields
   * address ("wakatime", "leetcode", "rss"). Absent means "github" — the
   * original native set predates multi-connector natives. Expansion passes
   * the generator exactly data[dataConnector].
   */
  dataConnector?: string;
  /** Connector snapshot paths a native component consumes (e.g. "stats.calendar"). */
  dataFields?: string[];
}

/**
 * A component definition failed validation. For the official kit this is a
 * boot-time programming error; for community definitions (§7.5) it is user
 * input the HTTP layer maps to an error response.
 */
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
 * The one structural v0 rule, checked ahead of ajv (whose oneOf error is
 * opaque) so it gets a clear message.
 */
function assertNoNestedInstance(raw: unknown, context: string): void {
  const rawNodes = (raw as { nodes?: unknown } | null)?.nodes;
  if (
    Array.isArray(rawNodes) &&
    rawNodes.some((n) => (n as { type?: unknown } | null)?.type === "instance")
  ) {
    throw new KitError(`${context}: nested instance nodes are not supported in kit v0`);
  }
}

/**
 * Semantic checks shared by the kit loader and community validation (§7.5):
 * unique node ids + computed integrity (known node, declared number prop,
 * ordered clamp).
 */
function assertComponentSemantics(component: KitComponent, context: string): void {
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
}

/**
 * Validate one raw component (schema + semantic checks) or throw KitError.
 * `context` names the source (filename) in error messages.
 */
export function parseKitComponent(raw: unknown, context: string): KitComponent {
  assertNoNestedInstance(raw, context);

  if (!validateFn(raw)) {
    const errors = (validateFn.errors ?? []).map(
      (e) => `${e.instancePath || "/"}: ${e.message ?? "invalid"}`,
    );
    throw new KitError(`${context}: invalid kit component:\n  ${errors.join("\n  ")}`);
  }
  const component = raw;
  // Native components may omit the static preview entirely ("nodes: [] or
  // absent" — the trusted generator supplies the render nodes); normalize so
  // every downstream consumer sees an array.
  (component as { nodes?: KitFragmentNode[] }).nodes ??= [];
  assertComponentSemantics(component, context);
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

// ---------------------------------------------------------------------------
// Community components (architecture.md §7.5)
//
// A community definition is the same kit-component document with a namespaced
// id — "{owner}/{name}" while a draft is being published, "{owner}/{name}@{n}"
// once pinned inside a render request. The registry stays out of the renderer:
// the API passes every non-kit definition a design references in the render
// request's components[], and they merge with the built-in kit per request.
// ---------------------------------------------------------------------------

/** "{owner}/{name}" with an optional "@{version}" pin (design.schema.json instance refs). */
const COMMUNITY_ID_RE = /^[a-z0-9-]+\/[a-z0-9-]+(@[0-9]+)?$/;

// Same document format, community id shape. The clone keeps the $id in the
// same schema directory so the relative design.v0.json $refs still resolve.
const communitySchema = structuredClone(kitSchema) as {
  $id: string;
  properties: { id: Record<string, unknown> };
};
communitySchema.$id = "https://makeitbeauty.dev/schemas/community-component.v0.json";
communitySchema.properties.id = {
  type: "string",
  pattern: COMMUNITY_ID_RE.source,
  maxLength: 128,
  description:
    'Fully-qualified community component id: "{owner}/{name}" or "{owner}/{name}@{version}".',
};

const validateCommunityFn: ValidateFunction<KitComponent> =
  ajv.compile<KitComponent>(communitySchema);

// Mirrors template.ts TEMPLATE_RE — the exact syntax the engine resolves.
const TEMPLATE_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * §7.5 publish rule: every {{template}} inside a community definition must
 * reference props.* — a component never touches connector data directly; data
 * reaches it only through props the design author binds, which keeps the
 * consent model intact when using other people's components. Throws on the
 * first violation; a reference to an undeclared prop is only a warning (it
 * resolves to the em-dash placeholder at render time).
 */
function checkPropsOnlyTemplates(
  value: unknown,
  path: string,
  component: KitComponent,
  context: string,
  warnings: string[],
): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(TEMPLATE_RE)) {
      const ref = match[1].trim();
      const segments = ref.split(".");
      if (segments[0] !== "props" || segments.length < 2 || segments[1] === "") {
        throw new KitError(
          `${context}: ${path}: template "{{${ref}}}" is not allowed — community component ` +
            `templates may only reference props.* (bind data to a prop in the design instead)`,
        );
      }
      if (!(segments[1] in component.props)) {
        warnings.push(`${context}: ${path}: template references undeclared prop "${segments[1]}"`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) =>
      checkPropsOnlyTemplates(item, `${path}[${i}]`, component, context, warnings),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      checkPropsOnlyTemplates(item, path ? `${path}.${key}` : key, component, context, warnings);
    }
  }
}

export interface CommunityParseOptions {
  /** Render-request definitions must pin a published version ("@{n}"); publish-time drafts need not. */
  requireVersion?: boolean;
}

export interface ParsedCommunityComponent {
  component: KitComponent;
  warnings: string[];
}

/**
 * Validate one community component definition — the full kit-loader suite
 * (ajv schema + nested-instance rejection + unique node ids + computed
 * integrity) PLUS the §7.5 props-only template rule. Throws KitError with the
 * first failure's precise reason. This runs at publish (via
 * POST /internal/validate-component) and again on every render request:
 * defense in depth, the renderer never trusts that the API already checked.
 */
export function parseCommunityComponent(
  raw: unknown,
  context: string,
  options: CommunityParseOptions = {},
): ParsedCommunityComponent {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new KitError(`${context}: definition must be a JSON object`);
  }

  // Id shape ahead of ajv so the most likely mistakes get precise messages.
  const id = (raw as { id?: unknown }).id;
  if (typeof id !== "string" || !COMMUNITY_ID_RE.test(id)) {
    throw new KitError(
      `${context}: id must be "{owner}/{name}" or "{owner}/{name}@{version}" ` +
        `(got ${JSON.stringify(id)})`,
    );
  }
  if (id.startsWith("kit/")) {
    throw new KitError(
      `${context}: the "kit/" namespace is reserved for the official kit (got "${id}")`,
    );
  }
  // Native components are official-kit only: their nodes come from trusted
  // generator code in this service, so a community definition claiming
  // native (or its dataFields/dataConnector companions) is rejected outright
  // — community components stay declarative-only (architecture.md §7.5).
  if ("native" in raw || "dataFields" in raw || "dataConnector" in raw) {
    throw new KitError(
      `${context}: "native"/"dataFields"/"dataConnector" are reserved for the official kit — ` +
        `community components are declarative-only`,
    );
  }
  if (options.requireVersion && !id.includes("@")) {
    throw new KitError(
      `${context}: render-request definitions must pin a published version ` +
        `("{owner}/{name}@{n}", got "${id}")`,
    );
  }

  assertNoNestedInstance(raw, context);

  if (!validateCommunityFn(raw)) {
    const errors = (validateCommunityFn.errors ?? []).map(
      (e) => `${e.instancePath || "/"}: ${e.message ?? "invalid"}`,
    );
    throw new KitError(`${context}: invalid component:\n  ${errors.join("\n  ")}`);
  }
  const component = raw as unknown as KitComponent;
  assertComponentSemantics(component, context);

  const warnings: string[] = [];
  checkPropsOnlyTemplates(component, "", component, context, warnings);
  return { component, warnings };
}

/**
 * Validate a renderRequest's components[] (render.schema.json): each item is
 * a community definition pinned to "{owner}/{name}@{n}", ids unique within
 * the request. Throws KitError on the first violation.
 */
export function parseRequestComponents(raw: unknown): {
  components: KitComponent[];
  warnings: string[];
} {
  if (raw === undefined) return { components: [], warnings: [] };
  if (!Array.isArray(raw)) {
    throw new KitError('"components" must be an array of component definitions');
  }
  const components: KitComponent[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const [i, item] of raw.entries()) {
    const parsed = parseCommunityComponent(item, `components[${i}]`, { requireVersion: true });
    if (seen.has(parsed.component.id)) {
      throw new KitError(`components[${i}]: duplicate definition for "${parsed.component.id}"`);
    }
    seen.add(parsed.component.id);
    components.push(parsed.component);
    warnings.push(...parsed.warnings);
  }
  return { components, warnings };
}

/**
 * Per-request expansion lookup: request definitions (keyed by their fully-
 * qualified id) merged UNDER the built-in kit registry — kit entries always
 * win on a key collision, and the module-level registry is never touched, so
 * concurrent renders stay isolated and deterministic.
 */
export function mergeComponentRegistry(
  kit: ReadonlyMap<string, KitComponent>,
  requestComponents: readonly KitComponent[],
): ReadonlyMap<string, KitComponent> {
  if (requestComponents.length === 0) return kit;
  const merged = new Map<string, KitComponent>();
  for (const component of requestComponents) merged.set(component.id, component);
  for (const [key, component] of kit) merged.set(key, component); // kit wins
  return merged;
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

  // Native components (§5.7): a trusted generator (src/native.ts, keyed by
  // the id without the "kit/" prefix) produces the nodes from (props, data,
  // frame) — array-driven visuals that declarative fragments cannot express.
  // The generator sees ONLY its own connector's snapshot subtree
  // (data[dataConnector], default github — the metadata qualifier added with
  // the multi-connector natives): generators stay connector-relative
  // ("stats.days", never "wakatime.stats.days"), and a missing or non-object
  // subtree degrades to the generator's own empty-state rendering.
  // Generated nodes are frame-relative and flow through the exact same
  // scale/offset/id-prefix treatment as declarative fragments below. No
  // generator registered → fall through to the component's declared static
  // preview nodes (or the dashed placeholder when there are none) with a
  // warning; a throwing generator (contract violation) degrades the same
  // way — never a render failure.
  if (component.native) {
    const generator = nativeGenerators.get(component.id);
    if (generator) {
      try {
        let stripped = false;
        const generated: KitFragmentNode[] = generator({
          props,
          data: connectorSubtree(data, component.dataConnector ?? "github"),
          frame: component.frame,
        }).map((gen) => {
          scaleAndOffset(gen, s, node.x, node.y);
          gen.id = `${node.id}__${gen.id}`;
          if (node.animation && gen.animation) {
            stripped = true;
            delete gen.animation;
          }
          return gen;
        });
        if (stripped) {
          warnings.push(
            `instance "${node.id}": generated node animations ignored — ` +
              "an animated instance composes as one layer",
          );
        }
        if (node.animation) {
          const group: NodeGroup = {
            kind: "group",
            id: node.id,
            animation: node.animation,
            // The layer's transform-origin anchors to the INSTANCE box — the
            // final canvas-space frame, not the fragment-local one.
            frame: { x: node.x, y: node.y, w: node.w, h: node.h },
            nodes: generated,
          };
          return { items: [group], warnings };
        }
        return { items: generated, warnings };
      } catch (err) {
        warnings.push(
          `native component "${node.component}" generator failed ` +
            `(${err instanceof Error ? err.message : String(err)}) — rendering placeholder`,
        );
        return { items: [node], warnings };
      }
    }
    if (component.nodes.length === 0) {
      warnings.push(
        `native component "${node.component}" has no registered generator — rendering placeholder`,
      );
      return { items: [node], warnings };
    }
    warnings.push(
      `native component "${node.component}" has no registered generator — ` +
        "rendering its static preview",
    );
    // …and fall through to the declarative expansion of the preview nodes.
  }

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
    const group: NodeGroup = {
      kind: "group",
      id: node.id,
      animation: node.animation,
      // Layer origin anchors to the instance box (final canvas-space frame).
      frame: { x: node.x, y: node.y, w: node.w, h: node.h },
      nodes,
    };
    return { items: [group], warnings };
  }
  return { items: nodes, warnings };
}

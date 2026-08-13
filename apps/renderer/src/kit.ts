/**
 * Kit instance expansion (architecture.md §5.7, §7.6).
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
 *
 * Components with kind "code" (§7.6) execute their `code` source as a pure
 * render({props, frame}) function inside the capability-less QuickJS-in-WASM
 * sandbox (@makeitbeauty/sandbox) — see expandCodeInstance. Output is nodes,
 * never SVG, and flows through the exact same gates as declarative fragments.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ajv ships CJS; under NodeNext the class must be imported as a named export,
// and the ajv-formats CJS default needs a type assertion to be callable.
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsExport, { type FormatsPlugin } from "ajv-formats";

const addFormats = addFormatsExport as unknown as FormatsPlugin;

import {
  DEFAULT_LIMITS,
  SandboxError,
  compileComponent,
  executeRender,
  sha256Hex,
  type CompileResult,
  type RenderResult as SandboxRenderResult,
} from "@makeitbeauty/sandbox";

import type { NodeGroup, RenderItem } from "./animate.js";
import { BUILTIN_FAMILIES, isBuiltinFamily } from "./fonts.js";
import { connectorSubtree, nativeGenerators, type ResolvedProps } from "./native.js";
import { repoPath } from "./paths.js";
import { resolveDeep } from "./template.js";
import type { DesignNode, InstanceNode } from "./types.js";

/** Kit fragments may use every design node type except instance (no nesting in v0). */
export type KitFragmentNode = Exclude<DesignNode, InstanceNode>;

/**
 * A declared prop slot. "series" (§7.6) declares a JSON-array prop (e.g. a
 * contribution calendar): instance values pass through as RAW arrays (see
 * mergeProps) and only code components consume them in v1 — declarative
 * fragments resolve {{props.x}} of an array to the em-dash placeholder.
 */
export type KitProp =
  | { type: "string"; description?: string; default: string }
  | { type: "number"; description?: string; default: number }
  | { type: "series"; description?: string; default: unknown[] };

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
   * Component variant (§7.6). Absent means "declarative". "code": `code` is
   * required and executes in the sandbox; declared nodes are only the static
   * palette preview; computed and the native family are forbidden.
   */
  kind?: "declarative" | "code";
  /**
   * kind "code" only: JavaScript source defining render({props, frame}) =>
   * text/rect/image nodes, executed in the capability-less QuickJS sandbox
   * under DEFAULT_LIMITS. Deterministic by construction (no Date, no
   * Math.random, no async, fresh context per execution).
   */
  code?: string;
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
 * Variant-shape rules (§7.6), checked ahead of ajv (whose allOf/if errors are
 * opaque) so each violation gets a precise message. kind "code" requires the
 * source, forbids computed (declarative-only — code computes its own
 * geometry) and is mutually exclusive with the native family (a component is
 * trusted-native or sandboxed-code, never both). `code` without kind "code"
 * is rejected too — code never rides along silently on another variant.
 */
function assertKindShape(raw: object, context: string): void {
  const kind = (raw as { kind?: unknown }).kind;
  if (kind === "code") {
    if ("native" in raw || "dataFields" in raw || "dataConnector" in raw) {
      throw new KitError(
        `${context}: kind "code" is mutually exclusive with "native"/"dataFields"/` +
          `"dataConnector" — a component is trusted-native or sandboxed-code, never both`,
      );
    }
    if ("computed" in raw) {
      throw new KitError(
        `${context}: "computed" is declarative-only — a code component computes its ` +
          `geometry inside render()`,
      );
    }
    const code = (raw as { code?: unknown }).code;
    if (typeof code !== "string" || code.length === 0) {
      throw new KitError(
        `${context}: kind "code" requires a non-empty "code" string ` +
          `(the render({props, frame}) function source)`,
      );
    }
  } else if ("code" in raw) {
    throw new KitError(`${context}: "code" requires kind "code"`);
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
  if (raw !== null && typeof raw === "object") assertKindShape(raw, context);

  if (!validateFn(raw)) {
    const errors = (validateFn.errors ?? []).map(
      (e) => `${e.instancePath || "/"}: ${e.message ?? "invalid"}`,
    );
    throw new KitError(`${context}: invalid kit component:\n  ${errors.join("\n  ")}`);
  }
  const component = raw;
  // Native and code components may omit the static preview entirely ("nodes:
  // [] or absent" — the trusted generator / the sandboxed render function
  // supplies the render nodes); normalize so every downstream consumer sees
  // an array.
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

/**
 * Font isolation rule: a community fragment may reference BUILT-IN font
 * families only. User-uploaded fonts are private to their owner's designs —
 * they travel per-request and never publish, so a stranger's component can
 * never carry (or demand) someone's private font. The value must be a
 * literal built-in name: a template here would dodge the check, so it is
 * rejected too (render-time fallback+warning still guards anything that
 * slips through). Kit fragments may use any built-in.
 */
function checkBuiltinFontFamilies(component: KitComponent, context: string): void {
  for (const [i, node] of component.nodes.entries()) {
    if (node.type !== "text" || node.style?.fontFamily === undefined) continue;
    const family = node.style.fontFamily;
    if (!isBuiltinFamily(family)) {
      const builtin = BUILTIN_FAMILIES.map((f) => `"${f.family}"`).join(", ");
      throw new KitError(
        `${context}: nodes[${i}].style.fontFamily ${JSON.stringify(family)} is not a built-in ` +
          `font family — community components may only use the built-ins (${builtin}); ` +
          `user-uploaded fonts stay private to their owner's designs`,
      );
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
  // — community components are declarative or sandboxed code (§7.5, §7.6),
  // never native.
  if ("native" in raw || "dataFields" in raw || "dataConnector" in raw) {
    throw new KitError(
      `${context}: "native"/"dataFields"/"dataConnector" are reserved for the official kit — ` +
        `community components may be declarative or code (kind: "code"), never native`,
    );
  }
  if (options.requireVersion && !id.includes("@")) {
    throw new KitError(
      `${context}: render-request definitions must pin a published version ` +
        `("{owner}/{name}@{n}", got "${id}")`,
    );
  }

  assertNoNestedInstance(raw, context);
  assertKindShape(raw, context);

  if (!validateCommunityFn(raw)) {
    const errors = (validateCommunityFn.errors ?? []).map(
      (e) => `${e.instancePath || "/"}: ${e.message ?? "invalid"}`,
    );
    throw new KitError(`${context}: invalid component:\n  ${errors.join("\n  ")}`);
  }
  const component = raw as unknown as KitComponent;
  // Code components may omit the static preview ("nodes: [] or absent") —
  // normalize like the kit loader so downstream checks see an array.
  (component as { nodes?: KitFragmentNode[] }).nodes ??= [];
  assertComponentSemantics(component, context);
  checkBuiltinFontFamilies(component, context);

  const warnings: string[] = [];
  // The props-only template rule walks every string in the definition EXCEPT
  // the `code` source: JavaScript legitimately contains "{{…}}"-looking text,
  // and it never goes through the template engine — a code component's OUTPUT
  // resolves against a props-only scope (expandCodeInstance), so a data
  // template smuggled into output dies as the unresolved placeholder anyway.
  const { code: _codeSource, ...templateSurface } = component as KitComponent &
    Record<string, unknown>;
  checkPropsOnlyTemplates(templateSurface, "", component, context, warnings);
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

/** Instance props after merging over declared defaults (series props are raw arrays). */
export type MergedProps = Record<string, string | number | unknown[]>;

/**
 * Merge instance props over declared defaults. Number props accept a number
 * or a numeric string (a prop bound to connector data arrives as a string);
 * anything else warns and falls back to the declared default.
 *
 * Series props (§7.6): the instance value must be an ARRAY — either a literal
 * one, or the raw value a SOLE "{{path}}" template resolved to (template.ts
 * resolvePropsDeep passes arrays through untouched). Anything else — a
 * missing path (the em-dash placeholder string), a non-sole template's
 * stringification, a scalar — warns and falls back to the declared default
 * array, NEVER a stringified value. Exported for the series test matrix.
 */
export function mergeProps(
  node: InstanceNode,
  component: KitComponent,
  warnings: string[],
): MergedProps {
  const given = node.props ?? {};
  const merged: MergedProps = {};
  for (const [name, decl] of Object.entries(component.props)) {
    const value = given[name];
    if (value === undefined || value === null) {
      merged[name] = decl.default;
    } else if (decl.type === "series") {
      if (Array.isArray(value)) {
        merged[name] = value;
      } else {
        warnings.push(
          `instance "${node.id}": prop "${name}" expects a series (a JSON array — bind it ` +
            `with a sole "{{path}}" template or pass a literal array), got ` +
            `${typeof value === "string" ? JSON.stringify(value) : `a ${typeof value}`} — ` +
            `using the declared default`,
        );
        merged[name] = decl.default;
      }
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

  // Code components (§7.6) execute asynchronously in the sandbox — the
  // pipeline dispatches them to expandCodeInstance. Reaching this sync path
  // with one is caller misuse; degrade to the placeholder, never fail.
  if (component.kind === "code") {
    return {
      items: [node],
      warnings: [
        `instance "${node.id}": code component "${node.component}" requires the async ` +
          `expansion path (expandCodeInstance) — rendering placeholder`,
      ],
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
        // The cast is safe in practice: official natives declare only
        // string/number props (a series-declared prop would arrive as a raw
        // array; no official native declares one).
        const generated: KitFragmentNode[] = generator({
          props: props as ResolvedProps,
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

// ---------------------------------------------------------------------------
// Code components (architecture.md §7.6)
//
// A code component's `code` executes as render({props, frame}) inside the
// capability-less QuickJS-in-WASM sandbox (@makeitbeauty/sandbox) under
// DEFAULT_LIMITS. Output is nodes, never SVG: it is ajv-validated against the
// FRAGMENT node schema (text/rect/image only — an instance node in output is
// rejected, so code can never smuggle a nested expansion), then flows through
// the exact same resolve → computed(skip; declarative-only) → scaleAndOffset
// → id-prefix pipeline as declarative fragments. Any sandbox failure degrades
// to the dashed placeholder with a warning — render never fails.
//
// NOTE on blocking: the sandbox's sync QuickJS variant blocks the Node event
// loop for up to limits.cpuMs (50ms) per execution. Acceptable at current
// scale — renders are satori-CPU-bound anyway, and a design carries at most a
// handful of code instances. Revisit with worker threads if p99 suffers.
// ---------------------------------------------------------------------------

/**
 * Output nodes may not exceed the sandbox node cap; the ajv gate re-states it
 * so the schema alone is sufficient even if limits drift.
 */
const CODE_OUTPUT_MAX_NODES = DEFAULT_LIMITS.maxNodes;

// Validates the FULL returned array against the kit fragment-node schema —
// the same text/rect/image definitions ($refs into design.v0.json) the
// declarative loader enforces, so code output can never carry a node shape
// the rest of the pipeline has not already agreed to render.
const codeOutputSchema = {
  $id: "https://makeitbeauty.dev/schemas/code-output.v0.json",
  type: "array",
  maxItems: CODE_OUTPUT_MAX_NODES,
  items: { $ref: "kit-component.v0.json#/$defs/fragmentNode" },
};
const validateCodeOutputFn: ValidateFunction<KitFragmentNode[]> =
  ajv.compile<KitFragmentNode[]>(codeOutputSchema);

/**
 * Validate one execution's returned nodes (§7.6) or throw KitError:
 *  1. every node is text/rect/image — an instance node gets its own precise
 *     rejection (nested expansion from code is never allowed);
 *  2. the array validates against the fragment node schema (ajv);
 *  3. node ids are unique (the "{instanceId}__" prefix keeps ids unique
 *     ACROSS instances only when they are unique within one output);
 *  4. text nodes name BUILT-IN font families only — the §7.5 font-isolation
 *     rule applied to code OUTPUT. The value must be a literal built-in: a
 *     template here would dodge the check, so it fails it (checked before
 *     any resolution, exactly like the declarative publish rule).
 * Used by render-time expansion AND publish validation — one gate, two doors.
 */
export function validateCodeOutputNodes(raw: unknown[], context: string): KitFragmentNode[] {
  for (const [i, item] of raw.entries()) {
    const type = (item as { type?: unknown } | null)?.type;
    if (type === "instance") {
      throw new KitError(
        `${context}: render() returned an instance node at [${i}] — code output may only ` +
          `contain text/rect/image nodes (nested instances are never allowed)`,
      );
    }
    if (type !== "text" && type !== "rect" && type !== "image") {
      throw new KitError(
        `${context}: render() output [${i}] is not a text/rect/image node ` +
          `(got type ${JSON.stringify(type)})`,
      );
    }
  }

  if (!validateCodeOutputFn(raw)) {
    const errors = (validateCodeOutputFn.errors ?? [])
      .slice(0, 8)
      .map((e) => `${e.instancePath || "/"}: ${e.message ?? "invalid"}`);
    throw new KitError(
      `${context}: render() output failed node validation:\n  ${errors.join("\n  ")}`,
    );
  }
  const nodes = raw as KitFragmentNode[];

  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) {
      throw new KitError(`${context}: render() output has duplicate node id "${node.id}"`);
    }
    ids.add(node.id);
  }

  for (const [i, node] of nodes.entries()) {
    if (node.type !== "text" || node.style?.fontFamily === undefined) continue;
    if (!isBuiltinFamily(node.style.fontFamily)) {
      const builtin = BUILTIN_FAMILIES.map((f) => `"${f.family}"`).join(", ");
      throw new KitError(
        `${context}: render() output [${i}].style.fontFamily ` +
          `${JSON.stringify(node.style.fontFamily)} is not a built-in font family — code ` +
          `component output may only use the built-ins (${builtin}); user-uploaded fonts ` +
          `stay private to their owner's designs`,
      );
    }
  }

  return nodes;
}

/**
 * Compile-check LRU keyed by sha256(source) — the fonts.ts cache pattern.
 * The sandbox re-parses source in the fresh per-execution context anyway
 * (state never survives, §7.6), so what is worth caching is the compile
 * VERDICT: a known-good source skips the throwaway syntax-check runtime, and
 * a known-bad one short-circuits straight to the placeholder without ever
 * spinning the sandbox up again.
 */
export const CODE_COMPILE_CACHE_CAP = 128;
const codeCompileCache = new Map<string, CompileResult>(); // Map preserves insertion order → LRU

/** Cache keys, oldest first — exported for tests. */
export function codeCompileCacheKeys(): string[] {
  return [...codeCompileCache.keys()];
}

/** Empty the compile cache — exported for tests. */
export function clearCodeCompileCache(): void {
  codeCompileCache.clear();
}

async function compileCached(source: string): Promise<CompileResult> {
  const hash = sha256Hex(source);
  const cached = codeCompileCache.get(hash);
  if (cached) {
    // Refresh recency: delete + re-set moves the key to the Map's tail.
    codeCompileCache.delete(hash);
    codeCompileCache.set(hash, cached);
    return cached;
  }
  const result = await compileComponent(source);
  codeCompileCache.set(hash, result);
  if (codeCompileCache.size > CODE_COMPILE_CACHE_CAP) {
    // Evict the least-recently-used entry (the Map's head).
    const oldest = codeCompileCache.keys().next().value as string;
    codeCompileCache.delete(oldest);
  }
  return result;
}

/**
 * Expand one kind:"code" instance (§7.6). Mirrors expandInstance's contract —
 * pure given its inputs, never throws for component-attributable failures:
 * every sandbox error (compile, timeout, memory, bad output, …) degrades to
 * the dashed placeholder with a warning naming the instance and the reason.
 *
 * The returned nodes resolve against a PROPS-ONLY scope: §7.6's consent rule
 * is "code receives props only", and its output gets no more than the code
 * itself — a "{{connector.field}}" template emitted into output text would
 * otherwise read snapshot data other nodes' bindings brought into the
 * request, bypassing the props-only publish rule (which cannot see strings
 * code builds at runtime). With the props-only scope such a template resolves
 * to the em-dash placeholder plus a warning. Computed entries are skipped by
 * construction (declarative-only; the schema forbids them for kind "code").
 */
export async function expandCodeInstance(
  node: InstanceNode,
  component: KitComponent,
): Promise<Expansion> {
  const warnings: string[] = [];
  const props = mergeProps(node, component, warnings);
  const code = component.code ?? "";

  const placeholder = (reason: string): Expansion => {
    warnings.push(
      `instance "${node.id}": code component "${node.component}" ${reason} — rendering placeholder`,
    );
    return { items: [node], warnings };
  };

  const compiled = await compileCached(code);
  if (!compiled.ok) return placeholder(`failed to compile: ${compiled.message}`);

  let result: SandboxRenderResult;
  try {
    // Blocks the event loop up to DEFAULT_LIMITS.cpuMs — see the section note.
    result = await executeRender(code, { props, frame: component.frame });
  } catch (err) {
    if (err instanceof SandboxError) return placeholder(`failed (${err.code}): ${err.message}`);
    // Engine-level failure (not component-attributable) — still never fail
    // the render; the warning names it so operators can tell the two apart.
    return placeholder(
      `hit a sandbox engine error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // In-sandbox console output surfaces prefixed with the instance id.
  for (const w of result.warnings) warnings.push(`instance "${node.id}": ${w}`);

  let outputNodes: KitFragmentNode[];
  try {
    outputNodes = validateCodeOutputNodes(result.nodes, `instance "${node.id}"`);
  } catch (err) {
    if (err instanceof KitError) {
      warnings.push(`${err.message} — rendering placeholder`);
      return { items: [node], warnings };
    }
    throw err;
  }

  // The exact declarative treatment: resolve (props-only scope, see above) →
  // computed (skipped — forbidden for code) → scaleAndOffset → id prefix.
  // No structuredClone needed: output nodes are freshly JSON-parsed per
  // execution, so nothing is shared to corrupt.
  const s = Math.min(node.w / component.frame.w, node.h / component.frame.h);
  let stripped = false;
  const nodes = outputNodes.map((raw) => {
    const copy = resolveDeep(raw, { props }, warnings) as KitFragmentNode;
    scaleAndOffset(copy, s, node.x, node.y);
    // Id-uniqueness across instances (raw.id: the schema's id pattern has no
    // "{", so resolution can never have rewritten it).
    copy.id = `${node.id}__${raw.id}`;
    if (node.animation && copy.animation) {
      stripped = true;
      delete copy.animation;
    }
    return copy;
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
      // Layer origin anchors to the instance box (final canvas-space frame).
      frame: { x: node.x, y: node.y, w: node.w, h: node.h },
      nodes,
    };
    return { items: [group], warnings };
  }
  return { items: nodes, warnings };
}

/**
 * Publish-time execution checks for a kind:"code" community component
 * (§7.6): compile, execute TWICE against the declared prop defaults under
 * full limits, byte-compare the two serialized outputs, then run the shared
 * output gate (fragment schema, no instances, unique ids, built-in fonts) on
 * the sample. Throws KitError with a precise reason; returns the sample
 * execution's console output as warnings.
 *
 * The double-run byte-compare is defense in depth: nondeterminism is already
 * impossible by construction (Date is excluded at the intrinsic level,
 * Math.random throws, there is no async, and every execution gets a fresh
 * context so no state survives between the two runs). It stays because it is
 * cheap (~2× cpuMs worst case) and turns any future sandbox regression into
 * a loud publish-time rejection instead of a silently unstable image.
 */
export async function runCodePublishChecks(
  component: KitComponent,
  context: string,
): Promise<string[]> {
  const code = component.code ?? "";

  const compiled = await compileComponent(code);
  if (!compiled.ok) {
    throw new KitError(`${context}: code failed to compile: ${compiled.message}`);
  }

  // Declared defaults are the sample input — this is why series defaults
  // must be representative arrays: they are what publish validation renders.
  const props = Object.fromEntries(
    Object.entries(component.props).map(([name, decl]) => [name, decl.default]),
  );
  const input = { props, frame: component.frame };

  const runOnce = async (): Promise<SandboxRenderResult> => {
    try {
      return await executeRender(code, input);
    } catch (err) {
      if (err instanceof SandboxError) {
        throw new KitError(
          `${context}: executing render() against the declared prop defaults failed ` +
            `(${err.code}): ${err.message}`,
        );
      }
      throw err;
    }
  };

  const first = await runOnce();
  const second = await runOnce();

  const a = JSON.stringify(first.nodes);
  const b = JSON.stringify(second.nodes);
  if (a !== b) {
    let what: string;
    if (first.nodes.length !== second.nodes.length) {
      what = `the runs returned ${first.nodes.length} vs ${second.nodes.length} nodes`;
    } else {
      const i = first.nodes.findIndex(
        (n, idx) => JSON.stringify(n) !== JSON.stringify(second.nodes[idx]),
      );
      what = `output node [${i}] differs between the runs`;
    }
    throw new KitError(
      `${context}: code is nondeterministic — two executions against the declared prop ` +
        `defaults produced different output (${what}); render() must be a pure function ` +
        `of (props, frame)`,
    );
  }

  validateCodeOutputNodes(first.nodes, context);

  return first.warnings.map((w) => `${context}: sample render: ${w}`);
}

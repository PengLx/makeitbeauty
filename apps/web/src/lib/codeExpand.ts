/**
 * Canvas-side execution of kind "code" component INSTANCES (§7.6) — the
 * browser mirror of apps/renderer/src/kit.ts expandCodeInstance, running the
 * SAME @makeitbeauty/sandbox engine, so what the canvas draws is what
 * production renders:
 *
 *   1. resolve instance prop values against connector data
 *      (template.ts resolvePropsDeep: a SOLE "{{path}}" template resolving
 *      to an ARRAY passes the raw array through — the series binding path)
 *   2. merge over declared defaults                → kit.ts mergeProps
 *   3. executeRender in the capability-less sandbox (cached — see below)
 *   4. resolve output against a PROPS-ONLY scope   → expandCodeInstance
 *   5. uniform-scale into the instance box         → kit.ts scaleAndOffset
 *
 * Executions are deterministic by construction, so results are cached in a
 * small module LRU keyed by (source hash, frame, resolved-props JSON) —
 * lib/codeExecCache.ts — with in-flight dedupe so ten instances of one
 * component cost one QuickJS context. Every sandbox failure degrades to
 * {ok: false} and the canvas keeps its dashed placeholder, matching the
 * renderer's warning + placeholder path (§5.7) — never a crash.
 */

import type { FragmentNode } from "./component";
import {
  mergeInstanceProps,
  resolveDeep,
  scaleAndOffset,
  type ConnectorData,
  type ExpandableDefinition,
} from "./expandFragment";
import { codeExecKey, LruCache } from "./codeExecCache";
import { loadSandbox } from "./sandboxClient";

/** A string that is EXACTLY one {{path}} template (renderer template.ts). */
const SOLE_TEMPLATE_RE = /^\{\{\s*([^{}]+?)\s*\}\}$/;

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
 * Resolve instance PROP VALUES against connector data — the renderer's
 * resolvePropsDeep (template.ts): a sole-template string whose path resolves
 * to an ARRAY passes the raw array through untouched (§7.6 series bindings);
 * everything else takes the standard template treatment (missing/non-scalar
 * → em-dash + warning). With no data (signed out, Variables mode) values pass
 * through unchanged — a bound series then falls back to its declared default
 * in the merge, the canvas's honest degrade.
 */
export function resolveCodeInstanceProps(
  given: Record<string, unknown>,
  data: ConnectorData,
  warnings: string[],
): Record<string, unknown> {
  if (data == null) return given;
  const resolve = (value: unknown): unknown => {
    if (typeof value === "string") {
      const sole = SOLE_TEMPLATE_RE.exec(value);
      if (sole) {
        const found = lookupPath(data, sole[1].trim());
        if (Array.isArray(found)) return found;
      }
      return resolveDeep(value, data, warnings, "all");
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, resolve(v)]),
      );
    }
    return value;
  };
  return resolve(given) as Record<string, unknown>;
}

/**
 * The definition surface this module needs: ExpandableDefinition (loose prop
 * metadata, frame) plus the code source. Satisfied by useKit.KitComponent
 * for entries with kind "code".
 */
export interface CodeDefinition extends ExpandableDefinition {
  code?: string;
}

/**
 * Merge resolved instance props over declared defaults — kit.ts mergeProps
 * including the series rule: a series-declared prop accepts only an ARRAY
 * (raw from a sole-template binding, or a literal); anything else falls back
 * to the declared default array, never a stringification. String/number
 * props reuse the canvas's existing mergeInstanceProps (the same renderer
 * contract).
 */
export function mergeCodeProps(
  def: CodeDefinition,
  given: Record<string, unknown>,
  warnings: string[],
): Record<string, unknown> {
  const scalarDecls: ExpandableDefinition["props"] = {};
  const merged: Record<string, unknown> = {};
  for (const [name, decl] of Object.entries(def.props)) {
    if (decl.type !== "series") {
      scalarDecls[name] = decl;
      continue;
    }
    const fallback = Array.isArray(decl.default) ? decl.default : [];
    const value = given[name];
    if (value === undefined || value === null) {
      merged[name] = fallback;
    } else if (Array.isArray(value)) {
      merged[name] = value;
    } else {
      warnings.push(
        `prop "${name}" expects a series (a JSON array) — using the declared default`,
      );
      merged[name] = fallback;
    }
  }
  const scalarGiven = Object.fromEntries(
    Object.entries(given).filter(([name]) => !(name in merged)),
  );
  Object.assign(
    merged,
    mergeInstanceProps({ ...def, props: scalarDecls }, scalarGiven, warnings),
  );
  return merged;
}

/** Settled execution: frame-relative nodes already resolved props-only. */
export type CodeExecution =
  | { ok: true; nodes: FragmentNode[] }
  | { ok: false; reason: string };

/** Loose output-shape gate — the renderer's validator is the real one. */
function isRenderableNode(v: unknown): v is FragmentNode {
  if (v === null || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  return (
    (n.type === "text" || n.type === "rect" || n.type === "image") &&
    typeof n.x === "number" &&
    typeof n.y === "number" &&
    typeof n.w === "number" &&
    typeof n.h === "number"
  );
}

/** ~a handful of components × a few prop variants; results are tiny JSON. */
const EXEC_CACHE_CAP = 64;

const settled = new LruCache<CodeExecution>(EXEC_CACHE_CAP);
const inflight = new Map<string, Promise<CodeExecution>>();

/**
 * Execute one code component against RESOLVED+MERGED props, through the
 * settled LRU + in-flight dedupe. Returns frame-relative nodes with output
 * templates already resolved props-only (§7.6: code's output gets no more
 * data than the code received). Never rejects.
 */
async function executeCached(
  code: string,
  frame: { w: number; h: number },
  props: Record<string, unknown>,
): Promise<CodeExecution> {
  const sandbox = await loadSandbox();
  const key = codeExecKey(sandbox.sha256Hex(code), frame, props);

  const done = settled.get(key);
  if (done !== undefined) return done;
  const pending = inflight.get(key);
  if (pending !== undefined) return pending;

  const promise = (async (): Promise<CodeExecution> => {
    try {
      const result = await sandbox.executeRender(code, { props, frame });
      const raw = result.nodes;
      if (!raw.every(isRenderableNode)) {
        return {
          ok: false,
          reason: "render() returned nodes that are not text/rect/image shapes",
        };
      }
      // Renderer parity (expandCodeInstance): output resolves against a
      // props-only scope; a {{connector.*}} emitted by code em-dashes.
      const warnings: string[] = [];
      const nodes = raw.map(
        (node) => resolveDeep(node, { props }, warnings, "all") as FragmentNode,
      );
      return { ok: true, nodes };
    } catch (e) {
      // SandboxError or engine failure alike: canvas placeholder, never a crash.
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  })();

  inflight.set(key, promise);
  const outcome = await promise;
  settled.set(key, outcome);
  inflight.delete(key);
  return outcome;
}

/**
 * The canvas entry point: resolve the instance's props (series bindings
 * included), merge over declared defaults, execute (cached). The returned
 * nodes are FRAME-relative — scale them into the instance box with
 * scaleCodeNodes, which stays outside the cache because the box changes on
 * every resize drag while the execution input does not.
 */
export async function executeCodeInstance(
  def: CodeDefinition,
  givenProps: Record<string, unknown> | undefined,
  data: ConnectorData,
): Promise<CodeExecution> {
  const code = def.code ?? "";
  if (code === "") return { ok: false, reason: "code component has no source" };
  const warnings: string[] = []; // display-only surface; API preview reports
  const resolved = resolveCodeInstanceProps(givenProps ?? {}, data, warnings);
  const merged = mergeCodeProps(def, resolved, warnings);
  return executeCached(code, def.frame, merged);
}

/**
 * Uniform-scale frame-relative executed nodes into an instance box (kit.ts
 * scaleAndOffset, dx = dy = 0 — the canvas wrapper already sits at the
 * instance position). Clones first: cached nodes are shared across mounts.
 */
export function scaleCodeNodes(
  nodes: FragmentNode[],
  frame: { w: number; h: number },
  box: { w: number; h: number },
): FragmentNode[] {
  const s = Math.min(box.w / frame.w, box.h / frame.h);
  return nodes.map((node) => {
    const copy = structuredClone(node);
    scaleAndOffset(copy, s, 0, 0);
    return copy;
  });
}

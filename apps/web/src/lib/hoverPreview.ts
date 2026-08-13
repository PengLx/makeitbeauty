/**
 * Pure machinery behind the palette's hover previews (hooks/useHoverPreview).
 *
 * A hover preview renders a component THROUGH THE REAL RENDERER: we build the
 * §7.5 one-instance preview design — a canvas exactly the component's frame,
 * dark chrome background, a single full-frame instance at (0,0) carrying the
 * component's declared default props — and POST it to /v1/preview like any
 * other design. Kit and pinned community components ship as instance nodes
 * (the server expands them; native kit components render the signed-in
 * user's live connector data). Studio starter templates are local-only, so
 * their nodes are inlined client-side via the Studio's own expansion
 * (expandForPreview) instead.
 *
 * Everything here is pure/deterministic apart from renderPreviewEntry (the
 * /v1/preview call, which never throws — failures become {error} entries so
 * a broken preview can never break the palette).
 */

import type { DesignDoc } from "./design";
import type { ComponentDefinition } from "./component";
import { expandForPreview, PREVIEW_BACKGROUND } from "./expandForPreview";

/** Same envelope shape as usePreview's PreviewError. */
export interface HoverPreviewError {
  code: string;
  message: string;
}

/**
 * One settled cache entry: the raw SVG text plus its canvas size (the
 * component frame). SVG TEXT is what gets cached — blob URLs are per-mount
 * (created/revoked by the hook) so a cached entry can outlive any component.
 */
export type HoverPreviewEntry =
  | { svg: string; width: number; height: number }
  | { error: HoverPreviewError };

// ---- cache keys ----------------------------------------------------------
//
// Official kit entries key by their registry id verbatim ("kit/stat-card") —
// no helper needed. The other two sources get explicit derivations so the
// three namespaces can never collide ("kit/…" vs "{owner}/{name}@{v}" vs
// "template/…" — templates never contain "@" or start with "kit/").

/** "{owner}/{name}" + version → the pinned ref the design will reference. */
export function pinnedPreviewKey(id: string, version: number): string {
  return `${id}@${version}`;
}

/** Studio starter template → a namespaced local key. */
export function templatePreviewKey(templateId: string): string {
  return `template/${templateId}`;
}

// ---- preview-design construction -----------------------------------------

/** Matches the Studio frame chrome; §7.5 one-instance preview design spec. */
export const PREVIEW_CANVAS_RADIUS = 8;

/**
 * Materialize a prop-declaration map into the DEFAULT prop values an instance
 * should carry. Kit metadata (useKit.KitProp) declares `default` optionally;
 * declarations without one are omitted — the renderer's own default handling
 * applies. Community declarations (ComponentPropDecl) always carry one.
 */
export function materializeDefaultProps(
  decls: Record<string, { default?: unknown }>,
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [name, decl] of Object.entries(decls)) {
    if (decl.default !== undefined) props[name] = decl.default;
  }
  return props;
}

/**
 * The §7.5 one-instance preview design: canvas = the component frame (dark
 * chrome background, rounded), one instance at (0,0) filling it, carrying
 * `props` (the declared defaults). `component` is a renderable ref —
 * "kit/{name}" or a pinned "{owner}/{name}@{v}".
 */
export function buildInstancePreviewDesign(
  component: string,
  frame: { w: number; h: number },
  props: Record<string, unknown>,
): DesignDoc {
  return {
    version: 0,
    canvas: {
      width: frame.w,
      height: frame.h,
      background: PREVIEW_BACKGROUND,
      radius: PREVIEW_CANVAS_RADIUS,
    },
    nodes: [
      {
        id: "preview",
        type: "instance",
        component,
        x: 0,
        y: 0,
        w: frame.w,
        h: frame.h,
        // Empty props serialize away — the renderer merges defaults anyway.
        ...(Object.keys(props).length > 0 ? { props } : {}),
      },
    ],
  };
}

/**
 * Preview design for a LOCAL definition (Studio starter templates): there is
 * nothing server-side to reference, so the nodes are inlined via the Studio's
 * draft expansion — expandForPreview with no sample overrides IS "render with
 * declared defaults" — then given the same rounded chrome as instance
 * previews. Template invariants (props-only bindings, valid tw) are already
 * guarded by componentTemplates.test.ts, so warnings are dropped.
 */
export function buildTemplatePreviewDesign(
  frame: { w: number; h: number },
  seed: Pick<ComponentDefinition, "props" | "nodes">,
): DesignDoc {
  const def: ComponentDefinition = {
    id: "template/preview",
    title: "",
    frame,
    props: seed.props,
    nodes: seed.nodes,
  };
  const { design } = expandForPreview(def, {});
  return {
    ...design,
    canvas: { ...design.canvas, radius: PREVIEW_CANVAS_RADIUS },
  };
}

// ---- in-flight dedupe ----------------------------------------------------

/**
 * Resolve `key` through a settled-value cache plus an in-flight map: a second
 * request while the first is pending reuses its promise; once settled the
 * value is served from `settled` and `produce` never runs again. A REJECTED
 * produce caches nothing (the in-flight slot is cleared so a later call
 * retries) — hover-preview producers never reject by construction, resolving
 * {error} entries instead, which DO settle into the cache per the design.
 *
 * Maps are injected so the logic stays pure/testable; the module-level maps
 * live with the hook (hooks/useHoverPreview.ts).
 */
export function resolveShared<K, V>(
  settled: Map<K, V>,
  inflight: Map<K, Promise<V>>,
  key: K,
  produce: () => Promise<V>,
): Promise<V> {
  const done = settled.get(key);
  if (done !== undefined) return Promise.resolve(done);
  const pending = inflight.get(key);
  if (pending !== undefined) return pending;
  const promise = produce().then(
    (value) => {
      settled.set(key, value);
      inflight.delete(key);
      return value;
    },
    (e: unknown) => {
      inflight.delete(key);
      throw e;
    },
  );
  inflight.set(key, promise);
  return promise;
}

// ---- rendering -----------------------------------------------------------

/**
 * Render a preview design to a settled cache entry via POST /v1/preview —
 * the same call + §8 error-envelope handling as usePreview, but resolving
 * {error} instead of throwing so entries are cacheable either way.
 */
export async function renderPreviewEntry(
  design: DesignDoc,
): Promise<HoverPreviewEntry> {
  try {
    const res = await fetch("/v1/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ design }),
    });
    const body = await res.text();
    if (!res.ok) {
      let code = `http_${res.status}`;
      let message = body || res.statusText;
      try {
        const parsed = JSON.parse(body) as {
          error?: { code?: string; message?: string };
        };
        if (parsed?.error?.code) {
          code = parsed.error.code;
          message = parsed.error.message ?? message;
        }
      } catch {
        /* non-JSON error body; keep the http_* fallback */
      }
      return { error: { code, message } };
    }
    return { svg: body, width: design.canvas.width, height: design.canvas.height };
  } catch (e) {
    return {
      error: {
        code: "network_error",
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }
}

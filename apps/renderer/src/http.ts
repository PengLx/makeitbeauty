/**
 * Internal HTTP routes (architecture.md §8). Never exposed publicly.
 *
 *   POST /internal/render              {design, data, options?, components?}
 *                                      → 200 {svg, warnings}
 *   POST /internal/validate-component  {definition} → 200 {ok:true, warnings}
 *                                      or 422 {"error":{"code":"invalid_component",...}}
 *                                      (the API's publish flow calls this, §7.5)
 *   GET  /healthz                      → 200 {"ok":true} (same shape as the API's)
 *
 * Exported as a factory so tests run the server on an ephemeral port;
 * src/server.ts is the boot entry that loads fonts and listens.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { LoadedFont } from "./fonts.js";
import { KitError, parseCommunityComponent, parseRequestComponents } from "./kit.js";
import { render } from "./pipeline.js";
import { SanitizeError } from "./sanitize.js";
import type { RenderOptions } from "./types.js";
import { validateDesign } from "./validate.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024; // designs + data: URIs; well over the 5 MB Camo cap
const THEMES = new Set(["auto", "light", "dark"]);

/** Error envelope per packages/schema/render.schema.json. */
function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code, message } }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Parse the JSON body into a plain object, or send the error response and return null. */
async function readJsonObject(
  req: IncomingMessage,
  res: ServerResponse,
  shape: string,
): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    sendError(res, 400, "INVALID_JSON", err instanceof Error ? err.message : "unparseable body");
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    sendError(res, 400, "INVALID_REQUEST", `body must be a JSON object ${shape}`);
    return null;
  }
  return body as Record<string, unknown>;
}

async function handleRender(
  req: IncomingMessage,
  res: ServerResponse,
  fonts: LoadedFont[],
): Promise<void> {
  const body = await readJsonObject(req, res, "{design, data, options?, components?}");
  if (body === null) return;
  const { design, data, options, components } = body;

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    sendError(res, 400, "INVALID_REQUEST", '"data" must be an object');
    return;
  }
  const opts = (options ?? {}) as RenderOptions;
  if (typeof opts !== "object" || (opts.theme !== undefined && !THEMES.has(opts.theme))) {
    sendError(res, 400, "INVALID_REQUEST", '"options.theme" must be auto|light|dark');
    return;
  }

  const validation = validateDesign(design);
  if (!validation.ok) {
    sendError(res, 400, "INVALID_DESIGN", validation.errors.join("; "));
    return;
  }

  // Per-request community definitions (§7.5): same suite the publish flow ran
  // — defense in depth. An INVALID definition is an API bug and fails loudly;
  // a MISSING one never does (expansion degrades to the dashed placeholder).
  let requestComponents;
  try {
    requestComponents = parseRequestComponents(components);
  } catch (err) {
    if (err instanceof KitError) {
      sendError(res, 400, "INVALID_COMPONENT", err.message);
      return;
    }
    throw err;
  }

  try {
    // validateDesign vouches for the shape; the cast is the trust boundary.
    const result = await render(
      design as never,
      data as Record<string, unknown>,
      fonts,
      opts,
      requestComponents.components,
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        svg: result.svg,
        warnings: [...requestComponents.warnings, ...result.warnings],
      }),
    );
  } catch (err) {
    if (err instanceof SanitizeError) {
      // Unsafe output must never leave the service — reject, non-200.
      sendError(res, 422, err.code, err.message);
      return;
    }
    sendError(res, 500, "RENDER_FAILED", err instanceof Error ? err.message : "render failed");
  }
}

async function handleValidateComponent(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonObject(req, res, "{definition}");
  if (body === null) return;
  if (!("definition" in body)) {
    sendError(res, 400, "INVALID_REQUEST", '"definition" is required');
    return;
  }

  try {
    // Draft ids ("{owner}/{name}") are fine here — the API assigns the
    // version pin when it freezes the publish.
    const { warnings } = parseCommunityComponent(body.definition, "definition");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, warnings }));
  } catch (err) {
    if (err instanceof KitError) {
      // Contract (§7.5): 422 with the first failure's precise reason.
      sendError(res, 422, "invalid_component", err.message);
      return;
    }
    throw err;
  }
}

/** Build the internal server. Fonts are injected so tests and boot share one loader. */
export function createRendererServer(fonts: LoadedFont[]): Server {
  return createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/healthz") {
      if (req.method !== "GET") {
        sendError(res, 405, "METHOD_NOT_ALLOWED", "use GET /healthz");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    if (path === "/internal/render") {
      handler = (rq, rs) => handleRender(rq, rs, fonts);
    } else if (path === "/internal/validate-component") {
      handler = handleValidateComponent;
    } else {
      sendError(res, 404, "NOT_FOUND", `no route ${path}`);
      return;
    }
    if (req.method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", `use POST ${path}`);
      return;
    }
    void handler(req, res).catch((err) => {
      if (!res.headersSent) {
        sendError(res, 500, "INTERNAL", err instanceof Error ? err.message : "internal error");
      }
    });
  });
}

/**
 * Internal render service (architecture.md §4, §8). Never exposed publicly.
 *
 *   POST /internal/render   {design, data, options?} → 200 {svg, warnings}
 *                           errors → non-200 {"error":{"code","message"}}
 *
 * Listens on MIB_RENDERER_ADDR (default ":7801", Go-style host:port).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { loadFontsOrExit, type LoadedFont } from "./fonts.js";
import { kitRegistry } from "./kit.js";
import { render } from "./pipeline.js";
import { SanitizeError } from "./sanitize.js";
import type { RenderOptions } from "./types.js";
import { validateDesign } from "./validate.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024; // designs + data: URIs; well over the 5 MB Camo cap
const THEMES = new Set(["auto", "light", "dark"]);

// Fonts load once at startup (exits with guidance if fonts/ is empty).
const fonts: LoadedFont[] = loadFontsOrExit();
// Kit components load + ajv-validate once at startup (throws KitError on a bad one).
const kit = kitRegistry();

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

async function handleRender(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    sendError(res, 400, "INVALID_JSON", err instanceof Error ? err.message : "unparseable body");
    return;
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    sendError(res, 400, "INVALID_REQUEST", "body must be a JSON object {design, data, options?}");
    return;
  }
  const { design, data, options } = body as Record<string, unknown>;

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

  try {
    // validateDesign vouches for the shape; the cast is the trust boundary.
    const result = await render(design as never, data as Record<string, unknown>, fonts, opts);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    if (err instanceof SanitizeError) {
      // Unsafe output must never leave the service — reject, non-200.
      sendError(res, 422, err.code, err.message);
      return;
    }
    sendError(res, 500, "RENDER_FAILED", err instanceof Error ? err.message : "render failed");
  }
}

const server = createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0];
  if (path !== "/internal/render") {
    sendError(res, 404, "NOT_FOUND", `no route ${path}`);
    return;
  }
  if (req.method !== "POST") {
    sendError(res, 405, "METHOD_NOT_ALLOWED", "use POST /internal/render");
    return;
  }
  void handleRender(req, res).catch((err) => {
    if (!res.headersSent) {
      sendError(res, 500, "INTERNAL", err instanceof Error ? err.message : "internal error");
    }
  });
});

// Go-style listen address: ":7801", "127.0.0.1:7801", or bare "7801".
const addr = process.env.MIB_RENDERER_ADDR ?? ":7801";
const colon = addr.lastIndexOf(":");
const host = colon > 0 ? addr.slice(0, colon) : "0.0.0.0";
const port = Number(colon >= 0 ? addr.slice(colon + 1) : addr);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`renderer: invalid MIB_RENDERER_ADDR "${addr}"`);
  process.exit(1);
}

server.listen(port, host, () => {
  console.log(
    `renderer (internal only) listening on ${host}:${port} — ` +
      `${fonts.length} font file(s), ${kit.size} kit component(s) loaded`,
  );
});

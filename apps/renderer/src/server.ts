/**
 * Internal render service boot entry (architecture.md §4, §8). Never exposed
 * publicly. Routes live in http.ts (createRendererServer); this file loads
 * the process-wide resources, parses the listen address and listens.
 *
 * Listens on MIB_RENDERER_ADDR (default ":7801", Go-style host:port).
 */
import { warmup } from "@makeitbeauty/sandbox";

import { loadFontsOrExit, type LoadedFont } from "./fonts.js";
import { createRendererServer } from "./http.js";
import { kitRegistry } from "./kit.js";

// Fonts load once at startup (exits with guidance if fonts/ is empty).
const fonts: LoadedFont[] = loadFontsOrExit();
// Kit components load + ajv-validate once at startup (throws KitError on a bad one).
const kit = kitRegistry();
// Pre-compile the sandbox wasm module (§7.6) so the first code-component
// render or publish validation does not pay for it. Fire-and-forget: a
// failure here surfaces on first use, and non-code renders never need it.
void warmup().catch(() => {});

const server = createRendererServer(fonts);

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

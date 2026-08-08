/**
 * CLI smoke test: renders examples/demo-design.json with demo-data.json to
 * out/demo.svg and reports size + warnings. Run with `pnpm demo`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadFontsOrExit } from "./fonts.js";
import { render } from "./pipeline.js";
import { repoPath } from "./paths.js";
import type { Design } from "./types.js";
import { validateDesign } from "./validate.js";

const design = JSON.parse(readFileSync(repoPath("examples", "demo-design.json"), "utf8"));
const data = JSON.parse(readFileSync(repoPath("examples", "demo-data.json"), "utf8"));

const validation = validateDesign(design);
if (!validation.ok) {
  console.error(`demo design failed schema validation:\n  ${validation.errors.join("\n  ")}`);
  process.exit(1);
}

const fonts = loadFontsOrExit();
const { svg, warnings } = await render(design as Design, data, fonts);

const outDir = fileURLToPath(new URL("../out/", import.meta.url));
mkdirSync(outDir, { recursive: true });
const outFile = `${outDir}demo.svg`;
writeFileSync(outFile, svg);

console.log(`wrote ${outFile} (${Buffer.byteLength(svg)} bytes)`);
if (warnings.length > 0) {
  console.log(`warnings (${warnings.length}):`);
  for (const w of warnings) console.log(`  - ${w}`);
} else {
  console.log("warnings: none");
}

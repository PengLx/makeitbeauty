/**
 * CLI smoke test: renders an example design with demo-data.json and reports
 * size + warnings.
 *
 *   pnpm demo       examples/demo-design.json     → out/demo.svg
 *   pnpm demo:kit   examples/demo-kit-design.json → out/demo-kit.svg
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadFontsOrExit } from "./fonts.js";
import { render } from "./pipeline.js";
import { repoPath } from "./paths.js";
import type { Design } from "./types.js";
import { validateDesign } from "./validate.js";

const kitMode = process.argv[2] === "kit";
const designFile = kitMode ? "demo-kit-design.json" : "demo-design.json";
const outName = kitMode ? "demo-kit.svg" : "demo.svg";

const design = JSON.parse(readFileSync(repoPath("examples", designFile), "utf8"));
const data = JSON.parse(readFileSync(repoPath("examples", "demo-data.json"), "utf8"));

const validation = validateDesign(design);
if (!validation.ok) {
  console.error(`${designFile} failed schema validation:\n  ${validation.errors.join("\n  ")}`);
  process.exit(1);
}

const fonts = loadFontsOrExit();
const { svg, warnings } = await render(design as Design, data, fonts);

const outDir = fileURLToPath(new URL("../out/", import.meta.url));
mkdirSync(outDir, { recursive: true });
const outFile = `${outDir}${outName}`;
writeFileSync(outFile, svg);

console.log(`wrote ${outFile} (${Buffer.byteLength(svg)} bytes)`);
if (warnings.length > 0) {
  console.log(`warnings (${warnings.length}):`);
  for (const w of warnings) console.log(`  - ${w}`);
} else {
  console.log("warnings: none");
}

#!/usr/bin/env node
/**
 * Schema conformance check, reusable by CI (`pnpm --filter @makeitbeauty/schema validate`).
 *
 * Validates:
 *   - every packages/kit/components/*.json against kit-component.schema.json
 *   - every examples/*design*.json against design.schema.json
 *
 * Exits non-zero with per-file ajv errors on any failure.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";

const schemaDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(schemaDir, "..", "..");

const loadJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// strict: false matches the runtime validators (apps/renderer/src/validate.ts, kit.ts).
const ajv = new Ajv2020({ allErrors: true, strict: false });
for (const f of readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json"))) {
  ajv.addSchema(loadJson(join(schemaDir, f)));
}

const targets = [];
const kitDir = join(repoRoot, "packages", "kit", "components");
for (const f of readdirSync(kitDir).filter((f) => f.endsWith(".json"))) {
  targets.push({
    file: join(kitDir, f),
    schema: "https://makeitbeauty.dev/schemas/kit-component.v0.json",
  });
}
const examplesDir = join(repoRoot, "examples");
for (const f of readdirSync(examplesDir).filter((f) => f.endsWith(".json") && f.includes("design"))) {
  targets.push({
    file: join(examplesDir, f),
    schema: "https://makeitbeauty.dev/schemas/design.v0.json",
  });
}

let failures = 0;
for (const { file, schema } of targets) {
  const validate = ajv.getSchema(schema);
  if (!validate) {
    console.error(`FAIL ${file}: schema not registered: ${schema}`);
    failures++;
    continue;
  }
  let doc;
  try {
    doc = loadJson(file);
  } catch (err) {
    console.error(`FAIL ${file}: invalid JSON: ${err.message}`);
    failures++;
    continue;
  }
  if (validate(doc)) {
    console.log(`ok   ${file}`);
  } else {
    console.error(`FAIL ${file}`);
    for (const e of validate.errors ?? []) {
      console.error(`     ${e.instancePath || "/"} ${e.message}`);
    }
    failures++;
  }
}

if (failures > 0) {
  console.error(`\n${failures} file(s) failed schema validation`);
  process.exit(1);
}
console.log(`\n${targets.length} file(s) validated`);

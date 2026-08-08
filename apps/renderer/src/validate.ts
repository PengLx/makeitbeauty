/**
 * Request validation (architecture.md §5 step 1).
 * Designs are validated with ajv (draft 2020-12) against the shared contract
 * in packages/schema/design.schema.json, loaded from the monorepo so the
 * renderer and API can never drift apart.
 */
import { readFileSync } from "node:fs";

// ajv ships CJS; under NodeNext the class must be imported as a named export,
// and the ajv-formats CJS default needs a type assertion to be callable.
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsExport, { type FormatsPlugin } from "ajv-formats";

const addFormats = addFormatsExport as unknown as FormatsPlugin;

import { repoPath } from "./paths.js";
import type { Design } from "./types.js";

const designSchema = JSON.parse(
  readFileSync(repoPath("packages/schema", "design.schema.json"), "utf8"),
);

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const validateFn: ValidateFunction<Design> = ajv.compile<Design>(designSchema);

export interface ValidationResult {
  ok: boolean;
  /** Human-readable "path: message" lines when ok is false. */
  errors: string[];
}

export function validateDesign(design: unknown): ValidationResult {
  if (validateFn(design)) return { ok: true, errors: [] };
  const errors = (validateFn.errors ?? []).map(
    (e) => `${e.instancePath || "/"}: ${e.message ?? "invalid"}`,
  );
  return { ok: false, errors };
}

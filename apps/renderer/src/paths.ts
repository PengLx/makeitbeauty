import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the monorepo root by walking up from this module's directory until
 * pnpm-workspace.yaml is found. Anchored on import.meta.url (not process.cwd())
 * so it works from src/ under tsx, from dist/ after tsc, and from any CWD.
 */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate repo root (pnpm-workspace.yaml) above ${import.meta.url}`);
}

/** Path relative to the monorepo root. */
export function repoPath(...segments: string[]): string {
  return join(repoRoot(), ...segments);
}

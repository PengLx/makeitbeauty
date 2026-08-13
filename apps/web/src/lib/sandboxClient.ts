/**
 * Lazy loader for @makeitbeauty/sandbox (§7.6 — the SAME engine the renderer
 * runs, so preview parity extends to code). The singlefile wasm variant is
 * ~1.5 MB of JS, so the editor imports it dynamically behind user intent —
 * the chunk loads only when a code component is actually authored or drawn —
 * and memoizes the module for the process lifetime (matching the engine's own
 * once-per-process wasm compilation).
 */

export type SandboxModule = typeof import("@makeitbeauty/sandbox");

let modulePromise: Promise<SandboxModule> | undefined;

export function loadSandbox(): Promise<SandboxModule> {
  modulePromise ??= import("@makeitbeauty/sandbox");
  return modulePromise;
}

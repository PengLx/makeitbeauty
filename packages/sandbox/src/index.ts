/**
 * @makeitbeauty/sandbox — capability-less QuickJS-in-WASM execution engine
 * for code components. Contract: docs/architecture.md §7.6.
 */
export { DEFAULT_LIMITS } from "./limits.js";
export type { Limits } from "./limits.js";
export { SandboxError, MAX_ERROR_MESSAGE_CHARS, sanitizeErrorText } from "./errors.js";
export type { SandboxErrorCode } from "./errors.js";
export { sha256Hex } from "./sha256.js";
export {
  REMOVED_GLOBALS,
  STUBBED_GLOBALS,
  MAX_CONSOLE_ENTRIES,
  MAX_CONSOLE_ENTRY_CHARS,
} from "./scripts.js";
export { compileComponent, executeRender, warmup } from "./engine.js";
export type {
  CompileFail,
  CompileOk,
  CompileResult,
  RenderFrame,
  RenderInput,
  RenderResult,
} from "./engine.js";

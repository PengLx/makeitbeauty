import variant from "@jitl/quickjs-singlefile-mjs-release-sync";
import {
  DefaultIntrinsics,
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";

import { SandboxError, sanitizeErrorText } from "./errors.js";
import { now, utf8ByteLength } from "./host.js";
import { DEFAULT_LIMITS, type Limits } from "./limits.js";
import { sha256Hex } from "./sha256.js";
import {
  MAX_CONSOLE_ENTRIES,
  MAX_CONSOLE_ENTRY_CHARS,
  INPUT_GLOBAL,
  SENTINEL_PREFIX_CODE,
  SETUP_SCRIPT,
  WARNINGS_SCRIPT,
  buildHarnessScript,
} from "./scripts.js";

export interface RenderFrame {
  w: number;
  h: number;
}

export interface RenderInput {
  props: Record<string, unknown>;
  frame: RenderFrame;
}

export interface RenderResult {
  /**
   * Parsed render output: a plain JSON array with at most maxNodes elements,
   * at most maxOutputBytes serialized. Structural node validation (text/rect/
   * image shape) stays the renderer's job.
   */
  nodes: unknown[];
  /** Bounded console.log/warn/error output captured inside the sandbox. */
  warnings: string[];
}

export interface CompileOk {
  ok: true;
  /** sha256 hex of the exact source string; callers cache compiled components by it. */
  hash: string;
}

export interface CompileFail {
  ok: false;
  code: "compile_error";
  /** Sanitized, length-capped sandbox-side error text. */
  message: string;
}

export type CompileResult = CompileOk | CompileFail;

/** Extra time granted for pulling warnings after a successful render. */
const WARNINGS_GRACE_MS = 25;

/** Host-side hard caps re-applied to whatever the warnings script produced. */
const MAX_WARNINGS_HOST = MAX_CONSOLE_ENTRIES + 1;
const MAX_WARNING_CHARS_HOST = MAX_CONSOLE_ENTRY_CHARS + 64;

// ---------------------------------------------------------------------------
// Module loading (memoized — the wasm is compiled once per process)
// ---------------------------------------------------------------------------

let modulePromise: Promise<QuickJSWASMModule> | undefined;

function getQuickJS(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModuleFromVariant(variant);
  return modulePromise;
}

/** Optional: pre-compile the wasm module so the first render doesn't pay for it. */
export async function warmup(): Promise<void> {
  await getQuickJS();
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

interface ExecState {
  interrupts: number;
  timedOut: boolean;
  deadline: number;
}

function describeDumped(dumped: unknown): string {
  if (dumped !== null && typeof dumped === "object") {
    const o = dumped as Record<string, unknown>;
    const name = typeof o["name"] === "string" ? (o["name"] as string) : "Error";
    const message = typeof o["message"] === "string" ? (o["message"] as string) : "";
    let text = message.length > 0 ? `${name}: ${message}` : name;
    if (typeof o["stack"] === "string" && (o["stack"] as string).length > 0) {
      const lines = (o["stack"] as string).split("\n").slice(0, 3).join("\n").trimEnd();
      if (lines.length > 0) text += `\n${lines}`;
    }
    return text;
  }
  if (typeof dumped === "string") return dumped;
  try {
    return String(dumped);
  } catch {
    return "unknown sandbox error";
  }
}

/**
 * Convert a failed evalCode into a SandboxError, consuming the error handle.
 * `phase: "compile"` marks an evaluation that only parses (compileOnly), so
 * its failures are compile errors; everything else is classified by what the
 * runtime reported (deadline interrupt → timeout, allocation failure →
 * memory, anything else → runtime_error).
 */
function sandboxErrorFromEval(
  context: QuickJSContext,
  errorHandle: QuickJSHandle,
  state: ExecState,
  limits: Limits,
  phase: "compile" | "run",
): SandboxError {
  let dumped: unknown;
  try {
    dumped = context.dump(errorHandle);
  } catch {
    dumped = undefined;
  }
  try {
    errorHandle.dispose();
  } catch {
    // already disposed or context torn down — nothing to leak
  }
  const text = sanitizeErrorText(describeDumped(dumped) || "unknown sandbox error");
  if (state.timedOut) {
    return new SandboxError(
      "timeout",
      `cpu budget of ${limits.cpuMs}ms exceeded (${state.interrupts} interrupt checks): ${text}`,
    );
  }
  if (/out of memory/i.test(text)) {
    return new SandboxError("memory", `memory limit of ${limits.memoryBytes} bytes exceeded: ${text}`);
  }
  if (phase === "compile") {
    return new SandboxError("compile_error", text);
  }
  return new SandboxError("runtime_error", text);
}

// ---------------------------------------------------------------------------
// Context plumbing
// ---------------------------------------------------------------------------

function newHardenedContext(runtime: {
  newContext: (options?: { intrinsics?: Record<string, boolean> }) => QuickJSContext;
}): QuickJSContext {
  // Exclude the Date intrinsic entirely: the real constructor never exists in
  // the context, so there is no resurrection path. The setup script then
  // installs a throwing stub purely for the determinism error message.
  return runtime.newContext({ intrinsics: { ...DefaultIntrinsics, Date: false } });
}

/** Run trusted host-authored script; a failure here is an engine bug, not a SandboxError. */
function runTrustedScript(context: QuickJSContext, code: string, filename: string): void {
  const res = context.evalCode(code, filename, { type: "global" });
  if (res.error) {
    let dumped: unknown;
    try {
      dumped = context.dump(res.error);
    } catch {
      dumped = undefined;
    }
    res.error.dispose();
    throw new Error(`sandbox internal script ${filename} failed: ${describeDumped(dumped)}`);
  }
  res.value.dispose();
}

/** Evaluate an expression expected to produce a string; returns null on any failure. */
function evalToString(
  context: QuickJSContext,
  code: string,
  filename: string,
): { ok: true; value: string } | { ok: false; errorHandle: QuickJSHandle } {
  const res = context.evalCode(code, filename, { type: "global" });
  if (res.error) return { ok: false, errorHandle: res.error };
  const isString = context.typeof(res.value) === "string";
  const value = isString ? context.getString(res.value) : "";
  res.value.dispose();
  if (!isString) return { ok: true, value: "" };
  return { ok: true, value };
}

function extractWarnings(context: QuickJSContext): string[] {
  const res = evalToString(context, WARNINGS_SCRIPT, "mib:warnings");
  if (!res.ok) {
    res.errorHandle.dispose();
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const item of parsed.slice(0, MAX_WARNINGS_HOST)) {
    let s: string;
    try {
      s = typeof item === "string" ? item : String(item);
    } catch {
      s = "[unprintable]";
    }
    out.push(s.length > MAX_WARNING_CHARS_HOST ? s.slice(0, MAX_WARNING_CHARS_HOST) + "…" : s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Syntax-check component source in a throwaway context (compile only — top
 * level code is never executed) and return the sha256 hash callers use as
 * the compile-cache key. Returns a typed error instead of throwing.
 */
export async function compileComponent(
  source: string,
  limitsIn?: Partial<Limits>,
): Promise<CompileResult> {
  const limits: Limits = { ...DEFAULT_LIMITS, ...limitsIn };
  const sourceBytes = utf8ByteLength(source);
  if (sourceBytes > limits.maxSourceBytes) {
    return {
      ok: false,
      code: "compile_error",
      message: `component source is ${sourceBytes} bytes; the limit is ${limits.maxSourceBytes} bytes`,
    };
  }

  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  try {
    runtime.setMemoryLimit(limits.memoryBytes);
    const state: ExecState = { interrupts: 0, timedOut: false, deadline: now() + limits.cpuMs };
    runtime.setInterruptHandler(() => {
      state.interrupts += 1;
      if (now() > state.deadline) {
        state.timedOut = true;
        return true;
      }
      return false;
    });
    const context = newHardenedContext(runtime);
    try {
      const res = context.evalCode(source, "component.js", { type: "global", compileOnly: true });
      if (res.error) {
        const err = sandboxErrorFromEval(context, res.error, state, limits, "compile");
        return { ok: false, code: "compile_error", message: err.message };
      }
      res.value.dispose();
      return { ok: true, hash: sha256Hex(source) };
    } finally {
      context.dispose();
    }
  } finally {
    runtime.dispose();
  }
}

/**
 * Execute a component's render function once, in a fresh capability-less
 * context, under hard limits. Resolves with bounded, host-parsed output;
 * rejects with SandboxError for every sandbox-attributable failure.
 */
export async function executeRender(
  source: string,
  input: RenderInput,
  limitsIn?: Partial<Limits>,
): Promise<RenderResult> {
  const limits: Limits = { ...DEFAULT_LIMITS, ...limitsIn };

  const sourceBytes = utf8ByteLength(source);
  if (sourceBytes > limits.maxSourceBytes) {
    throw new SandboxError(
      "compile_error",
      `component source is ${sourceBytes} bytes; the limit is ${limits.maxSourceBytes} bytes`,
    );
  }

  // Host-side serialization: only JSON text ever crosses the boundary, so
  // host prototypes, functions, and exotic objects cannot leak in. A
  // non-JSON-serializable props graph (circular, BigInt) is caller misuse
  // and surfaces as the underlying TypeError.
  const payload = JSON.stringify({ props: input.props, frame: input.frame });

  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  try {
    runtime.setMemoryLimit(limits.memoryBytes);
    const state: ExecState = { interrupts: 0, timedOut: false, deadline: Infinity };
    runtime.setInterruptHandler(() => {
      state.interrupts += 1;
      if (now() > state.deadline) {
        state.timedOut = true;
        return true;
      }
      return false;
    });

    const context = newHardenedContext(runtime);
    try {
      runTrustedScript(context, SETUP_SCRIPT, "mib:setup");

      // Everything from here on is on the user's CPU budget.
      state.deadline = now() + limits.cpuMs;

      // 1. Parse-only pass: precise compile_error classification. A later
      //    SyntaxError (e.g. user code calling JSON.parse("{")) stays a
      //    runtime_error.
      const compiled = context.evalCode(source, "component.js", {
        type: "global",
        compileOnly: true,
      });
      if (compiled.error) {
        throw sandboxErrorFromEval(context, compiled.error, state, limits, "compile");
      }
      compiled.value.dispose();

      // 2. Run the top level so `function render` / `const render =` bind.
      const ran = context.evalCode(source, "component.js", { type: "global" });
      if (ran.error) {
        throw sandboxErrorFromEval(context, ran.error, state, limits, "run");
      }
      ran.value.dispose();

      // 3. render must exist and be callable.
      const kindRes = evalToString(context, "typeof render", "mib:check");
      if (!kindRes.ok) {
        throw sandboxErrorFromEval(context, kindRes.errorHandle, state, limits, "run");
      }
      if (kindRes.value !== "function") {
        throw new SandboxError(
          "not_a_function",
          kindRes.value === "undefined"
            ? "the component must define render — `function render({ props, frame }) { ... }` or `const render = ({ props, frame }) => ...`"
            : `render must be a function, but it is a ${kindRes.value || "non-function value"}`,
        );
      }

      // 4. Marshal input. Injected only now, after user top-level code ran,
      //    and read+deleted as the harness's first step.
      const payloadHandle = context.newString(payload);
      try {
        context.setProp(context.global, INPUT_GLOBAL, payloadHandle);
      } finally {
        payloadHandle.dispose();
      }

      // 5. Call render synchronously inside the sandbox.
      const harness = context.evalCode(buildHarnessScript(limits.maxOutputBytes), "mib:harness", {
        type: "global",
      });
      if (harness.error) {
        throw sandboxErrorFromEval(context, harness.error, state, limits, "run");
      }
      const isString = context.typeof(harness.value) === "string";
      const outStr = isString ? context.getString(harness.value) : "";
      harness.value.dispose();
      if (!isString) {
        throw new SandboxError("output_invalid", "render output could not be serialized to JSON");
      }

      // 6. Harness sentinels (never collide with JSON.stringify output).
      if (outStr.length > 0 && outStr.charCodeAt(0) === SENTINEL_PREFIX_CODE) {
        const tag = outStr.slice(1);
        if (tag === "async") {
          throw new SandboxError(
            "async_result",
            "render returned a Promise/thenable; render must return its nodes synchronously (no async, no await)",
          );
        }
        if (tag === "nojson") {
          throw new SandboxError(
            "output_invalid",
            "render returned a value JSON cannot represent (undefined, a function, or a symbol); return an array of nodes",
          );
        }
        if (tag.startsWith("big ")) {
          throw new SandboxError(
            "output_too_large",
            `render output serialized to ${tag.slice(4)} characters, over the ${limits.maxOutputBytes}-byte output limit`,
          );
        }
        throw new SandboxError("output_invalid", "render output used a reserved sentinel value");
      }

      // 7. Authoritative host-side checks: UTF-8 bytes, JSON validity, array
      //    shape, node count. Everything beyond that is the renderer's gate.
      const outBytes = utf8ByteLength(outStr);
      if (outBytes > limits.maxOutputBytes) {
        throw new SandboxError(
          "output_too_large",
          `render output is ${outBytes} bytes, over the ${limits.maxOutputBytes}-byte output limit`,
        );
      }
      let parsedOut: unknown;
      try {
        parsedOut = JSON.parse(outStr);
      } catch {
        throw new SandboxError("output_invalid", "render output is not valid JSON");
      }
      if (!Array.isArray(parsedOut)) {
        throw new SandboxError(
          "output_invalid",
          `render must return an array of nodes (got ${parsedOut === null ? "null" : typeof parsedOut})`,
        );
      }
      if (parsedOut.length > limits.maxNodes) {
        throw new SandboxError(
          "output_too_large",
          `render returned too many nodes: ${parsedOut.length} > the ${limits.maxNodes}-node limit`,
        );
      }

      // 8. Warnings, best-effort, under a short fresh deadline so hostile
      //    values in the capture box cannot stall the host.
      state.deadline = now() + WARNINGS_GRACE_MS;
      const warnings = extractWarnings(context);

      return { nodes: parsedOut, warnings };
    } finally {
      context.dispose();
    }
  } finally {
    runtime.dispose();
  }
}

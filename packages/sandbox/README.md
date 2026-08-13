# @makeitbeauty/sandbox

Capability-less QuickJS-in-WASM execution engine for **code components** — the
Figma-plugin / Shopify-Functions pattern: third-party code may add LOGIC to the
declarative universe, never capabilities. One engine, used identically by the
renderer (Node) and the editor (browser), so preview parity extends to code.
Contract: `docs/architecture.md` §7.6.

```ts
import { compileComponent, executeRender, SandboxError } from "@makeitbeauty/sandbox";

const compiled = await compileComponent(source);        // { ok: true, hash } | { ok: false, code, message }
const { nodes, warnings } = await executeRender(source, {
  props: { title: "Hello", series: [1, 2, 3] },
  frame: { w: 400, h: 200 },
}); // throws SandboxError on any violation
```

A code component is a **pure render function**:

```js
function render({ props, frame }) {
  return [{ type: "text", text: props.title, x: 0, y: 0 }]; // FragmentNode[]
}
```

## Threat model

The source string is **assumed hostile**. The sandbox's only promises to the
rest of the platform:

- **Output is data, never capability.** The sandbox hands back a plain JSON
  array (parsed host-side from JSON text), bounded in bytes and node count.
  Structural node validation (text/rect/image shape) stays the renderer's job,
  and sandbox output flows through the exact same downstream gates as
  declarative fragments: schema validation, expansion, compositing, sanitizer.
  A fully compromised sandbox can still only "speak" text/rect/image.
- **No host reach.** No network, no filesystem, no timers, no host objects.
  Only JSON text crosses the boundary in either direction — host prototypes,
  functions, and exotic objects cannot leak in; `__proto__`/`constructor` keys
  in props arrive inside as plain data keys and come back out the same way
  (both directions are prototype-pollution-safe by construction: `JSON.parse`
  creates own data properties on both sides).
- **Determinism is enforced by the runtime**, not by trust: no clocks, no
  entropy (see the removed list below). Publish executes twice and
  byte-compares — this package provides the deterministic single execution.
- **Bounded resources.** CPU via the QuickJS interrupt handler against a
  monotonic host clock (`performance.now`), memory via the runtime allocator
  limit, plus source/output/node-count caps. Oversized output is length-checked
  *inside* the sandbox before the string is ever pulled host-side; the
  authoritative UTF-8 byte check happens host-side after the (pre-capped) pull.
- **Fresh context per execution.** Nothing survives between renders or users —
  globals, prototype pollution, monkey-patches all die with the context.
  Compiled components are cached by `sha256(source)` (the hash this package
  returns), never by live context.
- **Errors are sanitized.** Sandbox-side error text is control-character
  stripped and length-capped (1024 chars) before it reaches a host-side
  `SandboxError` — debuggable for authors, inert and bounded for the host.

When in doubt the engine rejects: async results, non-array output,
non-JSON-representable output, and reserved-sentinel collisions are all typed
errors, never best-effort acceptance.

## API

### `executeRender(source, input, limits?) => Promise<{ nodes, warnings }>`

Executes `render({ props, frame })` once in a fresh hardened context.

- `input: { props: Record<string, unknown>, frame: { w, h } }`. Props must be
  JSON-serializable (they are `JSON.stringify`'d host-side and rebuilt inside
  the sandbox with `JSON.parse`); non-JSON values (functions, class methods)
  silently drop, exactly like `JSON.stringify` does.
- `render` may be a `function render() {}` declaration or a top-level
  `const render = ...`. It must return synchronously; a returned
  Promise/thenable is an `async_result` error.
- `nodes` is a plain JSON array (≤ `maxNodes` elements, ≤ `maxOutputBytes`
  serialized). `warnings` is bounded `console.log/info/warn/error/debug`
  output captured inside the sandbox (max 32 entries of ≤ 512 chars, plus a
  truncation marker) — authors need debug output at publish time.
- Throws `SandboxError` for every sandbox-attributable failure (below).

### `compileComponent(source, limits?) => Promise<CompileResult>`

Syntax-checks in a throwaway context (`compileOnly` — top-level code is
**not** executed) and returns `{ ok: true, hash }` with the sha256 hex of the
source, or `{ ok: false, code: "compile_error", message }`. Callers cache
compiled components by `hash`.

### `SandboxError` codes

| code | meaning |
| --- | --- |
| `compile_error` | syntax error, or source over `maxSourceBytes` |
| `runtime_error` | user code threw (includes the sanitized message + sandbox stack) |
| `timeout` | cpu budget exceeded (interrupt-handler deadline) |
| `memory` | runtime allocator limit exceeded |
| `not_a_function` | no `render`, or `render` is not callable |
| `async_result` | `render` returned a Promise/thenable |
| `output_too_large` | serialized output over `maxOutputBytes`, or more than `maxNodes` nodes (message distinguishes the two) |
| `output_invalid` | output not JSON-representable, not valid JSON, or not an array |

### Limits (`DEFAULT_LIMITS`, override per call via `Partial<Limits>`)

| limit | default | enforced |
| --- | --- | --- |
| `cpuMs` | 50 | interrupt handler vs. monotonic host deadline; interrupts are counted and reported |
| `memoryBytes` | 32 MiB | QuickJS runtime allocator limit |
| `maxNodes` | 512 | host-side after parse |
| `maxSourceBytes` | 64 KiB | host-side (UTF-8), before any context is created |
| `maxOutputBytes` | 512 KiB | in-sandbox UTF-16 pre-check (never pull oversized strings), then authoritative host-side UTF-8 check |

Violations are typed errors here; the *policy* (§7.6: publish-time rejection,
render-time placeholder + warning — never a failed render) lives in callers.

### `warmup() => Promise<void>`

Optional: pre-compiles the wasm module so the first render doesn't pay for it.

## Removed capabilities (exact list)

Replaced with **throwing stubs** whose message explains that determinism is
enforced (`STUBBED_GLOBALS`):

- `Date` (also excluded at the QuickJS intrinsic level — the real constructor
  never exists in the context, so there is no resurrection path; the stub
  exists for the error message), `Date.now`, `Date.parse`, `Date.UTC`
- `Math.random`

Guaranteed **absent** (`REMOVED_GLOBALS`) — bare QuickJS defines none of
these, and the setup script deletes/undefines them defensively so the
guarantee survives engine upgrades:

- scheduling: `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`,
  `setImmediate`, `clearImmediate`, `queueMicrotask`,
  `requestAnimationFrame`, `cancelAnimationFrame`
- host reach: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
  `Worker`, `SharedWorker`, `importScripts`, `require`, `module`, `exports`,
  `process`, `global`, `window`, `self`, `document`, `navigator`,
  `localStorage`, `sessionStorage`, `indexedDB`, `caches`
- entropy/clocks: `crypto`, `performance`
- QuickJS std-lib/CLI helpers (never enabled, banned anyway): `std`, `os`,
  `scriptArgs`, `print`, `gc`, `load`, `read`, `readbuffer`, `quit`

`console` is **replaced** with the bounded capture described above. The
globals `__mib_input_json__` and `__mib_logs__` (and the `__mib_` prefix
generally) are reserved by the engine; components that tamper with them only
corrupt their own input/warnings, never the host.

`eval`/`Function` remain available (QuickJS defaults per §7.6) — they evaluate
inside the same capability-less context and add nothing.

## Dependency: the singlefile sync variant

This package uses the quickjs-emscripten family as
[`quickjs-emscripten-core`](https://github.com/justjake/quickjs-emscripten)
plus the **`@jitl/quickjs-singlefile-mjs-release-sync`** build variant — that
is upstream's supported way to select a non-default variant:

- **singlefile**: the wasm binary is embedded in the JS module as base64 —
  zero asset/bundler configuration in both Node and Vite (no `.wasm` file to
  locate, copy, or serve). **Size cost**: base64 inflates the ~1.1 MB wasm to
  a ~1.5 MB JS file (~+33%) that also stays resident as a JS string after
  instantiation. Accepted deliberately: the renderer is a long-lived server
  and the editor loads it once (and can lazy-import + `warmup()` behind user
  intent); in exchange, the same import line works everywhere and preview
  parity can never break on asset plumbing.
- **mjs**: ESM, matching this package (`type: module`, NodeNext) and Vite.
- **release**: optimized build (the debug variant costs ~2x runtime).
- **sync**: plain synchronous wasm (no ASYNCIFY) — `render` is required to be
  synchronous by contract, and the sync build is smaller and faster. Module
  *instantiation* is still async (`WebAssembly.compile`), which is why the API
  is Promise-based; the module is memoized after the first call.

Everything else in this package is dependency-free (including the pure-TS
sha256 used for compile-cache hashing, so hashing works sync and identically
in Node and the browser).

## Execution model (per §7.6)

Per `executeRender` call:

1. Host-side: source size check, `JSON.stringify({props, frame})`.
2. Fresh runtime (memory limit, interrupt handler) + fresh context with the
   `Date` intrinsic excluded.
3. Trusted setup script: bounded console capture, determinism stubs, banned
   global removal.
4. CPU deadline starts. Source is parse-checked (`compileOnly`) for precise
   `compile_error` classification, then evaluated as a classic script
   (`type: "global"`, so `import`/`export` are syntax errors).
5. `typeof render` must be `"function"`.
6. The input JSON is injected (only after user top-level code ran), and a
   trusted harness rebuilds `{props, frame}` via in-sandbox `JSON.parse`,
   calls `render` synchronously, rejects thenables, serializes with
   in-sandbox `JSON.stringify`, and refuses to return strings over the output
   cap (sentinel statuses use a raw `U+0001` prefix, which `JSON.stringify`
   output can never start with — unspoofable from data).
7. Host-side: UTF-8 byte check, `try { JSON.parse }`, `Array.isArray`, node
   count. (Host `JSON.parse` failures — including pathological nesting from a
   hijacked in-sandbox `JSON.stringify` — are caught and become
   `output_invalid`.)
8. Warnings extraction runs under a short fresh grace deadline so hostile
   values planted in the capture box cannot stall the host; on any failure,
   warnings degrade to `[]`.
9. Context and runtime are disposed — nothing survives.

Note on wasm memory: all executions in a process share one wasm heap, which
grows but never shrinks; per-execution isolation and the `memoryBytes` cap
are enforced by per-execution QuickJS runtimes inside that heap.

## Lineage

`docs/architecture.md` §7.6 (code components: sandboxed) — which itself
follows §7.5 (registry immutability + validation) and §9.7 (registry rules).
The founding research identified capability-less QuickJS-in-WASM as the only
safe shape for third-party code on this platform; this package is that
decision, executable.

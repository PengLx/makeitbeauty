/**
 * The JavaScript that runs INSIDE the QuickJS context: capability removal,
 * bounded console capture, the render harness, and warnings extraction.
 * Everything here is trusted host-authored code; user source only ever runs
 * through evalCode with these already in place.
 */

/** Reserved global used to pass the input payload into the sandbox. */
export const INPUT_GLOBAL = "__mib_input_json__";
/** Reserved global holding the bounded console-capture box. */
export const LOGS_GLOBAL = "__mib_logs__";

/**
 * Globals replaced with throwing stubs whose message explains that
 * determinism is enforced. (`Date` is additionally excluded at the intrinsic
 * level — the real constructor never exists in the context; the stub exists
 * purely to give authors a good error message.)
 */
export const STUBBED_GLOBALS = ["Date", "Date.now", "Date.parse", "Date.UTC", "Math.random"] as const;

/**
 * Globals guaranteed absent from the context. Bare QuickJS defines none of
 * these (they are host APIs), but the setup script deletes/undefines them
 * defensively so the guarantee holds even if a future engine version or
 * variant grows one of them. Referencing any of these from component code is
 * a ReferenceError (or `undefined`), surfaced as a runtime_error.
 */
export const REMOVED_GLOBALS = [
  // scheduling / async escape hatches
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "setImmediate", "clearImmediate", "queueMicrotask",
  "requestAnimationFrame", "cancelAnimationFrame",
  // network / host reach
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker",
  "importScripts", "require", "module", "exports", "process", "global",
  "window", "self", "document", "navigator",
  "localStorage", "sessionStorage", "indexedDB", "caches",
  // entropy / clocks beyond Date
  "crypto", "performance",
  // quickjs std-lib / CLI helpers, in case a variant ever enables them
  "std", "os", "scriptArgs", "print", "gc", "load", "read", "readbuffer", "quit",
] as const;

export const MAX_CONSOLE_ENTRIES = 32;
export const MAX_CONSOLE_ENTRY_CHARS = 512;

/**
 * Runs first in every fresh context. Installs bounded console capture,
 * replaces Date/Math.random with throwing determinism stubs, and removes the
 * REMOVED_GLOBALS list.
 */
export const SETUP_SCRIPT = `"use strict";
(() => {
  var G = globalThis;

  // ---- bounded console capture ------------------------------------------
  var entries = [];
  var state = { truncated: false };
  Object.defineProperty(G, ${JSON.stringify(LOGS_GLOBAL)}, {
    value: Object.freeze({ entries: entries, state: state }),
    writable: false,
    enumerable: false,
    configurable: false,
  });
  var MAX_ENTRIES = ${MAX_CONSOLE_ENTRIES};
  var MAX_CHARS = ${MAX_CONSOLE_ENTRY_CHARS};
  function fmtOne(a) {
    if (typeof a === "string") return a;
    try {
      var j = JSON.stringify(a);
      return j === undefined ? String(a) : j;
    } catch (e) {
      try { return String(a); } catch (e2) { return "[unprintable]"; }
    }
  }
  function capture() {
    if (entries.length >= MAX_ENTRIES) { state.truncated = true; return; }
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(fmtOne(arguments[i]));
    var s = parts.join(" ");
    if (s.length > MAX_CHARS) s = s.slice(0, MAX_CHARS) + "\\u2026";
    entries.push(s);
  }
  G.console = { log: capture, info: capture, warn: capture, error: capture, debug: capture };

  // ---- determinism: no clocks, no entropy -------------------------------
  function deny(name) {
    return function () {
      throw new Error(
        name +
          " is disabled: code components must be deterministic. render() is a" +
          " pure function of { props, frame }; publish executes it twice and" +
          " byte-compares the output."
      );
    };
  }
  var dateStub = deny("Date");
  dateStub.now = deny("Date.now");
  dateStub.parse = deny("Date.parse");
  dateStub.UTC = deny("Date.UTC");
  G.Date = dateStub;
  Math.random = deny("Math.random");

  // ---- no host-reaching or scheduling APIs, ever ------------------------
  var banned = ${JSON.stringify(REMOVED_GLOBALS)};
  for (var b = 0; b < banned.length; b++) {
    var name = banned[b];
    try { delete G[name]; } catch (e) {}
    if (typeof G[name] !== "undefined") {
      try { G[name] = undefined; } catch (e) {}
    }
  }
})();
`;

/**
 * Sentinel prefix (U+0001) for harness status strings. JSON.stringify output
 * can never start with a raw control character (controls inside JSON strings
 * are emitted as six-character escapes), so there is no collision with real
 * output.
 */
export const SENTINEL_PREFIX_CODE = 1;

/**
 * The render call. Reads and deletes the input payload global, builds the
 * {props, frame} graph inside the sandbox via JSON.parse (host prototypes
 * never cross the boundary), calls render() synchronously, rejects
 * thenables, serializes with the sandbox's JSON.stringify, and pre-checks
 * the serialized length so oversized output is never pulled host-side.
 * The UTF-16 length pre-check is conservative (UTF-8 bytes >= UTF-16 units);
 * the authoritative byte check happens host-side.
 */
export function buildHarnessScript(maxOutputBytes: number): string {
  const cap = Math.max(0, Math.floor(maxOutputBytes));
  return `(() => {
  var G = globalThis;
  var json = G[${JSON.stringify(INPUT_GLOBAL)}];
  delete G[${JSON.stringify(INPUT_GLOBAL)}];
  var input = JSON.parse(json);
  var out = render(input);
  if (out !== null && (typeof out === "object" || typeof out === "function") && typeof out.then === "function") {
    return "\\u0001async";
  }
  var s = JSON.stringify(out);
  if (typeof s !== "string") return "\\u0001nojson";
  if (s.length > ${cap}) return "\\u0001big " + s.length;
  return s;
})()`;
}

/**
 * Warnings extraction. Runs after a successful render under a short, fresh
 * grace deadline (user code may have shoved hostile values into the capture
 * box; a looping toString gets interrupted and warnings degrade to []).
 * Every entry is re-coerced and re-capped here, and the host re-validates
 * once more after JSON.parse.
 */
export const WARNINGS_SCRIPT = `(() => {
  var out = [];
  try {
    var box = globalThis[${JSON.stringify(LOGS_GLOBAL)}];
    var entries = box && box.entries;
    if (entries) {
      var n = entries.length;
      if (typeof n !== "number" || !(n >= 0)) n = 0;
      if (n > ${MAX_CONSOLE_ENTRIES}) n = ${MAX_CONSOLE_ENTRIES};
      for (var i = 0; i < n; i++) {
        var s;
        try {
          s = entries[i];
          s = typeof s === "string" ? s : String(s);
        } catch (e) {
          s = "[unprintable]";
        }
        if (s.length > ${MAX_CONSOLE_ENTRY_CHARS + 8}) s = s.slice(0, ${MAX_CONSOLE_ENTRY_CHARS}) + "\\u2026";
        out.push(s);
      }
    }
    if (box && box.state && box.state.truncated) out.push("[console: further output truncated]");
  } catch (e) {}
  return JSON.stringify(out);
})()`;

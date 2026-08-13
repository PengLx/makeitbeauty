import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  MAX_CONSOLE_ENTRIES,
  REMOVED_GLOBALS,
  SandboxError,
  compileComponent,
  executeRender,
  warmup,
  type Limits,
} from "./index.js";

const FRAME = { w: 400, h: 200 };

const run = (source: string, props: Record<string, unknown> = {}, limits?: Partial<Limits>) =>
  executeRender(source, { props, frame: FRAME }, limits);

async function runError(
  source: string,
  props: Record<string, unknown> = {},
  limits?: Partial<Limits>,
): Promise<SandboxError> {
  try {
    await run(source, props, limits);
  } catch (e) {
    expect(e).toBeInstanceOf(SandboxError);
    return e as SandboxError;
  }
  throw new Error("expected executeRender to throw a SandboxError");
}

// Pay the one-time wasm compile before any timing-sensitive test runs.
beforeAll(() => warmup());

describe("contract constants", () => {
  it("DEFAULT_LIMITS matches architecture.md §7.6", () => {
    expect(DEFAULT_LIMITS).toEqual({
      cpuMs: 50,
      memoryBytes: 32 * 1024 * 1024,
      maxNodes: 512,
      maxSourceBytes: 64 * 1024,
      maxOutputBytes: 512 * 1024,
    });
  });
});

describe("happy path", () => {
  it("renders nodes from props and frame (function declaration)", async () => {
    const { nodes, warnings } = await run(
      `function render({ props, frame }) {
        return [
          { type: "text", text: props.title, x: 0, y: 0 },
          { type: "rect", w: frame.w, h: frame.h },
        ];
      }`,
      { title: "Hello" },
    );
    expect(nodes).toEqual([
      { type: "text", text: "Hello", x: 0, y: 0 },
      { type: "rect", w: 400, h: 200 },
    ]);
    expect(warnings).toEqual([]);
  });

  it("accepts const render = arrow function", async () => {
    const { nodes } = await run(`const render = ({ frame }) => [{ w: frame.w * 2 }];`);
    expect(nodes).toEqual([{ w: 800 }]);
  });

  it("round-trips rich JSON props exactly", async () => {
    const props = {
      s: "str",
      n: 12.75,
      neg: -3,
      t: true,
      f: false,
      z: null,
      arr: [1, "two", { three: 3 }],
      nested: { deep: { deeper: ["ok", null, 0.5] } },
    };
    const { nodes } = await run(`function render({ props }) { return [props]; }`, props);
    expect(nodes).toEqual([props]);
  });

  it("passes series arrays (the §7.6 series prop type) through untouched", async () => {
    const series = Array.from({ length: 60 }, (_, i) => (i * 7) % 13);
    const { nodes } = await run(
      `function render({ props, frame }) {
        return props.series.map((v, i) => ({ type: "rect", x: i * 6, h: v * 4, w: frame.w }));
      }`,
      { series },
    );
    expect(nodes).toHaveLength(60);
    expect(nodes[7]).toEqual({ type: "rect", x: 42, h: ((7 * 7) % 13) * 4, w: 400 });
  });

  it("round-trips unicode byte-exactly (emoji, CJK, combining, RTL)", async () => {
    const text = "😀🌍 中文テスト é é مرحبا \u{1d54a} end";
    const { nodes } = await run(`function render({ props }) { return [{ text: props.text }]; }`, {
      text,
    });
    expect((nodes[0] as { text: string }).text).toBe(text);
  });

  it("captures console.log into warnings with argument formatting", async () => {
    const { nodes, warnings } = await run(
      `function render() {
        console.log("shape", { a: 1 }, 42, true, null);
        return [];
      }`,
    );
    expect(nodes).toEqual([]);
    expect(warnings).toEqual(['shape {"a":1} 42 true null']);
  });

  it("captures every console level, in call order", async () => {
    const { warnings } = await run(
      `function render() {
        console.log("one");
        console.warn("two");
        console.error("three");
        console.info("four");
        console.debug("five");
        return [];
      }`,
    );
    expect(warnings).toEqual(["one", "two", "three", "four", "five"]);
  });

  it("returns empty warnings when the component is silent", async () => {
    const { warnings } = await run(`function render() { return [{}]; }`);
    expect(warnings).toEqual([]);
  });

  it("caps a single console entry's length", async () => {
    const { warnings } = await run(
      `function render() { console.log("x".repeat(5000)); return []; }`,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.length).toBeLessThanOrEqual(520);
    expect(warnings[0]!.endsWith("…")).toBe(true);
  });

  it("caps the console entry count and appends a truncation marker", async () => {
    const { warnings } = await run(
      `function render() {
        for (let i = 0; i < 100; i++) console.log("entry", i);
        return [];
      }`,
    );
    expect(warnings).toHaveLength(MAX_CONSOLE_ENTRIES + 1);
    expect(warnings[0]).toBe("entry 0");
    expect(warnings[MAX_CONSOLE_ENTRIES - 1]).toBe(`entry ${MAX_CONSOLE_ENTRIES - 1}`);
    expect(warnings[MAX_CONSOLE_ENTRIES]).toBe("[console: further output truncated]");
  });
});

describe("determinism", () => {
  it("two executions of a math-heavy component are byte-equal", async () => {
    const source = `function render({ props, frame }) {
      let acc = 0.1;
      const out = [];
      for (let i = 1; i <= 200; i++) {
        acc = acc * 1.37 + Math.sin(i) * Math.sqrt(i) - Math.log(i + 1) / 3;
        acc = acc % 1000.25;
        out.push({ i, v: acc, w: frame.w / (i + 1) });
      }
      return [{ digest: JSON.stringify(out).length, last: acc }];
    }`;
    const a = await run(source, { seed: 7 });
    const b = await run(source, { seed: 7 });
    expect(JSON.stringify(a.nodes)).toBe(JSON.stringify(b.nodes));
  });

  it("two executions of a string/iteration component are byte-equal", async () => {
    const source = `function render({ props }) {
      const entries = Object.entries(props.data).sort((x, y) => (x[0] < y[0] ? -1 : 1));
      let s = "";
      for (const [k, v] of entries) s += k + "=" + v + ";";
      return [{ s, keys: Object.keys(props.data) }];
    }`;
    const props = { data: { b: 2, a: 1, c: 3, ü: "u", "😀": "e" } };
    const a = await run(source, props);
    const b = await run(source, props);
    expect(JSON.stringify(a.nodes)).toBe(JSON.stringify(b.nodes));
  });

  it("new Date() throws a runtime_error that explains determinism", async () => {
    const err = await runError(`function render() { return [new Date().toString()]; }`);
    expect(err.code).toBe("runtime_error");
    expect(err.message).toMatch(/Date is disabled/);
    expect(err.message).toMatch(/deterministic/);
  });

  it("Date.now() throws a runtime_error that explains determinism", async () => {
    const err = await runError(`function render() { return [Date.now()]; }`);
    expect(err.code).toBe("runtime_error");
    expect(err.message).toMatch(/Date\.now is disabled/);
    expect(err.message).toMatch(/deterministic/);
  });

  it("Math.random() throws a runtime_error that explains determinism", async () => {
    const err = await runError(`function render() { return [Math.random()]; }`);
    expect(err.code).toBe("runtime_error");
    expect(err.message).toMatch(/Math\.random is disabled/);
    expect(err.message).toMatch(/deterministic/);
  });

  it("every removed global is absent inside the sandbox", async () => {
    const source = `const names = ${JSON.stringify([...REMOVED_GLOBALS])};
      function render() {
        return [names.map((n) => typeof globalThis[n]).join(",")];
      }`;
    const { nodes } = await run(source);
    expect(nodes[0]).toBe(Array(REMOVED_GLOBALS.length).fill("undefined").join(","));
  });

  it("calling setTimeout is a ReferenceError runtime_error", async () => {
    const err = await runError(`function render() { setTimeout(() => {}, 0); return []; }`);
    expect(err.code).toBe("runtime_error");
    expect(err.message).toMatch(/setTimeout/);
  });
});

describe("limits", () => {
  it("an infinite loop in render times out within ~2x the cpu budget", async () => {
    const t0 = performance.now();
    const err = await runError(`function render() { while (true) {} }`, {}, { cpuMs: 250 });
    const elapsed = performance.now() - t0;
    expect(err.code).toBe("timeout");
    expect(err.message).toMatch(/250ms/);
    expect(err.message).toMatch(/interrupt/);
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThanOrEqual(2 * 250 + 100);
  });

  it("an infinite loop at the top level also times out", async () => {
    const err = await runError(`while (true) {} function render() { return []; }`, {}, { cpuMs: 150 });
    expect(err.code).toBe("timeout");
  });

  it("an unbounded allocation loop hits the memory limit", async () => {
    const err = await runError(
      `function render() {
        const a = [];
        while (true) a.push({ x: 1, y: [1, 2, 3], s: "block" });
      }`,
      {},
      { cpuMs: 10000, memoryBytes: 8 * 1024 * 1024 },
    );
    expect(err.code).toBe("memory");
    expect(err.message).toMatch(/memory limit of 8388608 bytes/);
  });

  it("a huge output string is rejected before being pulled host-side", async () => {
    const err = await runError(`function render() { return ["y".repeat(1000000)]; }`);
    expect(err.code).toBe("output_too_large");
    expect(err.message).toMatch(/characters/);
    expect(err.message).toMatch(new RegExp(String(DEFAULT_LIMITS.maxOutputBytes)));
  });

  it("output bytes are measured in UTF-8, not UTF-16 units", async () => {
    // 500 emoji = 1000 UTF-16 units but ~2000 UTF-8 bytes: passes the
    // in-sandbox unit pre-check, fails the authoritative host byte check.
    const err = await runError(
      `function render() { return ["\\u{1F600}".repeat(500)]; }`,
      {},
      { maxOutputBytes: 1500 },
    );
    expect(err.code).toBe("output_too_large");
    expect(err.message).toMatch(/bytes/);
  });

  it("513 nodes is rejected as too many nodes; 512 is accepted", async () => {
    const make = (n: number) =>
      `function render() { return Array.from({ length: ${n} }, (_, i) => ({ i })); }`;
    const err = await runError(make(513));
    expect(err.code).toBe("output_too_large");
    expect(err.message).toMatch(/too many nodes: 513 > the 512-node limit/);

    const ok = await run(make(512));
    expect(ok.nodes).toHaveLength(512);
    expect(ok.nodes[511]).toEqual({ i: 511 });
  });

  it("respects a maxNodes override", async () => {
    const err = await runError(
      `function render() { return [1, 2, 3, 4, 5]; }`,
      {},
      { maxNodes: 4 },
    );
    expect(err.code).toBe("output_too_large");
    expect(err.message).toMatch(/too many nodes: 5 > the 4-node limit/);
  });

  it("respects a maxOutputBytes override", async () => {
    const err = await runError(
      `function render() { return ["hello hello hello"]; }`,
      {},
      { maxOutputBytes: 10 },
    );
    expect(err.code).toBe("output_too_large");
  });

  it("a JSON depth bomb is bounded by the output byte limit", async () => {
    const err = await runError(
      `function render() {
        const root = [];
        let cur = root;
        for (let i = 0; i < 1500; i++) { const next = []; cur.push(next); cur = next; }
        return [root];
      }`,
      {},
      { maxOutputBytes: 2048 },
    );
    expect(err.code).toBe("output_too_large");
  });

  it("rejects source over maxSourceBytes in executeRender", async () => {
    const source = `function render() { return []; }\n// ${"p".repeat(DEFAULT_LIMITS.maxSourceBytes)}`;
    const err = await runError(source);
    expect(err.code).toBe("compile_error");
    expect(err.message).toMatch(/bytes/);
    expect(err.message).toMatch(new RegExp(String(DEFAULT_LIMITS.maxSourceBytes)));
  });

  it("rejects source over maxSourceBytes in compileComponent", async () => {
    const res = await compileComponent(`// ${"p".repeat(DEFAULT_LIMITS.maxSourceBytes)}`);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("compile_error");
      expect(res.message).toMatch(/bytes/);
    }
  });
});

describe("isolation", () => {
  it("globals set in run 1 are invisible in run 2 (fresh context per execution)", async () => {
    const first = await run(
      `function render() { globalThis.leak = "from-run-1"; return ["planted"]; }`,
    );
    expect(first.nodes).toEqual(["planted"]);
    const second = await run(`function render() { return [typeof globalThis.leak]; }`);
    expect(second.nodes).toEqual(["undefined"]);
  });

  it("sandbox Object.prototype pollution dies with its context and never reaches the host", async () => {
    await run(
      `function render() {
        Object.prototype.evil = "polluted";
        globalThis.Array.prototype.alsoEvil = 1;
        return [({}).evil];
      }`,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(({} as any).evil).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(([] as any).alsoEvil).toBeUndefined();
    const next = await run(`function render() { return [({}).evil === undefined]; }`);
    expect(next.nodes).toEqual([true]);
  });

  it("__proto__ in props arrives as a plain data key with no pollution anywhere", async () => {
    const props = JSON.parse('{"__proto__": {"polluted": "yes"}, "safe": 1}') as Record<
      string,
      unknown
    >;
    const { nodes } = await run(
      `function render({ props }) {
        const d = Object.getOwnPropertyDescriptor(props, "__proto__");
        return [{
          ownKey: Object.prototype.hasOwnProperty.call(props, "__proto__"),
          value: d ? d.value : null,
          sandboxClean: ({}).polluted === undefined,
          protoIsObjectProto: Object.getPrototypeOf(props) === Object.prototype,
          safe: props.safe,
        }];
      }`,
      props,
    );
    expect(nodes).toEqual([
      {
        ownKey: true,
        value: { polluted: "yes" },
        sandboxClean: true,
        protoIsObjectProto: true,
        safe: 1,
      },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(({} as any).polluted).toBeUndefined();
  });

  it("constructor/prototype keys in props are plain data too", async () => {
    const props = JSON.parse(
      '{"constructor": {"prototype": {"hax": true}}, "prototype": {"p": 2}}',
    ) as Record<string, unknown>;
    const { nodes } = await run(
      `function render({ props }) {
        return [{
          ctorIsPlain: props.constructor.prototype.hax === true,
          protoKey: props.prototype.p,
          sandboxClean: ({}).hax === undefined,
        }];
      }`,
      props,
    );
    expect(nodes).toEqual([{ ctorIsPlain: true, protoKey: 2, sandboxClean: true }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(({} as any).hax).toBeUndefined();
  });

  it("nodes containing __proto__ keys come back as data without touching host prototypes", async () => {
    const { nodes } = await run(
      `function render() { return JSON.parse('[{"__proto__": {"hax": 1}}]'); }`,
    );
    expect(nodes).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(nodes[0], "__proto__")).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(({} as any).hax).toBeUndefined();
  });

  it("marshalling is JSON-only: functions and class methods never cross", async () => {
    class Widget {
      a = 1;
      boom() {
        return "host code";
      }
    }
    const props = { w: new Widget(), fn: () => "host" } as unknown as Record<string, unknown>;
    const { nodes } = await run(
      `function render({ props }) {
        return [{
          keys: Object.keys(props),
          widgetKeys: Object.keys(props.w),
          method: typeof props.w.boom,
        }];
      }`,
      props,
    );
    // JSON.stringify drops the function prop entirely and keeps only the
    // instance's own enumerable data.
    expect(nodes).toEqual([{ keys: ["w"], widgetKeys: ["a"], method: "undefined" }]);
  });

  it("sentinel values cannot be spoofed through render output data", async () => {
    // A returned string starting with U+0001 is data; JSON.stringify escapes
    // it, so it never collides with the harness status sentinels.
    const { nodes } = await run(`function render() { return ["\\u0001async"]; }`);
    expect(nodes).toEqual(["async"]);
  });
});

describe("errors", () => {
  it("SandboxError is a well-formed Error subclass", async () => {
    const err = await runError(`function render() { throw new Error("x"); }`);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SandboxError);
    expect(err.name).toBe("SandboxError");
    expect(typeof err.code).toBe("string");
  });

  it("syntax errors are compile_error with the sandbox-side message", async () => {
    const err = await runError(`function render( { return []; }`);
    expect(err.code).toBe("compile_error");
    expect(err.message).toMatch(/SyntaxError/);
  });

  it("compileComponent returns the sha256 hash callers cache by", async () => {
    const source = `function render({ props }) { return [{ text: props.title }]; }`;
    const res = await compileComponent(source);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.hash).toBe(createHash("sha256").update(source, "utf8").digest("hex"));
    }
    const again = await compileComponent(source);
    expect(again).toEqual(res);
    const other = await compileComponent(source + " ");
    expect(other.ok).toBe(true);
    if (other.ok && res.ok) expect(other.hash).not.toBe(res.hash);
  });

  it("compileComponent only parses — top-level code is not executed", async () => {
    const res = await compileComponent(
      `throw new Error("must not run"); function render() { return []; }`,
    );
    expect(res.ok).toBe(true);
  });

  it("compileComponent reports syntax errors with location info", async () => {
    const res = await compileComponent(`const render = ({) => [];`);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("compile_error");
      expect(res.message).toMatch(/SyntaxError/);
      expect(res.message).toMatch(/component\.js/);
    }
  });

  it("a runtime SyntaxError stays runtime_error, not compile_error", async () => {
    const err = await runError(`function render() { return [JSON.parse("{")]; }`);
    expect(err.code).toBe("runtime_error");
    expect(err.message).toMatch(/SyntaxError/);
  });

  it("missing render is not_a_function with guidance", async () => {
    const err = await runError(`const draw = () => [];`);
    expect(err.code).toBe("not_a_function");
    expect(err.message).toMatch(/must define render/);
  });

  it("a non-function render is not_a_function naming the type", async () => {
    const err = await runError(`const render = 5;`);
    expect(err.code).toBe("not_a_function");
    expect(err.message).toMatch(/number/);
  });

  it("an async render function is async_result", async () => {
    const err = await runError(`async function render() { return []; }`);
    expect(err.code).toBe("async_result");
    expect(err.message).toMatch(/synchronous/);
  });

  it("a returned Promise is async_result", async () => {
    const err = await runError(`function render() { return Promise.resolve([]); }`);
    expect(err.code).toBe("async_result");
  });

  it("a returned plain thenable is async_result", async () => {
    const err = await runError(`function render() { return { then() {} }; }`);
    expect(err.code).toBe("async_result");
  });

  it("a thrown Error surfaces its message and sandbox stack", async () => {
    const err = await runError(
      `function render() { throw new Error("my specific bug in line four"); }`,
    );
    expect(err.code).toBe("runtime_error");
    expect(err.message).toMatch(/my specific bug in line four/);
    expect(err.message).toMatch(/component\.js/);
  });

  it("a thrown non-Error value surfaces too", async () => {
    const err = await runError(`function render() { throw "boom-string"; }`);
    expect(err.code).toBe("runtime_error");
    expect(err.message).toMatch(/boom-string/);
  });

  it("error messages are length-capped", async () => {
    const err = await runError(`function render() { throw new Error("x".repeat(50000)); }`);
    expect(err.code).toBe("runtime_error");
    expect(err.message.length).toBeLessThanOrEqual(1100);
    expect(err.message).toMatch(/truncated/);
  });

  it("non-array returns are output_invalid", async () => {
    for (const [body, hint] of [
      ["return { a: 1 };", "object"],
      ["return 42;", "number"],
      ["return null;", "null"],
      ['return "nodes";', "string"],
    ] as const) {
      const err = await runError(`function render() { ${body} }`);
      expect(err.code, body).toBe("output_invalid");
      expect(err.message, body).toContain(hint);
    }
  });

  it("returning undefined (no return) is output_invalid", async () => {
    const err = await runError(`function render() {}`);
    expect(err.code).toBe("output_invalid");
    expect(err.message).toMatch(/undefined/);
  });

  it("a hijacked JSON.stringify cannot smuggle non-JSON to the host", async () => {
    const err = await runError(
      `function render() { JSON.stringify = () => "not json at all"; return []; }`,
    );
    expect(err.code).toBe("output_invalid");
    expect(err.message).toMatch(/not valid JSON/);
  });
});

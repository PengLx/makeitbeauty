/**
 * Tiny host-environment shims typed against globalThis so the package
 * compiles with `"types": []` (no DOM lib, no @types/node) and runs
 * identically in Node and the browser.
 */

interface TextEncoderLike {
  encode(input: string): Uint8Array;
}

const g = globalThis as unknown as {
  TextEncoder?: new () => TextEncoderLike;
  performance?: { now(): number };
};

if (typeof g.TextEncoder !== "function") {
  throw new Error("@makeitbeauty/sandbox requires TextEncoder (Node >= 11 or any modern browser)");
}

const encoder: TextEncoderLike = new g.TextEncoder();

export function utf8Bytes(s: string): Uint8Array {
  return encoder.encode(s);
}

export function utf8ByteLength(s: string): number {
  return encoder.encode(s).length;
}

/**
 * Monotonic host clock in milliseconds. performance.now() everywhere that
 * has it (Node and all browsers); Date.now() only as a last-resort fallback.
 * The deadline enforcement in the interrupt handler must never run backwards.
 */
export const now: () => number =
  g.performance && typeof g.performance.now === "function"
    ? () => g.performance!.now()
    : () => Date.now();

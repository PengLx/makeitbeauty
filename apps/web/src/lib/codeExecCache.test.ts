/**
 * Execution-cache machinery for canvas code instances (§7.6): the key must
 * separate every input render() actually receives, and the LRU must evict
 * least-recently-USED (a get refreshes recency), so a design dragging one
 * hot component never evicts it in favour of stale entries.
 */
import { describe, expect, it } from "vitest";
import { codeExecKey, LruCache } from "./codeExecCache";

const FRAME = { w: 400, h: 160 };

describe("codeExecKey", () => {
  it("is stable for identical inputs", () => {
    expect(codeExecKey("abc", FRAME, { a: 1, s: [1, 2] })).toBe(
      codeExecKey("abc", FRAME, { a: 1, s: [1, 2] }),
    );
  });

  it("separates every execution input: source, frame, props", () => {
    const base = codeExecKey("abc", FRAME, { a: 1 });
    expect(codeExecKey("abd", FRAME, { a: 1 })).not.toBe(base);
    expect(codeExecKey("abc", { w: 401, h: 160 }, { a: 1 })).not.toBe(base);
    expect(codeExecKey("abc", { w: 400, h: 161 }, { a: 1 })).not.toBe(base);
    expect(codeExecKey("abc", FRAME, { a: 2 })).not.toBe(base);
    expect(codeExecKey("abc", FRAME, { a: 1, b: 0 })).not.toBe(base);
  });

  it("distinguishes series prop contents", () => {
    expect(codeExecKey("h", FRAME, { s: [1, 2, 3] })).not.toBe(
      codeExecKey("h", FRAME, { s: [1, 2, 4] }),
    );
  });
});

describe("LruCache", () => {
  it("stores and retrieves values under capacity", () => {
    const cache = new LruCache<number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(2);
    expect(cache.get("missing")).toBeUndefined();
    expect(cache.size).toBe(2);
  });

  it("evicts the least-recently-used entry beyond capacity", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // evicts "a"
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("get refreshes recency — a hot entry survives new inserts", () => {
    const cache = new LruCache<number>(2);
    cache.set("hot", 1);
    cache.set("cold", 2);
    expect(cache.get("hot")).toBe(1); // refresh
    cache.set("new", 3); // must evict "cold", not "hot"
    expect(cache.get("hot")).toBe(1);
    expect(cache.get("cold")).toBeUndefined();
    expect(cache.keys()).toEqual(["new", "hot"]);
  });

  it("set on an existing key updates in place without eviction", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 10);
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBe(10);
    expect(cache.get("b")).toBe(2);
  });

  it("rejects a nonsensical capacity", () => {
    expect(() => new LruCache(0)).toThrow();
  });
});

/**
 * Execution-result cache machinery for code-component instances on the
 * design canvas (§7.6). Pure and dependency-free so the key/LRU logic is
 * unit-testable; the async sandbox plumbing that uses it lives in
 * lib/codeExpand.ts.
 *
 * Rationale: render() is a pure function of (source, props, frame) — the
 * sandbox enforces determinism — so identical executions are cacheable
 * forever. The canvas re-renders on every patch/drag; without this cache each
 * re-mount would re-pay a fresh QuickJS context (~ms) per instance.
 */

/**
 * Cache key for one execution: the source's sha256 + the component frame +
 * the RESOLVED props JSON. Source hash (not the source) keeps keys short;
 * frame rides along because render() receives it (two components could share
 * source with different frames); props are the post-resolution merged values
 * — the exact sandbox input.
 */
export function codeExecKey(
  sourceHash: string,
  frame: { w: number; h: number },
  resolvedProps: Record<string, unknown>,
): string {
  return `${sourceHash}\n${frame.w}x${frame.h}\n${JSON.stringify(resolvedProps)}`;
}

/**
 * Minimal LRU over a Map (insertion order = recency order, the renderer's
 * codeCompileCache idiom): get refreshes, set evicts the least-recently-used
 * entry beyond capacity.
 */
export class LruCache<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error("LruCache capacity must be >= 1");
  }

  get(key: string): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }

  /** Test hook: current keys, least-recently-used first. */
  keys(): string[] {
    return [...this.map.keys()];
  }
}

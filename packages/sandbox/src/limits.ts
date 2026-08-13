/**
 * Resource limits for one sandboxed execution.
 * Contract: docs/architecture.md §7.6 — violations are a publish-time
 * rejection and a render-time placeholder + warning, never a failed render;
 * that policy lives in the callers, this package just enforces the limits.
 */
export interface Limits {
  /** CPU budget in milliseconds, enforced by the QuickJS interrupt handler against a monotonic host clock. */
  cpuMs: number;
  /** QuickJS runtime memory limit in bytes (allocator-level, includes all sandbox-side strings/objects). */
  memoryBytes: number;
  /** Maximum number of top-level nodes render() may return. */
  maxNodes: number;
  /** Maximum component source size in UTF-8 bytes. */
  maxSourceBytes: number;
  /** Maximum serialized output size in UTF-8 bytes. */
  maxOutputBytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  cpuMs: 50,
  memoryBytes: 32 * 1024 * 1024,
  maxNodes: 512,
  maxSourceBytes: 64 * 1024,
  maxOutputBytes: 512 * 1024,
};

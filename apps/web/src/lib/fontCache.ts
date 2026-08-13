/**
 * Invalidation bus for font-derived client state — the connectorCache
 * pattern: useFonts fetches once per mount; uploading or deleting a font in
 * the upload dialog changes what GET /v1/fonts returns, and the dialog can
 * live in a different subtree than the hooks, so a module-level subscription
 * is the channel: the dialog broadcasts, every mounted hook refetches, and
 * font pickers refresh without a reload.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** Registers a refetch trigger; returns the matching unsubscribe. */
export function subscribeFontCache(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tells every mounted font hook to refetch (upload/delete). */
export function invalidateFontCache(): void {
  // Snapshot: a listener unsubscribing mid-broadcast must not disturb iteration.
  for (const listener of [...listeners]) listener();
}

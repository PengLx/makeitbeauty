/**
 * Invalidation bus for connector-derived client state. useConnectors and
 * useConnectorData fetch once per mount; connecting or disconnecting a
 * connector in the DataDialog changes what those endpoints return, and the
 * dialog lives in a different subtree (header) than the hooks (Editor) — so
 * a module-level subscription is the channel: the dialog broadcasts, every
 * mounted hook refetches, and pickers/canvas update without a reload.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** Registers a refetch trigger; returns the matching unsubscribe. */
export function subscribeConnectorCache(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tells every mounted connector hook to refetch (connect/disconnect). */
export function invalidateConnectorCache(): void {
  // Snapshot: a listener unsubscribing mid-broadcast (unmount during a
  // re-render cascade) must not disturb iteration.
  for (const listener of [...listeners]) listener();
}

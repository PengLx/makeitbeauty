import { useEffect, useMemo, useState } from "react";
import { listConnectors, type ConnectorField, type ConnectorInfo } from "@/lib/api";

export interface ConnectorsState {
  /** null until loaded; stays null on 401/unavailable (surfaces hide). */
  connectors: ConnectorInfo[] | null;
  /** Every bindable field across connectors, for the insert-binding picker. */
  fields: ConnectorField[];
}

/**
 * Loads GET /v1/connectors once for binding surfaces. Deliberately silent on
 * failure (signed-out session, API down): the insert-field picker simply
 * doesn't render — the status UI with retry lives in DataDialog.
 */
export function useConnectors(): ConnectorsState {
  const [connectors, setConnectors] = useState<ConnectorInfo[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        setConnectors(await listConnectors(controller.signal));
      } catch {
        if (controller.signal.aborted) return;
        setConnectors(null);
      }
    })();
    return () => controller.abort();
  }, []);

  const fields = useMemo(
    () => (connectors ?? []).flatMap((c) => c.fields ?? []),
    [connectors],
  );

  return { connectors, fields };
}

import { useEffect, useState } from "react";
import { listConnectors, type ConnectorInfo } from "@/lib/api";
import { subscribeConnectorCache } from "@/lib/connectorCache";

export interface ConnectorsState {
  /** null until loaded; stays null on 401/unavailable (surfaces hide). */
  connectors: ConnectorInfo[] | null;
}

/**
 * Loads GET /v1/connectors ONCE per editor for every binding surface (the
 * instance-prop BindingControls and the text-node insert picker share this
 * single load), refetching when the DataDialog connects/disconnects a
 * connector (connectorCache invalidation). Deliberately silent on failure
 * (signed-out session, API down): binding UI degrades to Custom-only — the
 * status UI with retry lives in DataDialog.
 */
export function useConnectors(): ConnectorsState {
  const [connectors, setConnectors] = useState<ConnectorInfo[] | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(
    () => subscribeConnectorCache(() => setVersion((n) => n + 1)),
    [],
  );

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
  }, [version]);

  return { connectors };
}

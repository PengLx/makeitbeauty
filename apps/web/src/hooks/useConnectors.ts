import { useEffect, useState } from "react";
import { listConnectors, type ConnectorInfo } from "@/lib/api";

export interface ConnectorsState {
  /** null until loaded; stays null on 401/unavailable (surfaces hide). */
  connectors: ConnectorInfo[] | null;
}

/**
 * Loads GET /v1/connectors ONCE per editor for every binding surface (the
 * instance-prop BindingControls and the text-node insert picker share this
 * single load). Deliberately silent on failure (signed-out session, API
 * down): binding UI degrades to Custom-only — the status UI with retry
 * lives in DataDialog.
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

  return { connectors };
}

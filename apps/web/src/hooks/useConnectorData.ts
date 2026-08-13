import { useEffect, useState } from "react";
import { getConnectorData } from "@/lib/api";
import { subscribeConnectorCache } from "@/lib/connectorCache";
import type { ConnectorData } from "@/lib/expandFragment";

/**
 * Loads GET /v1/connectors/data ONCE per Editor mount — the merged
 * unfiltered snapshots the canvas's live-data display resolves {{connector.*}}
 * templates against — refetching when the DataDialog connects/disconnects a
 * connector (connectorCache invalidation), so fresh data reaches the canvas
 * without a reload. Deliberately silent on failure (401 signed-out session,
 * API down): stays null and the canvas keeps templates literal — the same
 * degrade path as useConnectors. A stale-while-editing snapshot is fine; the
 * API-rendered preview panel remains the data truth.
 */
export function useConnectorData(): ConnectorData {
  const [data, setData] = useState<ConnectorData>(null);
  const [version, setVersion] = useState(0);

  useEffect(
    () => subscribeConnectorCache(() => setVersion((n) => n + 1)),
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        setData(await getConnectorData(controller.signal));
      } catch {
        if (controller.signal.aborted) return;
        setData(null);
      }
    })();
    return () => controller.abort();
  }, [version]);

  return data;
}

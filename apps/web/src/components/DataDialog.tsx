import { useEffect, useState } from "react";
import { Database, RefreshCw } from "lucide-react";
import {
  ApiError,
  listConnectors,
  toApiError,
  type ConnectorInfo,
  type ConnectorStatus,
} from "@/lib/api";
import { ConnectorIcon } from "@/components/ConnectorIcon";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const STATUS_CLASSES: Record<ConnectorStatus, string> = {
  connected: "border-emerald-500/40 text-emerald-500",
  unconfigured: "text-muted-foreground",
  expired: "border-amber-500/40 text-amber-500",
};

function StatusBadge({ status }: { status: ConnectorStatus }) {
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
        STATUS_CLASSES[status] ?? "text-muted-foreground"
      }`}
    >
      {status}
    </span>
  );
}

interface Props {
  /** Under the dev fallback, unconfigured connectors hint at GitHub sign-in. */
  dev: boolean;
}

/**
 * Header "Data" button + read-only connector status list (GET /v1/connectors).
 * Settings CRUD (API keys, reconnect) comes later; today connecting means
 * signing in with GitHub (architecture §6: login is the first connector).
 */
export function DataDialog({ dev }: Props) {
  const [open, setOpen] = useState(false);
  const [connectors, setConnectors] = useState<ConnectorInfo[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError(null);
    (async () => {
      try {
        setConnectors(await listConnectors(controller.signal));
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(toApiError(e));
      }
    })();
    return () => controller.abort();
  }, [open, attempt]);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setConnectors(null);
      setError(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <Database data-icon="inline-start" />
          Data
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Data connectors</DialogTitle>
          <DialogDescription>
            Connectors feed live data into your designs — bind text to their
            fields from the inspector.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>
              Couldn't load connectors{" "}
              <code className="font-mono text-[10px] opacity-70">
                [{error.code}]
              </code>
            </AlertTitle>
            <AlertDescription>
              <p>{error.message}</p>
              <Button
                variant="secondary"
                size="xs"
                onClick={() => setAttempt((n) => n + 1)}
              >
                <RefreshCw data-icon="inline-start" />
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : connectors == null ? (
          <p className="text-xs text-muted-foreground">Loading connectors…</p>
        ) : connectors.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No connectors available yet.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {connectors.map((c) => (
              <li key={c.connector} className="rounded-lg border px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <ConnectorIcon
                      connector={c.connector}
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                    {c.connector}
                  </span>
                  <StatusBadge status={c.status} />
                </div>
                {c.status === "connected" && (
                  <p className="mt-0.5 pl-5.5 text-[11px] text-muted-foreground">
                    {c.fields.length} bindable field
                    {c.fields.length === 1 ? "" : "s"}
                  </p>
                )}
                {c.status === "unconfigured" && dev && (
                  <p className="mt-0.5 pl-5.5 text-[11px] text-muted-foreground">
                    Signing in with GitHub provisions this connector
                    automatically.
                  </p>
                )}
                {c.status === "expired" && (
                  <p className="mt-0.5 pl-5.5 text-[11px] text-muted-foreground">
                    Credentials expired — sign in with GitHub again to refresh.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useId, useState } from "react";
import { Database, Loader2, RefreshCw } from "lucide-react";
import {
  ApiError,
  deleteConnectorAccount,
  listConnectors,
  putConnectorAccount,
  toApiError,
  type ConnectorInfo,
  type ConnectorStatus,
} from "@/lib/api";
import {
  accountConfigSpec,
  forgetAccountHint,
  recallAccountHint,
  rememberAccountHint,
  type ConnectorConfigSpec,
} from "@/lib/connectorAccounts";
import { invalidateConnectorCache } from "@/lib/connectorCache";
import { ConnectorIcon } from "@/components/ConnectorIcon";
import { ConfirmDialog } from "@/components/ConfirmDialog";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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

/** Compact inline failure line (client validation or the §8 error envelope). */
function InlineError({ error }: { error: { code: string; message: string } }) {
  return (
    <p role="alert" className="text-[11px] text-destructive">
      {error.message}{" "}
      <code className="font-mono text-[10px] opacity-70">[{error.code}]</code>
    </p>
  );
}

/**
 * Config form + connect flow for one config-tier connector (§6 tiers
 * none/api_key): one input per the connector's spec, client-side validation
 * mirroring the server, PUT on submit, inline error envelope on failure.
 * Shown while unconfigured or expired (reconnect overwrites the account).
 */
function AccountForm({
  connector,
  spec,
  expired,
  onChanged,
}: {
  connector: string;
  spec: ConnectorConfigSpec;
  expired: boolean;
  onChanged: () => void;
}) {
  const inputId = useId();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(
    null,
  );

  async function connect() {
    if (busy) return;
    const trimmed = value.trim();
    const invalid = spec.validate(trimmed);
    if (invalid !== null) {
      setError({ code: "invalid_config", message: invalid });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await putConnectorAccount(connector, { [spec.field]: trimmed });
      // Remember only the spec's non-secret display hint (never credentials)
      // for the connected summary — the API seals config and never echoes it.
      rememberAccountHint(connector, spec.hintFromValue(trimmed));
      setValue("");
      onChanged();
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="mt-1.5 space-y-1 pl-5.5"
      onSubmit={(e) => {
        e.preventDefault();
        void connect();
      }}
    >
      {expired && (
        <p className="text-[11px] text-amber-500">
          Credentials expired — enter a new {spec.label.toLowerCase()} to
          reconnect.
        </p>
      )}
      <Label htmlFor={inputId} className="text-[11px] text-muted-foreground">
        {spec.label}
      </Label>
      <div className="flex items-center gap-1.5">
        <Input
          id={inputId}
          type={spec.inputType}
          value={value}
          placeholder={spec.placeholder}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          className="h-8 text-xs"
          onChange={(e) => setValue(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={busy || value.trim() === ""}>
          {busy ? (
            <>
              <Loader2 data-icon="inline-start" className="animate-spin" />
              Connecting…
            </>
          ) : (
            "Connect"
          )}
        </Button>
      </div>
      {error ? (
        <InlineError error={error} />
      ) : (
        <p className="text-[11px] text-muted-foreground">{spec.hint}</p>
      )}
    </form>
  );
}

/**
 * Connected state for a config-tier connector: masked summary ("API key
 * set" / username / feed host — never the credential) + Disconnect behind a
 * confirm, since removing the account downgrades every design binding this
 * connector's fields to placeholder values.
 */
function AccountSummary({
  connector,
  spec,
  fieldCount,
  onChanged,
}: {
  connector: string;
  spec: ConnectorConfigSpec;
  fieldCount: number;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function disconnect() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteConnectorAccount(connector);
      forgetAccountHint(connector);
      setConfirming(false);
      onChanged();
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-0.5 flex items-center justify-between gap-2 pl-5.5">
      <p className="min-w-0 truncate text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground/80">
          {spec.summary(recallAccountHint(connector))}
        </span>{" "}
        · {fieldCount} bindable field{fieldCount === 1 ? "" : "s"}
      </p>
      <Button
        variant="ghost"
        size="xs"
        className="shrink-0 text-muted-foreground hover:text-destructive"
        onClick={() => {
          setError(null);
          setConfirming(true);
        }}
      >
        Disconnect
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(next) => {
          if (!busy) setConfirming(next);
        }}
        title={`Disconnect ${connector}?`}
        description={
          <>
            The stored {spec.label.toLowerCase()} is removed from your
            account. Designs binding {connector} fields keep rendering, but
            show placeholder values until you reconnect.
          </>
        }
        confirmLabel={busy ? "Disconnecting…" : "Disconnect"}
        destructive
        busy={busy}
        error={error}
        onConfirm={() => void disconnect()}
      />
    </div>
  );
}

/**
 * One connector row with its management UI per auth tier (§6):
 * - github (OAuth-tier): status + sign-in hints only — login provisions it.
 * - config-tier (wakatime/leetcode/rss): AccountForm ↔ AccountSummary.
 * - unknown tiers (future OAuth connectors): status badge only.
 */
function ConnectorRow({
  info,
  dev,
  onChanged,
}: {
  info: ConnectorInfo;
  dev: boolean;
  onChanged: () => void;
}) {
  const spec = accountConfigSpec(info.connector);
  return (
    <li className="rounded-lg border px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm font-medium">
          <ConnectorIcon
            connector={info.connector}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          {info.connector}
        </span>
        <StatusBadge status={info.status} />
      </div>

      {spec ? (
        info.status === "connected" ? (
          <AccountSummary
            connector={info.connector}
            spec={spec}
            fieldCount={info.fields.length}
            onChanged={onChanged}
          />
        ) : (
          <AccountForm
            connector={info.connector}
            spec={spec}
            expired={info.status === "expired"}
            onChanged={onChanged}
          />
        )
      ) : (
        <>
          {info.status === "connected" && (
            <p className="mt-0.5 pl-5.5 text-[11px] text-muted-foreground">
              {info.fields.length} bindable field
              {info.fields.length === 1 ? "" : "s"}
            </p>
          )}
          {info.status === "unconfigured" && dev && (
            <p className="mt-0.5 pl-5.5 text-[11px] text-muted-foreground">
              Signing in with GitHub provisions this connector automatically.
            </p>
          )}
          {info.status === "expired" && (
            <p className="mt-0.5 pl-5.5 text-[11px] text-muted-foreground">
              Credentials expired — sign in with GitHub again to refresh.
            </p>
          )}
        </>
      )}
    </li>
  );
}

interface Props {
  /** Under the dev fallback, unconfigured OAuth connectors hint at sign-in. */
  dev: boolean;
}

/**
 * Header "Data" button: connector status list (GET /v1/connectors) plus
 * connection management per auth tier — config-tier connectors connect and
 * disconnect right here (PUT/DELETE /v1/connectors/{name}/account); GitHub
 * stays sign-in-provisioned (§6: login is the first connector). Every
 * successful change refreshes this list AND invalidates the shared connector
 * caches, so binding pickers and the canvas's live data update in place.
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

  /** Post connect/disconnect: reload this list + refetch every mounted hook. */
  function handleChanged() {
    setAttempt((n) => n + 1);
    invalidateConnectorCache();
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
              <ConnectorRow
                key={c.connector}
                info={c}
                dev={dev}
                onChanged={handleChanged}
              />
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

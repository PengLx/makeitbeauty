import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ConnectorInfo, ConnectorStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type BindingKind = "string" | "number";

/**
 * A value that is EXACTLY one {{path}} template renders in Data mode; any
 * other value (including mixed text around a template) is Custom. Mode is
 * derived from the value, never stored — code-pane edits stay in sync.
 */
const SOLE_TEMPLATE_RE = /^\{\{\s*[\w.]+\s*\}\}$/;

/** The template's inner path when the value is exactly one template, else null. */
export function boundPath(value: unknown): string | null {
  if (typeof value !== "string" || !SOLE_TEMPLATE_RE.test(value)) return null;
  return value.slice(2, -2).trim();
}

/**
 * Full binding path for a connector field. /v1/connectors serves paths
 * relative to the connector ("user.name"); templates and derived bindings
 * need the connector-qualified form ("github.user.name") — snapshots are
 * keyed by connector and deriveBindings requires the connector as the first
 * path segment.
 */
export function qualifyPath(connector: string, path: string): string {
  return path.startsWith(`${connector}.`) ? path : `${connector}.${path}`;
}

const STATUS_CLASSES: Record<ConnectorStatus, string> = {
  connected: "border-emerald-500/40 text-emerald-500",
  unconfigured: "text-muted-foreground",
  expired: "border-amber-500/40 text-amber-500",
};

function StatusBadge({ status }: { status: ConnectorStatus }) {
  return (
    <span
      className={`rounded-full border px-1.5 text-[9px] uppercase tracking-wider ${
        STATUS_CLASSES[status] ?? "text-muted-foreground"
      }`}
    >
      {status}
    </span>
  );
}

function TypeBadge({ type }: { type: BindingKind }) {
  return (
    <span className="rounded border px-1 text-[9px] uppercase tracking-wider text-muted-foreground">
      {type}
    </span>
  );
}

/**
 * Grouped connector-field picker: one group per connector (label = name +
 * status badge when not connected), items show the qualified path and the
 * field description. `kind` filters to one field type; leaving it undefined
 * lists every field with a type badge instead (the text-node insert surface,
 * where numbers stringify). Connectors with no matching fields are omitted.
 */
export function FieldSelect({
  connectors,
  kind,
  value,
  placeholder,
  id,
  onPick,
}: {
  connectors: ConnectorInfo[];
  kind?: BindingKind;
  /** Qualified path of the current selection, or "" for none. */
  value: string;
  placeholder: string;
  id?: string;
  onPick: (qualifiedPath: string) => void;
}) {
  const groups = connectors
    .map((c) => ({
      info: c,
      fields: (c.fields ?? []).filter(
        (f) => kind === undefined || f.type === kind,
      ),
    }))
    .filter((g) => g.fields.length > 0);

  return (
    <Select value={value} onValueChange={onPick}>
      <SelectTrigger size="sm" id={id} className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {groups.map(({ info, fields }) => (
          <SelectGroup key={info.connector}>
            <SelectLabel className="flex items-center gap-1.5">
              {info.connector}
              {info.status !== "connected" && (
                <StatusBadge status={info.status} />
              )}
            </SelectLabel>
            {fields.map((f) => {
              const qualified = qualifyPath(info.connector, f.path);
              return (
                <SelectItem key={qualified} value={qualified}>
                  <span className="flex min-w-0 flex-col items-start gap-0.5">
                    <span className="flex items-center gap-1.5 font-mono text-xs">
                      {qualified}
                      {kind === undefined && <TypeBadge type={f.type} />}
                    </span>
                    {f.description && (
                      <span className="text-[10px] text-muted-foreground">
                        {f.description}
                      </span>
                    )}
                  </span>
                </SelectItem>
              );
            })}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

/** One half of the compact Custom | Data segmented toggle. */
function Segment({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "h-5 rounded-[5px] px-1.5 text-[10px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        active
          ? "bg-background text-foreground shadow-sm dark:bg-input/50"
          : "hover:text-foreground",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      {children}
    </button>
  );
}

interface Props {
  kind: BindingKind;
  value: string | number;
  onChange: (v: string | number) => void;
  /** Full connector list (one shared /v1/connectors load); filtered internally. */
  fields: ConnectorInfo[];
  placeholder?: string;
  id?: string;
}

/**
 * Universal bindable input: every bindable editor input first chooses Custom
 * vs. Data (a connector field of the matching type). Mode is derived from
 * the value — exactly one "{{path}}" template means Data — so the control
 * never fights the code pane. Picking a field commits "{{connector.path}}";
 * unbinding restores the last freehand value (fallback ""/0).
 */
export function BindingControl({
  kind,
  value,
  onChange,
  fields,
  placeholder,
  id,
}: Props) {
  const bound = boundPath(value);
  // Custom→Data with nothing picked yet: show the picker WITHOUT touching
  // the value; it only changes once a field is actually chosen.
  const [dataIntent, setDataIntent] = useState(false);
  const mode: "custom" | "data" = bound !== null || dataIntent ? "data" : "custom";

  // Last freehand value, restored on unbind.
  const lastCustom = useRef<string | number>(kind === "number" ? 0 : "");
  useEffect(() => {
    if (boundPath(value) === null) lastCustom.current = value;
  }, [value]);

  const bindable = fields.some((c) =>
    (c.fields ?? []).some((f) => f.type === kind),
  );

  function toCustom() {
    setDataIntent(false);
    if (bound !== null) onChange(lastCustom.current);
  }

  function pick(path: string) {
    setDataIntent(false);
    onChange(`{{${path}}}`);
  }

  const dataSegment = (
    <Segment
      active={mode === "data"}
      disabled={!bindable}
      onClick={() => setDataIntent(true)}
    >
      Data
    </Segment>
  );

  return (
    <div className="space-y-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="inline-flex h-6 shrink-0 items-center rounded-md bg-muted p-0.5 text-muted-foreground">
          <Segment active={mode === "custom"} onClick={toCustom}>
            Custom
          </Segment>
          {bindable ? (
            dataSegment
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                {/* span wrapper: disabled buttons don't emit hover events */}
                <span className="inline-flex" tabIndex={-1}>
                  {dataSegment}
                </span>
              </TooltipTrigger>
              <TooltipContent>Sign in to bind live data</TooltipContent>
            </Tooltip>
          )}
        </div>
        {bound !== null && (
          <span className="flex min-w-0 flex-1 items-center gap-0.5 rounded-md bg-secondary py-0.5 pr-0.5 pl-1.5 text-secondary-foreground">
            <span className="min-w-0 flex-1 truncate font-mono text-[10px]">
              {bound}
            </span>
            <button
              type="button"
              aria-label={`Unbind ${bound}`}
              className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              onClick={toCustom}
            >
              <X className="size-3" />
            </button>
          </span>
        )}
      </div>

      {mode === "custom" ? (
        <CustomInput
          kind={kind}
          value={value}
          placeholder={placeholder}
          id={id}
          onChange={onChange}
        />
      ) : (
        <FieldSelect
          connectors={fields}
          kind={kind}
          value={bound ?? ""}
          placeholder="Choose a field…"
          id={id}
          onPick={pick}
        />
      )}
    </div>
  );
}

/** The plain per-kind input — exactly what the inspector rendered before. */
function CustomInput({
  kind,
  value,
  placeholder,
  id,
  onChange,
}: {
  kind: BindingKind;
  value: string | number;
  placeholder?: string;
  id?: string;
  onChange: (v: string | number) => void;
}) {
  if (kind === "number") {
    return (
      <Input
        type="number"
        id={id}
        value={typeof value === "number" ? value : Number(value) || 0}
        placeholder={placeholder}
        className="h-8 text-xs"
        onChange={(e) => {
          const v = Math.round(Number(e.target.value));
          if (Number.isFinite(v)) onChange(v);
        }}
      />
    );
  }
  const text = String(value);
  const isHex = /^#[0-9a-fA-F]{6}$/.test(text);
  return (
    <div className="flex items-center gap-1.5">
      {/^#[0-9a-fA-F]{3,8}$/.test(text) && (
        <input
          type="color"
          value={isHex ? text : "#000000"}
          aria-label="Color swatch"
          className="size-8 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      <Input
        id={id}
        value={text}
        placeholder={placeholder}
        spellCheck={false}
        className="h-8 text-xs"
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ConnectorInfo, ConnectorStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ConnectorIcon } from "@/components/ConnectorIcon";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
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

/** Display form of a field path once an icon already names the connector. */
function pathTail(connector: string, path: string): string {
  return path.startsWith(`${connector}.`) ? path.slice(connector.length + 1) : path;
}

/** First path segment — by convention the connector name ("github.user.name"). */
function pathConnector(path: string): string {
  const dot = path.indexOf(".");
  return dot > 0 ? path.slice(0, dot) : path;
}

const STATUS_DOT: Partial<Record<ConnectorStatus, string>> = {
  expired: "bg-amber-500",
  unconfigured: "bg-muted-foreground/50",
};

const STATUS_HINT: Partial<Record<ConnectorStatus, string>> = {
  expired: "Credentials expired",
  unconfigured: "Not configured",
};

function TypeBadge({ type }: { type: string }) {
  return (
    <span className="rounded border px-1 text-[9px] uppercase tracking-wider text-muted-foreground">
      {type}
    </span>
  );
}

/** One selectable connector chip in the picker's step-1 row. */
function ConnectorChip({
  info,
  active,
  iconOnly,
  onSelect,
}: {
  info: ConnectorInfo;
  active: boolean;
  iconOnly: boolean;
  onSelect: () => void;
}) {
  const dot = STATUS_DOT[info.status];
  const hint = STATUS_HINT[info.status];
  const chip = (
    <button
      type="button"
      aria-pressed={active}
      aria-label={info.connector}
      onClick={onSelect}
      className={cn(
        "inline-flex h-6 min-w-0 items-center gap-1 rounded-md border px-1.5 text-[10px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        active
          ? "border-ring/60 bg-secondary text-secondary-foreground ring-1 ring-ring/40"
          : "border-input text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      <ConnectorIcon connector={info.connector} className="size-3 shrink-0" />
      {!iconOnly && <span className="truncate">{info.connector}</span>}
      {dot && (
        <span
          className={cn("size-1.5 shrink-0 rounded-full", dot)}
          aria-hidden="true"
        />
      )}
    </button>
  );
  // Tooltip only when the chip hides something: its name (icon-only row)
  // and/or its non-connected status (the tiny dot).
  if (!hint && !iconOnly) return chip;
  const label = [iconOnly ? info.connector : null, hint]
    .filter(Boolean)
    .join(" — ");
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Two-step connector-field picker: step 1 is a chip row (icon + name) of the
 * connectors that have at least one field matching the `kind` filter; step 2
 * is a Select over the chosen connector's fields only (items = mono path tail
 * + muted description — the chip's icon already names the connector).
 * Leaving `kind` undefined lists every field with a type badge instead (the
 * text-node insert surface, where numbers stringify).
 *
 * Connector selection resolves, in order: the user's last chip click in this
 * instance → the bound value's connector → the sole eligible connector.
 * With one connector (today's GitHub-only reality) step 1 costs no clicks.
 */
export function FieldSelect({
  connectors,
  kind,
  value,
  placeholder,
  id,
  defaultConnector,
  onPick,
}: {
  connectors: ConnectorInfo[];
  kind?: BindingKind;
  /** Qualified path of the current selection, or "" for none. */
  value: string;
  placeholder: string;
  id?: string;
  /** Seeds the chip selection at mount (a parent's remembered last pick). */
  defaultConnector?: string | null;
  onPick: (qualifiedPath: string) => void;
}) {
  const eligible = connectors
    .map((c) => ({
      info: c,
      // No kind = the text insert surface: every PRIMITIVE field (numbers
      // stringify; structured "series" fields are native-component food — a
      // {{template}} of one only renders a placeholder, so don't offer it).
      fields: (c.fields ?? []).filter((f) =>
        kind === undefined
          ? f.type === "string" || f.type === "number"
          : f.type === kind,
      ),
    }))
    .filter((g) => g.fields.length > 0);

  const boundConnector = value ? pathConnector(value) : null;

  // The user's explicit chip choice, remembered for this control instance.
  // Seeded from the bound value's connector when one exists at mount (the
  // current truth beats any remembered pick), else the parent's memory.
  const [chosen, setChosen] = useState<string | null>(
    boundConnector ?? defaultConnector ?? null,
  );
  // When the bound connector changes (picking commits, or a code-pane edit
  // rebinds externally), it becomes the chip selection — render-time state
  // reconciliation, same idiom as deriving state from props.
  const [prevBound, setPrevBound] = useState(boundConnector);
  if (boundConnector !== prevBound) {
    setPrevBound(boundConnector);
    if (boundConnector !== null) setChosen(boundConnector);
  }

  const isEligible = (name: string | null) =>
    name !== null && eligible.some((g) => g.info.connector === name);
  const selected =
    (isEligible(chosen) ? chosen : null) ??
    (isEligible(boundConnector) ? boundConnector : null) ??
    (eligible.length === 1 ? eligible[0].info.connector : null);
  const group = eligible.find((g) => g.info.connector === selected);

  // Many connectors: drop names so the row still fits a 320px column;
  // tooltips take over naming.
  const iconOnly = eligible.length > 4;

  return (
    <div className="space-y-1">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {eligible.map(({ info }) => (
          <ConnectorChip
            key={info.connector}
            info={info}
            active={info.connector === selected}
            iconOnly={iconOnly}
            onSelect={() => setChosen(info.connector)}
          />
        ))}
      </div>
      <Select
        value={group && boundConnector === selected ? value : ""}
        onValueChange={onPick}
        disabled={!group}
      >
        <SelectTrigger size="sm" id={id} className="w-full">
          <SelectValue placeholder={group ? placeholder : "Pick a connector…"} />
        </SelectTrigger>
        <SelectContent>
          {group?.fields.map((f) => {
            const qualified = qualifyPath(group.info.connector, f.path);
            return (
              <SelectItem key={qualified} value={qualified}>
                <span className="flex min-w-0 flex-col items-start gap-0.5">
                  <span className="flex items-center gap-1.5 font-mono text-xs">
                    {pathTail(group.info.connector, f.path)}
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
        </SelectContent>
      </Select>
    </div>
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

  // Last connector the user bound through this control — seeds the picker's
  // chip selection when it remounts (Custom↔Data flips unmount FieldSelect).
  const lastConnector = useRef<string | null>(null);

  const bindable = fields.some((c) =>
    (c.fields ?? []).some((f) => f.type === kind),
  );

  function toCustom() {
    setDataIntent(false);
    if (bound !== null) onChange(lastCustom.current);
  }

  function pick(path: string) {
    setDataIntent(false);
    lastConnector.current = pathConnector(path);
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
          <span className="flex min-w-0 flex-1 items-center gap-1 rounded-md bg-secondary py-0.5 pr-0.5 pl-1.5 text-secondary-foreground">
            {/* Icon names the connector, so the path drops its prefix —
                display only; the stored value stays fully qualified. */}
            <ConnectorIcon
              connector={pathConnector(bound)}
              className="size-3 shrink-0"
            />
            <span className="min-w-0 flex-1 truncate font-mono text-[10px]">
              {pathTail(pathConnector(bound), bound)}
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
          defaultConnector={lastConnector.current}
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

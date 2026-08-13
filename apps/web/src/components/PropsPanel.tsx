import { useState } from "react";
import { Plus, Square, Type, X } from "lucide-react";
import {
  PROP_NAME_RE,
  parseSeriesJson,
  propReferences,
  type ComponentDefinition,
  type ComponentPropDecl,
} from "@/lib/component";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "./ConfirmDialog";

interface Props {
  def: ComponentDefinition;
  /**
   * kind "code" (§7.6): the center pane is the render-function source, so the
   * node quick-add row disappears (a code component's nodes come from
   * render(); declared nodes are only an optional static palette preview) and
   * the footer speaks the code contract.
   */
  codeMode?: boolean;
  onInsertText: () => void;
  onInsertRect: () => void;
  onAddProp: (name: string, decl: ComponentPropDecl) => void;
  onUpdateProp: (name: string, decl: ComponentPropDecl) => void;
  onRemoveProp: (name: string) => void;
}

/** Type-zero default when a prop switches declaration type. */
function zeroDefault(type: ComponentPropDecl["type"]): ComponentPropDecl["default"] {
  return type === "number" ? 0 : type === "series" ? [] : "";
}

/**
 * Studio left column: quick-add primitives plus the PROPS editor that
 * replaces the kit palette — a component's public surface is its declared
 * prop slots, not other components (no nesting in v0). Deleting a prop that
 * a {{props.x}} template (or computed mapping) still references warns first;
 * confirming leaves those templates to resolve as "—" until they're edited.
 */
export function PropsPanel({
  def,
  codeMode,
  onInsertText,
  onInsertRect,
  onAddProp,
  onUpdateProp,
  onRemoveProp,
}: Props) {
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<ComponentPropDecl["type"]>("string");
  const [pendingDelete, setPendingDelete] = useState<{
    name: string;
    references: string[];
  } | null>(null);

  const nameTaken = newName in def.props;
  const nameValid = PROP_NAME_RE.test(newName);
  const canAdd = nameValid && !nameTaken;

  function addProp() {
    if (!canAdd) return;
    onAddProp(newName, { type: newType, default: zeroDefault(newType) });
    setNewName("");
  }

  function requestDelete(name: string) {
    const references = propReferences(def, name);
    if (references.length === 0) {
      onRemoveProp(name);
    } else {
      setPendingDelete({ name, references });
    }
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-card">
      {!codeMode && (
        <>
          <div className="px-4 pt-3 pb-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Insert
            </h2>
          </div>
          <div className="grid grid-cols-2 gap-2 px-3 pb-3">
            <Button variant="outline" size="sm" onClick={onInsertText}>
              <Type data-icon="inline-start" />
              Text
            </Button>
            <Button variant="outline" size="sm" onClick={onInsertRect}>
              <Square data-icon="inline-start" />
              Rectangle
            </Button>
          </div>

          <Separator />
        </>
      )}

      <div className="px-4 pt-3 pb-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Props
        </h2>
      </div>

      <div className="space-y-2 px-3 pb-3">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addProp();
            }
          }}
          placeholder="new prop name"
          spellCheck={false}
          className="h-8 font-mono text-xs"
        />
        <div className="flex items-center gap-2">
          <Select
            value={newType}
            onValueChange={(v) => setNewType(v as ComponentPropDecl["type"])}
          >
            <SelectTrigger size="sm" className="flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="string">string</SelectItem>
              <SelectItem value="number">number</SelectItem>
              <SelectItem value="series">series</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" disabled={!canAdd} onClick={addProp}>
            <Plus data-icon="inline-start" />
            Add
          </Button>
        </div>
        {newName !== "" && !canAdd && (
          <p className="text-[11px] text-destructive">
            {nameTaken
              ? "A prop with this name already exists."
              : "Names start with a letter; letters, digits and _ after."}
          </p>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 px-3 pb-3">
          {Object.keys(def.props).length === 0 ? (
            <p className="rounded-lg border border-dashed p-3 text-xs leading-relaxed text-muted-foreground">
              No props yet. Declare one, then reference it from node text or
              values as{" "}
              <code className="font-mono text-[10px]">{"{{props.name}}"}</code>.
            </p>
          ) : (
            Object.entries(def.props).map(([name, decl]) => (
              <PropCard
                key={name}
                name={name}
                decl={decl}
                onUpdate={(next) => onUpdateProp(name, next)}
                onDelete={() => requestDelete(name)}
              />
            ))
          )}
        </div>
      </ScrollArea>

      <Separator />
      <p className="px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
        {codeMode ? (
          <>
            Props are the component's only inputs —{" "}
            <code className="font-mono text-[10px]">render({"{ props }"})</code>{" "}
            receives them with defaults merged; series props arrive as raw
            arrays.
          </>
        ) : (
          <>
            Props are the component's only inputs — designs bind their data to
            props when they use it.
          </>
        )}
      </p>

      <ConfirmDialog
        open={pendingDelete != null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={`Delete prop “${pendingDelete?.name ?? ""}”?`}
        description={
          <>
            It is still referenced by {pendingDelete?.references.length}{" "}
            place{pendingDelete?.references.length === 1 ? "" : "s"}:{" "}
            <span className="font-mono text-xs">
              {pendingDelete?.references.slice(0, 4).join(", ")}
              {(pendingDelete?.references.length ?? 0) > 4 ? ", …" : ""}
            </span>
            . Those templates will render as “—” until you edit them.
          </>
        }
        confirmLabel="Delete prop"
        destructive
        onConfirm={() => {
          if (pendingDelete) onRemoveProp(pendingDelete.name);
          setPendingDelete(null);
        }}
      />
    </aside>
  );
}

/** One declared prop: fixed name (renames would orphan templates), editable type/default/description. */
function PropCard({
  name,
  decl,
  onUpdate,
  onDelete,
}: {
  name: string;
  decl: ComponentPropDecl;
  onUpdate: (next: ComponentPropDecl) => void;
  onDelete: () => void;
}) {
  return (
    <div className="space-y-1.5 rounded-lg border bg-background p-2">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{name}</span>
        <Select
          value={decl.type}
          onValueChange={(v) => {
            const type = v as ComponentPropDecl["type"];
            if (type === decl.type) return;
            // Convert the default across the type switch instead of lying
            // about it: "42" → 42, everything non-numeric → 0. Switches
            // to/from series reset to the type's zero value — an array has
            // no honest scalar form and vice versa.
            const scalar = typeof decl.default === "string" || typeof decl.default === "number";
            onUpdate({
              ...decl,
              type,
              default:
                type === "series"
                  ? []
                  : !scalar
                    ? zeroDefault(type)
                    : type === "number"
                      ? Number(decl.default) || 0
                      : String(decl.default),
            });
          }}
        >
          <SelectTrigger
            size="sm"
            className="h-6! w-auto gap-1 px-1.5 font-mono text-[10px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="string">string</SelectItem>
            <SelectItem value="number">number</SelectItem>
            <SelectItem value="series">series</SelectItem>
          </SelectContent>
        </Select>
        <button
          type="button"
          aria-label={`Delete prop ${name}`}
          onClick={onDelete}
          className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-destructive"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {decl.type === "series" ? (
        <SeriesDefaultEditor
          name={name}
          value={Array.isArray(decl.default) ? decl.default : []}
          onCommit={(v) => onUpdate({ ...decl, default: v })}
        />
      ) : decl.type === "number" ? (
        <Input
          type="number"
          value={typeof decl.default === "number" ? decl.default : 0}
          aria-label={`Default for ${name}`}
          className="h-7 text-xs"
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onUpdate({ ...decl, default: v });
          }}
        />
      ) : (
        <Input
          value={String(decl.default)}
          aria-label={`Default for ${name}`}
          placeholder="default value"
          spellCheck={false}
          className="h-7 text-xs"
          onChange={(e) => onUpdate({ ...decl, default: e.target.value })}
        />
      )}
      <Input
        value={decl.description ?? ""}
        aria-label={`Description for ${name}`}
        placeholder="description (optional)"
        className="h-7 text-xs"
        onChange={(e) =>
          onUpdate({
            ...decl,
            description: e.target.value === "" ? undefined : e.target.value,
          })
        }
      />
    </div>
  );
}

/**
 * Series default (§7.6): a JSON array edited as text. Commits only VALID
 * states (must parse to an array of ≤1024 items — the schema cap parseSeriesJson
 * enforces); while the text is invalid the draft stays local, the error shows
 * inline, and the declaration keeps its last good array. Blur on a valid
 * draft resyncs the text to the committed value's canonical JSON.
 */
function SeriesDefaultEditor({
  name,
  value,
  onCommit,
}: {
  name: string;
  value: unknown[];
  onCommit: (v: unknown[]) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? JSON.stringify(value);
  const parsed = draft === null ? null : parseSeriesJson(draft);
  const error = parsed !== null && !parsed.ok ? parsed.error : null;
  const itemCount = parsed?.ok ? parsed.value.length : value.length;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">
          default (JSON array)
        </span>
        <span
          className={`rounded border px-1 font-mono text-[9px] tabular-nums ${
            error ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {itemCount} item{itemCount === 1 ? "" : "s"}
        </span>
      </div>
      <Textarea
        value={text}
        rows={3}
        spellCheck={false}
        aria-label={`Series default for ${name}`}
        aria-invalid={error !== null}
        placeholder='[0, 3, 7] or [{"date":"2026-01-01","count":4}]'
        className={`min-h-0 font-mono text-[10px] leading-snug ${
          error ? "border-destructive/60" : ""
        }`}
        onChange={(e) => {
          setDraft(e.target.value);
          const res = parseSeriesJson(e.target.value);
          if (res.ok) onCommit(res.value);
        }}
        onBlur={() => {
          if (error === null) setDraft(null); // resync to canonical JSON
        }}
      />
      {error && <p className="text-[10px] text-destructive">{error}</p>}
    </div>
  );
}

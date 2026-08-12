import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Copy, RefreshCw, Save, Upload, X } from "lucide-react";
import { PropsPanel } from "./PropsPanel";
import { DesignCanvas } from "./DesignCanvas";
import { CanvasToolbar } from "./CanvasToolbar";
import { Inspector } from "./Inspector";
import { StudioPreview } from "./StudioPreview";
import { ConfirmDialog } from "./ConfirmDialog";
import { SessionControls } from "./SessionControls";
import { VersionBadge } from "./ComponentList";
import type { KitComponent } from "../hooks/useKit";
import { useSnapSettings } from "../hooks/useSnapSettings";
import {
  ApiError,
  getComponent,
  publishComponent,
  toApiError,
  updateComponent,
  type ComponentRecord,
  type ConnectorInfo,
  type Me,
} from "@/lib/api";
import {
  splitComponentId,
  type ComponentDefinition,
  type ComponentPropDecl,
  type FragmentNode,
} from "@/lib/component";
import { PREVIEW_BACKGROUND } from "@/lib/expandForPreview";
import {
  centeredPosition,
  findNode,
  nextNodeId,
  removeNode,
  updateNode,
  type DesignCanvasSpec,
  type DesignDoc,
  type DesignNode,
} from "@/lib/design";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";

interface Props {
  me: Me;
  /** "{owner}/{name}" — one of my components. */
  componentId: string;
  onBack: () => void;
}

/**
 * Pick the editable draft out of a component record, most-authoritative
 * first: the draft itself, else the latest published definition (fresh drafts
 * of published components), else a blank definition on the metadata frame.
 * The id is normalized to the unversioned "{owner}/{name}" draft form.
 */
function extractDraft(
  record: ComponentRecord,
  componentId: string,
): ComponentDefinition {
  const source = record.draft ?? record.definition;
  const base: ComponentDefinition = source
    ? structuredClone(source)
    : {
        id: componentId,
        title: record.title || componentId,
        frame: record.frame ?? { w: 400, h: 160 },
        props: {},
        nodes: [],
      };
  base.id = componentId;
  if (!base.title) base.title = record.title || componentId;
  return base;
}

/**
 * Component Studio: the project editor's canvas machinery pointed at a DRAFT
 * COMPONENT DEFINITION (§7.5) instead of a project design — same canvas,
 * same inspector (node styling and animations are part of the component
 * model), but the left palette becomes a props editor and every binding
 * surface offers only {{props.*}} (components never reference connector
 * data). Save PUTs the draft; Publish freezes an immutable version.
 */
export function ComponentStudio({ me, componentId, onBack }: Props) {
  const parsed = splitComponentId(componentId);
  const owner = parsed?.owner ?? "";
  const name = parsed?.name ?? "";

  const [record, setRecord] = useState<ComponentRecord | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  // Single source of truth for every studio surface, like Editor's `design`.
  const [def, setDef] = useState<ComponentDefinition | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const [savedSerialized, setSavedSerialized] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const [publishOpen, setPublishOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<ApiError | null>(null);
  /** Pinned ref of the version this dialog session froze, e.g. "a/b@3". */
  const [publishedRef, setPublishedRef] = useState<string | null>(null);

  // Snap preferences (persisted to "mib.snap", shared with the Editor).
  const [snap, setSnap] = useSnapSettings();

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(null);
    (async () => {
      try {
        if (!parsed) {
          throw new ApiError(
            "invalid_component_id",
            `"${componentId}" is not an {owner}/{name} component id`,
            0,
          );
        }
        const loaded = await getComponent(owner, name, controller.signal);
        setRecord(loaded);
        const draft = extractDraft(loaded, componentId);
        setDef(draft);
        setSavedSerialized(JSON.stringify(draft));
        setSelectedNodeId(null);
      } catch (e) {
        if (controller.signal.aborted) return;
        setLoadError(toApiError(e));
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [componentId, loadAttempt]);

  const serialized = useMemo(() => (def ? JSON.stringify(def) : null), [def]);
  const dirty =
    serialized != null && savedSerialized != null && serialized !== savedSerialized;

  /** PUT the draft; throws on failure so the publish flow can chain on it. */
  const saveDraft = useCallback(async () => {
    if (!def) return;
    const sent = def;
    const updated = await updateComponent(owner, name, sent);
    if (updated.id !== "") {
      setRecord((prev) => ({ ...(prev ?? updated), ...updated }));
    }
    // Compare against what we sent — edits made mid-flight stay dirty.
    setSavedSerialized(JSON.stringify(sent));
  }, [def, owner, name]);

  const save = useCallback(async () => {
    if (!def || !dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveDraft();
    } catch (e) {
      setSaveError(toApiError(e));
    } finally {
      setSaving(false);
    }
  }, [def, dirty, saving, saveDraft]);

  // Cmd/Ctrl+S saves; ref keeps the window listener bound once (Editor idiom).
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveRef.current();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function requestBack() {
    if (dirty) setConfirmLeave(true);
    else onBack();
  }

  // The canvas machinery speaks DesignDoc; wrap the draft's frame + nodes as
  // one. The frame IS the canvas — expandForPreview mirrors exactly this
  // (s = 1) so what you lay out here is what the preview renders.
  const designView: DesignDoc | null = useMemo(
    () =>
      def
        ? {
            version: 0,
            canvas: {
              width: def.frame.w,
              height: def.frame.h,
              background: PREVIEW_BACKGROUND,
            },
            nodes: def.nodes,
          }
        : null,
    [def],
  );

  function applyDef(next: ComponentDefinition) {
    setDef(next);
  }

  function patchNode(id: string, patch: Partial<DesignNode>) {
    if (!def || !designView) return;
    applyDef({
      ...def,
      nodes: updateNode(designView, id, patch).nodes as FragmentNode[],
    });
  }

  /**
   * Frame edits from the canvas boundary handles AND the inspector's frame
   * panel. def.frame is the single source of truth — designView's canvas and
   * the frameLabel both derive from it via useMemo, so every surface tracks
   * live. Width/height only: a component frame has no background/radius
   * (kit-component.schema.json); the studio canvas/preview always paint
   * PREVIEW_BACKGROUND.
   */
  function patchFrame(patch: Partial<DesignCanvasSpec>) {
    if (!def) return;
    const w = patch.width ?? def.frame.w;
    const h = patch.height ?? def.frame.h;
    if (w === def.frame.w && h === def.frame.h) return;
    applyDef({ ...def, frame: { w, h } });
  }

  function deleteNode(id: string) {
    if (!def || !designView) return;
    applyDef({ ...def, nodes: removeNode(designView, id).nodes as FragmentNode[] });
    if (selectedNodeId === id) setSelectedNodeId(null);
  }

  function insertNode(node: FragmentNode) {
    if (!def) return;
    applyDef({ ...def, nodes: [...def.nodes, node] });
    setSelectedNodeId(node.id);
  }

  function insertText() {
    if (!def || !designView) return;
    const w = Math.min(240, def.frame.w);
    const h = 32;
    insertNode({
      id: nextNodeId(designView, "text"),
      type: "text",
      ...centeredPosition(designView.canvas, w, h),
      w,
      h,
      text: "Edit me",
      style: { fontSize: 18, fontWeight: 500, color: "#e6edf3" },
    });
  }

  function insertRect() {
    if (!def || !designView) return;
    const w = Math.min(160, def.frame.w);
    const h = Math.min(100, def.frame.h);
    insertNode({
      id: nextNodeId(designView, "rect"),
      type: "rect",
      ...centeredPosition(designView.canvas, w, h),
      w,
      h,
      style: { fill: "#21262d", radius: 8 },
    });
  }

  function addProp(propName: string, decl: ComponentPropDecl) {
    if (!def) return;
    applyDef({ ...def, props: { ...def.props, [propName]: decl } });
  }

  function updateProp(propName: string, decl: ComponentPropDecl) {
    if (!def) return;
    applyDef({ ...def, props: { ...def.props, [propName]: decl } });
  }

  function removeProp(propName: string) {
    if (!def) return;
    const props = { ...def.props };
    delete props[propName];
    // Computed entries on an undeclared prop are a hard validation error
    // (renderer semantics) — drop them with the prop. Orphaned {{props.x}}
    // TEXT templates stay (they only warn + em-dash); PropsPanel warned.
    const computed = (def.computed ?? []).filter((c) => c.prop !== propName);
    applyDef({
      ...def,
      props,
      ...(computed.length > 0 ? { computed } : { computed: undefined }),
    });
  }

  /**
   * §7.5: inside a component, the ONLY bindable source is the component's own
   * declared props — the connector Data mode never appears here. Reuses the
   * whole BindingControl/FieldSelect visual language with a synthetic "props"
   * source whose fields are the declared props.
   */
  const propConnectors: ConnectorInfo[] = useMemo(() => {
    if (!def) return [];
    const fields = Object.entries(def.props).map(([propName, decl]) => ({
      path: propName,
      description: decl.description,
      type: decl.type,
    }));
    return fields.length > 0
      ? [{ connector: "props", status: "connected" as const, fields }]
      : [];
  }, [def]);

  async function handlePublish() {
    if (!def || publishing) return;
    setPublishing(true);
    setPublishError(null);
    try {
      if (dirty) await saveDraft(); // the frozen version must be what's on screen
      const version = await publishComponent(owner, name);
      setRecord((prev) => (prev ? { ...prev, latestVersion: version } : prev));
      setPublishedRef(`${componentId}@${version}`);
    } catch (e) {
      setPublishError(toApiError(e));
    } finally {
      setPublishing(false);
    }
  }

  const selectedNode = designView ? findNode(designView, selectedNodeId) : null;
  const ready = record != null && def != null && designView != null;
  const nextVersion = (record?.latestVersion ?? 0) + 1;
  const emptyKit = useMemo(() => new Map<string, KitComponent>(), []);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-3 border-b bg-card px-4 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={requestBack}
          aria-label="Back to components"
        >
          <ArrowLeft />
        </Button>
        <span className="text-sm font-semibold">MakeItBeauty</span>
        <span className="rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          component studio
        </span>
        <Separator orientation="vertical" className="h-4!" />
        <span className="flex min-w-0 items-center gap-2 truncate text-sm text-muted-foreground">
          <span className="truncate">{def?.title ?? record?.title ?? "…"}</span>
          <span className="font-mono text-xs text-muted-foreground/60">
            {componentId}
          </span>
          {record && <VersionBadge latestVersion={record.latestVersion} />}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void save()}
            disabled={!dirty || saving}
            className="relative"
          >
            <Save data-icon="inline-start" />
            {saving ? "Saving…" : "Save draft"}
            {dirty && !saving && (
              <>
                <span
                  aria-hidden
                  className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-amber-500"
                />
                <span className="sr-only">(unsaved changes)</span>
              </>
            )}
          </Button>
          <Button
            size="sm"
            disabled={!ready}
            onClick={() => {
              setPublishError(null);
              setPublishedRef(null);
              setPublishOpen(true);
            }}
          >
            <Upload data-icon="inline-start" />
            Publish
          </Button>
          <Separator orientation="vertical" className="h-4!" />
          <SessionControls me={me} />
        </div>
      </header>

      {saveError && (
        <div className="border-b bg-card px-4 py-2">
          <Alert variant="destructive" className="py-2">
            <AlertTitle className="flex items-center gap-2">
              Save failed{" "}
              <code className="font-mono text-[10px] opacity-70">
                [{saveError.code}]
              </code>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Dismiss"
                className="ml-auto"
                onClick={() => setSaveError(null)}
              >
                <X />
              </Button>
            </AlertTitle>
            <AlertDescription>{saveError.message}</AlertDescription>
          </Alert>
        </div>
      )}

      {!ready ? (
        <div className="flex flex-1 items-center justify-center p-6">
          {loadError ? (
            <Alert variant="destructive" className="max-w-md">
              <AlertTitle>
                Couldn't load component{" "}
                <code className="font-mono text-[10px] opacity-70">
                  [{loadError.code}]
                </code>
              </AlertTitle>
              <AlertDescription>
                <p>{loadError.message}</p>
                <div className="flex gap-2 pt-1">
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => setLoadAttempt((n) => n + 1)}
                  >
                    <RefreshCw data-icon="inline-start" />
                    Retry
                  </Button>
                  <Button variant="outline" size="xs" onClick={onBack}>
                    Back to components
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : (
            <p className="text-sm text-muted-foreground">Loading component…</p>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <PropsPanel
            def={def}
            onInsertText={insertText}
            onInsertRect={insertRect}
            onAddProp={addProp}
            onUpdateProp={updateProp}
            onRemoveProp={removeProp}
          />

          <div className="relative flex min-w-0 flex-1 flex-col">
            <CanvasToolbar settings={snap} onChange={setSnap} />
            <DesignCanvas
              design={designView}
              selectedId={selectedNodeId}
              kitById={emptyKit}
              frameLabel={`${name} · ${def.frame.w}×${def.frame.h}`}
              snap={snap}
              onSelect={setSelectedNodeId}
              onPatchNode={patchNode}
              onDeleteNode={deleteNode}
              onCanvasResize={patchFrame}
            />
          </div>

          <aside className="flex w-80 shrink-0 flex-col border-l bg-card">
            <div className="flex items-center justify-between px-4 pt-3 pb-2">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Inspector
              </h2>
              {selectedNode && (
                <button
                  onClick={() => deleteNode(selectedNode.id)}
                  className="text-[11px] text-muted-foreground transition-colors hover:text-destructive"
                >
                  Delete node
                </button>
              )}
            </div>
            <Inspector
              node={selectedNode}
              kit={undefined}
              connectors={propConnectors}
              propsOnly
              canvas={designView.canvas}
              onPatch={patchNode}
              onPatchCanvas={patchFrame}
            />
            <StudioPreview def={def} />
          </aside>
        </div>
      )}

      <Dialog
        open={publishOpen}
        onOpenChange={(open) => {
          setPublishOpen(open);
          if (!open) {
            setPublishError(null);
            setPublishedRef(null);
          }
        }}
      >
        <DialogContent>
          {publishedRef == null ? (
            <>
              <DialogHeader>
                <DialogTitle>Publish v{nextVersion}?</DialogTitle>
                <DialogDescription>
                  Publishing freezes the current draft as{" "}
                  <code className="font-mono text-xs">
                    {componentId}@{nextVersion}
                  </code>
                  . Published versions are immutable — designs that already
                  inserted this component keep the exact version they pinned;
                  nothing updates silently. You can keep editing the draft and
                  publish v{nextVersion + 1} later.
                </DialogDescription>
              </DialogHeader>
              {dirty && (
                <p className="text-xs text-muted-foreground">
                  Unsaved changes will be saved first, so the frozen version is
                  exactly what you see.
                </p>
              )}
              {publishError && (
                <Alert variant="destructive">
                  <AlertTitle>
                    Publish failed{" "}
                    <code className="font-mono text-[10px] opacity-70">
                      [{publishError.code}]
                    </code>
                  </AlertTitle>
                  {/* Renderer-owned validation (§7.5): surface its message verbatim. */}
                  <AlertDescription className="whitespace-pre-wrap">
                    {publishError.message}
                  </AlertDescription>
                </Alert>
              )}
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline" disabled={publishing}>
                    Cancel
                  </Button>
                </DialogClose>
                <Button onClick={() => void handlePublish()} disabled={publishing}>
                  <Upload data-icon="inline-start" />
                  {publishing ? "Publishing…" : `Publish v${nextVersion}`}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Published</DialogTitle>
                <DialogDescription>
                  This exact version is now immutable and insertable — find it
                  in the editor palette under “My components”, or share the
                  pinned id:
                </DialogDescription>
              </DialogHeader>
              <PinnedRef refId={publishedRef} />
              <DialogFooter>
                <DialogClose asChild>
                  <Button>Done</Button>
                </DialogClose>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmLeave}
        onOpenChange={setConfirmLeave}
        title="Discard unsaved changes?"
        description={`“${def?.title ?? componentId}” has unsaved draft changes. Leaving now discards them — published versions are unaffected.`}
        confirmLabel="Discard changes"
        destructive
        onConfirm={onBack}
      />
    </div>
  );
}

/** The pinned "{owner}/{name}@{n}" id with a copy button (DeployDialog Snippet idiom). */
function PinnedRef({ refId }: { refId: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(refId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable; the text stays selectable */
    }
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2">
      <code className="min-w-0 flex-1 truncate font-mono text-sm">{refId}</code>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => void copy()}
        aria-label="Copy pinned component id"
      >
        {copied ? <Check className="text-emerald-500" /> : <Copy />}
      </Button>
    </div>
  );
}

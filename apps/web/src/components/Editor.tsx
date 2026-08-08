import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, RefreshCw, Save, X } from "lucide-react";
import { Palette } from "./Palette";
import { DesignCanvas } from "./DesignCanvas";
import { CodePane } from "./CodePane";
import { PreviewPane } from "./PreviewPane";
import { Inspector } from "./Inspector";
import { DeployDialog } from "./DeployDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { SessionControls } from "./SessionControls";
import { usePreview } from "../hooks/usePreview";
import { useKit, type KitComponent } from "../hooks/useKit";
import { useConnectors } from "../hooks/useConnectors";
import {
  ApiError,
  getProject,
  toApiError,
  updateProject,
  type Me,
  type Project,
} from "@/lib/api";
import {
  addNode,
  centeredPosition,
  findNode,
  isDesignDoc,
  nextNodeId,
  removeNode,
  updateNode,
  type DesignDoc,
  type DesignNode,
} from "@/lib/design";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";

type EditorTab = "design" | "code";

interface Props {
  me: Me;
  projectId: string;
  onBack: () => void;
}

/**
 * Editor view for one project: loads GET /v1/projects/{id}, edits its design
 * through the canvas/inspector/code machinery, and saves with an explicit
 * PUT /v1/projects/{id} (Save button / Cmd+S) — never implicitly.
 */
export function Editor({ me, projectId, onBack }: Props) {
  // Project metadata as last loaded/saved; its .design is NOT the edit state.
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const [tab, setTab] = useState<EditorTab>("design");
  // Single source of truth: `design` is the document every surface edits.
  // `code` mirrors it as text; while the user types invalid JSON in the Code
  // tab, `code` diverges and `design` stays at the last good parse.
  const [design, setDesign] = useState<DesignDoc | null>(null);
  const [code, setCode] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Dirty tracking compares canonical serializations, so cosmetic Code-tab
  // reformatting doesn't count as a change.
  const [savedSerialized, setSavedSerialized] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const kit = useKit();
  const kitById = useMemo(
    () => new Map(kit.components.map((c) => [c.id, c])),
    [kit.components],
  );
  // Bindable connector fields for the inspector's insert-field picker; empty
  // (picker hidden) when /v1/connectors is unavailable.
  const { fields: bindingFields } = useConnectors();

  // Lives at the Editor level so the preview survives tab switches. Sends the
  // CURRENT project design; null (still loading) skips rendering.
  const preview = usePreview(design);

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(null);
    (async () => {
      try {
        const loaded = await getProject(projectId, controller.signal);
        if (!isDesignDoc(loaded.design)) {
          setLoadError(
            new ApiError(
              "invalid_design",
              "the stored design is not a v0 design document",
              0,
            ),
          );
          return;
        }
        setProject(loaded);
        setDesign(loaded.design);
        setCode(JSON.stringify(loaded.design, null, 2));
        setSavedSerialized(JSON.stringify(loaded.design));
        setParseError(null);
        setSelectedNodeId(null);
      } catch (e) {
        if (controller.signal.aborted) return;
        setLoadError(toApiError(e));
      }
    })();
    return () => controller.abort();
  }, [projectId, loadAttempt]);

  const serialized = useMemo(
    () => (design ? JSON.stringify(design) : null),
    [design],
  );
  const dirty =
    serialized != null && savedSerialized != null && serialized !== savedSerialized;

  const save = useCallback(async () => {
    if (!project || !design || !dirty || saving) return;
    const sent = design;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await updateProject(project.id, {
        name: project.name,
        design: sent,
        bindings: project.bindings,
        outputs: project.outputs,
      });
      if (updated) setProject(updated);
      // Compare against what we sent — edits made mid-flight stay dirty.
      setSavedSerialized(JSON.stringify(sent));
    } catch (e) {
      setSaveError(toApiError(e));
    } finally {
      setSaving(false);
    }
  }, [project, design, dirty, saving]);

  // Cmd/Ctrl+S saves; the ref keeps the window listener bound once while
  // always calling the latest save closure.
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

  // Warn on tab close / reload while there are unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = ""; // legacy engines require returnValue to be set
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function requestBack() {
    if (dirty) setConfirmLeave(true);
    else onBack();
  }

  /** Canonical mutation path for canvas/inspector/palette edits. */
  function applyDesign(next: DesignDoc) {
    setDesign(next);
    setCode(JSON.stringify(next, null, 2));
    setParseError(null);
  }

  function handleCodeChange(next: string) {
    setCode(next);
    try {
      const parsed: unknown = JSON.parse(next);
      if (!isDesignDoc(parsed)) {
        setParseError('valid JSON, but not a v0 design document ("version", "canvas", "nodes")');
        return;
      }
      setDesign(parsed);
      setParseError(null);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
    }
  }

  function patchNode(id: string, patch: Partial<DesignNode>) {
    if (design) applyDesign(updateNode(design, id, patch));
  }

  function deleteNode(id: string) {
    if (design) applyDesign(removeNode(design, id));
    if (selectedNodeId === id) setSelectedNodeId(null);
  }

  function insertNode(node: DesignNode) {
    if (!design) return;
    applyDesign(addNode(design, node));
    setSelectedNodeId(node.id);
    setTab("design");
  }

  function insertText() {
    if (!design) return;
    const w = 240;
    const h = 32;
    insertNode({
      id: nextNodeId(design, "text"),
      type: "text",
      ...centeredPosition(design.canvas, w, h),
      w,
      h,
      text: "Edit me",
      style: { fontSize: 18, fontWeight: 500, color: "#e6edf3" },
    });
  }

  function insertRect() {
    if (!design) return;
    const w = 160;
    const h = 100;
    insertNode({
      id: nextNodeId(design, "rect"),
      type: "rect",
      ...centeredPosition(design.canvas, w, h),
      w,
      h,
      style: { fill: "#21262d", radius: 8 },
    });
  }

  function insertComponent(component: KitComponent) {
    if (!design) return;
    const { w, h } = component.frame;
    // "kit/stat-card" → node ids like "stat-card-1".
    const prefix = component.id.split("/").pop() ?? "instance";
    const defaults = Object.fromEntries(
      Object.entries(component.props)
        .filter(([, p]) => p.default !== undefined)
        .map(([key, p]) => [key, p.default]),
    );
    insertNode({
      id: nextNodeId(design, prefix),
      type: "instance",
      ...centeredPosition(design.canvas, w, h),
      w,
      h,
      component: component.id,
      props: defaults,
    });
  }

  const selectedNode = design ? findNode(design, selectedNodeId) : null;
  const ready = project != null && design != null;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-3 border-b bg-card px-4 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={requestBack}
          aria-label="Back to projects"
        >
          <ArrowLeft />
        </Button>
        <span className="text-sm font-semibold">MakeItBeauty</span>
        <span className="rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          editor
        </span>
        <Separator orientation="vertical" className="h-4!" />
        <span className="min-w-0 truncate text-sm text-muted-foreground">
          {project?.name ?? "…"}
          <span className="font-mono text-xs text-muted-foreground/60">
            {" "}
            · {projectId}
          </span>
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
            {saving ? "Saving…" : "Save"}
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
          {ready && <DeployDialog project={project} />}
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
                Couldn't load project{" "}
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
                    Back to projects
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : (
            <p className="text-sm text-muted-foreground">Loading project…</p>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <Palette
            kit={kit}
            onInsertComponent={insertComponent}
            onInsertText={insertText}
            onInsertRect={insertRect}
          />

          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as EditorTab)}
            className="min-w-0 flex-1 gap-0"
          >
            <div className="flex shrink-0 items-center border-b bg-card px-3 py-1.5">
              <TabsList>
                <TabsTrigger value="design">Design</TabsTrigger>
                <TabsTrigger value="code">Code</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="design" className="flex min-h-0 flex-col">
              <DesignCanvas
                design={design}
                selectedId={selectedNodeId}
                kitById={kitById}
                onSelect={setSelectedNodeId}
                onPatchNode={patchNode}
                onDeleteNode={deleteNode}
              />
            </TabsContent>
            <TabsContent value="code" className="flex min-h-0 flex-col">
              <CodePane
                code={code}
                onChange={handleCodeChange}
                parseError={parseError}
              />
            </TabsContent>
          </Tabs>

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
              kit={
                selectedNode?.type === "instance"
                  ? kitById.get(selectedNode.component)
                  : undefined
              }
              bindingFields={bindingFields}
              onPatch={patchNode}
            />
            <PreviewPane preview={preview} />
          </aside>
        </div>
      )}

      <ConfirmDialog
        open={confirmLeave}
        onOpenChange={setConfirmLeave}
        title="Discard unsaved changes?"
        description={`“${project?.name ?? projectId}” has unsaved changes. Leaving now discards them.`}
        confirmLabel="Discard changes"
        destructive
        onConfirm={onBack}
      />
    </div>
  );
}

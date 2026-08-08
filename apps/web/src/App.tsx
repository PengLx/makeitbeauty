import { useMemo, useState } from "react";
import demoDesign from "./fixtures/demo-design.json";
import { Palette } from "./components/Palette";
import { DesignCanvas } from "./components/DesignCanvas";
import { CodePane } from "./components/CodePane";
import { PreviewPane } from "./components/PreviewPane";
import { Inspector } from "./components/Inspector";
import { DeployDialog } from "./components/DeployDialog";
import { usePreview } from "./hooks/usePreview";
import { useKit, type KitComponent } from "./hooks/useKit";
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
} from "./lib/design";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";

type EditorTab = "design" | "code";

export default function App() {
  const [tab, setTab] = useState<EditorTab>("design");
  // Single source of truth: `design` is the document every surface edits.
  // `code` mirrors it as text; while the user types invalid JSON in the Code
  // tab, `code` diverges and `design` stays at the last good parse.
  const [design, setDesign] = useState<DesignDoc>(demoDesign as DesignDoc);
  const [code, setCode] = useState(() => JSON.stringify(demoDesign, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const kit = useKit();
  const kitById = useMemo(
    () => new Map(kit.components.map((c) => [c.id, c])),
    [kit.components],
  );

  // Lives at the App level so the preview survives tab switches.
  const preview = usePreview(design);

  const selectedNode = findNode(design, selectedNodeId);

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
    applyDesign(updateNode(design, id, patch));
  }

  function deleteNode(id: string) {
    applyDesign(removeNode(design, id));
    if (selectedNodeId === id) setSelectedNodeId(null);
  }

  function insertNode(node: DesignNode) {
    applyDesign(addNode(design, node));
    setSelectedNodeId(node.id);
    setTab("design");
  }

  function insertText() {
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

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <header className="flex shrink-0 items-center gap-3 border-b bg-card px-4 py-2">
          <span className="text-sm font-semibold">MakeItBeauty</span>
          <span className="rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            editor
          </span>
          <Separator orientation="vertical" className="h-4!" />
          <span className="text-sm text-muted-foreground">
            demo
            {design.name ? (
              <span className="text-muted-foreground/60"> · {design.name}</span>
            ) : null}
          </span>
          <div className="ml-auto">
            <DeployDialog />
          </div>
        </header>

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
              onPatch={patchNode}
            />
            <PreviewPane preview={preview} />
          </aside>
        </div>
      </div>
    </TooltipProvider>
  );
}

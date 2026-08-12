import { useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { Puzzle } from "lucide-react";
import {
  MIN_NODE_SIZE,
  findNode,
  type DesignDoc,
  type DesignNode,
  type InstanceNode,
  type RectNode,
  type TextNode,
} from "@/lib/design";
import {
  buildSnapTargets,
  effectiveSnapOptions,
  snapCanvasSize,
  snapRect,
  snapResizeRect,
  type ResizeDir,
  type SnapGuide,
  type SnapSettings,
  type SnapTargets,
} from "@/lib/snapping";
import type { KitComponent } from "@/hooks/useKit";
import { layerStyles, twApproxStyle } from "@/lib/tw";
import { cn } from "@/lib/utils";

interface DragState {
  nodeId: string;
  mode: "move" | ResizeDir;
  /** Pointer position at drag start (client coords). */
  startX: number;
  startY: number;
  /** Node frame at drag start. */
  frame: { x: number; y: number; w: number; h: number };
  /** Snap targets frozen at gesture start (other nodes + canvas). */
  targets: SnapTargets;
}

interface Props {
  design: DesignDoc;
  selectedId: string | null;
  /** Kit metadata by component id ("kit/stat-card") for instance labels. */
  kitById: Map<string, KitComponent>;
  /**
   * Component Studio: marks the canvas as a component FRAME (a Figma-style
   * corner tag + dashed outline) — nodes here are fragment nodes positioned
   * relative to the frame's top-left, not a full design canvas.
   */
  frameLabel?: string;
  /**
   * Snap preferences owned by the parent view (Editor / Studio, persisted to
   * localStorage). Holding Shift during a gesture inverts grid AND object
   * snapping live — pointermove's own shiftKey is read every move.
   */
  snap: SnapSettings;
  onSelect: (id: string | null) => void;
  onPatchNode: (id: string, patch: Partial<DesignNode>) => void;
  onDeleteNode: (id: string) => void;
  /**
   * Canvas self-resize (Figma frame feel): dragging the canvas's right edge,
   * bottom edge or bottom-right corner emits live size patches — integers,
   * grid-snapped through the same effectiveSnapOptions gesture pattern as
   * node ops (grid only; the canvas has no object targets) and clamped to
   * [CANVAS_MIN_SIZE, CANVAS_MAX_SIZE]. The Editor patches design.canvas,
   * the Studio patches definition.frame. Omit to hide the handles.
   */
  onCanvasResize?: (patch: { width?: number; height?: number }) => void;
}

/** Canvas edges that can be dragged: right, bottom, bottom-right corner. */
type CanvasResizeDir = "e" | "s" | "se";

interface CanvasDragState {
  dir: CanvasResizeDir;
  /** Pointer position at drag start (client coords). */
  startX: number;
  startY: number;
  /** Canvas size at drag start. */
  startW: number;
  startH: number;
}

/**
 * Canvas-boundary resize affordances. Hit areas straddle the edge (4px
 * inside, 8px outside) so they're easy to grab without stealing clicks from
 * nodes laid out against the border; the visible strip/grip lives in a child
 * span so the highlight stays thin while the target stays fat.
 */
const CANVAS_EDGE_HANDLES: {
  dir: Exclude<CanvasResizeDir, "se">;
  hit: string;
  strip: string;
  cursor: string;
  label: string;
}[] = [
  {
    dir: "e",
    hit: "inset-y-0 -right-2 w-3",
    strip: "inset-y-0 left-1/2 w-0.5 -translate-x-1/2",
    cursor: "ew-resize",
    label: "Resize canvas width",
  },
  {
    dir: "s",
    hit: "inset-x-0 -bottom-2 h-3",
    strip: "inset-x-0 top-1/2 h-0.5 -translate-y-1/2",
    cursor: "ns-resize",
    label: "Resize canvas height",
  },
];

const HANDLES: { dir: ResizeDir; className: string; cursor: string }[] = [
  { dir: "nw", className: "left-0 top-0 -translate-x-1/2 -translate-y-1/2", cursor: "nwse-resize" },
  { dir: "n", className: "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2", cursor: "ns-resize" },
  { dir: "ne", className: "right-0 top-0 translate-x-1/2 -translate-y-1/2", cursor: "nesw-resize" },
  { dir: "e", className: "right-0 top-1/2 translate-x-1/2 -translate-y-1/2", cursor: "ew-resize" },
  { dir: "se", className: "right-0 bottom-0 translate-x-1/2 translate-y-1/2", cursor: "nwse-resize" },
  { dir: "s", className: "left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2", cursor: "ns-resize" },
  { dir: "sw", className: "left-0 bottom-0 -translate-x-1/2 translate-y-1/2", cursor: "nesw-resize" },
  { dir: "w", className: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2", cursor: "ew-resize" },
];

/** New frame for a resize drag; the edge opposite the handle stays anchored. */
function resizeFrame(
  start: DragState["frame"],
  dir: ResizeDir,
  dx: number,
  dy: number,
): DragState["frame"] {
  let { x, y, w, h } = start;
  if (dir.includes("e")) w = start.w + dx;
  if (dir.includes("s")) h = start.h + dy;
  if (dir.includes("w")) {
    w = start.w - dx;
    x = start.x + dx;
  }
  if (dir.includes("n")) {
    h = start.h - dy;
    y = start.y + dy;
  }
  if (w < MIN_NODE_SIZE) {
    if (dir.includes("w")) x = start.x + start.w - MIN_NODE_SIZE;
    w = MIN_NODE_SIZE;
  }
  if (h < MIN_NODE_SIZE) {
    if (dir.includes("n")) y = start.y + start.h - MIN_NODE_SIZE;
    h = MIN_NODE_SIZE;
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/**
 * The editable canvas: nodes as absolutely positioned divs approximating the
 * renderer's output (the satori-true render lives in the preview panel).
 * Pointer math only — click selects, drag moves, handles resize; Escape
 * deselects, Delete removes, arrows nudge 1px (Shift = 10px). All coordinates
 * stay integers.
 */
export function DesignCanvas({
  design,
  selectedId,
  kitById,
  frameLabel,
  snap,
  onSelect,
  onPatchNode,
  onDeleteNode,
  onCanvasResize,
}: Props) {
  const drag = useRef<DragState | null>(null);
  const canvasDrag = useRef<CanvasDragState | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const selected = findNode(design, selectedId);
  // Guide lines for the active gesture's object/canvas snaps; [] when idle.
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  // Mirrors canvasDrag for rendering: keeps the grabbed strip/grip highlighted
  // and the live size readout visible while the pointer roams off the handle.
  const [canvasResizing, setCanvasResizing] = useState<CanvasResizeDir | null>(null);

  function beginDrag(e: PointerEvent, nodeId: string, mode: DragState["mode"]) {
    const node = findNode(design, nodeId);
    if (!node) return;
    e.stopPropagation();
    onSelect(nodeId);
    wrapperRef.current?.focus({ preventScroll: true });
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = {
      nodeId,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      frame: { x: node.x, y: node.y, w: node.w, h: node.h },
      // Built once per gesture, not per move.
      targets: buildSnapTargets(design.nodes, nodeId, design.canvas),
    };
  }

  function handlePointerMove(e: PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    // Shift inverts BOTH toggles for this gesture; pointermove carries the
    // modifier, so releasing Shift mid-drag reverts live.
    const opts = effectiveSnapOptions(snap, e.shiftKey);
    let nextGuides: SnapGuide[];
    if (d.mode === "move") {
      const snapped = snapRect(
        { x: d.frame.x + dx, y: d.frame.y + dy, w: d.frame.w, h: d.frame.h },
        d.targets,
        opts,
      );
      onPatchNode(d.nodeId, { x: snapped.x, y: snapped.y });
      nextGuides = snapped.guides;
    } else {
      const { guides: resizeGuides, ...frame } = snapResizeRect(
        resizeFrame(d.frame, d.mode, dx, dy),
        d.mode,
        d.targets,
        opts,
      );
      onPatchNode(d.nodeId, frame);
      nextGuides = resizeGuides;
    }
    // Keep the [] reference stable while idle so React can bail out.
    setGuides((prev) => (prev.length === 0 && nextGuides.length === 0 ? prev : nextGuides));
  }

  function endDrag() {
    drag.current = null;
    setGuides((prev) => (prev.length === 0 ? prev : []));
  }

  /** Grab a canvas edge/corner: node selection clears — the gesture targets the canvas itself. */
  function beginCanvasResize(e: PointerEvent, dir: CanvasResizeDir) {
    if (!onCanvasResize) return;
    e.stopPropagation();
    onSelect(null);
    wrapperRef.current?.focus({ preventScroll: true });
    (e.target as Element).setPointerCapture(e.pointerId);
    canvasDrag.current = {
      dir,
      startX: e.clientX,
      startY: e.clientY,
      startW: design.canvas.width,
      startH: design.canvas.height,
    };
    setCanvasResizing(dir);
  }

  function handleCanvasResizeMove(e: PointerEvent) {
    const d = canvasDrag.current;
    if (!d || !onCanvasResize) return;
    // Same live Shift inversion as node gestures; grid-only by construction
    // (snapCanvasSize ignores opts.objects — the canvas has no object targets).
    const opts = effectiveSnapOptions(snap, e.shiftKey);
    const patch: { width?: number; height?: number } = {};
    if (d.dir !== "s") patch.width = snapCanvasSize(d.startW + (e.clientX - d.startX), opts);
    if (d.dir !== "e") patch.height = snapCanvasSize(d.startH + (e.clientY - d.startY), opts);
    onCanvasResize(patch);
  }

  function endCanvasResize() {
    canvasDrag.current = null;
    setCanvasResizing(null);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      endDrag(); // also clears any active guides
      endCanvasResize();
      onSelect(null);
      return;
    }
    if (!selected) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      // Deleting mid-drag unmounts the pointer-capture element, so pointerup
      // never fires — end the gesture here or guides/drag state leak.
      endDrag();
      onDeleteNode(selected.id);
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const nudge: Record<string, Partial<DesignNode>> = {
      ArrowLeft: { x: selected.x - step },
      ArrowRight: { x: selected.x + step },
      ArrowUp: { y: selected.y - step },
      ArrowDown: { y: selected.y + step },
    };
    const patch = nudge[e.key];
    if (patch) {
      e.preventDefault();
      onPatchNode(selected.id, patch);
    }
  }

  return (
    <div
      ref={wrapperRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPointerDown={(e) => {
        // A press that reaches the wrapper itself missed every node.
        if (e.target === e.currentTarget) onSelect(null);
      }}
      className="relative flex flex-1 items-start justify-center overflow-auto p-10 outline-none
        [background-image:radial-gradient(circle,var(--color-border)_1px,transparent_1px)]
        [background-size:16px_16px]"
      aria-label="Design canvas"
    >
      <div
        onPointerDown={(e) => {
          // Clicking canvas background (not a node) also deselects.
          if (e.target === e.currentTarget) onSelect(null);
        }}
        className="relative shrink-0 shadow-[0_12px_40px_rgba(0,0,0,0.5)] ring-1 ring-border"
        style={{
          width: design.canvas.width,
          height: design.canvas.height,
          // Canvas tw approximation, merged UNDER the structured fields —
          // the renderer's §5.6 order (tree.ts buildCanvas: tw first, then
          // background/radius). The API-rendered preview stays the truth;
          // this only lets gradients/radii show up live while editing.
          ...layerStyles(twApproxStyle(design.canvas.tw), {
            backgroundColor: design.canvas.background,
            borderRadius: design.canvas.radius,
          }),
        }}
      >
        {snap.grid && (
          // WYSIWYG grid: dots at exactly the spacing positions snap to,
          // replacing the decorative wrapper dots inside the canvas bounds.
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[inherit]
              [background-image:radial-gradient(circle,rgba(148,163,184,0.4)_1px,transparent_1px)]"
            style={{
              backgroundSize: `${snap.gridSize}px ${snap.gridSize}px`,
              // The gradient dot sits at each tile's CENTER; shift the tiling
              // by half a cell so dots land exactly on the gridSize multiples
              // that snapping targets (0, gridSize, 2*gridSize, …).
              backgroundPosition: `${-snap.gridSize / 2}px ${-snap.gridSize / 2}px`,
            }}
          />
        )}
        {frameLabel && (
          <>
            <span className="pointer-events-none absolute -top-5 left-0 flex items-center gap-1 font-mono text-[10px] text-sky-400/90">
              <Puzzle className="size-3" aria-hidden />
              {frameLabel}
            </span>
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-[inherit] border border-dashed border-sky-500/30"
            />
          </>
        )}
        {design.nodes.map((node) => (
          <CanvasNode
            key={node.id}
            node={node}
            kitById={kitById}
            selected={node.id === selectedId}
            onPointerDown={(e) => beginDrag(e, node.id, "move")}
            onPointerMove={handlePointerMove}
            onPointerEnd={endDrag}
          />
        ))}

        {selected && (
          <div
            // z-30 keeps node handles grabbable above the canvas edge strips
            // (z-10) when a selected node sits flush against the border.
            className="pointer-events-none absolute z-30 ring-2 ring-sky-500"
            style={{
              left: selected.x,
              top: selected.y,
              width: selected.w,
              height: selected.h,
            }}
          >
            {HANDLES.map((h) => (
              <span
                key={h.dir}
                onPointerDown={(e) => beginDrag(e, selected.id, h.dir)}
                onPointerMove={handlePointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                className={cn(
                  "pointer-events-auto absolute size-2 rounded-[2px] border border-sky-500 bg-background",
                  h.className,
                )}
                style={{ cursor: h.cursor }}
              />
            ))}
          </div>
        )}

        {/* Active snap guides: 1px lines spanning target extent + dragged node. */}
        {guides.map((g) => (
          <div
            key={`${g.axis}:${g.at}`}
            aria-hidden
            className="pointer-events-none absolute z-20 bg-sky-400"
            style={
              g.axis === "v"
                ? { left: g.at, top: g.from, width: 1, height: g.to - g.from }
                : { top: g.at, left: g.from, height: 1, width: g.to - g.from }
            }
          />
        ))}

        {/* Canvas self-resize: right/bottom edge strips + corner grip. The
            canvas div's own width/height come straight from design.canvas, so
            the grid overlay (inset-0) and these edge-anchored handles track
            the live size on every mid-drag patch. */}
        {onCanvasResize && (
          <>
            {CANVAS_EDGE_HANDLES.map((h) => (
              <div
                key={h.dir}
                role="separator"
                aria-label={h.label}
                title={h.label}
                onPointerDown={(e) => beginCanvasResize(e, h.dir)}
                onPointerMove={handleCanvasResizeMove}
                onPointerUp={endCanvasResize}
                onPointerCancel={endCanvasResize}
                className={cn("group absolute z-10 touch-none select-none", h.hit)}
                style={{ cursor: h.cursor }}
              >
                <span
                  aria-hidden
                  className={cn(
                    "absolute rounded-full bg-sky-500 opacity-0 transition-opacity group-hover:opacity-60",
                    h.strip,
                    canvasResizing === h.dir && "opacity-100 group-hover:opacity-100",
                  )}
                />
              </div>
            ))}
            <div
              role="separator"
              aria-label="Resize canvas"
              title="Resize canvas"
              onPointerDown={(e) => beginCanvasResize(e, "se")}
              onPointerMove={handleCanvasResizeMove}
              onPointerUp={endCanvasResize}
              onPointerCancel={endCanvasResize}
              className="group absolute -right-2 -bottom-2 z-10 size-4 cursor-nwse-resize touch-none select-none"
            >
              {/* Always faintly visible — the founder ask was discoverability. */}
              <span
                aria-hidden
                className={cn(
                  "absolute inset-0.5 rounded-[3px] border-2 border-sky-500 bg-background opacity-40 transition-opacity group-hover:opacity-100",
                  canvasResizing === "se" && "opacity-100",
                )}
              />
            </div>
            {canvasResizing && (
              <span
                aria-hidden
                className="pointer-events-none absolute top-full right-0 mt-2 font-mono text-[10px] text-sky-400"
              >
                {design.canvas.width}×{design.canvas.height}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface NodeProps {
  node: DesignNode;
  kitById: Map<string, KitComponent>;
  selected: boolean;
  onPointerDown: (e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerEnd: () => void;
}

/** One node, drawn to approximate the renderer's satori tree (apps/renderer/src/tree.ts). */
function CanvasNode({ node, kitById, selected, onPointerDown, onPointerMove, onPointerEnd }: NodeProps) {
  const frame: CSSProperties = {
    position: "absolute",
    left: node.x,
    top: node.y,
    width: node.w,
    height: node.h,
    opacity: node.opacity,
    transform: node.rotation ? `rotate(${node.rotation}deg)` : undefined,
  };

  return (
    <div
      data-node-id={node.id}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      className={cn("cursor-move touch-none select-none", !selected && "hover:ring-1 hover:ring-sky-500/40")}
      style={frame}
    >
      <NodeBody node={node} kitById={kitById} />
    </div>
  );
}

function NodeBody({ node, kitById }: { node: DesignNode; kitById: Map<string, KitComponent> }) {
  switch (node.type) {
    case "text":
      return <TextBody node={node} />;
    case "rect":
      return <RectBody node={node} />;
    case "image":
      return (
        <img
          src={node.src}
          alt=""
          draggable={false}
          className="pointer-events-none h-full w-full"
          // tw under structured (tree.ts imageEl) — e.g. rounded-full applies
          // unless an explicit structured radius overrides it.
          style={layerStyles(twApproxStyle(node.tw), {
            objectFit: node.fit ?? "cover",
            borderRadius: node.radius,
          })}
        />
      );
    case "instance":
      return <InstanceBody node={node} kitById={kitById} />;
  }
}

// Node tw approximation (§5.6): each body compiles node.tw and layers it
// UNDER the structured style mapping — defaults < tw < structured, exactly
// the renderer's merge order (apps/renderer/src/tree.ts) so gradients, radii
// and shadows show up live while the Inspector's structured edits still win.
// The API-rendered preview stays the truth; this is only an approximation.

function TextBody({ node }: { node: TextNode }) {
  const s = node.style ?? {};
  const align = s.align ?? "left";
  return (
    <div
      className="flex h-full w-full"
      style={layerStyles(
        {
          justifyContent: align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start",
          textAlign: align,
          fontFamily: s.fontFamily ?? "Inter, sans-serif",
          fontSize: s.fontSize ?? 16,
          fontWeight: 400,
          // Renderer default is #000000 (tree.ts); mirror it so WYSIWYG holds.
          color: "#000000",
        },
        twApproxStyle(node.tw),
        {
          fontWeight: s.fontWeight,
          color: s.color,
          lineHeight: s.lineHeight,
          letterSpacing: s.letterSpacing !== undefined ? `${s.letterSpacing}px` : undefined,
        },
      )}
    >
      {node.text}
    </div>
  );
}

function RectBody({ node }: { node: RectNode }) {
  const s = node.style ?? {};
  return (
    <div
      className="h-full w-full"
      style={layerStyles(
        twApproxStyle(node.tw),
        {
          backgroundColor: s.fill,
          borderRadius: s.radius,
          // Longhands, matching tree.ts rectEl, so a structured stroke
          // deterministically overrides tw border classes.
          ...(s.stroke && s.strokeWidth
            ? {
                borderWidth: `${s.strokeWidth}px`,
                borderStyle: "solid" as const,
                borderColor: s.stroke,
              }
            : undefined),
        },
      )}
    />
  );
}

/**
 * Instances show title + frame outline; the true expansion renders in the
 * preview panel. Deliberately NO tw approximation here: the renderer ignores
 * tw on instance nodes in v0 (tree.ts instanceEl — it warns instead), so
 * painting it on the canvas would preview an effect production never shows.
 */
function InstanceBody({ node, kitById }: { node: InstanceNode; kitById: Map<string, KitComponent> }) {
  const kit = kitById.get(node.component);
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-0.5 overflow-hidden rounded-md border-2 border-dashed border-sky-500/50 bg-sky-500/5">
      <span className="text-xs font-medium text-sky-400">{kit?.title ?? node.component}</span>
      <span className="font-mono text-[10px] text-muted-foreground">{node.component}</span>
    </div>
  );
}

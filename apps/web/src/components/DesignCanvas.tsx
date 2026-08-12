import { useRef } from "react";
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
import type { KitComponent } from "@/hooks/useKit";
import { cn } from "@/lib/utils";

type ResizeDir = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

interface DragState {
  nodeId: string;
  mode: "move" | ResizeDir;
  /** Pointer position at drag start (client coords). */
  startX: number;
  startY: number;
  /** Node frame at drag start. */
  frame: { x: number; y: number; w: number; h: number };
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
  onSelect: (id: string | null) => void;
  onPatchNode: (id: string, patch: Partial<DesignNode>) => void;
  onDeleteNode: (id: string) => void;
}

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
  onSelect,
  onPatchNode,
  onDeleteNode,
}: Props) {
  const drag = useRef<DragState | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const selected = findNode(design, selectedId);

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
    };
  }

  function handlePointerMove(e: PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (d.mode === "move") {
      onPatchNode(d.nodeId, {
        x: Math.round(d.frame.x + dx),
        y: Math.round(d.frame.y + dy),
      });
    } else {
      onPatchNode(d.nodeId, resizeFrame(d.frame, d.mode, dx, dy));
    }
  }

  function endDrag() {
    drag.current = null;
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      onSelect(null);
      return;
    }
    if (!selected) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
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
          background: design.canvas.background ?? "transparent",
          borderRadius: design.canvas.radius ?? 0,
        }}
      >
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
            className="pointer-events-none absolute ring-2 ring-sky-500"
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
          style={{ objectFit: node.fit ?? "cover", borderRadius: node.radius ?? 0 }}
        />
      );
    case "instance":
      return <InstanceBody node={node} kitById={kitById} />;
  }
}

function TextBody({ node }: { node: TextNode }) {
  const s = node.style ?? {};
  const align = s.align ?? "left";
  return (
    <div
      className="flex h-full w-full"
      style={{
        justifyContent: align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start",
        textAlign: align,
        fontFamily: s.fontFamily ?? "Inter, sans-serif",
        fontSize: s.fontSize ?? 16,
        fontWeight: s.fontWeight ?? 400,
        // Renderer default is #000000 (tree.ts); mirror it so WYSIWYG holds.
        color: s.color ?? "#000000",
        lineHeight: s.lineHeight,
        letterSpacing: s.letterSpacing !== undefined ? `${s.letterSpacing}px` : undefined,
      }}
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
      style={{
        backgroundColor: s.fill ?? "transparent",
        borderRadius: s.radius ?? 0,
        border: s.stroke && s.strokeWidth ? `${s.strokeWidth}px solid ${s.stroke}` : undefined,
      }}
    />
  );
}

/** Instances show title + frame outline; the true expansion renders in the preview panel. */
function InstanceBody({ node, kitById }: { node: InstanceNode; kitById: Map<string, KitComponent> }) {
  const kit = kitById.get(node.component);
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-0.5 overflow-hidden rounded-md border-2 border-dashed border-sky-500/50 bg-sky-500/5">
      <span className="text-xs font-medium text-sky-400">{kit?.title ?? node.component}</span>
      <span className="font-mono text-[10px] text-muted-foreground">{node.component}</span>
    </div>
  );
}

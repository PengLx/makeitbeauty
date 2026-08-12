/**
 * Pure snapping engine for the design canvas.
 *
 * No DOM, no React: given the other nodes + canvas as snap targets and a
 * candidate rect mid-gesture, compute the snapped rect and the guide lines to
 * draw. DesignCanvas builds targets once per gesture (pointerdown) and calls
 * snapRect / snapResizeRect on every pointermove.
 *
 * Decision table (per axis, applied independently to x and y):
 *   1. object snapping enabled AND an edge/center/canvas target is within
 *      `threshold` of a moved edge  → nearest target wins, guide rendered
 *   2. otherwise, grid snapping enabled → round to the nearest gridSize
 *   3. otherwise → plain Math.round (the canvas's integer invariant)
 *
 * Move snaps position only (w/h untouched). Resize snaps only the moving
 * edge(s) and recomputes w/h, rejecting any snap that would shrink the node
 * below MIN_NODE_SIZE. All outputs are integers.
 */

import { MIN_NODE_SIZE } from "./design";

/** "v" = vertical guide line (an x value); "h" = horizontal (a y value). */
export type SnapAxis = "v" | "h";

export type ResizeDir = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapTarget {
  /** Coordinate on the snap axis (x for "v" targets, y for "h" targets). */
  at: number;
  /** Extent of the source node/canvas along the other axis (guide span). */
  from: number;
  to: number;
}

export interface SnapTargets {
  /** x values: every other node's left/centerX/right + canvas 0/center/width. */
  v: SnapTarget[];
  /** y values: every other node's top/centerY/bottom + canvas 0/center/height. */
  h: SnapTarget[];
}

export interface SnapGuide {
  axis: SnapAxis;
  at: number;
  from: number;
  to: number;
}

/** Persisted snap preferences (localStorage "mib.snap", shared Editor/Studio). */
export interface SnapSettings {
  grid: boolean;
  gridSize: 4 | 8 | 16;
  objects: boolean;
}

export const DEFAULT_SNAP_SETTINGS: SnapSettings = {
  grid: true,
  gridSize: 8,
  objects: true,
};

export const GRID_SIZES: readonly SnapSettings["gridSize"][] = [4, 8, 16];

/** Max distance (canvas px) an edge may be from a target and still snap. */
export const SNAP_THRESHOLD = 6;

export interface SnapOptions {
  grid: boolean;
  gridSize: number;
  objects: boolean;
  threshold?: number;
}

/**
 * The SnapOptions a gesture actually uses: holding Shift inverts BOTH stored
 * toggles (effective = stored XOR shift). So snapping toggled OFF + Shift
 * held snaps to grid/objects, and ON + Shift moves freely. DesignCanvas calls
 * this with pointermove's own shiftKey, so releasing Shift mid-drag reverts
 * live on the next move.
 */
export function effectiveSnapOptions(
  settings: SnapSettings,
  shiftKey: boolean,
): SnapOptions {
  return {
    grid: shiftKey ? !settings.grid : settings.grid,
    objects: shiftKey ? !settings.objects : settings.objects,
    gridSize: settings.gridSize,
  };
}

export interface SnapResult {
  x: number;
  y: number;
  guides: SnapGuide[];
}

export type SnapResizeResult = Rect & { guides: SnapGuide[] };

interface NodeLike {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface CanvasLike {
  width: number;
  height: number;
}

/**
 * Snap targets for one gesture: every node except `excludeId` (the node being
 * dragged) contributes its edges and center on both axes; the canvas
 * contributes its bounds and center. Centers are rounded so `at` is always an
 * integer.
 */
export function buildSnapTargets(
  nodes: readonly NodeLike[],
  excludeId: string | null,
  canvas: CanvasLike,
): SnapTargets {
  const v: SnapTarget[] = [
    { at: 0, from: 0, to: canvas.height },
    { at: Math.round(canvas.width / 2), from: 0, to: canvas.height },
    { at: canvas.width, from: 0, to: canvas.height },
  ];
  const h: SnapTarget[] = [
    { at: 0, from: 0, to: canvas.width },
    { at: Math.round(canvas.height / 2), from: 0, to: canvas.width },
    { at: canvas.height, from: 0, to: canvas.width },
  ];
  for (const n of nodes) {
    if (n.id === excludeId) continue;
    v.push(
      { at: n.x, from: n.y, to: n.y + n.h },
      { at: Math.round(n.x + n.w / 2), from: n.y, to: n.y + n.h },
      { at: n.x + n.w, from: n.y, to: n.y + n.h },
    );
    h.push(
      { at: n.y, from: n.x, to: n.x + n.w },
      { at: Math.round(n.y + n.h / 2), from: n.x, to: n.x + n.w },
      { at: n.y + n.h, from: n.x, to: n.x + n.w },
    );
  }
  return { v, h };
}

interface AxisHit {
  /** How far the rect must shift on this axis to land on the target. */
  delta: number;
  target: SnapTarget;
}

/** Nearest target within threshold across all (edge, target) pairs, or null. */
function nearestObjectSnap(
  edges: readonly number[],
  targets: readonly SnapTarget[],
  threshold: number,
): AxisHit | null {
  let best: AxisHit | null = null;
  for (const target of targets) {
    for (const edge of edges) {
      const delta = target.at - edge;
      if (Math.abs(delta) > threshold) continue;
      if (best === null || Math.abs(delta) < Math.abs(best.delta)) {
        best = { delta, target };
      }
    }
  }
  return best;
}

function snapToGrid(value: number, size: number): number {
  return Math.round(value / size) * size;
}

/**
 * Snap a candidate rect during a MOVE gesture. Object/canvas targets are
 * compared against the moved rect's own left/center/right (top/center/bottom);
 * the nearest within threshold wins its axis. Grid applies per axis only when
 * no object snap won there. Position only — w/h pass through untouched.
 */
export function snapRect(
  rect: Rect,
  targets: SnapTargets,
  opts: SnapOptions,
): SnapResult {
  const threshold = opts.threshold ?? SNAP_THRESHOLD;
  const { w, h } = rect;

  const hitV = opts.objects
    ? nearestObjectSnap([rect.x, rect.x + w / 2, rect.x + w], targets.v, threshold)
    : null;
  const hitH = opts.objects
    ? nearestObjectSnap([rect.y, rect.y + h / 2, rect.y + h], targets.h, threshold)
    : null;

  let x: number;
  if (hitV) x = Math.round(rect.x + hitV.delta);
  else if (opts.grid) x = snapToGrid(rect.x, opts.gridSize);
  else x = Math.round(rect.x);

  let y: number;
  if (hitH) y = Math.round(rect.y + hitH.delta);
  else if (opts.grid) y = snapToGrid(rect.y, opts.gridSize);
  else y = Math.round(rect.y);

  const guides: SnapGuide[] = [];
  if (hitV) {
    guides.push({
      axis: "v",
      at: hitV.target.at,
      from: Math.min(hitV.target.from, y),
      to: Math.max(hitV.target.to, y + h),
    });
  }
  if (hitH) {
    guides.push({
      axis: "h",
      at: hitH.target.at,
      from: Math.min(hitH.target.from, x),
      to: Math.max(hitH.target.to, x + w),
    });
  }
  return { x, y, guides };
}

/**
 * Snap the MOVING edge(s) of a candidate rect during a RESIZE gesture (the
 * rect is resizeFrame's output; the opposite edge stays anchored). Only the
 * edge the handle drags is compared — centers never snap during resize. Any
 * snap that would push w/h below MIN_NODE_SIZE is rejected (candidate kept).
 */
export function snapResizeRect(
  rect: Rect,
  dir: ResizeDir,
  targets: SnapTargets,
  opts: SnapOptions,
): SnapResizeResult {
  const threshold = opts.threshold ?? SNAP_THRESHOLD;
  let { x, y, w, h } = rect;
  let hitV: AxisHit | null = null;
  let hitH: AxisHit | null = null;

  function snapEdge(
    edge: number,
    axisTargets: readonly SnapTarget[],
  ): { value: number; hit: AxisHit | null } {
    const hit = opts.objects ? nearestObjectSnap([edge], axisTargets, threshold) : null;
    if (hit) return { value: Math.round(edge + hit.delta), hit };
    if (opts.grid) return { value: snapToGrid(edge, opts.gridSize), hit: null };
    return { value: Math.round(edge), hit: null };
  }

  if (dir.includes("e")) {
    const { value, hit } = snapEdge(x + w, targets.v);
    const next = value - x;
    if (next >= MIN_NODE_SIZE) {
      w = next;
      hitV = hit;
    }
  } else if (dir.includes("w")) {
    const { value, hit } = snapEdge(x, targets.v);
    const next = x + w - value;
    if (next >= MIN_NODE_SIZE) {
      x = value;
      w = next;
      hitV = hit;
    }
  }

  if (dir.includes("s")) {
    const { value, hit } = snapEdge(y + h, targets.h);
    const next = value - y;
    if (next >= MIN_NODE_SIZE) {
      h = next;
      hitH = hit;
    }
  } else if (dir.includes("n")) {
    const { value, hit } = snapEdge(y, targets.h);
    const next = y + h - value;
    if (next >= MIN_NODE_SIZE) {
      y = value;
      h = next;
      hitH = hit;
    }
  }

  const guides: SnapGuide[] = [];
  if (hitV) {
    guides.push({
      axis: "v",
      at: hitV.target.at,
      from: Math.min(hitV.target.from, y),
      to: Math.max(hitV.target.to, y + h),
    });
  }
  if (hitH) {
    guides.push({
      axis: "h",
      at: hitH.target.at,
      from: Math.min(hitH.target.from, x),
      to: Math.max(hitH.target.to, x + w),
    });
  }
  return { x, y, w, h, guides };
}

/* ---------- canvas self-resize (dragging the canvas/frame edges) ---------- */

/**
 * Interactive canvas size bounds. The schemas allow anything in [1, 4096]
 * (design.schema.json canvas / kit-component.schema.json frame), but a canvas
 * below ~64px is unusable in the editor — the resize affordances, frame label
 * and node handles crowd out the surface and grid cells stop being
 * distinguishable — so every interactive surface (edge drag, inspector W/H
 * fields) clamps the minimum to 64. The Code tab still accepts any
 * schema-valid size; this is a UI floor, not a document invariant.
 */
export const CANVAS_MIN_SIZE = 64;
export const CANVAS_MAX_SIZE = 4096;

/** Round + clamp one canvas dimension to the interactive bounds. */
export function clampCanvasSize(value: number): number {
  return Math.min(CANVAS_MAX_SIZE, Math.max(CANVAS_MIN_SIZE, Math.round(value)));
}

/**
 * One canvas dimension mid-drag: grid-snap, then clamp. The canvas has no
 * sibling objects to snap against, so `opts.objects` is deliberately ignored
 * — grid only (Shift inversion still applies because callers build `opts`
 * with effectiveSnapOptions, exactly like node gestures). Snapping runs
 * before clamping so a grid round past a bound still lands back inside;
 * the output is always an integer in [CANVAS_MIN_SIZE, CANVAS_MAX_SIZE].
 */
export function snapCanvasSize(value: number, opts: SnapOptions): number {
  return clampCanvasSize(opts.grid ? snapToGrid(value, opts.gridSize) : value);
}

/* ---------- canvas alignment (Inspector align row) ---------- */

export type AlignEdge = "left" | "centerX" | "right" | "top" | "centerY" | "bottom";

/**
 * Position patch that aligns a node to the canvas/frame on one edge or
 * center. Integer math; exactly one axis in the patch.
 */
export function alignToCanvas(
  rect: Pick<Rect, "x" | "y" | "w" | "h">,
  canvas: CanvasLike,
  edge: AlignEdge,
): { x: number } | { y: number } {
  switch (edge) {
    case "left":
      return { x: 0 };
    case "centerX":
      return { x: Math.round((canvas.width - rect.w) / 2) };
    case "right":
      return { x: Math.round(canvas.width - rect.w) };
    case "top":
      return { y: 0 };
    case "centerY":
      return { y: Math.round((canvas.height - rect.h) / 2) };
    case "bottom":
      return { y: Math.round(canvas.height - rect.h) };
  }
}

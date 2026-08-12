import { describe, expect, it } from "vitest";
import {
  alignToCanvas,
  buildSnapTargets,
  clampCanvasSize,
  effectiveSnapOptions,
  snapCanvasSize,
  snapRect,
  snapResizeRect,
  CANVAS_MAX_SIZE,
  CANVAS_MIN_SIZE,
  type SnapOptions,
  type SnapSettings,
  type SnapTargets,
} from "./snapping";

const CANVAS = { width: 1200, height: 630 };

const NODES = [
  { id: "a", x: 100, y: 100, w: 200, h: 50 },
  { id: "b", x: 400, y: 300, w: 101, h: 41 }, // odd sizes → fractional centers
];

const OBJECTS_ONLY: SnapOptions = { grid: false, gridSize: 8, objects: true };
const GRID_ONLY: SnapOptions = { grid: true, gridSize: 8, objects: false };
const NONE: SnapOptions = { grid: false, gridSize: 8, objects: false };

/** Targets with exactly one vertical / one horizontal entry. */
function only(v: number[], h: number[] = []): SnapTargets {
  return {
    v: v.map((at) => ({ at, from: 0, to: 100 })),
    h: h.map((at) => ({ at, from: 0, to: 100 })),
  };
}

describe("buildSnapTargets", () => {
  it("collects canvas bounds + center and every other node's edges + centers", () => {
    const t = buildSnapTargets(NODES, "a", CANVAS);
    // canvas: 0 / 600 / 1200, node b: 400 / round(450.5)=451 / 501
    expect(t.v.map((s) => s.at)).toEqual([0, 600, 1200, 400, 451, 501]);
    // canvas: 0 / 315 / 630, node b: 300 / round(320.5)=321 / 341
    expect(t.h.map((s) => s.at)).toEqual([0, 315, 630, 300, 321, 341]);
    // all integers, even for odd node sizes
    for (const s of [...t.v, ...t.h]) expect(Number.isInteger(s.at)).toBe(true);
  });

  it("excludes the moving node and tags targets with the source span", () => {
    const t = buildSnapTargets(NODES, "b", CANVAS);
    expect(t.v.map((s) => s.at)).not.toContain(400);
    // node a's left edge target spans a's vertical extent
    const left = t.v.find((s) => s.at === 100);
    expect(left).toMatchObject({ from: 100, to: 150 });
  });
});

describe("snapRect (move)", () => {
  it("snaps to the nearest target within threshold (nearest wins)", () => {
    // left edge at 97: |100-97|=3 beats |92-97|=5
    const r = snapRect({ x: 97, y: 500, w: 50, h: 20 }, only([92, 100]), OBJECTS_ONLY);
    expect(r.x).toBe(100);
    expect(r.guides).toEqual([{ axis: "v", at: 100, from: 0, to: 520 }]);
  });

  it("compares left, center AND right edges of the moved rect", () => {
    // right edge 147 → target 150 (delta 3); left/center are far away
    const right = snapRect({ x: 97, y: 500, w: 50, h: 20 }, only([150]), OBJECTS_ONLY);
    expect(right.x).toBe(100); // x shifts so right edge lands on 150

    // center 122 → target 125 (delta 3)
    const center = snapRect({ x: 97, y: 500, w: 50, h: 20 }, only([125]), OBJECTS_ONLY);
    expect(center.x).toBe(100);
  });

  it("misses targets beyond the threshold", () => {
    const r = snapRect({ x: 90, y: 500, w: 50, h: 20 }, only([100]), OBJECTS_ONLY);
    expect(r.x).toBe(90); // |100-90| = 10 > 6
    expect(r.guides).toEqual([]);
  });

  it("falls back to the grid on an axis where no object snap won", () => {
    const r = snapRect(
      { x: 90, y: 297, w: 50, h: 20 },
      only([], [300]),
      { grid: true, gridSize: 8, objects: true },
    );
    expect(r.y).toBe(300); // object snap won y (top edge 297 → 300)
    expect(r.x).toBe(88); // grid handled x (round(90/8)*8)
    expect(r.guides).toHaveLength(1);
  });

  it("snaps to the grid per axis when object snapping is off", () => {
    const r = snapRect({ x: 13, y: 19, w: 50, h: 20 }, only([14]), GRID_ONLY);
    expect(r).toMatchObject({ x: 16, y: 16, guides: [] });
  });

  it("respects a custom threshold", () => {
    const r = snapRect(
      { x: 90, y: 0, w: 50, h: 20 },
      only([100]),
      { ...OBJECTS_ONLY, threshold: 12 },
    );
    expect(r.x).toBe(100);
  });

  it("plain-rounds when both grid and objects are disabled (Shift inversion)", () => {
    const r = snapRect({ x: 13.6, y: 19.2, w: 50, h: 20 }, only([14]), NONE);
    expect(r).toMatchObject({ x: 14, y: 19, guides: [] });
  });

  it("always returns integers, even snapping an odd-width center", () => {
    // center = 10 + 25.5 = 35.5 → target 38: x = round(10 + 2.5) = 13 (integer)
    const r = snapRect({ x: 10, y: 0.4, w: 51, h: 20 }, only([38]), OBJECTS_ONLY);
    expect(Number.isInteger(r.x)).toBe(true);
    expect(Number.isInteger(r.y)).toBe(true);
    expect(r.x).toBe(13);
  });

  it("guide spans the union of the target extent and the moved rect", () => {
    const targets: SnapTargets = {
      v: [{ at: 100, from: 40, to: 90 }],
      h: [],
    };
    const r = snapRect({ x: 98, y: 60, w: 50, h: 200 }, targets, OBJECTS_ONLY);
    expect(r.guides).toEqual([{ axis: "v", at: 100, from: 40, to: 260 }]);
  });
});

describe("snapResizeRect", () => {
  it("snaps the moving east edge and recomputes width; x stays anchored", () => {
    const r = snapResizeRect(
      { x: 100, y: 100, w: 96, h: 50 },
      "e",
      only([200]),
      OBJECTS_ONLY,
    );
    expect(r).toMatchObject({ x: 100, y: 100, w: 100, h: 50 });
    expect(r.guides).toEqual([{ axis: "v", at: 200, from: 0, to: 150 }]);
  });

  it("snaps the moving west edge, keeping the right edge fixed", () => {
    const r = snapResizeRect(
      { x: 103, y: 100, w: 97, h: 50 },
      "w",
      only([100]),
      OBJECTS_ONLY,
    );
    expect(r).toMatchObject({ x: 100, w: 100 }); // right edge still 200
  });

  it("snaps both moving edges of a corner handle independently", () => {
    const r = snapResizeRect(
      { x: 100, y: 100, w: 97, h: 53 },
      "se",
      only([200], [150]),
      OBJECTS_ONLY,
    );
    expect(r).toMatchObject({ x: 100, y: 100, w: 100, h: 50 });
    expect(r.guides).toHaveLength(2);
  });

  it("never snaps the anchored edge", () => {
    // n-handle: only the top edge moves; a target near the bottom edge (150)
    // must not fire.
    const r = snapResizeRect(
      { x: 100, y: 100, w: 50, h: 50 },
      "n",
      only([], [148]),
      OBJECTS_ONLY,
    );
    expect(r).toMatchObject({ y: 100, h: 50, guides: [] });
  });

  it("rejects an object snap that would shrink below the 8px minimum", () => {
    // right edge 110, target 106 → w would become 6 (< 8): keep candidate.
    const r = snapResizeRect(
      { x: 100, y: 100, w: 10, h: 50 },
      "e",
      only([106]),
      OBJECTS_ONLY,
    );
    expect(r).toMatchObject({ w: 10, guides: [] });
  });

  it("grid-snaps the moving edge when no object target is near", () => {
    const r = snapResizeRect(
      { x: 100, y: 100, w: 97, h: 50 },
      "e",
      only([400]), // far away — object snap misses
      { grid: true, gridSize: 8, objects: true },
    );
    // right edge 197 → round(197/8)*8 = 200 → w = 100; no guide for grid snaps
    expect(r).toMatchObject({ x: 100, w: 100, guides: [] });
  });

  it("returns integers for fractional candidates", () => {
    const r = snapResizeRect(
      { x: 100, y: 100, w: 50.4, h: 50 },
      "e",
      only([]),
      NONE,
    );
    expect(Number.isInteger(r.w)).toBe(true);
  });
});

describe("effectiveSnapOptions (Shift inversion — the DesignCanvas seam)", () => {
  const ALL_OFF: SnapSettings = { grid: false, gridSize: 8, objects: false };
  const ALL_ON: SnapSettings = { grid: true, gridSize: 8, objects: true };

  it("passes stored settings through unchanged without Shift", () => {
    expect(effectiveSnapOptions(ALL_ON, false)).toEqual({
      grid: true,
      objects: true,
      gridSize: 8,
    });
    expect(effectiveSnapOptions(ALL_OFF, false)).toEqual({
      grid: false,
      objects: false,
      gridSize: 8,
    });
  });

  it("snapping toggled OFF + Shift held → snaps to the grid", () => {
    const opts = effectiveSnapOptions(ALL_OFF, true);
    expect(opts).toMatchObject({ grid: true, objects: true });
    // No object target nearby → grid catches both axes.
    const r = snapRect({ x: 13, y: 21, w: 50, h: 20 }, only([]), opts);
    expect(r).toMatchObject({ x: 16, y: 24, guides: [] });
  });

  it("snapping toggled OFF + Shift held → object targets snap too", () => {
    const opts = effectiveSnapOptions(ALL_OFF, true);
    const r = snapRect({ x: 97, y: 500, w: 50, h: 20 }, only([100]), opts);
    expect(r.x).toBe(100);
    expect(r.guides).toHaveLength(1);
  });

  it("snapping toggled ON + Shift held → free movement (plain rounding)", () => {
    const opts = effectiveSnapOptions(ALL_ON, true);
    expect(opts).toMatchObject({ grid: false, objects: false });
    // Target at 16 is within threshold of x=13.4 and the grid would give 16,
    // but with both toggles inverted off the rect just plain-rounds.
    const r = snapRect({ x: 13.4, y: 21, w: 50, h: 20 }, only([16]), opts);
    expect(r).toMatchObject({ x: 13, y: 21, guides: [] });
  });

  it("releasing Shift mid-drag reverts on the next move (same settings, shift=false)", () => {
    const rect = { x: 13.4, y: 21, w: 50, h: 20 };
    const free = snapRect(rect, only([16]), effectiveSnapOptions(ALL_ON, true));
    const snapped = snapRect(rect, only([16]), effectiveSnapOptions(ALL_ON, false));
    expect(free.x).toBe(13); // Shift held: no snapping
    expect(snapped.x).toBe(16); // Shift released: object snap wins again
  });

  it("preserves gridSize through inversion", () => {
    const settings: SnapSettings = { grid: false, gridSize: 16, objects: false };
    const opts = effectiveSnapOptions(settings, true);
    expect(opts.gridSize).toBe(16);
    const r = snapRect({ x: 13, y: 0, w: 50, h: 20 }, only([]), opts);
    expect(r.x).toBe(16); // round(13/16)*16
  });
});

describe("clampCanvasSize", () => {
  it("clamps to the interactive floor (64, not the schema's 1)", () => {
    expect(clampCanvasSize(0)).toBe(CANVAS_MIN_SIZE);
    expect(clampCanvasSize(-500)).toBe(CANVAS_MIN_SIZE);
    expect(clampCanvasSize(63)).toBe(CANVAS_MIN_SIZE);
    expect(clampCanvasSize(64)).toBe(64);
  });

  it("clamps to the schema ceiling", () => {
    expect(clampCanvasSize(4097)).toBe(CANVAS_MAX_SIZE);
    expect(clampCanvasSize(999999)).toBe(CANVAS_MAX_SIZE);
    expect(clampCanvasSize(4096)).toBe(4096);
  });

  it("rounds fractional drags to integers", () => {
    expect(clampCanvasSize(199.4)).toBe(199);
    expect(clampCanvasSize(199.5)).toBe(200);
    expect(Number.isInteger(clampCanvasSize(63.7))).toBe(true);
  });
});

describe("snapCanvasSize (canvas edge drag — grid only)", () => {
  it("grid-snaps when grid is on", () => {
    expect(snapCanvasSize(197, GRID_ONLY)).toBe(200); // round(197/8)*8
    expect(snapCanvasSize(203, GRID_ONLY)).toBe(200);
    expect(snapCanvasSize(204, GRID_ONLY)).toBe(208);
  });

  it("plain-rounds when grid is off", () => {
    expect(snapCanvasSize(197.6, NONE)).toBe(198);
    expect(snapCanvasSize(197.2, NONE)).toBe(197);
  });

  it("ignores the objects flag — the canvas has no object targets", () => {
    const objectsNoGrid: SnapOptions = { grid: false, gridSize: 8, objects: true };
    expect(snapCanvasSize(197.6, objectsNoGrid)).toBe(198); // not snapped anywhere
  });

  it("clamps after snapping, so grid rounds past a bound land back inside", () => {
    // 50 grid-snaps to 48 — below the 64 floor → clamp wins.
    expect(snapCanvasSize(50, GRID_ONLY)).toBe(CANVAS_MIN_SIZE);
    // 4100 grid-snaps to 4104 — above the ceiling → clamp wins.
    expect(snapCanvasSize(4100, GRID_ONLY)).toBe(CANVAS_MAX_SIZE);
  });

  it("respects gridSize", () => {
    expect(snapCanvasSize(1190, { grid: true, gridSize: 16, objects: false })).toBe(1184);
  });

  it("composes with effectiveSnapOptions for Shift inversion, like node ops", () => {
    const gridOn: SnapSettings = { grid: true, gridSize: 8, objects: false };
    // Shift held with grid ON → free drag (plain rounding).
    expect(snapCanvasSize(197.6, effectiveSnapOptions(gridOn, true))).toBe(198);
    // Shift released → grid snapping again.
    expect(snapCanvasSize(197.6, effectiveSnapOptions(gridOn, false))).toBe(200);
    // Grid OFF + Shift held → snaps to grid.
    const gridOff: SnapSettings = { grid: false, gridSize: 8, objects: false };
    expect(snapCanvasSize(197.6, effectiveSnapOptions(gridOff, true))).toBe(200);
  });

  it("always returns integers within the interactive bounds", () => {
    for (const value of [-10, 0, 63.2, 64.5, 197.6, 4095.7, 5000]) {
      for (const opts of [GRID_ONLY, NONE]) {
        const out = snapCanvasSize(value, opts);
        expect(Number.isInteger(out)).toBe(true);
        expect(out).toBeGreaterThanOrEqual(CANVAS_MIN_SIZE);
        expect(out).toBeLessThanOrEqual(CANVAS_MAX_SIZE);
      }
    }
  });
});

describe("alignToCanvas", () => {
  const rect = { x: 5, y: 5, w: 101, h: 41 };

  it("aligns each edge/center with integer math", () => {
    expect(alignToCanvas(rect, CANVAS, "left")).toEqual({ x: 0 });
    expect(alignToCanvas(rect, CANVAS, "centerX")).toEqual({ x: 550 }); // round(1099/2)
    expect(alignToCanvas(rect, CANVAS, "right")).toEqual({ x: 1099 });
    expect(alignToCanvas(rect, CANVAS, "top")).toEqual({ y: 0 });
    expect(alignToCanvas(rect, CANVAS, "centerY")).toEqual({ y: 295 }); // round(589/2)
    expect(alignToCanvas(rect, CANVAS, "bottom")).toEqual({ y: 589 });
  });
});

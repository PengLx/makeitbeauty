/**
 * Native kit components (architecture.md §5.7).
 *
 * Declarative fragments cannot express array-driven visuals — a contribution
 * heatmap is hundreds of cells colored from a timeseries. For those, official
 * kit metadata declares {native: true, dataFields: [...]} and a TRUSTED
 * generator in this module produces the nodes from (props, data, frame).
 * Expansion (kit.ts) dispatches by the component id (without the "kit/"
 * prefix) and pushes the generated nodes through the exact same scale/offset/
 * id-prefix pipeline as declarative fragments, so generators think purely in
 * frame-relative coordinates.
 *
 * THE GENERATOR CONTRACT
 * - Deterministic: same (props, data, frame) → identical nodes. No Date.now,
 *   no randomness, no ambient state. Renders must stay byte-identical so the
 *   GitHub Action can skip commits when nothing changed.
 * - Never throw: missing/empty/malformed data renders a tasteful empty state
 *   (muted "no data" text on the card), never a render failure.
 * - Fresh nodes every call: the expansion pipeline mutates the returned nodes
 *   (scaling, id prefixing), so returning cached objects would corrupt the
 *   next render.
 * - Plain text/rect nodes only — generators emit the same vocabulary the
 *   sanitizer and animation compositor already understand. Generated nodes
 *   may carry preset animations; expansion strips them when the instance
 *   itself animates (an animated instance composes as one layer).
 *
 * Natives auto-consume connector data via their metadata dataFields (e.g.
 * "stats.calendar") — no {{templates}} involved, so the API's binding
 * derivation unions dataFields into the design's connector bindings to keep
 * the consent record complete.
 */
import { lookupPath } from "./template.js";
import type { RectNode, TextNode } from "./types.js";

/** Generators emit plain text/rect design nodes in frame coordinates. */
export type NativeFragmentNode = TextNode | RectNode;

/** Instance props after mergeProps: declared defaults overlaid by the design. */
export type ResolvedProps = Record<string, string | number>;

/** The connector data snapshot passed to render (namespaced by connector). */
export type DataSnapshot = Record<string, unknown>;

export interface NativeGeneratorArgs {
  props: ResolvedProps;
  data: DataSnapshot;
  frame: { w: number; h: number };
}

export type NativeGenerator = (args: NativeGeneratorArgs) => NativeFragmentNode[];

// ---------------------------------------------------------------------------
// Shared helpers (all pure)
// ---------------------------------------------------------------------------

// GitHub-dark constants shared by every generator's chrome.
const BORDER = "#21262d";
const MUTED = "#7d8590";
const FG = "#e6edf3";
const TRACK = "#21262d";

/**
 * Resolve a connector-relative dataField (e.g. "stats.calendar") against the
 * snapshot. Snapshots are namespaced by connector ({github: {stats: …}}), so
 * try the path as given first, then under each top-level namespace in sorted
 * order — deterministic, and connector-agnostic so a future connector serving
 * the same normalized shape lights the same component up.
 */
export function dataField(data: DataSnapshot, field: string): unknown {
  const direct = lookupPath(data, field);
  if (direct !== undefined) return direct;
  for (const ns of Object.keys(data).sort()) {
    const found = lookupPath(data, `${ns}.${field}`);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Coerce a calendar timeseries into daily counts, oldest → newest. Accepts
 * the normalized [{date, count}] shape and bare number arrays; anything
 * unusable in an entry counts as 0. Returns null when there is no series.
 */
function toCounts(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.map((entry) => {
    const n =
      typeof entry === "number"
        ? entry
        : entry !== null && typeof entry === "object"
          ? (entry as { count?: unknown }).count
          : undefined;
    const num = typeof n === "number" ? n : typeof n === "string" ? Number(n) : NaN;
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
  });
}

/** Coerce a scalar counter (streak days, totals) to a non-negative integer, or null. */
function toCount(value: unknown): number | null {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(num) ? Math.max(0, Math.floor(num)) : null;
}

/** Parse #rgb or #rrggbb into channels, or null for anything else. */
function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(color.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

/** Blend a→b at t = num/den per channel (integer rounding — deterministic). */
function mixHex(a: [number, number, number], b: [number, number, number], num: number, den: number): string {
  const channel = (i: number) => a[i] + Math.round(((b[i] - a[i]) * num) / den);
  const hex = (v: number) => v.toString(16).padStart(2, "0");
  return `#${hex(channel(0))}${hex(channel(1))}${hex(channel(2))}`;
}

/** The card backdrop every stat component sits on (mirrors the kit previews). */
function card(frame: { w: number; h: number }, background: string): RectNode {
  return {
    id: "bg",
    type: "rect",
    x: 0,
    y: 0,
    w: frame.w,
    h: frame.h,
    style: { fill: background, radius: 12, stroke: BORDER, strokeWidth: 1 },
  };
}

/** Small uppercase heading in the card's top-left corner. */
function heading(text: string, x: number, y: number, w: number, fontSize: number): TextNode {
  return {
    id: "label",
    type: "text",
    x,
    y,
    w,
    h: fontSize + 4,
    text,
    style: { fontSize, fontWeight: 600, color: MUTED, letterSpacing: 1 },
  };
}

/** The tasteful empty state: muted "no data" line centered in the content area. */
function noData(frame: { w: number; h: number }, top: number, message: string): TextNode {
  return {
    id: "empty",
    type: "text",
    x: 0,
    y: top + (frame.h - top) / 2 - 9,
    w: frame.w,
    h: 18,
    text: message,
    style: { fontSize: 13, color: MUTED, align: "center" },
  };
}

// ---------------------------------------------------------------------------
// contribution-heatmap — 53×7 GitHub-style contribution calendar
// ---------------------------------------------------------------------------

const HM_COLS = 53;
const HM_ROWS = 7;
const HM_GAP = 3;
const HM_TOP = 40; // grid starts below the heading
const HM_PAD = 17; // side/bottom padding around the grid

/**
 * Intensity level 0..4 for a day. Integer math only: for count ≥ 1 the level
 * is ceil(4·count/max) — quartiles of the series max — computed without
 * floats as 1 + ((4·count − 1) div max), so the non-zero thresholds are
 * max/4, max/2, 3·max/4 and max exactly. count 0 (or a degenerate max) is
 * level 0, the track cell.
 */
export function contributionLevel(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.min(4, 1 + Math.floor((4 * count - 1) / max));
}

function contributionHeatmap({ props, data, frame }: NativeGeneratorArgs): NativeFragmentNode[] {
  const background = String(props.background);
  const chrome: NativeFragmentNode[] = [
    card(frame, background),
    heading(String(props.label), HM_PAD, 14, frame.w - 2 * HM_PAD, 12),
  ];

  const counts = toCounts(dataField(data, "stats.calendar"));
  if (!counts) return [...chrome, noData(frame, HM_TOP, "no contribution data yet")];

  // Cell size derives from the frame so 53 columns always fit exactly:
  //   width-limited:  (w − 2·PAD − 52·GAP) / 53   → (720 − 34 − 156)/53 = 10
  //   height-limited: (h − TOP − PAD − 6·GAP) / 7 → (140 − 40 − 17 − 18)/7 ≈ 9.28…
  // take the min, then center the grid in the available area. With the
  // metadata frame (720×140) that yields ~9.3px cells + 3px gaps.
  const cell = Math.min(
    (frame.w - 2 * HM_PAD - (HM_COLS - 1) * HM_GAP) / HM_COLS,
    (frame.h - HM_TOP - HM_PAD - (HM_ROWS - 1) * HM_GAP) / HM_ROWS,
  );
  const gridW = HM_COLS * cell + (HM_COLS - 1) * HM_GAP;
  const gridH = HM_ROWS * cell + (HM_ROWS - 1) * HM_GAP;
  const x0 = (frame.w - gridW) / 2;
  const y0 = HM_TOP + (frame.h - HM_TOP - HM_PAD - gridH) / 2;

  // 5-level ramp: level 0 is the empty/track cell; levels 1–3 blend the
  // track toward the accent at 6/20, 11/20 and 16/20 (integer channel math);
  // level 4 is the accent itself. Bad hex props fall back to the defaults.
  const empty = String(props.emptyColor);
  const accentHex = parseHex(String(props.accent)) ?? (parseHex("#39d353") as [number, number, number]);
  const emptyHex = parseHex(empty) ?? (parseHex(TRACK) as [number, number, number]);
  const ramp = [
    mixHex(emptyHex, accentHex, 6, 20),
    mixHex(emptyHex, accentHex, 11, 20),
    mixHex(emptyHex, accentHex, 16, 20),
    String(props.accent),
  ];

  // The last series entry is the most recent day and lands in the bottom-right
  // cell; shorter series are front-padded so the grid right-aligns like
  // GitHub's calendar. Cells walk column-major (a column = one week).
  const total = HM_COLS * HM_ROWS;
  const tail = counts.slice(-total);
  const pad = total - tail.length;
  const max = tail.reduce((a, b) => Math.max(a, b), 0);

  const cells: NativeFragmentNode[] = [];
  for (let i = 0; i < total; i++) {
    const col = Math.floor(i / HM_ROWS);
    const row = i % HM_ROWS;
    const count = i < pad ? 0 : tail[i - pad];
    const level = contributionLevel(count, max);
    cells.push({
      id: `d${i}`,
      type: "rect",
      x: x0 + col * (cell + HM_GAP),
      y: y0 + row * (cell + HM_GAP),
      w: cell,
      h: cell,
      style: { fill: level === 0 ? empty : ramp[level - 1], radius: 2 },
    });
  }
  return [...chrome, ...cells];
}

// ---------------------------------------------------------------------------
// activity-sparkline — last 84 days bucketed into 12 weekly bars
// ---------------------------------------------------------------------------

const SP_WEEKS = 12;
const SP_DAYS = SP_WEEKS * 7; // 84
const SP_PAD = 16;
const SP_TOP = 34; // bars start below the heading row
const SP_BOTTOM = 14;
const SP_GAP = 8;

function activitySparkline({ props, data, frame }: NativeGeneratorArgs): NativeFragmentNode[] {
  const chrome: NativeFragmentNode[] = [
    card(frame, String(props.background)),
    heading(String(props.label), SP_PAD, 12, frame.w - 2 * SP_PAD, 11),
  ];

  const counts = toCounts(dataField(data, "stats.calendar"));
  if (!counts) return [...chrome, noData(frame, SP_TOP, "no activity data yet")];

  // Bucket math: the last 84 days form 12 weeks of 7; a shorter series is
  // front-padded with zeros so the newest day always lands in the rightmost
  // bar. weeks[i] is the total of days [7i, 7i+7).
  const tail = counts.slice(-SP_DAYS);
  const padded: number[] = new Array(SP_DAYS - tail.length).fill(0).concat(tail);
  const weeks: number[] = [];
  for (let w = 0; w < SP_WEEKS; w++) {
    let sum = 0;
    for (let d = 0; d < 7; d++) sum += padded[w * 7 + d];
    weeks.push(sum);
  }
  const max = weeks.reduce((a, b) => Math.max(a, b), 0);

  // Bars fill the frame width exactly: barW = (w − 2·PAD − 11·GAP)/12
  // (360 → (360 − 32 − 88)/12 = 20). Heights scale to the busiest week over
  // areaH, floored at 2px whenever the week has any activity; empty weeks
  // render a 2px track stub so the rhythm of the 12 columns stays visible.
  const baseline = frame.h - SP_BOTTOM;
  const areaH = baseline - SP_TOP;
  const barW = (frame.w - 2 * SP_PAD - (SP_WEEKS - 1) * SP_GAP) / SP_WEEKS;
  const accent = String(props.accent);

  const bars: NativeFragmentNode[] = weeks.map((sum, i) => {
    const h = max > 0 && sum > 0 ? Math.max(2, Math.round((sum * areaH) / max)) : 2;
    return {
      id: `bar${i}`,
      type: "rect",
      x: SP_PAD + i * (barW + SP_GAP),
      y: baseline - h,
      w: barW,
      h,
      style: { fill: sum > 0 ? accent : TRACK, radius: 2 },
      // Staggered entrance, 40ms per bar, oldest first. Stripped by expansion
      // when the instance itself animates (one composed layer wins).
      animation: { preset: "growY", durationMs: 600, delayMs: i * 40 },
    };
  });

  const nodes = [...chrome, ...bars];
  // Optional peak label (numeric prop: 0 hides): the busiest week's total,
  // top-right, mirroring the heading row.
  if (Number(props.peakLabel) !== 0 && max > 0) {
    nodes.push({
      id: "peak",
      type: "text",
      x: frame.w - SP_PAD - 120,
      y: 12,
      w: 120,
      h: 15,
      text: `peak ${max}`,
      style: { fontSize: 11, fontWeight: 500, color: MUTED, align: "right" },
    });
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// language-bar — proportional language segments + legend
// ---------------------------------------------------------------------------

/**
 * Fixed 8-color palette (GitHub-dark friendly). A language's color is keyed
 * by name hash, so it is stable across renders, data refreshes and reorderings
 * — TypeScript is always the same color no matter its share.
 */
export const LANGUAGE_PALETTE = [
  "#58a6ff", // blue
  "#3fb950", // green
  "#f78166", // coral
  "#d2a8ff", // violet
  "#f2cc60", // gold
  "#76e3ea", // cyan
  "#ff7b72", // red
  "#ffa657", // orange
] as const;

/**
 * djb2-xor hash over UTF-16 code units ((h·33) XOR c, kept in uint32 by
 * >>> 0). Pure integer ops on the string's code units: platform-independent,
 * so the palette index — and therefore every language's color — is identical
 * on every render anywhere.
 */
export function languageColor(name: string): string {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h * 33) ^ name.charCodeAt(i)) >>> 0;
  return LANGUAGE_PALETTE[h % LANGUAGE_PALETTE.length];
}

const LB_PAD = 20;
const LB_BAR_Y = 44;
const LB_BAR_H = 14;
const LB_RADIUS = 7;
const LB_LEGEND_Y = 74;
const LB_FONT = 12;
/** Rough glyph advance for legend width budgeting: ~0.62 × fontSize. */
const LB_CHAR_W = 7.5;

interface LanguageShare {
  name: string;
  value: number;
}

/** Coerce stats.topLanguages entries ({name, percent|value|count} objects). */
function toLanguages(value: unknown): LanguageShare[] | null {
  if (!Array.isArray(value)) return null;
  const out: LanguageShare[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const { name, percent, pct, value: v, count } = entry as Record<string, unknown>;
    const num = toCount(percent ?? pct ?? v ?? count);
    if (typeof name === "string" && name !== "" && num !== null && num > 0) {
      out.push({ name, value: num });
    }
  }
  return out.length > 0 ? out : null;
}

function languageBar({ props, data, frame }: NativeGeneratorArgs): NativeFragmentNode[] {
  const chrome: NativeFragmentNode[] = [
    card(frame, String(props.background)),
    heading(String(props.label), LB_PAD, 16, frame.w - 2 * LB_PAD, 12),
  ];

  const parsed = toLanguages(dataField(data, "stats.topLanguages"));
  if (!parsed) return [...chrome, noData(frame, LB_BAR_Y, "no language data yet")];

  // Stable order: share desc, then name asc — deterministic even when the
  // connector reports ties. At most 8 segments (one per palette slot).
  const shown = [...parsed]
    .sort((a, b) => b.value - a.value || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, LANGUAGE_PALETTE.length);
  const sum = shown.reduce((a, l) => a + l.value, 0);

  const barW = frame.w - 2 * LB_PAD;
  const nodes: NativeFragmentNode[] = [
    ...chrome,
    // Rounded track under the segments: normally fully covered, it backstops
    // sub-pixel rounding at the far edge and keeps the declared trackColor
    // meaningful for sparse data.
    {
      id: "track",
      type: "rect",
      x: LB_PAD,
      y: LB_BAR_Y,
      w: barW,
      h: LB_BAR_H,
      style: { fill: String(props.trackColor), radius: LB_RADIUS },
    },
  ];

  // Proportional segments. Only the OUTER corners round: the first and last
  // segments are drawn with the full radius, then a same-fill square rect
  // overlaps their inner half so the seam to the neighbor stays crisp — the
  // simple overlapping-rects trick, no path math.
  let x = LB_PAD;
  shown.forEach((lang, i) => {
    const w = (barW * lang.value) / sum;
    const fill = languageColor(lang.name);
    const first = i === 0;
    const last = i === shown.length - 1;
    const rounded = first || last;
    nodes.push({
      id: `seg${i}`,
      type: "rect",
      x,
      y: LB_BAR_Y,
      w,
      h: LB_BAR_H,
      style: { fill, radius: rounded && shown.length > 0 ? LB_RADIUS : 0 },
    });
    if (rounded && shown.length > 1 && w > LB_RADIUS) {
      // Square off the inner edge (right half of the first segment, left
      // half of the last). A segment can be both first and last only when
      // it is alone, which the branch above excludes.
      nodes.push({
        id: `cap${i}`,
        type: "rect",
        x: first ? x + w / 2 : x,
        y: LB_BAR_Y,
        w: w / 2,
        h: LB_BAR_H,
        style: { fill, radius: 0 },
      });
    }
    x += w;
  });

  // Legend: "● Name 43%" items on one line; percentages are recomputed from
  // the shown shares so they always total ~100. Items that would overflow the
  // card are dropped (width estimate: chars × 0.62 × fontSize).
  let lx = LB_PAD;
  shown.forEach((lang, i) => {
    const pct = Math.round((100 * lang.value) / sum);
    const text = `${lang.name} ${pct}%`;
    const estW = Math.ceil(text.length * LB_CHAR_W);
    if (lx + 14 + estW > LB_PAD + barW) return;
    nodes.push({
      id: `dot${i}`,
      type: "rect",
      x: lx,
      y: LB_LEGEND_Y + 5,
      w: 8,
      h: 8,
      style: { fill: languageColor(lang.name), radius: 2 },
    });
    nodes.push({
      id: `lang${i}`,
      type: "text",
      x: lx + 14,
      y: LB_LEGEND_Y,
      w: estW,
      h: 18,
      text,
      style: { fontSize: LB_FONT, fontWeight: 500, color: FG },
    });
    lx += 14 + estW + 18;
  });

  return nodes;
}

// ---------------------------------------------------------------------------
// streak-flame — current/longest contribution streak
// ---------------------------------------------------------------------------

function streakFlame({ props, data, frame }: NativeGeneratorArgs): NativeFragmentNode[] {
  const accent = String(props.accent);
  const chrome: NativeFragmentNode[] = [
    card(frame, String(props.background)),
    heading(String(props.label), 20, 18, frame.w - 40, 12),
  ];

  const current = toCount(dataField(data, "stats.currentStreak"));
  if (current === null) return [...chrome, noData(frame, 34, "no streak data yet")];
  const longest = toCount(dataField(data, "stats.longestStreak"));

  const nodes: NativeFragmentNode[] = [
    ...chrome,
    {
      id: "count",
      type: "text",
      x: 20,
      y: 42,
      w: frame.w - 160,
      h: 46,
      text: String(current),
      style: { fontSize: 38, fontWeight: 700, color: accent },
    },
    {
      id: "unit",
      type: "text",
      x: 20,
      y: 92,
      w: frame.w - 160,
      h: 18,
      text: "day streak",
      style: { fontSize: 13, fontWeight: 500, color: FG },
    },
    {
      id: "tick",
      type: "rect",
      x: 20,
      y: frame.h - 20,
      w: 32,
      h: 4,
      style: { fill: accent, radius: 2 },
      // The "flame": a gentle looping pulse on the accent tick. Stripped by
      // expansion when the instance itself animates.
      animation: { preset: "pulse", durationMs: 1600, loop: true },
    },
  ];
  if (longest !== null) {
    nodes.push({
      id: "best",
      type: "text",
      x: frame.w - 140,
      y: 92,
      w: 120,
      h: 18,
      text: `best: ${longest}`,
      style: { fontSize: 13, fontWeight: 500, color: MUTED, align: "right" },
    });
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Generator registry, keyed by the kit component id WITHOUT the "kit/"
 * prefix. kit.ts dispatches here for components whose metadata declares
 * native: true; a native id missing from this map degrades to the
 * component's static preview nodes (or the dashed placeholder) with a
 * warning — never a render failure.
 */
export const nativeGenerators: ReadonlyMap<string, NativeGenerator> = new Map<
  string,
  NativeGenerator
>([
  ["contribution-heatmap", contributionHeatmap],
  ["activity-sparkline", activitySparkline],
  ["language-bar", languageBar],
  ["streak-flame", streakFlame],
]);

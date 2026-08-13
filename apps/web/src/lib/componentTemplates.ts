/**
 * Starter templates for the "New component" dialog (Component Studio
 * onboarding). These are TEACHING MATERIAL: each non-blank option is a
 * small, complete, schema-valid component definition a first-time creator
 * opens instead of an empty frame — every Studio concept gets one live,
 * beautiful example: a tw gradient + shadow, a {{props.*}} slot with a
 * sensible declaration, and exactly one animated node.
 *
 * Invariants (guarded by componentTemplates.test.ts):
 * - props-only bindings — components may reference {{props.*}} and nothing
 *   else (§7.5), so every template string resolves against declared props;
 * - every tw string compiles warning-free against @makeitbeauty/twc;
 * - nodes stay inside the frame; ids are unique and schema-shaped;
 * - exactly one node per template carries an animation, with a valid preset.
 */
import type { ComponentDefinition } from "./component";

/**
 * Draft content a template seeds. Code starters (§7.6) additionally carry
 * kind "code" + the render source; their nodes stay [] (for a code component
 * declared nodes are only the optional static palette preview).
 */
export interface ComponentTemplateSeed {
  props: ComponentDefinition["props"];
  nodes: ComponentDefinition["nodes"];
  kind?: "code";
  code?: string;
}

export interface ComponentTemplate {
  id:
    | "blank"
    | "gradient-banner"
    | "stat-card"
    | "badge"
    | "code-heatmap"
    | "code-blank";
  /** Radio-card heading. */
  label: string;
  /** One-line pitch under the heading. */
  blurb: string;
  /**
   * tw string painted (via twApproxStyle) as the radio card's preview strip;
   * "" renders the dashed empty-frame placeholder instead.
   */
  swatchTw: string;
  /**
   * Frame the seed nodes are laid out for. Selecting the template pre-fills
   * (and locks) the dialog's frame inputs — the frame stays resizable later
   * by dragging its edge in the Studio.
   */
  frame: { w: number; h: number };
  /** Draft content to seed; null = start from an empty frame. */
  seed: ComponentTemplateSeed | null;
  /** Suggested slug, prefilled only into an empty Name field. */
  suggestedName?: string;
}

/**
 * Deterministic sample calendar for the heatmap starter: 371 entries
 * (53 weeks × 7 days) from a Knuth multiplicative hash — no Math.random
 * anywhere near a code component, even in its sample data, so the seeded
 * draft publishes verbatim (publish executes twice and byte-compares).
 */
function sampleCalendar(): number[] {
  const days: number[] = [];
  for (let i = 0; i < 371; i++) {
    const h = (i * 2654435761) % 127;
    days.push(h < 52 ? 0 : h % 11);
  }
  return days;
}

/**
 * The heatmap starter's render source — proven against the real sandbox by
 * componentTemplates.test.ts (compile + execute twice + byte-compare, the
 * exact publish gate) so the starter always publishes.
 */
const HEATMAP_CODE = `function render({ props, frame }) {
  // GitHub-style contribution heatmap: 53 week-columns, days run down each
  // column. Accepts a series of {date, count} objects (or bare numbers).
  var days = Array.isArray(props.calendar) ? props.calendar : [];
  var count = Math.min(days.length, 371); // 53 weeks x 7 days
  var cell = 10;
  var gap = 3;
  var top = 22;
  var ramp = ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"];
  function at(i) {
    var d = days[i];
    var n = typeof d === "number" ? d : d && typeof d.count === "number" ? d.count : 0;
    return isFinite(n) && n > 0 ? n : 0;
  }
  var max = 0;
  for (var i = 0; i < count; i++) {
    if (at(i) > max) max = at(i);
  }
  var nodes = [
    {
      id: "label",
      type: "text",
      x: 0,
      y: 0,
      w: frame.w,
      h: 14,
      text: props.label,
      style: { fontSize: 11, color: "#7d8590" }
    }
  ];
  for (var j = 0; j < count; j++) {
    var v = at(j);
    var level = v === 0 ? 0 : Math.min(4, 1 + Math.floor((3 * v) / max));
    nodes.push({
      id: "d" + j,
      type: "rect",
      x: Math.floor(j / 7) * (cell + gap),
      y: top + (j % 7) * (cell + gap),
      w: cell,
      h: cell,
      style: { fill: ramp[level], radius: 2 }
    });
  }
  return nodes;
}
`;

/** The minimal teaching source for the blank code starter. */
const CODE_BLANK_CODE = `// A code component is ONE pure function:
//
//   render({ props, frame }) => nodes
//
// - props: your declared props with defaults merged in ("series" props
//   arrive as raw JSON arrays — the only place arrays are consumed)
// - frame: { w, h } — your component's own coordinate space
// - return: an ARRAY of text/rect/image nodes (the same shapes the canvas
//   uses), positioned relative to the frame's top-left corner
//
// The sandbox keeps render honest: no Date, no Math.random, no fetch, no
// async — deterministic by construction (publish runs it twice and compares
// bytes). Budget: ~50ms CPU, 32MB memory, at most 512 nodes, 64KB source.
// console.log(...) output appears under the Studio preview while you build.
function render({ props, frame }) {
  return [
    {
      id: "greeting",
      type: "text",
      x: 0,
      y: Math.round(frame.h / 2) - 12,
      w: frame.w,
      h: 24,
      text: props.text,
      style: { fontSize: 18, color: "#e6edf3", align: "center" },
    },
  ];
}
`;

export const COMPONENT_TEMPLATES: readonly ComponentTemplate[] = [
  {
    id: "blank",
    label: "Blank",
    blurb: "An empty frame — start from scratch.",
    swatchTw: "",
    frame: { w: 400, h: 160 },
    seed: null,
  },

  // Gradient banner — teaches: multi-stop tw gradients, layering (a sheen
  // rect over the background), text styled by structured fields + tw, and a
  // one-shot entrance animation on the headline.
  {
    id: "gradient-banner",
    label: "Gradient banner",
    blurb: "Bold hero strip: gradient, sheen, headline + subtitle slots.",
    swatchTw:
      "bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 rounded-md",
    frame: { w: 600, h: 200 },
    suggestedName: "gradient-banner",
    seed: {
      props: {
        title: {
          type: "string",
          default: "Make it beautiful",
          description: "Headline text",
        },
        subtitle: {
          type: "string",
          default: "A gradient banner, rendered fresh on every view",
          description: "Supporting line under the headline",
        },
      },
      nodes: [
        // Full-bleed card: tw does all the painting — no structured fill.
        {
          id: "bg",
          type: "rect",
          x: 0,
          y: 0,
          w: 600,
          h: 200,
          tw: "bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 rounded-2xl shadow-xl",
        },
        // Soft top sheen: white→transparent gradient faded to 10% opacity.
        {
          id: "sheen",
          type: "rect",
          x: 0,
          y: 0,
          w: 600,
          h: 90,
          tw: "bg-gradient-to-b from-white to-transparent opacity-10 rounded-2xl",
        },
        // The {{props.title}} slot — edit its default in the Props panel.
        {
          id: "title",
          type: "text",
          x: 32,
          y: 62,
          w: 536,
          h: 44,
          text: "{{props.title}}",
          style: { fontSize: 34, fontWeight: 700, color: "#ffffff" },
          tw: "tracking-tight",
          animation: { preset: "slideUp", durationMs: 700 },
        },
        {
          id: "subtitle",
          type: "text",
          x: 32,
          y: 114,
          w: 536,
          h: 24,
          text: "{{props.subtitle}}",
          style: { fontSize: 16, color: "#ffffff" },
          tw: "opacity-80",
        },
      ],
    },
  },

  // Stat card — teaches: a dark vertical gradient + border + shadow card,
  // tw-driven text color/weight/tracking, three prop slots, and growX
  // sweeping an accent bar in on every view.
  {
    id: "stat-card",
    label: "Stat card",
    blurb: "Dark metric card: label, big value, delta, animated accent bar.",
    swatchTw:
      "bg-gradient-to-b from-slate-800 to-slate-900 border-2 border-slate-700 rounded-md",
    frame: { w: 320, h: 180 },
    suggestedName: "stat-card",
    seed: {
      props: {
        label: {
          type: "string",
          default: "Monthly revenue",
          description: "What the number measures",
        },
        value: {
          type: "string",
          default: "$12,480",
          description: "Headline number (a string, so you own the formatting)",
        },
        delta: {
          type: "string",
          default: "+18% vs last month",
          description: "Change line under the value",
        },
      },
      nodes: [
        {
          id: "card",
          type: "rect",
          x: 0,
          y: 0,
          w: 320,
          h: 180,
          tw: "bg-gradient-to-b from-slate-800 to-slate-900 rounded-xl border-2 border-slate-700 shadow-lg",
        },
        {
          id: "label",
          type: "text",
          x: 24,
          y: 24,
          w: 272,
          h: 18,
          text: "{{props.label}}",
          style: { fontSize: 13 },
          tw: "text-slate-400 font-medium tracking-wide",
        },
        {
          id: "value",
          type: "text",
          x: 24,
          y: 48,
          w: 272,
          h: 48,
          text: "{{props.value}}",
          style: { fontSize: 40, fontWeight: 700 },
          tw: "text-white tracking-tight",
        },
        {
          id: "delta",
          type: "text",
          x: 24,
          y: 102,
          w: 272,
          h: 18,
          text: "{{props.delta}}",
          style: { fontSize: 13 },
          tw: "text-emerald-400 font-semibold",
        },
        // growX sweeps the bar in from the left on every render.
        {
          id: "accent",
          type: "rect",
          x: 24,
          y: 140,
          w: 180,
          h: 6,
          tw: "bg-gradient-to-r from-emerald-400 to-cyan-400 rounded-full",
          animation: { preset: "growX", durationMs: 900 },
        },
      ],
    },
  },

  // Badge — teaches: the smallest useful component; rounded-full pill, a
  // single prop slot, centered text, and a looping pulse.
  {
    id: "badge",
    label: "Badge",
    blurb: "Pulsing gradient pill with one text slot.",
    swatchTw: "bg-gradient-to-r from-amber-400 to-orange-500 rounded-full",
    frame: { w: 260, h: 64 },
    suggestedName: "badge",
    seed: {
      props: {
        text: {
          type: "string",
          default: "NEW RELEASE",
          description: "Badge caption (keep it short)",
        },
      },
      nodes: [
        {
          id: "pill",
          type: "rect",
          x: 0,
          y: 0,
          w: 260,
          h: 64,
          tw: "bg-gradient-to-r from-amber-400 to-orange-500 rounded-full shadow-md",
          animation: { preset: "pulse", durationMs: 1800, loop: true },
        },
        {
          id: "caption",
          type: "text",
          x: 0,
          y: 22,
          w: 260,
          h: 20,
          text: "{{props.text}}",
          style: { fontSize: 15, fontWeight: 700, color: "#ffffff", align: "center" },
          tw: "tracking-widest",
        },
      ],
    },
  },

  // Code: contribution heatmap — teaches: a kind "code" component (§7.6)
  // consuming a SERIES prop. 371 cells is exactly what declarative fragments
  // cannot express; the render function computes its own geometry. Frame fits
  // the drawing precisely: 53 columns × (10 + 3) − 3 wide, label + 7 rows tall.
  {
    id: "code-heatmap",
    label: "Code: Contribution heatmap",
    blurb: "A render() function drawing 371 cells from a series prop.",
    swatchTw:
      "bg-gradient-to-r from-emerald-900 via-emerald-600 to-emerald-400 rounded-md",
    frame: { w: 686, h: 110 },
    suggestedName: "contribution-heatmap",
    seed: {
      kind: "code",
      code: HEATMAP_CODE,
      props: {
        label: {
          type: "string",
          default: "1,204 contributions in the last year",
          description: "Caption above the grid",
        },
        calendar: {
          type: "series",
          default: sampleCalendar(),
          description:
            "Daily counts, oldest first — bind github stats.calendar, or numbers/{count} objects",
        },
      },
      nodes: [],
    },
  },

  // Code: blank — the smallest honest code component: a commented render
  // function teaching the whole contract (props in, nodes out, limits, no
  // Date/random) plus one declared prop so the props panel isn't empty.
  {
    id: "code-blank",
    label: "Code: Blank",
    blurb: "A commented minimal render() teaching the code contract.",
    swatchTw:
      "bg-gradient-to-br from-slate-900 to-slate-800 border-2 border-emerald-500 rounded-md",
    frame: { w: 400, h: 160 },
    seed: {
      kind: "code",
      code: CODE_BLANK_CODE,
      props: {
        text: {
          type: "string",
          default: "Hello from code",
          description: "Text the starter renders centered in the frame",
        },
      },
      nodes: [],
    },
  },
];

/**
 * Materialize a template into a full draft definition for the post-create
 * PUT. Deep-cloned so Studio edits never mutate the shared template objects.
 * Returns null for blank — creation proceeds with just the frame.
 */
export function seedDefinition(
  template: ComponentTemplate,
  id: string,
  title: string,
): ComponentDefinition | null {
  if (!template.seed) return null;
  return {
    id,
    title,
    frame: { ...template.frame },
    // Code starters (§7.6): kind + source ride the seed; both stay absent on
    // declarative templates so their drafts serialize exactly as before.
    ...(template.seed.kind === "code"
      ? { kind: "code" as const, code: template.seed.code }
      : {}),
    props: structuredClone(template.seed.props),
    nodes: structuredClone(template.seed.nodes),
  };
}

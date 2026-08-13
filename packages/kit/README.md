# @makeitbeauty/kit

The official component kit. A kit component is a reusable, parameterized
design fragment that users drop onto the canvas as an `instance` node.

## Kit format (v0)

The format is pinned by
[`packages/schema/kit-component.schema.json`](../schema/kit-component.schema.json)
— every component is ajv-validated against it when the renderer boots. A
component is a single JSON file:

```jsonc
{
  "id": "stat-card",              // referenced as "kit/stat-card"
  "title": "Stat card",           // shown in the editor palette
  "category": "stats",            // optional palette-menu group (lowercase slug)
  "frame": { "w": 260, "h": 140 },// the component's own coordinate space
  "props": {                      // declared slots, with types + defaults
    "label": { "type": "string", "description": "…", "default": "Followers" }
  },
  "nodes": [ /* design-schema nodes, positioned relative to the frame */ ]
}
```

- **`category`** (optional) groups the component in the editor's palette menu.
  It is a lowercase slug (`^[a-z][a-z0-9-]{0,23}$`); uncategorized components
  land in a catch-all bucket. The recommended taxonomy — the official kit uses
  exactly these — is `cards` (framed containers/showcases), `stats`
  (single-number metrics and meters), `data` (array-driven connector visuals),
  `banners` (wide text/header strips) and `decor` (dividers and ornaments).

- **`nodes`** is a design fragment: an array using exactly the node types of
  [`packages/schema/design.schema.json`](../schema/design.schema.json)
  (`text`, `rect`, `image` — nested `instance` nodes are rejected at load
  time in v0), positioned **relative to the declared `frame` w/h** — `(0,0)`
  is the component's own top-left corner.
- **`props`** declares the component's slots. Each prop has a `type`
  (`string` or `number` — colors are strings), an optional `description`,
  and a required `default` used when an instance omits the prop (and for the
  palette preview). Defaults must match the declared type.
- **Instances** reference a component as `kit/{id}` and pass props:

  ```json
  {
    "id": "followers", "type": "instance",
    "x": 40, "y": 40, "w": 260, "h": 140,
    "component": "kit/stat-card",
    "props": { "label": "Followers", "value": "{{github.user.followers}}" }
  }
  ```

### Slot resolution and expansion

`{{props.*}}` placeholders inside a component's nodes resolve with **the same
template engine as connector data** — the one that substitutes
`{{path.to.field}}` from data snapshots at render time. Expansion order
(implemented in `apps/renderer/src/kit.ts`, run before the static/animated
split so the rest of the pipeline only ever sees plain nodes):

1. The instance's `props` resolve against the data snapshot (standard
   pipeline template step) — so a prop value like
   `"{{github.user.followers}}"` arrives as live data. Missing paths become
   an em-dash placeholder with a warning — never a render failure.
2. Resolved props merge over the declared defaults. `number` props
   type-check: a number or numeric string passes (data-bound values arrive
   as strings and are coerced); anything else warns and falls back to the
   declared default. Undeclared props warn and are ignored.
3. The component's nodes are deep-copied and every `{{props.*}}` slot (and
   any direct `{{data.path}}` template a fragment may carry) resolves
   against `{…snapshot, props}`.
4. `computed` entries apply (see below), in frame coordinates.
5. The fragment **uniform-scales** into the instance box:
   `s = min(instance.w/frame.w, instance.h/frame.h)`, top-left aligned.
   Positions and sizes multiply by `s`, as do `fontSize` (pinned to the 16px
   default when unset), `letterSpacing`, `radius` and `strokeWidth`. Then
   everything translates by the instance's `(x, y)`.
6. Expanded node ids are prefixed `{instanceId}__` so two instances of the
   same component never collide.

An **unknown component id** renders the dashed placeholder with a warning —
never a render failure. An instance's own `animation` applies to its expanded
nodes **as one composed layer** (`<g id="node-{instanceId}">`); animations on
individual fragment nodes are ignored (with a warning) inside an animated
instance, and compose per-node as usual otherwise.

Slots may appear anywhere the design schema accepts a string: text content
and colors. Numeric geometry cannot hold a template (the schema types those
fields as numbers), so v0 adds one restricted, declarative mechanism:

### `tw` in components — static per definition

Fragment nodes may carry a `tw` utility string (compiled by
[`packages/twc`](../twc), architecture.md §5.6) — that is what powers the
gradient/glass/shadow chrome of `gradient-banner`, `glow-stat` and
`terminal-card`. One deliberate v1 constraint:

- **`tw` strings are static per definition — templates are not supported
  inside `tw`.** The pipeline's template step
  (`apps/renderer/src/template.ts`) resolves `{{…}}` only in text content and
  instance props; a `{{props.*}}` placeholder inside a plain node's `tw`
  reaches the compiler literally and is dropped as an unknown class (with a
  warning). Do not parameterize gradients or tw colors via props — bake them
  in. (Kit expansion happens to deep-resolve fragment strings, so a template
  in a *fragment's* `tw` would mechanically resolve today, but that is an
  implementation detail, not a contract: the editor lints/previews `tw`
  statically, and plain design nodes never get it. Components must not rely
  on it.)
- When a color **must** be prop-driven, route it through the structured
  `style` fields (`style.color`, `style.fill`, `style.stroke`), which *are*
  template-resolved and override `tw` in the §5.6 merge order — see
  `terminal-card`'s prompt/cursor accent, or `stat-card`'s `accent`.
- `tw` on an **instance node itself** is not supported yet (the pipeline
  warns and ignores it); `tw` inside a component's fragment nodes is fine.

### Computed geometry (`computed`)

A component may declare linear mappings from a numeric prop to a node's
geometry — enough for progress bars and meters, deliberately **not** an
expression language:

```json
"computed": [
  { "node": "fill", "field": "w", "prop": "percent", "scale": 4.4, "clamp": [0, 440] }
]
```

Meaning: at expansion time, set node `fill`'s `w` to
`clamp(props.percent × scale)`. The node still carries a schema-valid default
value so the fragment renders as-is without expansion.

## Declarative by design

v0 components are pure data: no code, no logic, no fetches. This is
deliberate — components are the part of the system that third parties will
eventually author, and declarative fragments are trivially safe to review,
render, and sandbox. Per
[architecture.md §10](../../docs/architecture.md#10-roadmap), community
*declarative* components arrive in Phase 3 (with a registry: verified
namespaces, immutable versions, no silent auto-updates), and *code*
components only in Phase 4, as QuickJS-in-WASM pure render functions with no
host APIs. Until that sandbox exists, "component" means "data".

Because fragments are just design-schema nodes, everything a component emits
inherits the Camo-safe rules automatically: no external URLs (`data:` URIs
only), no scripts, animation via presets only. Components also never see
connector credentials — they receive filtered data snapshots, nothing else
(see [docs/SECURITY.md](../../docs/SECURITY.md)).

## Animation presets

Any node (or a whole instance) may carry an `animation`:

```json
"animation": { "preset": "growX", "durationMs": 900, "delayMs": 200, "loop": false }
```

| Preset | Effect | Typical use |
|---|---|---|
| `fadeIn` | opacity 0 → 1 | entrances for text and cards |
| `pulse` | opacity 1 → 0.55 → 1 | drawing attention to a metric (use `loop: true`) |
| `float` | translateY 0 → −6px → 0 | gentle hover for badges/orbs (use `loop: true`) |
| `growX` | scaleX 0 → 1, origin left center | **progress fills, bars and rules growing out** |
| `growY` | scaleY 0 → 1, origin center bottom | columns/charts growing up |
| `slideUp` | translateY 8px + opacity 0 → rest | staggered text entrances (vary `delayMs`) |
| `slideLeft` | translateX 8px + opacity 0 → rest | list items sliding into place |
| `blink` | opacity 1 → 0 → 1 with a hard step-end cut | terminal cursors (use `loop: true`) |

**Loop guidance.** `loop` defaults to `false` for EVERY preset — an animation
plays once and holds its final frame. That is the right call for entrance
presets (`fadeIn`, `growX`, `growY`, `slideUp`, `slideLeft`). For the cyclic
presets — `blink`, `pulse` and `float` — a single play looks like a glitch, so
set `loop: true` explicitly (see `accent-divider`'s cursor). Timing defaults:
`durationMs` 800, `delayMs` 0. Stagger entrances by giving sibling nodes
increasing `delayMs` (see `profile-header` and `stat-trio`).

The scale presets (`growX`, `growY`) get an ABSOLUTE `transform-origin`
computed from the animated node's frame at compose time (left-center /
bottom-center in viewBox units), so growth always starts at the element's own
edge. (`transform-box: fill-box` was abandoned: every animated layer is a
full-canvas satori pass containing a transparent root rect, which inflated the
fill-box to the whole canvas — bars visibly grew in from the canvas edge.)
`slideUp`/`slideLeft` are pure translates and need no origin. All output is guarded by `prefers-reduced-motion`: users who opt out
of motion get the final, static frame.

## Components (v0)

| Id | File | Category | Frame | Purpose |
|---|---|---|---|---|
| `kit/stat-card` | [components/stat-card.json](components/stat-card.json) | `stats` | 260×140 | One headline metric with label + caption |
| `kit/text-banner` | [components/text-banner.json](components/text-banner.json) | `banners` | 720×120 | Title + subtitle banner with accent tick |
| `kit/progress-bar` | [components/progress-bar.json](components/progress-bar.json) | `stats` | 480×72 | Labeled percentage bar (computed fill width, fill grows out via `growX`) |
| `kit/profile-header` | [components/profile-header.json](components/profile-header.json) | `banners` | 720×120 | Name + @login + followers, staggered `slideUp` entrance |
| `kit/metric-badge` | [components/metric-badge.json](components/metric-badge.json) | `stats` | 200×56 | Compact `label: value` pill with accent left border, `fadeIn` |
| `kit/stat-trio` | [components/stat-trio.json](components/stat-trio.json) | `stats` | 720×110 | Three stat cells, each `slideUp` with 0/120/240ms stagger |
| `kit/quote-banner` | [components/quote-banner.json](components/quote-banner.json) | `banners` | 720×90 | Quote with accent quotation mark and a `growX` underline bar |
| `kit/accent-divider` | [components/accent-divider.json](components/accent-divider.json) | `decor` | 720×24 | Thin accent rule (`growX`) ending in a looping `blink` cursor square |
| `kit/gradient-banner` | [components/gradient-banner.json](components/gradient-banner.json) | `banners` | 720×140 | tw showcase: full-bleed indigo→purple→slate gradient banner, kicker/title/subtitle slots, cyan→fuchsia `growX` rule |
| `kit/glow-stat` | [components/glow-stat.json](components/glow-stat.json) | `stats` | 280×140 | tw showcase: glassy card (rgba bg + border + arbitrary glow shadow) with a big number and gradient underline |
| `kit/terminal-card` | [components/terminal-card.json](components/terminal-card.json) | `cards` | 560×180 | tw showcase: terminal window with traffic-light dots, two prompt lines and a looping `blink` block cursor |
| `kit/contribution-heatmap` | [components/contribution-heatmap.json](components/contribution-heatmap.json) | `data` | 720×140 | Native: GitHub-style contribution calendar, cells generated from `stats.calendar` |
| `kit/activity-sparkline` | [components/activity-sparkline.json](components/activity-sparkline.json) | `data` | 360×100 | Native: last 84 days of commits as 12 weekly bars with a staggered `growY` entrance |
| `kit/language-bar` | [components/language-bar.json](components/language-bar.json) | `data` | 720×110 | Native: top languages as a stacked horizontal bar with legend |
| `kit/streak-flame` | [components/streak-flame.json](components/streak-flame.json) | `data` | 360×140 | Native: current contribution streak with pulsing flame accent + longest-streak record |

All components use the GitHub-dark palette (`#0d1117` / `#161b22` / `#21262d`
/ `#30363d` / `#58a6ff` / `#e6edf3` / `#7d8590`) with consistent radii
(12 card / 4 bar) and 16–20px padding, so they compose cleanly on a
`#0d1117` canvas. The three tw showcase components layer the Tailwind-subset
chrome (gradients, glass, glow shadows) on top of that same palette — their
`tw` strings are fixed by design (see “`tw` in components” above), and the
only mono-ish styling is `tracking`: the renderer currently loads **Inter
only** (`apps/renderer/fonts/`), so no component may reference a monospace
`fontFamily` until one ships.

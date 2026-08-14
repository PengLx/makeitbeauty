# Declarative Components

A declarative component is **pure data**: a JSON document (format pinned by [`packages/schema/kit-component.schema.json`](https://github.com/PengLx/makeitbeauty/blob/main/packages/schema/kit-component.schema.json)) whose `nodes` *are* the component. No code executes — the fragment expands through the same trusted pipeline as every design, which is why strangers' components are safe to install.

A complete, valid definition:

```json
{
  "id": "you/status-badge",
  "title": "Status badge",
  "description": "A pill badge with a pulsing accent dot and one text slot.",
  "category": "decor",
  "frame": { "w": 240, "h": 56 },
  "props": {
    "text": {
      "type": "string",
      "description": "Badge caption",
      "default": "available for hire"
    },
    "accent": {
      "type": "string",
      "description": "Dot and border color",
      "default": "#3fb950"
    }
  },
  "nodes": [
    {
      "id": "pill", "type": "rect", "x": 0, "y": 0, "w": 240, "h": 56,
      "style": { "fill": "#161b22", "radius": 28, "stroke": "{{props.accent}}", "strokeWidth": 1 }
    },
    {
      "id": "dot", "type": "rect", "x": 20, "y": 22, "w": 12, "h": 12,
      "style": { "fill": "{{props.accent}}", "radius": 6 },
      "animation": { "preset": "pulse", "durationMs": 1800, "loop": true }
    },
    {
      "id": "caption", "type": "text", "x": 44, "y": 18, "w": 176, "h": 20,
      "text": "{{props.text}}",
      "style": { "fontSize": 14, "color": "#e6edf3" }
    }
  ]
}
```

(In the editor you never type the `id` — you choose only the `{name}` half in the **New component** dialog, and the id becomes `{your-github-login}/{name}` automatically. The schema pattern for community ids is `^[a-z0-9-]+/[a-z0-9-]+(@[0-9]+)?$`.)

## Top-level fields

| Field | Required | Constraints (from the schema) |
|---|---|---|
| `id` | yes | Community: `{owner}/{name}`, lowercase `[a-z0-9-]`, ≤ 128 chars. The `kit/` namespace is reserved. |
| `title` | yes | 1–100 chars — shown in the palette. |
| `description` | no | ≤ 1000 chars — searched by the palette/browse. Must not contain non-`props.*` `{{…}}` text (see [Publishing and Versions](./Publishing-and-Versions.md)). |
| `category` | no | Lowercase slug, `^[a-z][a-z0-9-]{0,23}$`. See taxonomy below. |
| `frame` | yes | `{w, h}`, each `> 0` and `≤ 4096`. Your component's own coordinate space. |
| `props` | yes | Up to 32 declared slots; names match `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`. |
| `nodes` | yes (declarative) | 1–64 design-schema nodes (`text`/`rect`/`image`), frame-relative. Nested `instance` nodes are rejected. |
| `computed` | no | Up to 32 linear prop→geometry mappings (below). |

### Category taxonomy

The palette groups components by `category`; anything else (or no category) lands in the catch-all **other** bucket. The recommended taxonomy — the official kit uses exactly these:

| Slug | Meaning |
|---|---|
| `cards` | framed containers/showcases |
| `stats` | single-number metrics and meters |
| `data` | array-driven connector visuals |
| `banners` | wide text/header strips |
| `decor` | dividers and ornaments |

## Props

Each prop declares a `type`, an optional `description`, and a **required `default` that must match the declared type**:

| Type | Default must be | Notes |
|---|---|---|
| `string` | a string (≤ 2000 chars) | Colors are strings. |
| `number` | a number | At render time a numeric *string* also passes (data-bound values arrive as strings and are coerced); anything else warns and falls back to the default. |
| `series` | a JSON array (≤ 1024 items) | Raw arrays for **code components** — declarative fragments cannot interpolate them: `{{props.x}}` of an array resolves to the em-dash placeholder. See [Code Components](./Code-Components.md). |

Defaults do real work: they fill in when an instance omits the prop, they drive the palette's hover preview, and (for code components) they are the input publish validation executes against. Make them representative.

Undeclared props passed by an instance warn and are ignored; a wrong-typed value warns and falls back to the declared default — never a render failure.

## Nodes

Nodes are exactly the design-schema node types minus `instance` (no nesting in v0), positioned **relative to the frame** — `(0,0)` is the component's own top-left corner.

Common fields (all node types): `id` (`^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`, unique within the component), `type`, `x`, `y`, `w ≥ 0`, `h ≥ 0`, optional `opacity` (0–1), `rotation` (−360–360), `animation`, `tw`.

| Type | Own fields |
|---|---|
| `text` | `text` (required; template string, ≤ 2000 chars); `style`: `fontFamily`, `fontSize` (1–512), `fontWeight` (100–900 in steps of 100), `color`, `align` (`left`/`center`/`right`), `lineHeight` (0.5–4), `letterSpacing` |
| `rect` | `style`: `fill`, `radius` (≥ 0), `stroke`, `strokeWidth` (≥ 0) |
| `image` | `src` (required; **`data:` URI only** — `^data:image/(png|jpeg|webp|svg\+xml);base64,`), `fit` (`contain`/`cover`/`fill`, default `cover`), `radius` |

Every color field is a CSS color value with one hard rule: **`url()` and external references are forbidden** (schema pattern `^(?!.*url\().*$`).

## `{{props.*}}` templating — where slots work

`{{props.name}}` placeholders resolve with the same template engine that substitutes connector data in designs. Slots may appear **anywhere the design schema accepts a string**:

- **text content** (`text` on a text node) — including mixed text: `"⭐ {{props.stars}} stars"`,
- **style colors** (`style.color`, `style.fill`, `style.stroke`).

Slots can **NOT** appear in numeric geometry — `x`, `y`, `w`, `h`, `fontSize`, etc. are typed as numbers by the schema, so a template simply can't be written there. For prop-driven geometry you get exactly one declarative mechanism: `computed`.

A template referencing an *undeclared* prop is a publish-time warning and renders as an em-dash. A template referencing anything other than `props.*` (e.g. `{{github.user.followers}}`) is a **publish-time rejection** — data must be bound by the design author through props ([the props-only rule](./Publishing-and-Versions.md)).

## Computed geometry (`computed`)

A linear map from a numeric prop onto one node's geometry — enough for progress bars and meters, deliberately **not** an expression language:

```
node[field] = clamp(props[prop] × scale, clamp[0], clamp[1])
```

in frame coordinates (instance scaling applies afterwards). The classic progress-bar example, complete:

```json
{
  "id": "you/meter",
  "title": "Meter",
  "category": "stats",
  "frame": { "w": 480, "h": 72 },
  "props": {
    "label": { "type": "string", "description": "What the bar measures", "default": "Profile completeness" },
    "percent": { "type": "number", "description": "0-100", "default": 62 }
  },
  "nodes": [
    {
      "id": "label", "type": "text", "x": 0, "y": 0, "w": 480, "h": 18,
      "text": "{{props.label}}", "style": { "fontSize": 13, "color": "#7d8590" }
    },
    {
      "id": "track", "type": "rect", "x": 0, "y": 28, "w": 440, "h": 10,
      "style": { "fill": "#21262d", "radius": 4 }
    },
    {
      "id": "fill", "type": "rect", "x": 0, "y": 28, "w": 273, "h": 10,
      "style": { "fill": "#58a6ff", "radius": 4 },
      "animation": { "preset": "growX", "durationMs": 900 }
    }
  ],
  "computed": [
    { "node": "fill", "prop": "percent", "field": "w", "scale": 4.4, "clamp": [0, 440] }
  ]
}
```

At expansion, `fill.w` becomes `clamp(percent × 4.4, 0, 440)` — 62 % → 272.8 of the 440-wide track. Rules checked at publish: `node` must name a node in `nodes`, `prop` must be a declared prop of type `number`, `field` is one of `x`/`y`/`w`/`h`, and `clamp` is an ordered `[min, max]` pair. The node still carries a schema-valid default value (here `"w": 273`) so the fragment renders as-is without expansion.

## Animations

Any node — or a whole instance, on the consumer side — may carry an `animation`, e.g. on a rule that sweeps in:

```json
{
  "id": "rule", "type": "rect", "x": 0, "y": 60, "w": 240, "h": 3,
  "style": { "fill": "#58a6ff", "radius": 2 },
  "animation": { "preset": "growX", "durationMs": 900, "delayMs": 200, "loop": false }
}
```

The eight presets (the complete list, from `apps/renderer/src/animate.ts`):

| Preset | Effect | Typical use |
|---|---|---|
| `fadeIn` | opacity 0 → 1 | entrances for text and cards |
| `pulse` | opacity 1 → 0.55 → 1 | drawing attention to a metric (use `loop: true`) |
| `float` | translateY 0 → −6px → 0 | gentle hover for badges/orbs (use `loop: true`) |
| `growX` | scaleX 0 → 1, origin left center | progress fills, bars and rules growing out |
| `growY` | scaleY 0 → 1, origin center bottom | columns/charts growing up |
| `slideUp` | translateY 8px + opacity 0 → rest | staggered text entrances (vary `delayMs`) |
| `slideLeft` | translateX 8px + opacity 0 → rest | list items sliding into place |
| `blink` | opacity 1 → 0 → 1 with a hard step-end cut | terminal cursors (use `loop: true`) |

**Loop guidance.** `loop` defaults to `false` for every preset — the animation plays once and holds its final frame. That is right for the entrance presets (`fadeIn`, `growX`, `growY`, `slideUp`, `slideLeft`). For the cyclic presets — `blink`, `pulse`, `float` — a single play looks like a glitch, so set `loop: true` explicitly. Timing: `durationMs` 1–60000 (default 800), `delayMs` 0–60000 (default 0). Stagger entrances by giving sibling nodes increasing `delayMs`.

All animation output is guarded by `prefers-reduced-motion`: users who opt out of motion get the final, static frame. And note the consumer-side rule: when a design animates the **instance itself**, the whole component composes as one animated layer and animations on your individual nodes are ignored (with a warning).

## `tw` utility styling

Nodes may carry a `tw` string (≤ 500 chars) compiled by the platform's own deterministic Tailwind-subset compiler (`@makeitbeauty/twc`) — this is what powers gradient/glass/glow chrome. Supported families:

> `bg-` (color, gradients via `bg-gradient-to-*` + `from-/via-/to-`), `text-`, `font-` (weight), `tracking-`, `leading-`, `rounded*`, `border*` (width + color), `shadow*` (presets + strict arbitrary grammar), `opacity-*`, `p-/px-/py-`.

Colors are the standard Tailwind palette plus `[#hex]` arbitrary values. Policy is a **whitelist**: unknown or unsupported classes warn and are dropped — never failures, never passthrough. Conflicting classes: last wins per property. Values containing `url(`, `var(`, `;` or newlines are dropped with a warning. Merge order: `tw` compiles first, explicit structured `style` fields override it.

Two constraints that matter to component authors:

- **`tw` strings are static per definition — templates are not supported inside `tw`.** A `{{props.*}}` placeholder inside `tw` is not a contract-supported way to parameterize styling (the editor lints and previews `tw` statically, and on plain design nodes such a template reaches the compiler literally and is dropped as an unknown class). Do not parameterize gradients or tw colors via props — bake them in.
- **The escape hatch for prop-driven colors** is the structured `style` fields (`style.color`, `style.fill`, `style.stroke`), which *are* template-resolved and override `tw` in the merge order. Paint the static chrome with `tw`, and route the one accent that must follow a prop through `style` — see the `accent` slot idiom in the official `stat-card` and `terminal-card`.

Also: `tw` on an **instance node itself** is not supported yet (the pipeline warns and ignores it); `tw` inside your component's own nodes is fine.

## Fonts

Only the **built-in families** may appear in a community component's `style.fontFamily` — currently **Inter** (the default), **JetBrains Mono**, and **Lora**, each at weights 400 and 700. Matching is case-insensitive, but the value must be a **literal** name: a template in `fontFamily` would dodge the check, so it fails it.

User-uploaded fonts are private to their owner's designs (they travel per render request and never publish), so publish validation rejects any other family. At render time an unknown family falls back to Inter with a warning — a degraded card, never a broken one.

## Scaling semantics — what happens to your layout

An instance places your component into a box `{x, y, w, h}` on the canvas. Expansion **uniform-scales** your frame into that box:

```
s = min(instance.w / frame.w, instance.h / frame.h)
```

top-left aligned. Everything multiplies by `s`: positions, sizes, `fontSize` (pinned to the 16 px default when unset, so unstyled text scales too), `letterSpacing`, `radius`, and `strokeWidth`; then everything translates by the instance's `(x, y)`. Expanded node ids get prefixed `{instanceId}__` so two instances of the same component never collide.

What this means for your layout:

- **Aspect ratio is preserved** — your component never stretches. If the instance box has a different aspect ratio than your frame, the slack space (right or bottom, since alignment is top-left) simply stays empty. Design your frame at the aspect ratio you expect consumers to keep.
- Think in your frame's units and forget the instance — `260 × 140` design coordinates stay `260 × 140` to you.
- Because `fontSize` scales with `s`, text keeps its proportion to the layout at any instance size.

Missing data at render time never breaks anything: a missing template path becomes an em-dash with a warning, an unknown component renders a dashed placeholder, a wrong-typed prop falls back to its default.

---

Next: [Code-Components](./Code-Components.md)

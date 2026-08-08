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
  "frame": { "w": 260, "h": 140 },// the component's own coordinate space
  "props": {                      // declared slots, with types + defaults
    "label": { "type": "string", "description": "…", "default": "Followers" }
  },
  "nodes": [ /* design-schema nodes, positioned relative to the frame */ ]
}
```

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

## Components (v0 seed)

| Id | File | Frame | Purpose |
|---|---|---|---|
| `kit/stat-card` | [components/stat-card.json](components/stat-card.json) | 260×140 | One headline metric with label + caption |
| `kit/text-banner` | [components/text-banner.json](components/text-banner.json) | 720×120 | Title + subtitle banner with accent tick |
| `kit/progress-bar` | [components/progress-bar.json](components/progress-bar.json) | 480×72 | Labeled percentage bar (computed fill width) |

All three use the GitHub-dark palette (`#0d1117` / `#161b22` / `#21262d` /
`#58a6ff` / `#e6edf3` / `#7d8590`) with consistent radii (12 card / 4 bar)
and 20px padding, so they compose cleanly on a `#0d1117` canvas.

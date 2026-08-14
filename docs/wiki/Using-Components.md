# Using Components

This page is the consumer side: putting components — official kit, your own, or the community's — into a design.

## Inserting from the palette

The editor palette has three sources behind one search box:

- **Kit** — the official components, grouped by category in a fixed display order: **Stats, Data, Banners, Cards, Decor**, with uncategorized items under **Other**. Group open/closed state is remembered; an active search force-expands every group with matches.
- **My components** — your **published** components only (`latestVersion > 0`); drafts live in the Components section and join the palette on first publish.
- **Community** — published components from everyone, with a category chip facet and a sort selector: **newest** (default), **uses**, or **favorites**.

The single search box matches case-insensitively over **id, title, and description** — the same fields the server's community search scans, so the one query means the same thing everywhere.

**Favorites**: signed in, every community card carries a heart (`♥ N`) you can toggle; the Favorites view lists what you've hearted (newest favorite first) and applies the same search/category rules client-side. Cards also show the honest usage counter — *used in N projects* (distinct projects currently referencing the component; see [Publishing and Versions](./Publishing-and-Versions.md)).

**Hover previews** render the component **through the real renderer**: a one-instance design — a canvas exactly the component's frame, dark chrome background, one full-frame instance carrying the component's declared default props — POSTed to `/v1/preview` like any other design. So what you see hovering is byte-for-byte what you'd deploy with the defaults; native kit components even preview with *your* live connector data when you're signed in. A failed preview shows an error entry, never a broken palette.

**Insertion** drops an `instance` node on the canvas. Community/my-component insertion pins the ref as `{owner}/{name}@{latestVersion}` and fetches that version's definition for the frame size and prop defaults (cached — a second insert is instant). Kit components insert unversioned as `kit/{id}`.

## Editing props

Select an instance and the Inspector lists one field per declared prop, typed by the component's metadata (name, description tooltip, and current value).

**Custom vs Data.** Every `string` and `number` prop is bindable through a segmented **Custom | Data** toggle:

- **Custom** — a freehand input (text or number).
- **Data** — a two-step connector-field picker: pick a connector chip, then a field. The picker is **type-filtered**: it lists only fields whose type matches the prop, so e.g. a progress bar's `percent` offers exactly the number-typed connector fields. Picking a field writes the prop as a sole `{{connector.path}}` template.

Mode is *derived from the value*, never stored: a value that is exactly one `{{path}}` template shows as Data; anything else — including mixed text around a template — is Custom. (You can absolutely type `"⭐ {{github.user.followers}}"` into a Custom string field.) Bound number props travel as strings and are coerced at render time.

**Series props are Data-only.** A raw JSON array has no freehand input, so instead of the toggle you see the current state — a bound-field chip, or *"declared default · N items"* — plus a picker filtered to **series-typed** fields only. Unbinding restores the component's declared default array. If no connected connector serves series data, the panel says so: *"Sign in with a connector that serves series data to bind this."*

A typical bound instance, in design JSON:

```json
{
  "id": "hm", "type": "instance",
  "x": 24, "y": 24, "w": 686, "h": 110,
  "component": "you/contribution-heatmap@1",
  "props": {
    "label": "{{github.user.login}}'s year",
    "calendar": "{{github.stats.calendar}}"
  }
}
```

Note: `tw` on an instance node itself is ignored in v0 (the Inspector tells you so) — styling lives inside the component.

## The consent record

Bindings are **derived, never hand-authored**: on every project save the server recomputes the design's `{{connector.field}}` references into the project's binding record. That record is two things at once:

1. the **render-time data filter** — a component receives only the fields the design's bindings declare, never credentials, never the whole snapshot;
2. the **consent record** — "this image will PUBLICLY display: …" is computed from what the design actually displays.

This is why community components can only read `props.*`: the data a stranger's component sees is exactly the data *you* chose to bind to its props, and nothing more.

## Version pinning as a user

- Your design references a community component at a **pinned immutable version** (`@N`). It renders identically forever — published versions are never edited.
- **Updates are opt-in.** When the author publishes `@N+1`, nothing happens to your design. To move up, insert the newer version from the palette (it always pins the latest) and swap it in — or edit the ref in code mode. There are no silent auto-updates, by platform rule.
- If the author **unlists** the component, browse hides it but your pinned instance keeps rendering.
- Missing data or a broken component never breaks your card: unknown refs render a dashed placeholder, missing paths render an em-dash, and code-component failures degrade to a placeholder with a warning — always with the rest of the design intact.

---

Next: [Quickstart-zh](./Quickstart-zh.md)

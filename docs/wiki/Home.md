# MakeItBeauty Component Authoring

Welcome. This wiki is for community developers who want to build **components** for [makeitbeauty.org](https://makeitbeauty.org) — from a simple badge to a code-powered contribution heatmap.

## What a component is

A MakeItBeauty component is a **reusable, parameterized design fragment** that other users drop onto their canvas as an `instance` node. It declares:

- a **frame** — its own coordinate space (`{w, h}`),
- **props** — typed slots (`string`, `number`, `series`) with required defaults,
- and either **nodes** (a declarative JSON fragment of `text`/`rect`/`image` nodes) **or** a **`render()` function** (a sandboxed pure function that returns those same nodes).

Whatever a component emits is rendered by the same trusted pipeline as everything else and ends up in a Camo-safe SVG: no scripts, no external requests, animation via CSS presets only.

## The two kinds at a glance

| | Declarative (`kind` absent) | Code (`kind: "code"`) |
|---|---|---|
| What it is | A JSON design fragment with `{{props.*}}` slots | A pure JavaScript `render({props, frame}) => nodes` function |
| Best for | Badges, cards, banners, meters — layouts you can draw by hand | Array-driven visuals: heatmaps, sparklines, grids — anything with per-item geometry |
| Data access | `{{props.*}}` templates in text content and style colors | The `props` object only — including raw `series` arrays |
| Prop-driven geometry | `computed` linear mappings only (`prop × scale`, clamped) | Any math you can write in code |
| `series` (array) props | Can be declared, but templates can't interpolate them (they render as an em-dash) | Fully consumable — the reason `series` exists |
| Node budget | ≤ 64 declared nodes | ≤ 512 output nodes per render |
| Execution | None — pure data through the trusted pipeline | Capability-less QuickJS-in-WASM sandbox (~50 ms CPU, 32 MB) |
| Publish validation | Schema + semantic checks | The same, plus compile + **two executions byte-compared** for determinism |

Start with [Declarative Components](./Declarative-Components.md) unless you need per-item geometry from an array — then read [Code Components](./Code-Components.md).

## Lifecycle: draft → published version → community

1. **Draft** — created from the editor's **Components** section via the **New component** dialog (`POST /v1/components` with `{name, title, frame}`), then edited in the Component Studio. Drafts are **mutable and private** to you.
2. **Publish** — freezes the draft as `{owner}/{name}@{n}` with an auto-incrementing version number. **Published versions are immutable** — they are never edited, only superseded by the next publish.
3. **Community** — published components appear in the public browse (search, categories, favorites, "used in N projects"). Designs that use your component **pin the exact version** (`@N`); updating to a newer version is opt-in per design — there are **no silent auto-updates** (a malicious update is the top realistic registry attack, so the platform rules it out by construction).
4. **Unlist** — you can hide a component from browse at any time; designs already pinning a version keep rendering. Immutability beats deletion.

Details: [Publishing and Versions](./Publishing-and-Versions.md).

## Your namespace

Your namespace is **your GitHub login, lowercased**: components are identified as `{owner}/{name}` (e.g. `octocat/streak-card`), and published versions as `{owner}/{name}@{n}`. The `kit/` namespace is reserved for the official in-repo kit.

## The golden safety rules

You will meet these on every page, because every publish check enforces them:

1. **Props-only data access.** A community component never touches connector data directly. Every `{{template}}` in a declarative definition must reference `props.*`; code components receive **props only**. Data reaches your component exclusively through props the *design author* binds — that keeps the platform's consent record ("this image will publicly display: …") true even when designs use strangers' components.
2. **Built-in fonts only.** Components may reference only the built-in families — currently **Inter**, **JetBrains Mono**, and **Lora**. User-uploaded fonts are private to their owner's designs and never publish; naming any other family is a publish-time rejection.
3. **No external URLs, ever.** Images must be `data:` URIs; colors can't contain `url(`; and the output sanitizer rejects any final SVG containing an external reference (it rejects rather than repairs — only `data:` URIs and `#fragment` references pass). This is a security boundary (an external URL plus connector data is an exfiltration beacon), not a style guideline.
4. **Code is deterministic by construction.** No `Date`, no `Math.random`, no async, no network — and publish executes your `render()` twice and byte-compares the output.

## Pages

- [Declarative Components](./Declarative-Components.md) — the full JSON format: props, templating, computed geometry, animations, `tw` styling, fonts, scaling.
- [Code Components](./Code-Components.md) — the `render()` contract, the sandbox rules, series props, a full annotated heatmap walkthrough.
- [Publishing and Versions](./Publishing-and-Versions.md) — the publish flow, what validation runs, immutability, unlisting, and every common rejection message with its fix.
- [Using Components](./Using-Components.md) — the consumer side: the palette, prop editing and data binding, consent, version pinning.
- [中文快速上手](./Quickstart-zh.md) — Chinese quick-start.

## Deeper reading (repository docs)

- [docs/architecture.md](https://github.com/PengLx/makeitbeauty/blob/main/docs/architecture.md) — the platform contract; components are §5.6–§5.7 and §7.5–§7.6.
- [docs/SECURITY.md](https://github.com/PengLx/makeitbeauty/blob/main/docs/SECURITY.md) — the security commitments the component rules serve.
- [packages/kit/README.md](https://github.com/PengLx/makeitbeauty/blob/main/packages/kit/README.md) — the official kit's authoring notes (the same format you publish).
- [packages/sandbox/README.md](https://github.com/PengLx/makeitbeauty/blob/main/packages/sandbox/README.md) — the code-component sandbox, in full.

---

Next: [Declarative-Components](./Declarative-Components.md)

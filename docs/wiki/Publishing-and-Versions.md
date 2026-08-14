# Publishing and Versions

## The publish flow

1. **Create a draft** — the editor's **New component** dialog (in the **Components** section) calls `POST /v1/components` with `{name, title, frame}`; the id becomes `{your-login}/{name}`, and the draft opens in the Component Studio. Drafts are **mutable and private**.
2. **Edit** — every save is a `PUT /v1/components/{owner}/{name}` of the full definition (published versions are never mutated). Code components carry `kind: "code"` + the `code` source (≤ 64 KiB) in the same document.
3. **Publish** — `POST /v1/components/{owner}/{name}/publish` runs the full validation suite (below) and, on success, freezes the draft as the next immutable version `{owner}/{name}@{n}` (auto-increment, starting at 1). The Studio's publish dialog also lets you set the `category` before you confirm.

Heads-up for code authors: **published source is public.** `code` travels in definition payloads exactly like `nodes` do — anyone can fetch `GET /v1/components/{owner}/{name}/versions/{n}` and read it.

## What validation runs

Publish-time validation is renderer-owned (`POST /internal/validate-component`) — the exact same code path that guards the official kit loader, and it runs **again on every render request** (defense in depth: the renderer never trusts that the API already checked).

For every component:

- **Schema conformance** — ajv against `kit-component.schema.json` (with the community id shape).
- **Id rules** — `{owner}/{name}` shape; the `kit/` namespace is reserved.
- **Variant shape** — `kind: "code"` requires `code` and forbids `computed`/`native`/`dataFields`/`dataConnector`; `code` without `kind: "code"` is rejected.
- **No nested instances** — fragment/preview nodes may be `text`/`rect`/`image` only.
- **Semantic checks** — unique node ids; `computed` integrity (known node, declared `number` prop, ordered clamp).
- **Built-in fonts only** — every literal `style.fontFamily` in declared nodes.
- **Props-only templates** — every string in the definition (except the `code` source) is walked; any `{{…}}` not referencing `props.*` is a rejection, and a reference to an *undeclared* prop is a warning.

Additionally, for `kind: "code"`:

- **Compile** — syntax check (source ≤ 64 KiB UTF-8).
- **Execute twice** against the declared prop defaults under full sandbox limits (50 ms CPU, 32 MiB, ≤ 512 nodes, ≤ 512 KiB output) and **byte-compare** the two serialized outputs — any difference is a rejection. (Nondeterminism is already impossible by construction — no `Date`, no `Math.random`, no async, fresh context per run — the double-run is defense in depth that turns any future sandbox regression into a loud publish failure instead of a silently unstable image.)
- **Output gate on the sample** — fragment node schema, no instance nodes, unique ids, built-in fonts.
- Your sample run's `console.*` output comes back as warnings — free debugging at publish time.

## Immutability and pinning

- A published version is **frozen forever**. Iterating means editing the draft and publishing the next version.
- Designs reference community components **pinned to an exact version**: `{owner}/{name}@{n}` (render requests reject unpinned community refs). Inserting from the palette pins the latest published version at insert time.
- **Updates are opt-in per design.** A design keeps rendering the version it pinned until its author chooses a newer one. This is a platform security rule, not a convenience default: *no silent auto-updates of installed components* — a malicious update to a widely-used component is the top realistic registry attack, and pinning removes it by construction.

## Unlisting

`DELETE /v1/components/{owner}/{name}` (owner only) **unlists** — it does not delete:

- the component disappears from community browse (and, to non-owners, its metadata reads as not-found),
- but **pinned usages keep rendering** — immutability beats deletion; someone's profile card never breaks because an author changed their mind.
- Abuse of the registry is a moderation action, not a 404.

## Favorites and "used in N projects"

Community browse rows carry two counters:

- **`favoriteCount`** — hearts from signed-in users (`PUT`/`DELETE /v1/components/{owner}/{name}/favorite`, idempotent; only components with at least one published version can be favorited).
- **`usageCount`** — the number of **distinct projects currently referencing** the component at *any* pinned version. It is recomputed server-side from each design on every project write (official `kit/*` refs excluded), so it is honest and unfakeable: one project using your component in five places counts once, and deleting the instance (or the project) decrements it.

Browse sorts by `newest` (default), `uses`, or `favorites`; ties break by publish date, then id.

## Common rejection messages, verbatim

Every message below is thrown by the renderer (`apps/renderer/src/kit.ts`), prefixed with a context naming your component or the instance. Quoted with placeholders in `{…}`.

### Props-only violation

> `template "{{{ref}}}" is not allowed — community component templates may only reference props.* (bind data to a prop in the design instead)`

**Fix:** never reference connector data (`{{github.…}}`) or anything else inside a component. Declare a prop, use `{{props.yourProp}}`, and let the design author bind the data. Remember the walk covers *all* prose — a literal `{{…}}` in your `description` trips it too.

### Non-built-in font (declarative nodes)

> `nodes[{i}].style.fontFamily {family} is not a built-in font family — community components may only use the built-ins ("Inter", "JetBrains Mono", "Lora"); user-uploaded fonts stay private to their owner's designs`

…and the same rule applied to code output:

> `render() output [{i}].style.fontFamily {family} is not a built-in font family — code component output may only use the built-ins ("Inter", "JetBrains Mono", "Lora"); user-uploaded fonts stay private to their owner's designs`

**Fix:** use a literal `"Inter"`, `"JetBrains Mono"`, or `"Lora"`. The **templated-family dodge fails too**: `"fontFamily": "{{props.font}}"` is checked before any resolution, is not a built-in name, and is rejected with the same message.

### Nested instance

> `nested instance nodes are not supported in kit v0`

…and from code output:

> `render() returned an instance node at [{i}] — code output may only contain text/rect/image nodes (nested instances are never allowed)`

**Fix:** components can't contain other components. Inline the nodes you need.

### `native`/`dataFields` reserved

> `"native"/"dataFields"/"dataConnector" are reserved for the official kit — community components may be declarative or code (kind: "code"), never native`

**Fix:** drop those keys. Native components are trusted generator code *inside* the renderer; the community equivalent for array-driven visuals is a [code component](./Code-Components.md) with a `series` prop.

### Reserved namespace

> `the "kit/" namespace is reserved for the official kit (got "{id}")`

### Variant-shape mistakes

> `kind "code" requires a non-empty "code" string (the render({props, frame}) function source)`

> `"code" requires kind "code"`

> `"computed" is declarative-only — a code component computes its geometry inside render()`

> `kind "code" is mutually exclusive with "native"/"dataFields"/"dataConnector" — a component is trusted-native or sandboxed-code, never both`

**Fix:** a code component computes geometry in `render()` — delete `computed`; a declarative component must not carry `code`.

### Nondeterminism (code)

> `code is nondeterministic — two executions against the declared prop defaults produced different output ({what}); render() must be a pure function of (props, frame)`

where `{what}` is `the runs returned {n} vs {m} nodes` or `output node [{i}] differs between the runs`.

**Fix:** the renderer's own comment notes nondeterminism is *already impossible by construction* (`Date` is excluded at the intrinsic level, `Math.random` throws, there is no async, and each run gets a fresh context) — the double-run exists to catch sandbox regressions loudly. If you somehow see this, the message names the differing node; make it a pure function of `(props, frame)` and report what you did, because it's interesting.

### CPU / memory / output limits (code)

> `executing render() against the declared prop defaults failed ({code}): {message}`

with `{code}` one of `timeout` (50 ms CPU), `memory` (32 MiB), `output_too_large` (> 512 nodes or > 512 KiB — the message distinguishes the two), `runtime_error`, `async_result`, `not_a_function`, `output_invalid`, `compile_error` (the latter also appears as `code failed to compile: {message}`). See the [SandboxError table](./Code-Components.md) for per-code fixes.

### Semantic-check messages

> `duplicate node id "{id}"` · `render() output has duplicate node id "{id}"`

> `computed references unknown node "{node}"` · `computed references undeclared prop "{prop}"` · `computed prop "{prop}" must have type "number"` · `computed clamp [{min}, {max}] has min > max`

> `render() output [{i}] is not a text/rect/image node (got type {type})` · `render() output failed node validation:` (followed by the ajv errors)

> `id must be "{owner}/{name}" or "{owner}/{name}@{version}" (got {id})`

---

Next: [Using-Components](./Using-Components.md)

# MakeItBeauty — Architecture

> Founding design document. These decisions were researched against the GitHub
> profile-README ecosystem (competitors, GitHub Camo constraints, rendering tech,
> sandboxing patterns, connector prior art) as of 2026-08. Treat this file as the
> contract all services align to; change it deliberately.

## 1. Product

A visual editor + rendering platform for profile-README images. Users design SVG
cards on a WYSIWYG canvas (or as code), bind components to live data through
**connectors**, and deploy the result to their own repos. Community component
libraries and multi-platform connectors come later; the editor + official kit +
GitHub connector come first.

Positioning: the ecosystem splits into "live data, fixed card designs"
(github-readme-stats et al.) and "free layout, dead Markdown" (README generators).
MakeItBeauty occupies the empty intersection: **designed canvas + live data**.

## 2. The delivery constraint (read this first)

Everything in a GitHub README renders through the **Camo proxy** inside `<img>`
tags. This imposes hard rules on every SVG we ever emit:

| Rule | Consequence |
|---|---|
| No JavaScript executes | Animation = inline CSS `@keyframes` or SMIL only |
| No external requests (fonts, images, CSS) | Everything inlined: fonts subset + base64 `@font-face` or text-to-path; images as `data:` URIs |
| ~5 MB proxy size cap | Size budget + meter in editor |
| `<foreignObject>` breaks on Safari/WebKit | Never use it; pure SVG primitives only |
| No hover/click inside `<img>` | No interactivity in exports, ever |
| Camo caches by origin `Cache-Control`; raw.githubusercontent.com is `max-age=300` | Updates appear within ~5 min; fine for cron cadence |

An export-time validator enforces these rules on every rendered SVG.

## 3. The three-plane model

```
  Render plane (MakeItBeauty)      Schedule plane (user's Action)      Storage plane (user's repo)
┌─────────────────────────────┐   ┌─────────────────────────────┐   ┌─────────────────────────────┐
│ api (Go)  ──►  renderer(TS) │◄──│ cron / workflow_dispatch /  │──►│ commit SVG → output branch  │
│ connectors, vault, projects │   │ push; curl + commit; dumb   │   │ (single forced commit)      │
│ stateless render on demand  │   │ pipe, fails soft            │   │ README references raw URL   │
└─────────────────────────────┘   └─────────────────────────────┘   └─────────────────────────────┘
```

- **We render. We do not store images and we do not schedule updates.** The user's
  Action pulls a fresh image from us and commits it to their repo.
- **Economics**: renders are O(projects × cron frequency), never O(profile views).
  A daily-refresh project costs ~30 renders/month. This deliberately avoids the
  failure mode that killed hosted-endpoint services (per-view rendering).
- **Failure semantics**: if the API errors, the Action exits non-zero and commits
  nothing — the previous image keeps displaying. A user's profile can go stale but
  can never break. Action templates must write to a temp file and only replace the
  committed file after validating the response.
- **Renders are deterministic**: same design + same data ⇒ byte-identical SVG. No
  timestamps, no randomness in output. This lets Actions skip commits when nothing
  changed. CI enforces this.
- The repo uses an **`output` branch kept at a single forced commit** so the default
  branch history stays clean, the contribution graph isn't polluted by bot commits,
  and the repo never bloats.

## 4. Services

| Service | Stack | Port (dev) | Role |
|---|---|---|---|
| `apps/web` | React + TS + Tailwind (Vite) | 5173 | Editor: canvas, code mode, project management. Talks only to `api`. |
| `apps/api` | Go (stdlib net/http) | 7800 | Public API: auth, projects, connector vault, snapshot cache, rate limiting, render orchestration. |
| `apps/renderer` | Node + TS (internal only) | 7801 | Pure function service: (design, data, options) → SVG. satori pipeline, animation compositor, sanitizer, fonts. |
| `packages/action` | composite GitHub Action | — | The schedule-plane client: curl with retries + safe file replacement. |

**Why Go + Node**: satori (the JSX/CSS→SVG engine) is a JS library; there is no Go
equivalent. Go owns the public plane (auth, tokens, orchestration — where Go's
strengths matter); the renderer is a small stateless Node service scaled
independently. The renderer is *never* exposed publicly.

**Deployment** (Coolify / any compose host): one Dockerfile per service under
`deploy/docker/`, composed by the root `docker-compose.yml`. Only `web` (nginx:
static SPA + `/v1` reverse proxy to `api`) is public — a single domain serves both
the editor and the render API, so the GitHub Action's `api-url` is just that
domain. `renderer` stays on the internal network; `api` state lives on a named
volume. Configuration via env (`.env.example` documents every `MIB_*` var).
`MIB_ENV=production` semantics: no dev seed, no implicit user (auth must be
configured), `/v1/preview` requires a session, CORS locked to `MIB_PUBLIC_URL`,
Secure cookies.

## 5. Rendering pipeline (`apps/renderer`)

1. **Validate** the design document against `packages/schema/design.schema.json`.
2. **Resolve bindings**: `{{path.to.field}}` templates in node properties are
   substituted from the data snapshot. Missing paths produce a warning and an
   em-dash placeholder — never a render failure.
3. **Layout & rasterize text**: satori converts the node tree (flexbox + absolute
   positioning; satori supports no grid, no calc(), no z-index) into SVG. Text is
   converted to paths by default (embedFont). Fonts live server-side — this is what
   makes CJK practical: multi-MB fonts stay in renderer memory and only used glyphs
   ship in output.
4. **Animation compositing**: satori output is flattened/anonymous, so animated
   nodes are rendered in **separate satori passes** (transparent background, same
   canvas), composed as `<g id="node-{id}">` layers over the static base pass, and
   a single injected `<style>` block carries preset `@keyframes` plus a
   `prefers-reduced-motion` guard. Presets: `fadeIn`, `pulse`, `float`,
   `growX`, `growY`, `slideUp`, `slideLeft`, `blink` — transform presets emit
   `transform-box: fill-box` so scale/translate originate from the element's
   own box, not the viewport.
5. **Sanitize** (allowlist): reject `<script>`, `<foreignObject>`, `on*` attributes,
   `javascript:` hrefs, and **any external URL reference** (only `data:` URIs pass).
   External refs are not just broken-through-Camo — connector data + an
   attacker-chosen URL is an exfiltration beacon. This gate is a security boundary,
   not a linter.
6. **Tailwind note**: satori's `tw` prop is experimental (twrnc-based) and is NOT
   used. Editor styling compiles Tailwind-subset classes to plain style objects,
   validated against satori's supported-property whitelist; unsupported classes are
   editor lint errors.
7. **Instance expansion**: `instance` nodes resolve against the kit registry
   (`packages/kit/components`, format pinned by
   `packages/schema/kit-component.schema.json`): fragment nodes are uniform-scaled
   (`min(w/frame.w, h/frame.h)`, top-left aligned) into the instance box;
   `{{props.*}}` slots resolve with the standard template engine; restricted
   `computed` entries map a numeric prop linearly onto node geometry
   (`prop × scale`, clamped) — declarative, no code execution. Expansion runs
   before the satori passes, so animation compositing and sanitization only ever
   see plain nodes. An instance's own `animation` applies to its expanded group as
   one layer.

The editor's live preview calls the same render path (`POST /v1/preview`), so
preview = production output, byte for byte.

## 6. Connector model

**Platform-managed credentials** (the Pipedream Connect pattern): users configure a
connector once under their account; every project reuses it.

```
User ──< ConnectorAccount        credentials, user-level, configured once
User ──< Project ──< Binding     project-level: which account + which fields
```

- **Login is the first connector**: GitHub App sign-in auto-provisions the GitHub
  connector. Zero-config path from login to first live card.
- **Components never see tokens.** Ever. The connector layer resolves data
  server-side; a component receives a *filtered* snapshot containing only the
  fields its bindings declare.
- **Snapshot cache** per (user, connector) with manifest-declared TTL +
  stale-while-revalidate: upstream rate limits or an expired token serve stale data
  rather than failing a render. Upstream API cost is O(users × connectors),
  decoupled from render volume.
- **Auth tiers** (each connector manifest declares one):
  | Tier | Example | Notes |
  |---|---|---|
  | `none` | LeetCode public, RSS | fetch directly |
  | `api_key` | WakaTime | user pastes key once |
  | `oauth_pkce` | Spotify | public-client OAuth, refresh server-side |
  | `oauth_confidential` | others | requires our client secret; add sparingly |
- **GitHub connector** uses a GitHub App (8-hour user tokens + refresh tokens,
  fine-grained permissions), not a classic OAuth App. A refresh worker is a
  first-class component. Contribution-calendar data requires authenticated GraphQL
  (no anonymous path exists), so this connector is a prerequisite for the flagship
  widgets.
- **Two consent layers**: (1) connecting — "MakeItBeauty will read: …";
  (2) binding — "this image will PUBLICLY display: …". The second matters because
  connector data ends up in a world-readable SVG.
- Normalized snapshot shapes (`timeseries`, `counter`, `item_list`, `profile`) let
  one component consume different sources (GitHub contributions / WakaTime hours /
  LeetCode submissions) — component value multiplies with connector count.

## 7. Data model (v0)

```
User             { id, login, displayName, createdAt }
ConnectorAccount { id, userId, connector, encryptedCredentials, status, lastRefreshAt }
Project          { id, userId, name, design, bindings[], outputs[], createdAt, updatedAt }
Binding          { connector, accountId, fields[] }   — DERIVED, never client-authored:
                 recomputed from the design's {{connector.field}} references on every
                 project write; it is the consent record and render-time data filter
Output           { id, theme: auto|light|dark, format: svg, filename }
DeployToken      { id, projectId, hash, createdAt, revokedAt? }
Snapshot         { userId, connector, data, fetchedAt, ttlSeconds }   (cache)
```

### 7.5 Community components (declarative registry)

A user component is the kit-component format (`kit-component.schema.json`) plus
registry metadata — a design fragment with prop slots, `computed` mappings, and
node animations. **No code, ever**: components render through the same trusted
pipeline as the official kit, which is why strangers' components are safe to
install (architecture §9.7 registry rules apply from day one).

- **Namespace = owner's GitHub login, lowercased**: `{owner}/{name}`. The `kit/`
  namespace is reserved for the official in-repo set.
- **Drafts are mutable and private. Published versions are immutable**:
  publishing freezes `{owner}/{name}@{n}` (auto-increment). Instances pin the
  exact version; updating is opt-in per design — no silent auto-updates (a
  malicious update is the top realistic registry attack).
- **Publish-time validation is renderer-owned** (`POST /internal/validate-component`,
  same ajv + semantic checks as the kit loader): schema conformance, no nested
  instances, computed integrity, unique node ids, and **templates restricted to
  `{{props.*}}`** — a component never references connector data directly; data
  reaches it only through props the design author binds. This keeps the consent
  model intact when using other people's components.
- **Unpublish = unlist**: hidden from browse, but pinned usages keep rendering
  (immutability beats deletion; abuse is a moderation action, not a 404).
- **Render path stays stateless**: the API collects every non-kit component
  version a design references and passes the definitions inside the render
  request; the renderer merges them with the built-in kit registry per request.

```
Component        { id "{owner}/{name}", ownerId, title, description, latestVersion, unlisted, createdAt, updatedAt }
ComponentVersion { componentId, version, definition, publishedAt }        — immutable
```

Storage: clean interfaces with two implementations — in-memory (tests) and a
file-backed JSON store (`MIB_DATA_DIR`, default `./data`, gitignored) that makes
dev and small self-host deployments durable with zero dependencies. Postgres is
the scale target behind the same interfaces. Credentials use envelope encryption
with KMS-managed keys (see SECURITY.md).

## 8. API contracts (v0)

### Public (`apps/api`, :7800)

- `GET  /healthz` → `200 {"ok":true}`
- `POST /v1/projects/{id}/render?output={outputId}` — **deploy-token auth**
  (`Authorization: Bearer <token>`, constant-time compare). Resolves project →
  snapshots → renderer; responds `image/svg+xml` (body is the SVG, streamed).
  This is the endpoint the GitHub Action calls.
- `POST /v1/preview` — session auth. Body `{design, data?}`; when data is omitted
  the API derives the design's bindings and resolves the session user's own
  connector snapshots — the exact path production renders take, so preview =
  production for data too (the dev stub connector serves the demo fixture).
  Responds `image/svg+xml`. Used by the editor's live preview.
- `POST /v1/projects`, `GET /v1/projects`, `GET /v1/projects/{id}`,
  `PUT /v1/projects/{id}` (name/design/bindings/outputs), `DELETE /v1/projects/{id}`
  — session auth (dev: implicit user until GitHub App login lands).
- Deploy tokens: `POST /v1/projects/{id}/tokens` → `{id, token, createdAt}` — the
  plaintext token appears in this response ONCE and is never retrievable again
  (only its hash is stored); `GET /v1/projects/{id}/tokens` → masked list
  (id, createdAt, revokedAt); `DELETE /v1/projects/{id}/tokens/{tokenId}` revokes.
- `GET /v1/kit` — public kit component metadata for the editor palette:
  `[{id: "kit/stat-card", title, description?, frame: {w, h}, props}]`, served
  from `packages/kit/components`.
- Components (§7.5): `GET /v1/components` (mine: drafts + published, session);
  `POST /v1/components` `{name, title, frame}` → draft (session; id =
  `{login}/{name}`); `PUT /v1/components/{owner}/{name}` update draft definition
  (owner only; published versions are never mutated); `POST
  /v1/components/{owner}/{name}/publish` → freezes the next immutable version
  after renderer validation; `GET /v1/components/{owner}/{name}` metadata +
  latest published definition (public when published);
  `GET /v1/components/{owner}/{name}/versions/{n}` immutable definition (public);
  `DELETE /v1/components/{owner}/{name}` unlist (owner);
  `GET /v1/community/components?q=` browse published, newest first (public).
- Auth (GitHub App user OAuth): `GET /v1/auth/github/login` → 302 to GitHub
  authorize (CSRF `state` in a short-lived cookie); `GET /v1/auth/github/callback`
  → code exchange (user token, 8h + refresh), upsert user, provision the GitHub
  ConnectorAccount (credentials sealed at rest), set session, 302 to the app;
  `POST /v1/auth/logout`; `GET /v1/me` → `{user, connectors:[{connector, status}]}`
  or 401. Sessions: server-side store, random id in an HttpOnly `mib_session`
  cookie (SameSite=Lax; Secure in production; 30-day expiry). Tokens never reach
  the browser (BFF). Dev fallback: with `MIB_ENV=dev` and no
  `MIB_GITHUB_CLIENT_ID`, the implicit dev user remains (`/v1/me` flags
  `dev: true`); production without auth config refuses to boot.
- `GET /v1/connectors` — session auth: the user's connector status plus available
  snapshot field paths (drives the editor's binding controls):
  `[{connector: "github", status: "connected"|"unconfigured"|"expired",
  fields: [{path, description, type: "string"|"number"}]}]`. Every bindable
  editor input offers Custom vs. Data modes; Data mode lists only fields whose
  type matches the input.
- Auth/crypto env: `MIB_PUBLIC_URL`, `MIB_MASTER_KEY` (base64 32-byte key;
  credential sealing), `MIB_GITHUB_CLIENT_ID`, `MIB_GITHUB_CLIENT_SECRET`,
  `MIB_GITHUB_APP_SLUG` (install link; reserved), `MIB_GITHUB_URL` /
  `MIB_GITHUB_API_URL` (GitHub endpoint overrides for Enterprise/tests).
  Sessions are server-side records looked up by random id, so no signing key
  exists (`MIB_SESSION_KEY` was dropped as unnecessary).
- Errors: JSON envelope `{"error":{"code":"...","message":"..."}}` with proper
  status codes. Render failures MUST be non-200 so the Action fails soft.
- Rate limits: per-deploy-token minimum render interval (dev default: none;
  production target: 15 min).

### Internal (`apps/renderer`, :7801 — never public)

- `POST /internal/render` — body/response per `packages/schema/render.schema.json`:
  request `{design, data, options?}` → `200 {svg, warnings[]}` or
  `4xx/5xx {error:{code,message}}`.

### Dev seeds (`MIB_ENV=dev`)

API seeds project `demo` from `examples/demo-design.json` with deploy token
`dev-demo-token`, so this works out of the box:

```bash
curl -X POST -H "Authorization: Bearer dev-demo-token" \
  http://localhost:7800/v1/projects/demo/render
```

## 9. Security commitments (summary; full text in SECURITY.md)

1. Credentials sealed at rest with AES-256-GCM behind a `Sealer` interface —
   self-host tier: master key from `MIB_MASTER_KEY` (env, never in the repo);
   scale tier: KMS-managed envelope keys behind the same interface. Disk
   encryption alone does not count. Dev without a key runs unsealed with a loud
   startup warning; production with auth configured requires the key (fatal).
2. Prefer short-lived upstream tokens (GitHub App 8h + refresh).
3. BFF: tokens never reach the browser; the editor holds only a session.
4. Components receive filtered data snapshots, never credentials — this is the
   security boundary, not a convention.
5. Output sanitizer strips all external references (exfiltration-beacon defense).
6. Deploy tokens are per-project, revocable, and can only pull rendered output —
   small blast radius by construction.
7. Future community registry: namespaces bound to verified identities, immutable
   versions, **no silent auto-updates** of installed components.

## 10. Roadmap

- **Phase 1 (MVP)**: editor (canvas + code mode) + official kit (10–20 Camo-safe
  components) + GitHub connector + one-click deploy (App scaffolds workflow;
  Action pulls renders). No-login design mode with placeholder data.
- **Phase 2**: connector depth (contributions, languages), theming, public project
  pages + Remix (fork-ability), design import/export.
- **Phase 3**: declarative community components + registry; more connectors
  (WakaTime, LeetCode, RSS, Spotify; CJK-ecosystem sources are an open
  differentiator). Community connectors ship only via reviewed PRs — they are
  trusted code, unlike sandboxed components.
- **Phase 4**: QuickJS-in-WASM code components (pure render functions,
  data-in/element-tree-out, no host APIs); optional hosted endpoints as a
  sponsored/paid path; additional export targets (GitLab, og-images) as platform
  hedge.

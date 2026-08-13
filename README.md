# MakeItBeauty ✨ [![CI](https://github.com/PengLx/makeitbeauty/actions/workflows/ci.yml/badge.svg)](https://github.com/PengLx/makeitbeauty/actions/workflows/ci.yml)

**Design beautiful, data-driven images for your GitHub profile README.**

MakeItBeauty is an open-source visual editor + rendering service for profile-README images.
Drag and resize components on a canvas (or edit the design as code), bind them to live data
through **connectors** (GitHub, WakaTime, …), and publish self-contained animated SVGs that
render perfectly inside GitHub's README sandbox.

> Status: **usable self-host alpha** — visual editor (shadcn/ui), kit components with
> live-data bindings, durable projects, deploy-token lifecycle, GitHub App sign-in
> with a live GitHub connector (sealed credentials), Docker/Coolify deployment, and
> CI-enforced deterministic renders. More connectors and community components are the
> next milestones ([docs/architecture.md](docs/architecture.md) §10).

## How it works — the three-plane model

```
  Render plane (us)          Schedule plane (you)         Storage plane (you)
┌────────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│ MakeItBeauty API   │ ←── │ GitHub Action (cron / │ ──→ │ your repo            │
│ renders your       │     │ manual) curls us for  │     │ commit SVG → raw URL │
│ project into SVG   │     │ a fresh image         │     │ → README <img>       │
└────────────────────┘     └──────────────────────┘     └──────────────────────┘
```

- **We render, you own storage & scheduling.** Your images live in *your* repo; your Action
  decides when to refresh them. If our API is ever down, your profile keeps showing the last
  image — it never breaks.
- **Connectors are configured once, used everywhere.** Sign in, connect your data sources a
  single time, then bind any number of image projects to them. Components receive filtered
  data snapshots — never your tokens.
- **Multiple projects per user.** Different images for GitHub, GitLab, your blog, your résumé —
  each with its own design, data bindings, and output settings.

## Repository layout

| Path | What it is |
|---|---|
| `apps/web` | React + Tailwind visual editor (Vite) |
| `apps/api` | Go backend — auth, projects, connector vault, render orchestration |
| `apps/renderer` | Internal Node render service — satori pipeline, animation, sanitizer, fonts |
| `packages/schema` | JSON Schemas: design document, project, connector manifest, render API, kit component |
| `packages/kit` | Official component kit (declarative, Camo-safe) |
| `packages/action` | GitHub Action + workflow templates for the schedule plane |
| `examples/` | Canonical demo design + data fixtures used by tests and the editor |
| `docs/` | Architecture, security model |

## Quickstart (development)

```bash
pnpm install
make fonts   # one-time: downloads Inter + JetBrains Mono + Lora into apps/renderer/fonts/ (gitignored)

# terminal 1 — render service (:7801)
make dev-renderer

# terminal 2 — API (:7800, seeds a demo project in dev)
make dev-api

# terminal 3 — editor (:5173)
make dev-web

# or render the demo fixture straight to a file:
make demo   # → apps/renderer/out/demo.svg
```

## Deploy (self-host)

The whole stack ships as three Docker images (`deploy/docker/`) composed by the root
`docker-compose.yml` — one public domain serves the editor and the render API. See
**[docs/deploy-coolify.md](docs/deploy-coolify.md)** for the step-by-step Coolify (or any
compose host) guide, and [`.env.example`](.env.example) for every configuration knob.

## Design principles

1. **Camo-safe by construction** — exported SVGs contain no JavaScript, no external
   references, fonts subset + inlined; animation is inline CSS `@keyframes` / SMIL only.
2. **Operator cost is O(projects), not O(profile views)** — rendering happens when *your*
   Action asks, never per page view.
3. **Components never see credentials** — the connector layer resolves data server-side and
   passes filtered snapshots; see [docs/SECURITY.md](docs/SECURITY.md).
4. **Deterministic renders** — same design + same data → byte-identical SVG, so no-change
   runs commit nothing.

## License

[MIT](LICENSE)

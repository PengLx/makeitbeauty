# Deploying MakeItBeauty on Coolify

Self-host the full stack — editor, API, renderer — on a [Coolify](https://coolify.io)
server (or any Docker Compose host) with one domain and one named volume.

What you end up with:

```
your-domain.example.com
        │
        ▼
┌──────────────┐   /v1/*   ┌──────────────┐   internal   ┌──────────────┐
│ web (nginx)  │ ────────► │ api (Go)     │ ───────────► │ renderer     │
│ SPA + proxy  │           │ :7800        │              │ (Node) :7801 │
│ :80 (public) │           │ mib-data vol │              │ never public │
└──────────────┘           └──────────────┘              └──────────────┘
```

One domain serves both the editor **and** the render API (nginx proxies `/v1/`
to `api`), so the `api-url` you later give the GitHub Action is simply
`https://your-domain.example.com`.

## Prerequisites

- A Coolify server (v4) with a wildcard or dedicated DNS record pointing at it.
- This repository on GitHub (your fork or the upstream repo).
- The domain you will serve MakeItBeauty from, e.g. `mib.example.com`.

## 1. Create the GitHub App (login)

Login is the first connector (architecture §6): a GitHub App provides user
sign-in, and v0 needs **identity only** — no repository or org permissions.

1. GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**
   (use an org's settings page to own the app as an org).
2. Fill in:
   - **GitHub App name**: e.g. `MakeItBeauty (mib.example.com)`. Note the
     generated slug (shown in the app's URL, `github.com/apps/<slug>`).
   - **Homepage URL**: `https://mib.example.com`
   - **Callback URL**: `https://mib.example.com/v1/auth/github/callback`
     (must be exactly `MIB_PUBLIC_URL` + `/v1/auth/github/callback`).
   - Check **Request user authorization (OAuth) during installation**.
   - **Webhook**: uncheck *Active* — no webhooks in v0.
   - **Permissions**: leave everything at *No access*. Identity comes with the
     user authorization flow; add nothing for v0 login.
   - **Where can this GitHub App be installed?** — *Any account* if others
     will sign in to your instance.
3. Create the app. On its settings page:
   - Copy the **Client ID** → `MIB_GITHUB_CLIENT_ID`.
   - **Generate a new client secret** → `MIB_GITHUB_CLIENT_SECRET` (shown
     once; store it in Coolify's env vars, never in the repo).

## 2. Create the Coolify resource

1. Coolify → your project → **+ New Resource** → **Docker Compose** → pick
   **Public Repository** (or your GitHub source for a private fork).
2. Repository: this repo's URL; branch: `main`. Coolify detects the root
   `docker-compose.yml` — keep that as the compose file.
3. Do not deploy yet — set the environment first.

## 3. Environment variables

In the resource's **Environment Variables** tab, set the values documented in
[`.env.example`](../.env.example). Required for production:

| Variable | Value |
|---|---|
| `MIB_ENV` | `production` |
| `MIB_PUBLIC_URL` | `https://mib.example.com` |
| `MIB_MASTER_KEY` | output of `openssl rand -base64 32` |
| `MIB_GITHUB_CLIENT_ID` | from step 1 |
| `MIB_GITHUB_CLIENT_SECRET` | from step 1 |

(Keep the app slug from step 1 handy — `MIB_GITHUB_APP_SLUG` is reserved for
the editor's install link; see `.env.example`.)

Everything else has working defaults (see the optional section of
`.env.example`). Two production behaviors to know about:

- `MIB_ENV=production` disables the dev seed and the implicit dev user; the
  app refuses to boot without auth configured — that is intentional.
- `MIB_MASTER_KEY` seals connector credentials at rest (architecture §9.1).
  Losing it does not lose projects, but every user must reconnect their
  connectors.

Also set `MIB_WEB_PORT` to a free host port (e.g. `8080`): on a Coolify
server, ports 80/443 belong to Coolify's proxy, and the default `80:80`
mapping in `docker-compose.yml` would collide with it. The domain you attach
in the next step is routed by the proxy directly to the container's port 80
regardless of the published host port.

## 4. Attach the domain to `web`

In the resource's service list, set the **domain** on the **web** service:
`https://mib.example.com`. Leave `api` and `renderer` without domains —
`renderer` must never be public, and `api` is reached through the nginx
`/v1` proxy on the same domain.

Coolify provisions TLS (Let's Encrypt) for the domain automatically.

## 5. Deploy and verify

Hit **Deploy**. Coolify builds the three images from `deploy/docker/` and
starts them; `depends_on` + healthchecks bring them up in order
(renderer → api → web).

Verify from your machine:

```bash
curl https://mib.example.com/healthz          # web (nginx)   → {"ok":true}
curl https://mib.example.com/v1/kit           # api via proxy → kit component list
```

### Persistent data

API state (users, projects, deploy tokens, sealed connector credentials)
lives in the `mib-data` named volume mounted at `/data` — it survives
redeploys and image rebuilds. Include this volume in your server backups
(Coolify → resource → Storages shows it). The renderer and web containers
are stateless.

## 6. First login

1. Open `https://mib.example.com` — the editor loads.
2. Sign in with GitHub: you are sent to `/v1/auth/github/login`, GitHub asks
   you to authorize (and on first use, install) the app, then returns to
   `/v1/auth/github/callback`, which creates your user, provisions the GitHub
   connector, sets the `mib_session` cookie, and lands you back in the app.
3. Create a project, design your card, and add a deploy token
   (Deploy dialog). The token is shown **once**.
4. In your profile repo, add the workflow from
   [`packages/action`](../packages/action/) with
   `api-url: https://mib.example.com` and the deploy token as a secret.

## 7. Updating

Deploys are plain `git push` → rebuild:

1. Push to `main` (or merge a PR). CI's `images` job has already proven the
   Dockerfiles build on every push.
2. Coolify → resource → **Redeploy** — or enable **auto-deploy on push** in
   the resource's settings (Coolify installs a webhook) so step 2 disappears.

Data in `mib-data` is untouched by redeploys.

## Troubleshooting

- **`api` never becomes healthy**: check its logs. In production it exits at
  boot when auth env vars are missing or `MIB_MASTER_KEY` is absent/invalid —
  the log line says which.
- **Port conflict on deploy**: another service (usually Coolify's own proxy)
  owns host port 80 — set `MIB_WEB_PORT` (step 3).
- **GitHub login loops or 404s**: the App's callback URL must be exactly
  `MIB_PUBLIC_URL` + `/v1/auth/github/callback`, and `MIB_PUBLIC_URL` must be
  the https domain attached to `web`.
- **Renders time out**: the nginx proxy allows 75s; check `renderer` health
  and logs (fonts load at startup — the build fetches Inter automatically).

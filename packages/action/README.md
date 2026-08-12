# @makeitbeauty/action

The schedule-plane client of the [three-plane model](../../docs/architecture.md#3-the-three-plane-model):
a composite GitHub Action that pulls a freshly rendered SVG from the
MakeItBeauty API and replaces your committed image **only after validating the
response**. It is deliberately a dumb pipe — curl with retries plus safe file
replacement — because everything interesting happens on the render plane.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `api-url` | no | `https://makeitbeauty.org` | Base URL of the MakeItBeauty API (the editor's own domain — it serves the API under `/v1`). |
| `project` | **yes** | — | Project id to render. |
| `deploy-token` | **yes** | — | Per-project deploy token. Store it as a repo secret; never inline it. |
| `output` | no | `default` | Output id within the project (e.g. a theme variant). |
| `path` | no default — **yes** | — | Repo-relative path to write the SVG to, e.g. `assets/card.svg`. |

## Failure semantics: your profile can go stale, but never break

The action renders into a **temp file** and validates it (non-empty, starts
with `<svg`) before moving it into place. On *any* failure — API down, render
error, auth failure, truncated body, JSON error envelope instead of an image —
the action exits non-zero **without touching the existing file**. The
previously committed image keeps displaying in your README.

Combined with the API contract (render failures are always non-200, so curl's
`--fail` trips) and deterministic renders (same design + same data ⇒
byte-identical SVG, so unchanged output can skip commits), the worst case for
your profile is a stale image — never a broken one.

Transient hiccups are absorbed before they even count as failures: curl runs
with `--retry 3 --retry-delay 5 --max-time 60`.

## Setup

1. **Create a project** in the MakeItBeauty editor and add an output.
2. **Generate a deploy token** for the project (Project → Deploy). Deploy
   tokens are per-project, revocable, and can only pull rendered output.
3. **Add the secret**: in your profile repo (the repo named after your
   username), go to *Settings → Secrets and variables → Actions* and add
   `MAKEITBEAUTY_DEPLOY_TOKEN` with the token value.
4. **Add the workflow**: copy
   [`templates/profile-workflow.yml`](templates/profile-workflow.yml) to
   `.github/workflows/makeitbeauty.yml` and edit the matrix to list your
   projects. It runs daily (off-the-hour cron — GitHub delays on-the-hour
   ones), on manual dispatch, and on pushes to `.makeitbeauty/**`.
5. **Embed the image** in your README (see below).

> Note: GitHub auto-disables scheduled workflows after ~60 days of repo
> inactivity. Any commit to the repo, or re-enabling in the Actions tab,
> resets the clock.

## Embedding

The workflow commits rendered images to an `output` branch kept at a single
forced commit (clean history, no contribution-graph pollution, no repo bloat).
Reference it via `raw.githubusercontent.com` — GitHub's Camo proxy caches it
for 5 minutes, so updates show up shortly after each run:

```html
<img src="https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_USERNAME/output/assets/card.svg"
     alt="Profile card" />
```

## Standalone usage

```yaml
- uses: makeitbeauty/action@v0
  with:
    project: my-profile-card
    deploy-token: ${{ secrets.MAKEITBEAUTY_DEPLOY_TOKEN }}
    output: default
    path: assets/card.svg
```

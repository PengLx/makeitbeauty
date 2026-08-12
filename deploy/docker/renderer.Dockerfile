# MakeItBeauty internal render service (apps/renderer) — architecture.md §4.
# Build context is the repo root:
#   docker build -f deploy/docker/renderer.Dockerfile .
#
# NEVER expose this container publicly; only the api service talks to it.
#
# The runtime stage reproduces the monorepo shape under /app because the
# renderer resolves shared assets by walking up to pnpm-workspace.yaml
# (src/paths.ts): packages/schema (design + kit schemas), packages/kit
# (component fragments), examples/ (demo fixtures), apps/renderer/fonts.

# ---- fonts: fetched at build time, same release as `make fonts` -----------
FROM node:24-slim AS fonts
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
ARG INTER_URL=https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip
RUN mkdir -p /fonts \
 && curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors -o /tmp/inter.zip "$INTER_URL" \
 && unzip -o -j /tmp/inter.zip extras/ttf/Inter-Regular.ttf extras/ttf/Inter-Bold.ttf -d /fonts \
 && rm /tmp/inter.zip

# ---- build: workspace-aware install + tsc ---------------------------------
FROM node:24-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Every workspace manifest must be present for --frozen-lockfile to accept
# the lockfile (its importers cover all packages), even in a filtered install.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/renderer/package.json apps/renderer/
COPY apps/web/package.json apps/web/
COPY packages/action/package.json packages/action/
COPY packages/kit/package.json packages/kit/
COPY packages/schema/package.json packages/schema/
RUN pnpm install --frozen-lockfile --filter @makeitbeauty/renderer

COPY apps/renderer/tsconfig.json apps/renderer/
COPY apps/renderer/src/ apps/renderer/src/
RUN pnpm --filter @makeitbeauty/renderer build \
 # replace the dev install with production-only node_modules for the runtime stage
 && rm -rf node_modules apps/renderer/node_modules \
 && pnpm install --prod --frozen-lockfile --filter @makeitbeauty/renderer

# ---- runtime --------------------------------------------------------------
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app

# repo-root anchor for src/paths.ts (repoRoot walks up to this file)
COPY --from=build --chown=node:node /app/pnpm-workspace.yaml ./
# prod node_modules: the per-package dir symlinks into the root virtual store,
# so both must be copied at the same relative locations
COPY --from=build --chown=node:node /app/node_modules/ node_modules/
COPY --from=build --chown=node:node /app/apps/renderer/node_modules/ apps/renderer/node_modules/
COPY --from=build --chown=node:node /app/apps/renderer/package.json apps/renderer/
COPY --from=build --chown=node:node /app/apps/renderer/dist/ apps/renderer/dist/
COPY --from=fonts --chown=node:node /fonts/ apps/renderer/fonts/
# shared runtime assets, straight from the build context
COPY --chown=node:node packages/schema/ packages/schema/
COPY --chown=node:node packages/kit/ packages/kit/
COPY --chown=node:node examples/ examples/

USER node
EXPOSE 7801

# node -e fetch: slim images carry no curl/wget. Port matches the
# MIB_RENDERER_ADDR default (":7801").
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:7801/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "apps/renderer/dist/server.js"]

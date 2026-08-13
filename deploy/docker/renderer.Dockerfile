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

# ---- fonts: fetched at build time, same releases as `make fonts` ----------
# Built-in families (all OFL): Inter, JetBrains Mono, Lora — Regular + Bold.
# Keep these URLs in sync with the Makefile fonts target.
FROM node:24-slim AS fonts
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
ARG INTER_URL=https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip
ARG JBMONO_URL=https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip
ARG LORA_URL=https://github.com/cyrealtype/Lora-Cyrillic/releases/download/v3.021/Lora.zip
RUN mkdir -p /fonts \
 && curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors -o /tmp/inter.zip "$INTER_URL" \
 && curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors -o /tmp/jbmono.zip "$JBMONO_URL" \
 && curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors -o /tmp/lora.zip "$LORA_URL" \
 && unzip -o -j /tmp/inter.zip extras/ttf/Inter-Regular.ttf extras/ttf/Inter-Bold.ttf -d /fonts \
 && unzip -o -j /tmp/jbmono.zip fonts/ttf/JetBrainsMono-Regular.ttf fonts/ttf/JetBrainsMono-Bold.ttf -d /fonts \
 && unzip -o -j /tmp/lora.zip ttf/Lora-Regular.ttf ttf/Lora-Bold.ttf -d /fonts \
 && rm /tmp/inter.zip /tmp/jbmono.zip /tmp/lora.zip

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
COPY packages/twc/package.json packages/twc/
# twc must be SELECTED (not just pulled in as a workspace dependency):
# only selected projects get their devDependencies installed, and twc's
# build needs its own typescript.
RUN pnpm install --frozen-lockfile --filter @makeitbeauty/renderer --filter @makeitbeauty/twc

# twc (workspace dep) must be built before the renderer's tsc can resolve it
COPY packages/twc/tsconfig.json packages/twc/
COPY packages/twc/src/ packages/twc/src/
COPY apps/renderer/tsconfig.json apps/renderer/
COPY apps/renderer/src/ apps/renderer/src/
RUN pnpm --filter @makeitbeauty/twc build \
 && pnpm --filter @makeitbeauty/renderer build \
 # replace the dev install with production-only node_modules for the runtime stage
 && rm -rf node_modules apps/renderer/node_modules packages/twc/node_modules \
 && pnpm install --prod --frozen-lockfile --filter @makeitbeauty/renderer --filter @makeitbeauty/twc

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
# workspace dep target of the @makeitbeauty/twc symlink in apps/renderer/node_modules
COPY --from=build --chown=node:node /app/packages/twc/package.json packages/twc/
COPY --from=build --chown=node:node /app/packages/twc/dist/ packages/twc/dist/
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

# MakeItBeauty editor (apps/web) — architecture.md §4.
# Build context is the repo root:
#   docker build -f deploy/docker/web.Dockerfile .
#
# The only public service: nginx serves the built SPA and reverse-proxies
# /v1/ to the api container (deploy/docker/nginx.conf), so one domain covers
# both the editor and the render API.

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
RUN pnpm install --frozen-lockfile --filter @makeitbeauty/web

COPY apps/web/ apps/web/
RUN pnpm --filter @makeitbeauty/web build

FROM nginx:alpine
COPY deploy/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist/ /usr/share/nginx/html/

EXPOSE 80

# Mirrors the compose healthcheck so a standalone `docker run` is covered too.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1

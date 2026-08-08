# MakeItBeauty public API (apps/api) — architecture.md §4.
# Build context is the repo root:
#   docker build -f deploy/docker/api.Dockerfile .
#
# The Go module is stdlib-only (no go.sum), so the source tree is the whole
# build input. The runtime stage is alpine + ca-certificates (rather than
# distroless) so busybox wget can serve container healthchecks.

FROM golang:1.26-alpine AS build
WORKDIR /src/apps/api
COPY apps/api/ .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

FROM alpine:3.22
RUN apk add --no-cache ca-certificates \
 && addgroup -S mib && adduser -S -G mib mib \
 && mkdir -p /data && chown mib:mib /data

COPY --from=build /out/api /usr/local/bin/mib-api

# Runtime assets the binary resolves (architecture.md §8): the kit palette
# served by GET /v1/kit, and the demo fixtures used by the dev seed and the
# /v1/preview data fallback. The MIB_* envs point at these in-image paths
# (absolute paths are used as-is by internal/kit and internal/fixture).
COPY packages/kit/components/ /app/packages/kit/components/
COPY examples/ /app/examples/

ENV MIB_ADDR=:7800 \
    MIB_DATA_DIR=/data \
    MIB_KIT_DIR=/app/packages/kit/components \
    MIB_DEMO_DATA=/app/examples/demo-data.json \
    MIB_DEMO_DESIGN=/app/examples/demo-design.json

USER mib
EXPOSE 7800

# Mirrors the compose healthcheck so a standalone `docker run` is covered too.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7800/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/mib-api"]

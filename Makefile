.PHONY: fonts dev-api dev-renderer dev-web build test demo

# The renderer embeds text as vector paths and needs .ttf/.otf files in
# apps/renderer/fonts/ (gitignored — fetched at setup, not committed).
INTER_URL := https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip
fonts:
	tmp=$$(mktemp -d) && \
	curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors -o $$tmp/inter.zip $(INTER_URL) && \
	unzip -o -j $$tmp/inter.zip extras/ttf/Inter-Regular.ttf extras/ttf/Inter-Bold.ttf -d apps/renderer/fonts/ && \
	rm -rf $$tmp

dev-api:
	cd apps/api && MIB_ENV=dev go run ./cmd/api

dev-renderer:
	pnpm --filter @makeitbeauty/renderer dev

dev-web:
	pnpm --filter @makeitbeauty/web dev

build:
	pnpm -r build
	cd apps/api && go build ./...

test:
	# renderer tests import @makeitbeauty/twc's built output — build it first
	# so `make test` works on a fresh clone (and in CI, whatever the order)
	pnpm --filter @makeitbeauty/twc build
	pnpm -r test
	cd apps/api && go test ./...

demo:
	pnpm --filter @makeitbeauty/renderer demo

// Package httpapi wires the public HTTP API: mux, handlers, middleware.
// Contracts: architecture.md §8 and packages/schema/*.json.
package httpapi

import (
	"log/slog"
	"net/http"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/config"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/connector"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/kit"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/render"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// Server holds the wired dependencies of the public API.
type Server struct {
	cfg      config.Config
	log      *slog.Logger
	stores   store.Stores
	cache    *connector.SnapshotCache
	renderer *render.Client
	// demoData is the merged demo fixture ({"github": {...}}) used as the
	// /v1/preview fallback when the request omits data. Nil outside dev.
	demoData map[string]any
	// kit is the palette metadata served by GET /v1/kit, loaded once at
	// startup and sorted by id.
	kit []kit.Component
}

// NewServer wires a Server. demoData may be nil (non-dev).
func NewServer(cfg config.Config, log *slog.Logger, stores store.Stores, cache *connector.SnapshotCache, renderer *render.Client, demoData map[string]any, kitComponents []kit.Component) *Server {
	return &Server{cfg: cfg, log: log, stores: stores, cache: cache, renderer: renderer, demoData: demoData, kit: kitComponents}
}

// Handler builds the full middleware + route stack.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /v1/kit", s.handleKit)
	mux.HandleFunc("POST /v1/projects/{id}/render", s.requireDeployToken(s.handleRender))
	mux.HandleFunc("POST /v1/preview", s.handlePreview)
	mux.HandleFunc("POST /v1/projects", s.requireSession(s.handleCreateProject))
	mux.HandleFunc("GET /v1/projects", s.requireSession(s.handleListProjects))
	mux.HandleFunc("GET /v1/projects/{id}", s.requireSession(s.handleGetProject))

	// Everything else: JSON 404 envelope instead of the default text page.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "no such route")
	})

	var h http.Handler = mux
	if s.cfg.Dev() {
		h = corsDev(h) // permissive CORS for the Vite editor, dev only
	}
	h = recoverPanics(s.log, h)
	h = logRequests(s.log, h)
	return h
}

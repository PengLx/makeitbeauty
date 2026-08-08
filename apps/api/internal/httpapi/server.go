// Package httpapi wires the public HTTP API: mux, handlers, middleware.
// Contracts: architecture.md §8 and packages/schema/*.json.
package httpapi

import (
	"log/slog"
	"net/http"
	"net/url"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/auth"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/config"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/connector"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/crypto"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/kit"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/render"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// Server holds the wired dependencies of the public API.
type Server struct {
	cfg      config.Config
	log      *slog.Logger
	stores   store.Stores
	sessions auth.Sessions
	sealer   crypto.Sealer
	// oauth is nil when GitHub auth is unconfigured (dev without
	// MIB_GITHUB_CLIENT_ID): login/callback then refuse and the implicit dev
	// user carries sessions.
	oauth    *auth.GitHubOAuth
	cache    *connector.SnapshotCache
	renderer *render.Client
	// demoData is the merged demo fixture ({"github": {...}}) used as the
	// /v1/preview fallback when the request omits data. Nil outside dev.
	demoData map[string]any
	// kit is the palette metadata served by GET /v1/kit, loaded once at
	// startup and sorted by id.
	kit []kit.Component
}

// Deps bundles the wired dependencies of NewServer.
type Deps struct {
	Stores   store.Stores
	Sessions auth.Sessions
	Sealer   crypto.Sealer
	OAuth    *auth.GitHubOAuth // nil == GitHub auth unconfigured
	Cache    *connector.SnapshotCache
	Renderer *render.Client
	DemoData map[string]any // nil outside dev
	Kit      []kit.Component
}

// NewServer wires a Server.
func NewServer(cfg config.Config, log *slog.Logger, deps Deps) *Server {
	return &Server{
		cfg:      cfg,
		log:      log,
		stores:   deps.Stores,
		sessions: deps.Sessions,
		sealer:   deps.Sealer,
		oauth:    deps.OAuth,
		cache:    deps.Cache,
		renderer: deps.Renderer,
		demoData: deps.DemoData,
		kit:      deps.Kit,
	}
}

// Handler builds the full middleware + route stack.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /v1/kit", s.handleKit)
	mux.HandleFunc("POST /v1/projects/{id}/render", s.requireDeployToken(s.handleRender))
	mux.HandleFunc("POST /v1/preview", s.requireSession(s.handlePreview))
	mux.HandleFunc("POST /v1/projects", s.requireSession(s.handleCreateProject))
	mux.HandleFunc("GET /v1/projects", s.requireSession(s.handleListProjects))
	mux.HandleFunc("GET /v1/projects/{id}", s.requireSession(s.handleGetProject))
	mux.HandleFunc("PUT /v1/projects/{id}", s.requireSession(s.handleUpdateProject))
	mux.HandleFunc("DELETE /v1/projects/{id}", s.requireSession(s.handleDeleteProject))
	mux.HandleFunc("POST /v1/projects/{id}/tokens", s.requireSession(s.handleCreateToken))
	mux.HandleFunc("GET /v1/projects/{id}/tokens", s.requireSession(s.handleListTokens))
	mux.HandleFunc("DELETE /v1/projects/{id}/tokens/{tokenId}", s.requireSession(s.handleRevokeToken))
	mux.HandleFunc("GET /v1/auth/github/login", s.handleGitHubLogin)
	mux.HandleFunc("GET /v1/auth/github/callback", s.handleGitHubCallback)
	mux.HandleFunc("POST /v1/auth/logout", s.handleLogout)
	mux.HandleFunc("GET /v1/me", s.handleMe)
	mux.HandleFunc("GET /v1/connectors", s.requireSession(s.handleConnectors))

	// Everything else: JSON 404 envelope instead of the default text page.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "no such route")
	})

	var h http.Handler = mux
	if s.cfg.Dev() {
		h = cors(devCORSOrigin, h) // permissive CORS for the Vite editor, dev only
	} else {
		// Outside dev the only allowed cross-origin caller is the editor at
		// MIB_PUBLIC_URL (architecture.md §4). Same-origin traffic through
		// the nginx BFF never sends an Origin that differs, so this is a
		// no-op there.
		h = cors(originOf(s.cfg.PublicURL), h)
	}
	h = recoverPanics(s.log, h)
	h = logRequests(s.log, h)
	return h
}

// originOf reduces a URL to its origin (scheme://host) for the CORS
// allowlist; an empty or unparseable URL allows nothing.
func originOf(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

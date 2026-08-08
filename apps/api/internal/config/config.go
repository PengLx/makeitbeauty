// Package config loads API configuration from environment variables.
// Every knob has a dev-friendly default so `make dev-api` works with zero setup.
package config

import (
	"fmt"
	"os"
	"strings"
)

// Config is the resolved runtime configuration of the API process.
type Config struct {
	// Addr is the listen address of the public API (MIB_ADDR).
	Addr string
	// RendererURL is the base URL of the internal renderer service (MIB_RENDERER_URL).
	RendererURL string
	// Env is the deployment environment, e.g. "dev" or "prod" (MIB_ENV).
	Env string
	// Store selects the persistence backend: "file" or "memory" (MIB_STORE).
	// Defaults to the durable file store; "memory" exists for tests and
	// throwaway runs.
	Store string
	// DataDir is where the file store keeps its JSON collections
	// (MIB_DATA_DIR, default "./data" relative to the working directory;
	// created on demand, gitignored).
	DataDir string
	// DemoDataPath points at the demo connector-data fixture (MIB_DEMO_DATA).
	// Relative paths are resolved robustly; see internal/fixture.
	DemoDataPath string
	// DemoDesignPath points at the demo design fixture (MIB_DEMO_DESIGN).
	DemoDesignPath string
	// KitDir points at the official kit component directory (MIB_KIT_DIR).
	// Relative paths are resolved robustly; see internal/kit.
	KitDir string
	// PublicURL is the origin the editor is served from (MIB_PUBLIC_URL):
	// the post-login redirect target and the only CORS origin outside dev.
	// Defaults to the Vite dev server in dev; required in production.
	PublicURL string
	// MasterKey is the base64-encoded 32-byte credential-sealing key
	// (MIB_MASTER_KEY, architecture.md §9.1). Empty selects the unsealed dev
	// fallback; required in production.
	MasterKey string
	// GitHubClientID / GitHubClientSecret configure GitHub App user OAuth
	// (MIB_GITHUB_CLIENT_ID / MIB_GITHUB_CLIENT_SECRET). An empty client id
	// means auth is unconfigured: dev falls back to the implicit user,
	// production refuses to boot.
	GitHubClientID     string
	GitHubClientSecret string
	// GitHubURL is the base of GitHub's web endpoints — authorize and token
	// exchange (MIB_GITHUB_URL). Overridable so tests point at httptest
	// servers.
	GitHubURL string
	// GitHubAPIURL is the base of GitHub's REST/GraphQL API
	// (MIB_GITHUB_API_URL). Overridable for tests, like GitHubURL.
	GitHubAPIURL string
}

// Load reads configuration from the environment, applying defaults.
func Load() Config {
	cfg := Config{
		Addr:               getenv("MIB_ADDR", ":7800"),
		RendererURL:        getenv("MIB_RENDERER_URL", "http://localhost:7801"),
		Env:                getenv("MIB_ENV", "dev"),
		Store:              getenv("MIB_STORE", "file"),
		DataDir:            getenv("MIB_DATA_DIR", "./data"),
		DemoDataPath:       getenv("MIB_DEMO_DATA", "../../examples/demo-data.json"),
		DemoDesignPath:     getenv("MIB_DEMO_DESIGN", "../../examples/demo-design.json"),
		KitDir:             getenv("MIB_KIT_DIR", "../../packages/kit/components"),
		PublicURL:          os.Getenv("MIB_PUBLIC_URL"),
		MasterKey:          os.Getenv("MIB_MASTER_KEY"),
		GitHubClientID:     os.Getenv("MIB_GITHUB_CLIENT_ID"),
		GitHubClientSecret: os.Getenv("MIB_GITHUB_CLIENT_SECRET"),
		GitHubURL:          getenv("MIB_GITHUB_URL", "https://github.com"),
		GitHubAPIURL:       getenv("MIB_GITHUB_API_URL", "https://api.github.com"),
	}
	// The public-URL default is dev-only on purpose: production must state
	// its origin explicitly (Validate), never inherit a localhost default.
	if cfg.PublicURL == "" && cfg.Dev() {
		cfg.PublicURL = "http://localhost:5173"
	}
	return cfg
}

// Dev reports whether the process runs in the dev environment. Dev gates the
// preview endpoint, the implicit session user, seeds, and permissive CORS.
func (c Config) Dev() bool { return c.Env == "dev" }

// Production reports whether the process runs with production semantics
// (architecture.md §4): no dev seed, no implicit user, Secure cookies, CORS
// locked to PublicURL, and the Validate boot requirements.
func (c Config) Production() bool { return c.Env == "production" }

// Validate enforces the production boot requirements (architecture.md §4/§8):
// MIB_ENV=production requires configured GitHub auth, the public URL, and the
// credential-sealing master key. Anything else refuses to boot rather than
// running production with an implicit user or unsealed credentials.
func (c Config) Validate() error {
	if !c.Production() {
		return nil
	}
	var missing []string
	for _, v := range []struct{ name, value string }{
		{"MIB_GITHUB_CLIENT_ID", c.GitHubClientID},
		{"MIB_GITHUB_CLIENT_SECRET", c.GitHubClientSecret},
		{"MIB_PUBLIC_URL", c.PublicURL},
		{"MIB_MASTER_KEY", c.MasterKey},
	} {
		if v.value == "" {
			missing = append(missing, v.name)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("MIB_ENV=production requires %s to be set", strings.Join(missing, ", "))
	}
	return nil
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

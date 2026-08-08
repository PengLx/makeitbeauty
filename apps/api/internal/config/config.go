// Package config loads API configuration from environment variables.
// Every knob has a dev-friendly default so `make dev-api` works with zero setup.
package config

import "os"

// Config is the resolved runtime configuration of the API process.
type Config struct {
	// Addr is the listen address of the public API (MIB_ADDR).
	Addr string
	// RendererURL is the base URL of the internal renderer service (MIB_RENDERER_URL).
	RendererURL string
	// Env is the deployment environment, e.g. "dev" or "prod" (MIB_ENV).
	Env string
	// DemoDataPath points at the demo connector-data fixture (MIB_DEMO_DATA).
	// Relative paths are resolved robustly; see internal/fixture.
	DemoDataPath string
	// DemoDesignPath points at the demo design fixture (MIB_DEMO_DESIGN).
	DemoDesignPath string
	// KitDir points at the official kit component directory (MIB_KIT_DIR).
	// Relative paths are resolved robustly; see internal/kit.
	KitDir string
}

// Load reads configuration from the environment, applying defaults.
func Load() Config {
	return Config{
		Addr:           getenv("MIB_ADDR", ":7800"),
		RendererURL:    getenv("MIB_RENDERER_URL", "http://localhost:7801"),
		Env:            getenv("MIB_ENV", "dev"),
		DemoDataPath:   getenv("MIB_DEMO_DATA", "../../examples/demo-data.json"),
		DemoDesignPath: getenv("MIB_DEMO_DESIGN", "../../examples/demo-design.json"),
		KitDir:         getenv("MIB_KIT_DIR", "../../packages/kit/components"),
	}
}

// Dev reports whether the process runs in the dev environment. Dev gates the
// preview endpoint, the implicit session user, seeds, and permissive CORS.
func (c Config) Dev() bool { return c.Env == "dev" }

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

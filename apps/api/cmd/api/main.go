// Command api runs the MakeItBeauty public API (architecture.md §4, :7800).
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/config"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/connector"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/fixture"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/httpapi"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/kit"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/render"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(log); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg := config.Load()
	stores, err := newStores(cfg, log)
	if err != nil {
		return err
	}

	// Connector registry: the GitHub stub serves the demo fixture; the cache
	// and filtering around it are the production code paths.
	registry := connector.NewRegistry()
	github, err := connector.NewGitHubStub(cfg.DemoDataPath)
	if err != nil {
		return err
	}
	registry.Register(github)
	cache := connector.NewSnapshotCache(registry, log)

	renderer := render.NewClient(cfg.RendererURL, 15*time.Second)

	// Kit registry: palette metadata for GET /v1/kit, loaded once at startup.
	kitComponents, err := kit.Load(cfg.KitDir, log)
	if err != nil {
		return err
	}
	log.Info("kit loaded", "components", len(kitComponents))

	var demoData map[string]any // preview fallback, dev only
	if cfg.Dev() {
		if err := fixture.LoadJSON(cfg.DemoDataPath, &demoData); err != nil {
			return err
		}
		if err := seedDev(context.Background(), stores, cfg.DemoDesignPath); err != nil {
			return err
		}
		log.Info("dev seed ensured", "project", "demo", "token", "dev-demo-token")
	}

	server := httpapi.NewServer(cfg, log, stores, cache, renderer, demoData, kitComponents)
	httpServer := &http.Server{
		Addr:              cfg.Addr,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	// Graceful shutdown on SIGINT/SIGTERM.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		log.Info("api listening", "addr", cfg.Addr, "env", cfg.Env, "renderer", cfg.RendererURL)
		errCh <- httpServer.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil && !errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		return nil
	}
}

// newStores selects the persistence backend per MIB_STORE (architecture.md
// §7): the durable file-backed JSON store by default, in-memory on request.
func newStores(cfg config.Config, log *slog.Logger) (store.Stores, error) {
	switch cfg.Store {
	case "file":
		log.Info("using file store", "dir", cfg.DataDir)
		return store.NewFile(cfg.DataDir)
	case "memory":
		log.Info("using in-memory store (data is lost on exit)")
		return store.NewMemory(), nil
	default:
		return store.Stores{}, fmt.Errorf("unknown MIB_STORE %q (want \"file\" or \"memory\")", cfg.Store)
	}
}

// seedDev ensures the out-of-the-box dev fixtures exist (architecture.md §8):
// user "dev", project "demo" from examples/demo-design.json, and deploy token
// "dev-demo-token" (stored as its SHA-256 hash), so this works immediately:
//
//	curl -X POST -H "Authorization: Bearer dev-demo-token" \
//	  http://localhost:7800/v1/projects/demo/render
//
// The seed is idempotent: each fixture is created only if absent, so restarts
// against the durable file store never overwrite user edits to the demo
// project or invalidate extra tokens the user created.
func seedDev(ctx context.Context, stores store.Stores, designPath string) error {
	now := time.Now().UTC()

	if _, err := stores.Users.Get(ctx, "dev"); errors.Is(err, store.ErrNotFound) {
		if err := stores.Users.Create(ctx, &store.User{
			ID: "dev", Login: "dev", DisplayName: "Dev User", CreatedAt: now,
		}); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}

	if _, err := stores.ConnectorAccounts.GetByUserConnector(ctx, "dev", "github"); errors.Is(err, store.ErrNotFound) {
		if err := stores.ConnectorAccounts.Create(ctx, &store.ConnectorAccount{
			ID: "acct-dev-github", UserID: "dev", Connector: "github", Status: "active", LastRefreshAt: now,
		}); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}

	if _, err := stores.Projects.Get(ctx, "demo"); errors.Is(err, store.ErrNotFound) {
		design, err := fixture.Read(designPath)
		if err != nil {
			return err
		}
		if err := stores.Projects.Create(ctx, &store.Project{
			ID:     "demo",
			UserID: "dev",
			Name:   "Demo profile card",
			Design: design,
			Bindings: []store.Binding{{
				Connector: "github",
				AccountID: "acct-dev-github",
				Fields: []string{
					"user.name", "user.login", "user.followers",
					"stats.totalStars", "stats.topLanguage",
				},
			}},
			Outputs:   []store.Output{{ID: "default", Filename: "card.svg"}},
			CreatedAt: now,
			UpdatedAt: now,
		}); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}

	// The seeded token stays valid across restarts; if the user revoked it,
	// its id is still present, so it is not resurrected.
	existing, err := stores.DeployTokens.ListByProject(ctx, "demo")
	if err != nil {
		return err
	}
	for _, t := range existing {
		if t.ID == "tok-dev-demo" {
			return nil
		}
	}
	return stores.DeployTokens.Create(ctx, &store.DeployToken{
		ID:        "tok-dev-demo",
		ProjectID: "demo",
		Hash:      store.HashToken("dev-demo-token"),
		CreatedAt: now,
	})
}

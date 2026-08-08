package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// The design fixture is resolved by internal/fixture walking working-directory
// ancestors, so the bare basename works from this package's test CWD.
const testDesignPath = "demo-design.json"

func TestSeedDevIdempotent(t *testing.T) {
	ctx := context.Background()
	stores := store.NewMemory()

	if err := seedDev(ctx, stores, testDesignPath); err != nil {
		t.Fatal(err)
	}

	// User edits the demo project between restarts.
	project, err := stores.Projects.Get(ctx, "demo")
	if err != nil {
		t.Fatal(err)
	}
	project.Name = "My edited card"
	project.Design = json.RawMessage(`{"version":0,"canvas":{"width":1,"height":1},"nodes":[]}`)
	project.UpdatedAt = project.UpdatedAt.Add(time.Hour)
	if err := stores.Projects.Update(ctx, project); err != nil {
		t.Fatal(err)
	}

	// Restart: the seed runs again and must not clobber anything.
	if err := seedDev(ctx, stores, testDesignPath); err != nil {
		t.Fatal(err)
	}

	after, err := stores.Projects.Get(ctx, "demo")
	if err != nil {
		t.Fatal(err)
	}
	if after.Name != "My edited card" {
		t.Errorf("re-seed overwrote the project name: %q", after.Name)
	}
	if string(after.Design) != string(project.Design) {
		t.Error("re-seed overwrote the edited design")
	}

	tokens, err := stores.DeployTokens.ListByProject(ctx, "demo")
	if err != nil {
		t.Fatal(err)
	}
	if len(tokens) != 1 {
		t.Errorf("re-seed duplicated the demo token: %d tokens", len(tokens))
	}
}

// A revoked demo token must stay revoked across restarts — the seed checks
// for the token id, not for an active token.
func TestSeedDevDoesNotResurrectRevokedToken(t *testing.T) {
	ctx := context.Background()
	stores := store.NewMemory()

	if err := seedDev(ctx, stores, testDesignPath); err != nil {
		t.Fatal(err)
	}
	if err := stores.DeployTokens.Revoke(ctx, "demo", "tok-dev-demo", time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := seedDev(ctx, stores, testDesignPath); err != nil {
		t.Fatal(err)
	}

	tokens, err := stores.DeployTokens.ListByProject(ctx, "demo")
	if err != nil {
		t.Fatal(err)
	}
	if len(tokens) != 1 {
		t.Fatalf("seed created a second demo token: %d tokens", len(tokens))
	}
	if tokens[0].RevokedAt == nil {
		t.Error("seed resurrected the revoked demo token")
	}
}

// The seed works identically against the file store and survives a restart
// (load-on-boot + idempotent re-seed).
func TestSeedDevOnFileStore(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()

	stores, err := store.NewFile(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := seedDev(ctx, stores, testDesignPath); err != nil {
		t.Fatal(err)
	}

	reloaded, err := store.NewFile(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := seedDev(ctx, reloaded, testDesignPath); err != nil {
		t.Fatal(err)
	}
	if _, err := reloaded.Projects.Get(ctx, "demo"); err != nil {
		t.Fatalf("demo project missing after restart: %v", err)
	}
	tokens, err := reloaded.DeployTokens.ListByProject(ctx, "demo")
	if err != nil || len(tokens) != 1 {
		t.Fatalf("demo tokens after restart = %v, %v (want exactly one)", tokens, err)
	}
	if tokens[0].Hash != store.HashToken("dev-demo-token") {
		t.Error("dev-demo-token is no longer valid after restart")
	}
}

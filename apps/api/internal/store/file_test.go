package store

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// newFileStores opens a file store in a fresh temp dir and returns both.
func newFileStores(t *testing.T) (Stores, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "data")
	stores, err := NewFile(dir)
	if err != nil {
		t.Fatal(err)
	}
	return stores, dir
}

// compactJSON canonicalizes whitespace for semantic JSON comparison.
func compactJSON(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var buf strings.Builder
	dec := json.NewEncoder(&buf)
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if err := dec.Encode(v); err != nil {
		t.Fatal(err)
	}
	return buf.String()
}

// reopen simulates a process restart: a second NewFile over the same dir.
func reopen(t *testing.T, dir string) Stores {
	t.Helper()
	stores, err := NewFile(dir)
	if err != nil {
		t.Fatalf("reopening store: %v", err)
	}
	return stores
}

func TestFileStoreRoundTrip(t *testing.T) {
	ctx := context.Background()
	stores, dir := newFileStores(t)
	now := time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC)

	if err := stores.Users.Create(ctx, &User{ID: "u1", Login: "alice", DisplayName: "Alice", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	project := &Project{
		ID: "card", UserID: "u1", Name: "My card",
		Design:    json.RawMessage(`{"version":0,"canvas":{"width":10,"height":10},"nodes":[]}`),
		Bindings:  []Binding{{Connector: "github", Fields: []string{"user.login"}}},
		Outputs:   []Output{{ID: "default", Filename: "card.svg"}},
		CreatedAt: now, UpdatedAt: now,
	}
	if err := stores.Projects.Create(ctx, project); err != nil {
		t.Fatal(err)
	}
	if err := stores.DeployTokens.Create(ctx, &DeployToken{
		ID: "tok-1", ProjectID: "card", Hash: HashToken("secret"), CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := stores.ConnectorAccounts.Create(ctx, &ConnectorAccount{
		ID: "acct-1", UserID: "u1", Connector: "github", Status: "active", LastRefreshAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	// Everything survives a restart, byte for byte.
	reloaded := reopen(t, dir)

	u, err := reloaded.Users.Get(ctx, "u1")
	if err != nil || u.Login != "alice" || !u.CreatedAt.Equal(now) {
		t.Fatalf("reloaded user = %+v, %v", u, err)
	}
	p, err := reloaded.Projects.Get(ctx, "card")
	if err != nil {
		t.Fatal(err)
	}
	if p.UserID != "u1" {
		t.Errorf("reloaded project lost its owner: userID = %q", p.UserID)
	}
	// The store pretty-prints its files, so the design round-trips
	// semantically (same JSON), not byte-identically.
	if compactJSON(t, p.Design) != compactJSON(t, project.Design) {
		t.Errorf("design round-trip mismatch: %s", p.Design)
	}
	if len(p.Bindings) != 1 || p.Bindings[0].Connector != "github" || len(p.Outputs) != 1 {
		t.Errorf("bindings/outputs round-trip mismatch: %+v", p)
	}
	tokens, err := reloaded.DeployTokens.ListByProject(ctx, "card")
	if err != nil || len(tokens) != 1 {
		t.Fatalf("reloaded tokens = %v, %v", tokens, err)
	}
	if tokens[0].Hash != HashToken("secret") {
		t.Error("token hash did not survive the round trip")
	}
	if tokens[0].RevokedAt != nil {
		t.Error("token unexpectedly revoked after reload")
	}
	a, err := reloaded.ConnectorAccounts.GetByUserConnector(ctx, "u1", "github")
	if err != nil || a.ID != "acct-1" {
		t.Fatalf("reloaded account = %+v, %v", a, err)
	}
}

func TestFileStoreUpdateDeleteRevokePersist(t *testing.T) {
	ctx := context.Background()
	stores, dir := newFileStores(t)
	now := time.Now().UTC().Truncate(time.Second)

	seedProject := func(id string) {
		t.Helper()
		if err := stores.Projects.Create(ctx, &Project{
			ID: id, UserID: "u1", Name: "n", Design: json.RawMessage(`{}`),
			Outputs: []Output{{ID: "default", Filename: "card.svg"}}, CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			t.Fatal(err)
		}
	}
	seedProject("keep")
	seedProject("drop")
	if err := stores.DeployTokens.Create(ctx, &DeployToken{ID: "tok-1", ProjectID: "keep", Hash: HashToken("x"), CreatedAt: now}); err != nil {
		t.Fatal(err)
	}

	// Update
	updated := &Project{
		ID: "keep", UserID: "u1", Name: "renamed", Design: json.RawMessage(`{"v":1}`),
		Outputs: []Output{{ID: "default", Filename: "card.svg"}}, CreatedAt: now, UpdatedAt: now.Add(time.Hour),
	}
	if err := stores.Projects.Update(ctx, updated); err != nil {
		t.Fatal(err)
	}
	if err := stores.Projects.Update(ctx, &Project{ID: "ghost"}); err != ErrNotFound {
		t.Errorf("Update(ghost) = %v, want ErrNotFound", err)
	}

	// Delete
	if err := stores.Projects.Delete(ctx, "drop"); err != nil {
		t.Fatal(err)
	}
	if err := stores.Projects.Delete(ctx, "drop"); err != ErrNotFound {
		t.Errorf("second Delete = %v, want ErrNotFound", err)
	}

	// Revoke
	revokeAt := now.Add(2 * time.Hour)
	if err := stores.DeployTokens.Revoke(ctx, "keep", "tok-1", revokeAt); err != nil {
		t.Fatal(err)
	}
	if err := stores.DeployTokens.Revoke(ctx, "keep", "tok-1", revokeAt.Add(time.Hour)); err != nil {
		t.Errorf("re-revoking = %v, want nil (idempotent)", err)
	}
	if err := stores.DeployTokens.Revoke(ctx, "keep", "ghost", revokeAt); err != ErrNotFound {
		t.Errorf("Revoke(ghost) = %v, want ErrNotFound", err)
	}

	reloaded := reopen(t, dir)
	p, err := reloaded.Projects.Get(ctx, "keep")
	if err != nil || p.Name != "renamed" || !p.UpdatedAt.Equal(now.Add(time.Hour)) {
		t.Fatalf("updated project after reload = %+v, %v", p, err)
	}
	if _, err := reloaded.Projects.Get(ctx, "drop"); err != ErrNotFound {
		t.Errorf("deleted project after reload: err = %v, want ErrNotFound", err)
	}
	tokens, err := reloaded.DeployTokens.ListByProject(ctx, "keep")
	if err != nil || len(tokens) != 1 {
		t.Fatal(err)
	}
	if tokens[0].RevokedAt == nil || !tokens[0].RevokedAt.Equal(revokeAt) {
		t.Errorf("revokedAt after reload = %v, want %v (original revocation time)", tokens[0].RevokedAt, revokeAt)
	}
}

// TestFileStoreAtomicity: after every mutation the on-disk collection is a
// complete, valid JSON document with no temp-file debris — the write is
// temp + rename, never an in-place truncate.
func TestFileStoreAtomicity(t *testing.T) {
	ctx := context.Background()
	stores, dir := newFileStores(t)

	for i := range 5 {
		if err := stores.Projects.Create(ctx, &Project{
			ID: "p-" + string(rune('a'+i)), UserID: "u1", Name: "n",
			Design:  json.RawMessage(`{}`),
			Outputs: []Output{{ID: "default", Filename: "card.svg"}},
		}); err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(filepath.Join(dir, "projects.json"))
		if err != nil {
			t.Fatal(err)
		}
		var parsed []map[string]any
		if err := json.Unmarshal(b, &parsed); err != nil {
			t.Fatalf("projects.json is not valid JSON after write %d: %v", i, err)
		}
		if len(parsed) != i+1 {
			t.Fatalf("projects.json has %d entries after write %d", len(parsed), i)
		}
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp") {
			t.Errorf("temp-file debris left behind: %s", e.Name())
		}
	}
}

// The data dir is created on demand with owner-only permissions and the
// hash on disk is hex of SHA-256, never plaintext.
func TestFileStoreDirAndHashHygiene(t *testing.T) {
	ctx := context.Background()
	stores, dir := newFileStores(t)

	info, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o700 {
		t.Errorf("data dir permissions = %o, want 700", perm)
	}

	if err := stores.DeployTokens.Create(ctx, &DeployToken{
		ID: "tok-1", ProjectID: "p", Hash: HashToken("mib_super-secret"), CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "deploy_tokens.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "super-secret") {
		t.Error("deploy_tokens.json contains the plaintext token")
	}
}

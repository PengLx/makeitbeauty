package connector

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/auth"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/crypto"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// The fixture path resolves via internal/fixture ancestor walking, like
// cmd/api/main_test.go.
const testFixturePath = "demo-data.json"

// fakeGitHub mocks the two endpoints the connector touches: POST /graphql
// (valid bearer token required) and POST /login/oauth/access_token (refresh
// grant). Behavior is scripted through its fields.
type fakeGitHub struct {
	t *testing.T

	mu           sync.Mutex
	validToken   string // graphql accepts only this bearer token
	refreshOK    bool   // refresh grant succeeds, issuing validToken
	graphqlCalls int
	refreshCalls int
	lastRefresh  string // refresh_token form value of the last refresh call
}

func (f *fakeGitHub) server() *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /graphql", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.graphqlCalls++
		valid := "Bearer "+f.validToken == r.Header.Get("Authorization")
		f.mu.Unlock()
		if !valid {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data": {"viewer": {
			"name": "Grace Hopper",
			"login": "grace",
			"avatarUrl": "https://avatars.example/1",
			"followers": {"totalCount": 42},
			"contributionsCollection": {"contributionCalendar": {"totalContributions": 1234}},
			"repositories": {"nodes": [
				{"stargazerCount": 10, "primaryLanguage": {"name": "Go"}},
				{"stargazerCount": 3, "primaryLanguage": {"name": "TypeScript"}},
				{"stargazerCount": 0, "primaryLanguage": {"name": "TypeScript"}},
				{"stargazerCount": 5, "primaryLanguage": null}
			]}
		}}}`))
	})
	mux.HandleFunc("POST /login/oauth/access_token", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			f.t.Fatal(err)
		}
		if got := r.PostForm.Get("grant_type"); got != "refresh_token" {
			f.t.Errorf("refresh grant_type = %q, want refresh_token", got)
		}
		f.mu.Lock()
		f.refreshCalls++
		f.lastRefresh = r.PostForm.Get("refresh_token")
		ok := f.refreshOK
		valid := f.validToken
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if !ok {
			_, _ = w.Write([]byte(`{"error": "bad_refresh_token", "error_description": "expired"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": valid, "expires_in": 28800,
			"refresh_token": "ghr_rotated", "refresh_token_expires_in": 15897600,
		})
	})
	return httptest.NewServer(mux)
}

// newTestGitHub wires a connector against the fake, with an account seeded
// with sealed creds.
func newTestGitHub(t *testing.T, fake *fakeGitHub, creds auth.Credentials) (*GitHub, *store.ConnectorAccount, store.ConnectorAccounts) {
	t.Helper()
	srv := fake.server()
	t.Cleanup(srv.Close)

	sealer := crypto.PlainSealer{}
	stores := store.NewMemory()

	raw, err := json.Marshal(creds)
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := sealer.Seal(raw)
	if err != nil {
		t.Fatal(err)
	}
	account := &store.ConnectorAccount{
		ID: "acct-1", UserID: "u1", Connector: "github",
		EncryptedCredentials: sealed, Status: "active", LastRefreshAt: time.Now(),
	}
	if err := stores.ConnectorAccounts.Create(context.Background(), account); err != nil {
		t.Fatal(err)
	}

	g, err := NewGitHub(testFixturePath, GitHubDeps{
		APIBaseURL: srv.URL,
		OAuth:      auth.NewGitHubOAuth(srv.URL, srv.URL, "cid", "csecret"),
		Sealer:     sealer,
		Accounts:   stores.ConnectorAccounts,
	})
	if err != nil {
		t.Fatal(err)
	}
	return g, account, stores.ConnectorAccounts
}

// lookupPath resolves a dot path in a snapshot for assertions.
func lookupPath(t *testing.T, snapshot map[string]any, path ...string) any {
	t.Helper()
	var cur any = snapshot
	for _, p := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			t.Fatalf("path %v: %T is not a map", path, cur)
		}
		if cur, ok = m[p]; !ok {
			t.Fatalf("path %v: key %q missing", path, p)
		}
	}
	return cur
}

// No credentials (dev, not logged in): the fixture is served unchanged, on
// the exact paths existing projects bind.
func TestGitHubFetchWithoutCredentialsServesFixture(t *testing.T) {
	g, err := NewGitHub(testFixturePath, GitHubDeps{})
	if err != nil {
		t.Fatal(err)
	}
	for name, account := range map[string]*store.ConnectorAccount{
		"nil account":           nil,
		"account without creds": {ID: "acct-dev-github", UserID: "dev", Connector: "github", Status: "active"},
	} {
		t.Run(name, func(t *testing.T) {
			snap, err := g.Fetch(context.Background(), account)
			if err != nil {
				t.Fatal(err)
			}
			if got := lookupPath(t, snap, "user", "login"); got != "ada" {
				t.Errorf("user.login = %v, want the fixture value", got)
			}
			if got := lookupPath(t, snap, "stats", "topLanguage"); got != "TypeScript" {
				t.Errorf("stats.topLanguage = %v, want the fixture value", got)
			}
		})
	}
}

func TestGitHubFetchLiveSnapshot(t *testing.T) {
	fake := &fakeGitHub{t: t, validToken: "ghu_live"}
	g, account, _ := newTestGitHub(t, fake, auth.Credentials{
		AccessToken: "ghu_live", AccessExpiry: time.Now().Add(time.Hour), RefreshToken: "ghr_1",
	})

	snap, err := g.Fetch(context.Background(), account)
	if err != nil {
		t.Fatal(err)
	}

	// The contractual fixture paths, now live.
	if got := lookupPath(t, snap, "user", "name"); got != "Grace Hopper" {
		t.Errorf("user.name = %v", got)
	}
	if got := lookupPath(t, snap, "user", "login"); got != "grace" {
		t.Errorf("user.login = %v", got)
	}
	if got := lookupPath(t, snap, "user", "followers"); got != 42 {
		t.Errorf("user.followers = %v", got)
	}
	if got := lookupPath(t, snap, "stats", "totalStars"); got != 18 {
		t.Errorf("stats.totalStars = %v, want 10+3+0+5", got)
	}
	// Star-weighted: Go 10+1 beats TypeScript (3+1)+(0+1).
	if got := lookupPath(t, snap, "stats", "topLanguage"); got != "Go" {
		t.Errorf("stats.topLanguage = %v, want Go", got)
	}
	// Additive fields.
	if got := lookupPath(t, snap, "user", "avatarUrl"); got != "https://avatars.example/1" {
		t.Errorf("user.avatarUrl = %v", got)
	}
	if got := lookupPath(t, snap, "stats", "totalContributions"); got != 1234 {
		t.Errorf("stats.totalContributions = %v", got)
	}
	if fake.refreshCalls != 0 {
		t.Errorf("refresh called %d times for a fresh token", fake.refreshCalls)
	}
	// Every advertised picker field resolves in the snapshot.
	for _, f := range GitHubFields {
		if got := Filter(snap, []string{f.Path}); len(got) == 0 {
			t.Errorf("GitHubFields path %q missing from the live snapshot", f.Path)
		}
	}
}

// A known-expired access token is refreshed before querying, and the new
// credentials are resealed and persisted.
func TestGitHubProactiveRefreshPersistsCredentials(t *testing.T) {
	fake := &fakeGitHub{t: t, validToken: "ghu_new", refreshOK: true}
	g, account, accounts := newTestGitHub(t, fake, auth.Credentials{
		AccessToken: "ghu_expired", AccessExpiry: time.Now().Add(-time.Minute), RefreshToken: "ghr_old",
	})

	snap, err := g.Fetch(context.Background(), account)
	if err != nil {
		t.Fatal(err)
	}
	if got := lookupPath(t, snap, "user", "login"); got != "grace" {
		t.Errorf("user.login = %v", got)
	}
	if fake.refreshCalls != 1 || fake.lastRefresh != "ghr_old" {
		t.Errorf("refresh calls = %d with token %q, want 1 with ghr_old", fake.refreshCalls, fake.lastRefresh)
	}
	if fake.graphqlCalls != 1 {
		t.Errorf("graphql calls = %d, want exactly 1 (refresh happens before the query)", fake.graphqlCalls)
	}

	// The stored account carries the resealed rotated credentials.
	stored, err := accounts.GetByUserConnector(context.Background(), "u1", "github")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := crypto.PlainSealer{}.Open(stored.EncryptedCredentials)
	if err != nil {
		t.Fatalf("stored credentials are not sealed: %v", err)
	}
	var creds auth.Credentials
	if err := json.Unmarshal(raw, &creds); err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "ghu_new" || creds.RefreshToken != "ghr_rotated" {
		t.Errorf("persisted creds = %+v, want the refreshed pair", creds)
	}
	if creds.AccessExpiry.IsZero() || creds.RefreshExpiry.IsZero() {
		t.Errorf("persisted expiries missing: %+v", creds)
	}
	if stored.Status != "active" {
		t.Errorf("account status = %q, want active", stored.Status)
	}
}

// A 401 mid-flight (revoked or expired underneath us) triggers exactly one
// refresh + retry.
func TestGitHubRetriesOnceAfter401(t *testing.T) {
	fake := &fakeGitHub{t: t, validToken: "ghu_new", refreshOK: true}
	g, account, _ := newTestGitHub(t, fake, auth.Credentials{
		AccessToken: "ghu_revoked", RefreshToken: "ghr_old", // no expiry: looks fresh
	})

	snap, err := g.Fetch(context.Background(), account)
	if err != nil {
		t.Fatal(err)
	}
	if got := lookupPath(t, snap, "user", "login"); got != "grace" {
		t.Errorf("user.login = %v", got)
	}
	if fake.graphqlCalls != 2 {
		t.Errorf("graphql calls = %d, want 2 (401 then retry)", fake.graphqlCalls)
	}
	if fake.refreshCalls != 1 {
		t.Errorf("refresh calls = %d, want 1", fake.refreshCalls)
	}
}

// Refresh failure marks the account "expired" and errors the fetch — the
// SnapshotCache turns that into a stale-serve (next test).
func TestGitHubRefreshFailureMarksAccountExpired(t *testing.T) {
	fake := &fakeGitHub{t: t, validToken: "ghu_other", refreshOK: false}
	g, account, accounts := newTestGitHub(t, fake, auth.Credentials{
		AccessToken: "ghu_expired", AccessExpiry: time.Now().Add(-time.Minute), RefreshToken: "ghr_dead",
	})

	if _, err := g.Fetch(context.Background(), account); err == nil {
		t.Fatal("Fetch succeeded with a dead refresh token")
	}
	stored, err := accounts.GetByUserConnector(context.Background(), "u1", "github")
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != "expired" {
		t.Errorf("account status = %q, want expired", stored.Status)
	}
}

// End to end with the cache: once a snapshot exists, an expired token with a
// failing refresh serves the stale snapshot instead of failing the render.
func TestGitHubExpiredTokenServesStaleThroughCache(t *testing.T) {
	fake := &fakeGitHub{t: t, validToken: "ghu_live", refreshOK: false}
	g, account, accounts := newTestGitHub(t, fake, auth.Credentials{
		AccessToken: "ghu_live", AccessExpiry: time.Now().Add(30 * time.Minute), RefreshToken: "ghr_1",
	})
	registry := NewRegistry()
	registry.Register(g)
	cache := NewSnapshotCache(registry, slog.New(slog.DiscardHandler))

	base := time.Now()
	cache.now = func() time.Time { return base }

	// Warm the cache while the token works.
	warm, err := cache.Snapshot(context.Background(), "u1", "github", account)
	if err != nil {
		t.Fatal(err)
	}
	if got := lookupPath(t, warm, "user", "login"); got != "grace" {
		t.Fatalf("warm snapshot login = %v", got)
	}

	// The token dies upstream, the cache entry goes stale, the access token
	// expires: a render must still get the stale snapshot, immediately.
	fake.mu.Lock()
	fake.validToken = "ghu_rotated_elsewhere"
	fake.mu.Unlock()
	g.now = func() time.Time { return base.Add(time.Hour) } // access token now expired
	cache.now = func() time.Time { return base.Add(time.Hour) }

	stale, err := cache.Snapshot(context.Background(), "u1", "github", account)
	if err != nil {
		t.Fatalf("stale render failed: %v", err)
	}
	if got := lookupPath(t, stale, "user", "login"); got != "grace" {
		t.Errorf("stale snapshot login = %v, want the cached value", got)
	}

	// The background revalidation fails and flips the account to "expired".
	deadline := time.Now().Add(2 * time.Second)
	for {
		stored, err := accounts.GetByUserConnector(context.Background(), "u1", "github")
		if err != nil {
			t.Fatal(err)
		}
		if stored.Status == "expired" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("background revalidation never marked the account expired")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// Full lifecycle per architecture.md §8: create → plaintext authenticates
// the render path → revoke → render path answers 401.
func TestDeployTokenLifecycle(t *testing.T) {
	s, h := newTestServer(t)
	ctx := context.Background()
	seedProject(t, s, "p1")

	// A guarded render-path probe (the real handler needs a renderer; the
	// middleware under test is the same).
	guarded := http.NewServeMux()
	guarded.HandleFunc("POST /v1/projects/{id}/render", s.requireDeployToken(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	render := func(token string) int {
		r := httptest.NewRequest(http.MethodPost, "/v1/projects/p1/render", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		guarded.ServeHTTP(rec, r)
		return rec.Code
	}

	// Create: plaintext appears once, in the expected format.
	rec := doJSON(t, h, http.MethodPost, "/v1/projects/p1/tokens", "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var created struct {
		ID        string    `json:"id"`
		Token     string    `json:"token"`
		CreatedAt time.Time `json:"createdAt"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.ID == "" || created.CreatedAt.IsZero() {
		t.Fatalf("create response incomplete: %s", rec.Body.String())
	}
	if !strings.HasPrefix(created.Token, "mib_") {
		t.Errorf("token %q lacks the mib_ prefix", created.Token)
	}
	if got := len(created.Token); got != len("mib_")+43 { // base64url of 32 bytes, unpadded
		t.Errorf("token length = %d, want %d", got, len("mib_")+43)
	}

	// Only the hash is stored.
	stored, err := s.stores.DeployTokens.ListByProject(ctx, "p1")
	if err != nil || len(stored) != 1 {
		t.Fatalf("stored tokens = %v, %v", stored, err)
	}
	if stored[0].Hash != store.HashToken(created.Token) {
		t.Error("stored hash does not match sha256 of the plaintext")
	}

	// The plaintext authenticates the render path.
	if code := render(created.Token); code != http.StatusOK {
		t.Fatalf("render with fresh token = %d, want 200", code)
	}

	// The list is masked: id + createdAt, no hash, no plaintext, no revokedAt yet.
	rec = doJSON(t, h, http.MethodGet, "/v1/projects/p1/tokens", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d", rec.Code)
	}
	if body := rec.Body.String(); strings.Contains(body, created.Token) || strings.Contains(body, "hash") {
		t.Errorf("token list leaks secrets: %s", body)
	}
	var list struct {
		Tokens []struct {
			ID        string     `json:"id"`
			CreatedAt time.Time  `json:"createdAt"`
			RevokedAt *time.Time `json:"revokedAt"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Tokens) != 1 || list.Tokens[0].ID != created.ID || list.Tokens[0].RevokedAt != nil {
		t.Fatalf("token list = %+v", list.Tokens)
	}

	// Revoke.
	rec = doJSON(t, h, http.MethodDelete, "/v1/projects/p1/tokens/"+created.ID, "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("revoke status = %d, body = %s", rec.Code, rec.Body.String())
	}

	// The render path now rejects the token.
	if code := render(created.Token); code != http.StatusUnauthorized {
		t.Fatalf("render with revoked token = %d, want 401", code)
	}

	// The list shows revokedAt.
	rec = doJSON(t, h, http.MethodGet, "/v1/projects/p1/tokens", "")
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Tokens) != 1 || list.Tokens[0].RevokedAt == nil {
		t.Fatalf("revokedAt missing from list: %s", rec.Body.String())
	}

	// Revoking an unknown token id: 404.
	rec = doJSON(t, h, http.MethodDelete, "/v1/projects/p1/tokens/tok-ghost", "")
	if rec.Code != http.StatusNotFound {
		t.Errorf("revoke unknown token status = %d, want 404", rec.Code)
	}
}

// Token routes 404 on unknown projects (and, later, on other users' projects).
func TestTokenRoutesRequireOwnedProject(t *testing.T) {
	_, h := newTestServer(t)
	for _, req := range [][2]string{
		{http.MethodPost, "/v1/projects/ghost/tokens"},
		{http.MethodGet, "/v1/projects/ghost/tokens"},
		{http.MethodDelete, "/v1/projects/ghost/tokens/tok-1"},
	} {
		rec := doJSON(t, h, req[0], req[1], "")
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s %s = %d, want 404", req[0], req[1], rec.Code)
		}
	}
}

// Two tokens for one project are independent: revoking one leaves the other
// working (the §8 rotation story).
func TestDeployTokenRotation(t *testing.T) {
	s, h := newTestServer(t)
	seedProject(t, s, "p1")

	create := func() (id, token string) {
		rec := doJSON(t, h, http.MethodPost, "/v1/projects/p1/tokens", "")
		if rec.Code != http.StatusCreated {
			t.Fatalf("create status = %d", rec.Code)
		}
		var c struct{ ID, Token string }
		if err := json.Unmarshal(rec.Body.Bytes(), &c); err != nil {
			t.Fatal(err)
		}
		return c.ID, c.Token
	}
	oldID, oldToken := create()
	_, newToken := create()

	if rec := doJSON(t, h, http.MethodDelete, "/v1/projects/p1/tokens/"+oldID, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("revoke status = %d", rec.Code)
	}

	ctx := context.Background()
	if err := authenticateDeployToken(ctx, s.stores.DeployTokens, "p1", "Bearer "+oldToken); err == nil {
		t.Error("revoked token still authenticates")
	}
	if err := authenticateDeployToken(ctx, s.stores.DeployTokens, "p1", "Bearer "+newToken); err != nil {
		t.Errorf("fresh token rejected after rotating the old one: %v", err)
	}
}

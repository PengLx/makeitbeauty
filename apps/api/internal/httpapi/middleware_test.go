package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// newTokenFixtures seeds an in-memory token store with:
//   - an active token "dev-demo-token" for project "demo"
//   - a revoked token "revoked-token" for project "demo"
//   - an active token "other-token" for project "other"
func newTokenFixtures(t *testing.T) store.Stores {
	t.Helper()
	stores := store.NewMemory()
	ctx := context.Background()
	now := time.Now()
	revokedAt := now

	seed := []*store.DeployToken{
		{ID: "t1", ProjectID: "demo", Hash: store.HashToken("dev-demo-token"), CreatedAt: now},
		{ID: "t2", ProjectID: "demo", Hash: store.HashToken("revoked-token"), CreatedAt: now, RevokedAt: &revokedAt},
		{ID: "t3", ProjectID: "other", Hash: store.HashToken("other-token"), CreatedAt: now},
	}
	for _, tok := range seed {
		if err := stores.DeployTokens.Create(ctx, tok); err != nil {
			t.Fatal(err)
		}
	}
	return stores
}

func TestAuthenticateDeployToken(t *testing.T) {
	stores := newTokenFixtures(t)

	tests := []struct {
		name      string
		projectID string
		header    string
		wantErr   error // nil == authenticated
	}{
		{"valid token", "demo", "Bearer dev-demo-token", nil},
		{"scheme is case-insensitive", "demo", "bearer dev-demo-token", nil},
		{"missing header", "demo", "", errNoToken},
		{"wrong scheme", "demo", "Basic ZGV2OmRldg==", errNoToken},
		{"bearer with empty token", "demo", "Bearer ", errNoToken},
		{"token is not a prefix match", "demo", "Bearer dev-demo", errBadToken},
		{"wrong token", "demo", "Bearer wrong-token", errBadToken},
		{"revoked token", "demo", "Bearer revoked-token", errBadToken},
		{"token from another project", "demo", "Bearer other-token", errBadToken},
		{"valid token, unknown project", "ghost", "Bearer dev-demo-token", errBadToken},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := authenticateDeployToken(context.Background(), stores.DeployTokens, tt.projectID, tt.header)
			if !errors.Is(err, tt.wantErr) {
				t.Errorf("authenticateDeployToken(%q, %q) = %v, want %v", tt.projectID, tt.header, err, tt.wantErr)
			}
		})
	}
}

// End-to-end through the middleware: status codes and the error envelope.
func TestRequireDeployTokenHTTP(t *testing.T) {
	s := &Server{stores: newTokenFixtures(t)}
	handler := http.NewServeMux()
	handler.HandleFunc("POST /v1/projects/{id}/render", s.requireDeployToken(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	tests := []struct {
		name       string
		header     string
		wantStatus int
		wantCode   string // error envelope code; "" for success
	}{
		{"authenticated", "Bearer dev-demo-token", http.StatusOK, ""},
		{"missing token", "", http.StatusUnauthorized, "unauthenticated"},
		{"invalid token", "Bearer nope", http.StatusUnauthorized, "invalid_token"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/v1/projects/demo/render", nil)
			if tt.header != "" {
				req.Header.Set("Authorization", tt.header)
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if tt.wantCode == "" {
				return
			}
			var envelope struct {
				Error struct{ Code, Message string } `json:"error"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
				t.Fatalf("body is not the JSON error envelope: %s", rec.Body.String())
			}
			if envelope.Error.Code != tt.wantCode {
				t.Errorf("error.code = %q, want %q", envelope.Error.Code, tt.wantCode)
			}
			if envelope.Error.Message == "" {
				t.Error("error.message is empty")
			}
		})
	}
}

package httpapi

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// Deploy-token lifecycle (architecture.md §8). All routes are session-auth +
// ownership: deploy tokens can only pull rendered output, never manage
// themselves. The plaintext token appears exactly once — in the POST
// response — and only its SHA-256 hash is ever stored.

// tokenView is the masked wire shape: never the hash, never the plaintext.
type tokenView struct {
	ID        string     `json:"id"`
	CreatedAt time.Time  `json:"createdAt"`
	RevokedAt *time.Time `json:"revokedAt,omitempty"`
}

// ---- POST /v1/projects/{id}/tokens --------------------------------------

func (s *Server) handleCreateToken(w http.ResponseWriter, r *http.Request) {
	project, ok := s.ownedProject(w, r)
	if !ok {
		return
	}

	plaintext := newDeployTokenPlaintext()
	token := &store.DeployToken{
		ID:        newTokenID(),
		ProjectID: project.ID,
		Hash:      store.HashToken(plaintext),
		CreatedAt: time.Now().UTC(),
	}
	if err := s.stores.DeployTokens.Create(r.Context(), token); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "creating deploy token failed")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id":        token.ID,
		"token":     plaintext, // shown ONCE, never retrievable again
		"createdAt": token.CreatedAt,
	})
}

// ---- GET /v1/projects/{id}/tokens ---------------------------------------

func (s *Server) handleListTokens(w http.ResponseWriter, r *http.Request) {
	project, ok := s.ownedProject(w, r)
	if !ok {
		return
	}
	tokens, err := s.stores.DeployTokens.ListByProject(r.Context(), project.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "listing deploy tokens failed")
		return
	}
	views := make([]tokenView, 0, len(tokens))
	for _, t := range tokens {
		views = append(views, tokenView{ID: t.ID, CreatedAt: t.CreatedAt, RevokedAt: t.RevokedAt})
	}
	writeJSON(w, http.StatusOK, map[string]any{"tokens": views})
}

// ---- DELETE /v1/projects/{id}/tokens/{tokenId} --------------------------

func (s *Server) handleRevokeToken(w http.ResponseWriter, r *http.Request) {
	project, ok := s.ownedProject(w, r)
	if !ok {
		return
	}
	err := s.stores.DeployTokens.Revoke(r.Context(), project.ID, r.PathValue("tokenId"), time.Now().UTC())
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "deploy token not found")
	default:
		writeError(w, http.StatusInternalServerError, "internal", "revoking deploy token failed")
	}
}

// ---- token generation ---------------------------------------------------

// newDeployTokenPlaintext returns "mib_" + base64url(32 random bytes):
// 256 bits of entropy, URL/header-safe, greppable by prefix.
func newDeployTokenPlaintext() string {
	var b [32]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read never fails on supported platforms
	return "mib_" + base64.RawURLEncoding.EncodeToString(b[:])
}

// newTokenID generates the public identifier of a token (safe to display).
func newTokenID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return "tok-" + hex.EncodeToString(b[:])
}

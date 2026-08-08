// Package auth implements server-side sessions and the GitHub App user-OAuth
// flows behind them (architecture.md §8): the browser holds only a random
// session id in an HttpOnly cookie; upstream tokens never leave the server
// (BFF). Session persistence mirrors internal/store: an interface with
// in-memory and file-backed implementations.
package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"time"
)

// SessionTTL is the server-side session lifetime (architecture.md §8).
const SessionTTL = 30 * 24 * time.Hour

// Session is one signed-in browser. The ID is the bearer secret stored in the
// mib_session cookie, so it must come from NewSessionID (256-bit random).
type Session struct {
	ID        string    `json:"id"`
	UserID    string    `json:"userId"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// Expired reports whether the session is past its expiry at now.
func (s *Session) Expired(now time.Time) bool { return !now.Before(s.ExpiresAt) }

// Sessions persists sessions. Get returns expired sessions too — expiry is
// enforced by the caller (httpapi) against the request clock; implementations
// only garbage-collect.
type Sessions interface {
	Create(ctx context.Context, s *Session) error
	// Get returns the session with the given id, or store.ErrNotFound.
	Get(ctx context.Context, id string) (*Session, error)
	// Delete removes a session (logout). Deleting an unknown id is a no-op:
	// logout must be idempotent.
	Delete(ctx context.Context, id string) error
}

// NewSessionID returns hex(32 random bytes): 256 bits of entropy, cookie-safe.
func NewSessionID() string {
	var b [32]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read never fails on supported platforms
	return hex.EncodeToString(b[:])
}

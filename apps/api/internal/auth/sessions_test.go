package auth

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// Both implementations must satisfy the same contract.
func TestSessionsContract(t *testing.T) {
	impls := map[string]func(t *testing.T) Sessions{
		"memory": func(*testing.T) Sessions { return NewMemorySessions() },
		"file": func(t *testing.T) Sessions {
			s, err := NewFileSessions(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			return s
		},
	}

	for name, newSessions := range impls {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			sessions := newSessions(t)
			now := time.Now().UTC()

			sess := &Session{ID: NewSessionID(), UserID: "u1", CreatedAt: now, ExpiresAt: now.Add(SessionTTL)}
			if err := sessions.Create(ctx, sess); err != nil {
				t.Fatal(err)
			}

			got, err := sessions.Get(ctx, sess.ID)
			if err != nil {
				t.Fatal(err)
			}
			if got.UserID != "u1" || !got.ExpiresAt.Equal(sess.ExpiresAt) {
				t.Errorf("Get = %+v, want the created session", got)
			}

			if _, err := sessions.Get(ctx, "nope"); !errors.Is(err, store.ErrNotFound) {
				t.Errorf("Get(unknown) = %v, want ErrNotFound", err)
			}

			if err := sessions.Delete(ctx, sess.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := sessions.Get(ctx, sess.ID); !errors.Is(err, store.ErrNotFound) {
				t.Errorf("Get after Delete = %v, want ErrNotFound", err)
			}
			// Logout is idempotent.
			if err := sessions.Delete(ctx, sess.ID); err != nil {
				t.Errorf("second Delete = %v, want nil", err)
			}
		})
	}
}

// File sessions survive a restart; expired ones are garbage-collected on load.
func TestFileSessionsReloadAndExpiryGC(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	now := time.Now().UTC()

	sessions, err := NewFileSessions(dir)
	if err != nil {
		t.Fatal(err)
	}
	live := &Session{ID: NewSessionID(), UserID: "u1", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
	dead := &Session{ID: NewSessionID(), UserID: "u1", CreatedAt: now.Add(-2 * time.Hour), ExpiresAt: now.Add(-time.Hour)}
	for _, s := range []*Session{live, dead} {
		if err := sessions.Create(ctx, s); err != nil {
			t.Fatal(err)
		}
	}

	reloaded, err := NewFileSessions(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reloaded.Get(ctx, live.ID); err != nil {
		t.Errorf("live session lost across restart: %v", err)
	}
	if _, err := reloaded.Get(ctx, dead.ID); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("expired session survived the restart GC: %v", err)
	}
}

func TestNewSessionID(t *testing.T) {
	a, b := NewSessionID(), NewSessionID()
	if len(a) != 64 {
		t.Errorf("id length = %d, want 64 hex chars (32 bytes)", len(a))
	}
	if a == b {
		t.Error("two ids are identical")
	}
}

func TestSessionExpired(t *testing.T) {
	now := time.Now()
	s := &Session{ExpiresAt: now}
	if !s.Expired(now) {
		t.Error("session at its exact expiry instant should be expired")
	}
	if s.Expired(now.Add(-time.Second)) {
		t.Error("session before expiry reported expired")
	}
}

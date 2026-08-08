package auth

import (
	"context"
	"sync"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// NewMemorySessions returns a fully in-memory Sessions, suitable for tests
// and MIB_STORE=memory runs (sessions die with the process, like all other
// memory-store state).
func NewMemorySessions() Sessions {
	return &memSessions{m: map[string]*Session{}}
}

type memSessions struct {
	mu sync.RWMutex
	m  map[string]*Session
}

func (s *memSessions) Create(_ context.Context, sess *Session) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := *sess
	s.m[sess.ID] = &cp
	return nil
}

func (s *memSessions) Get(_ context.Context, id string) (*Session, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	sess, ok := s.m[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *sess
	return &cp, nil
}

func (s *memSessions) Delete(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, id)
	return nil
}

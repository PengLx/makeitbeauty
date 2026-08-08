package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

const sessionsFile = "sessions.json"

// NewFileSessions returns Sessions backed by sessions.json under dir (the
// same MIB_DATA_DIR the file store uses), following the internal/store file
// pattern: load on boot, atomic rewrite (temp file + rename) per mutation.
// Expired sessions are dropped at load time so the file cannot grow without
// bound across restarts.
func NewFileSessions(dir string) (Sessions, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("auth: creating data dir %q: %w", dir, err)
	}
	s := &fileSessions{dir: dir, m: map[string]*Session{}}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

type fileSessions struct {
	mu  sync.RWMutex
	dir string
	m   map[string]*Session
}

func (s *fileSessions) load() error {
	b, err := os.ReadFile(filepath.Join(s.dir, sessionsFile))
	if err != nil {
		if os.IsNotExist(err) {
			return nil // missing file == empty collection
		}
		return fmt.Errorf("auth: reading %s: %w", sessionsFile, err)
	}
	var sessions []Session
	if err := json.Unmarshal(b, &sessions); err != nil {
		return fmt.Errorf("auth: %s is not valid JSON: %w", sessionsFile, err)
	}
	now := time.Now()
	for i := range sessions {
		if sessions[i].Expired(now) {
			continue // garbage-collect on boot
		}
		s.m[sessions[i].ID] = &sessions[i]
	}
	return nil
}

// persist snapshots the collection (caller holds the write lock) into a
// deterministic, ID-sorted array and atomically replaces sessions.json.
func (s *fileSessions) persist() error {
	out := make([]Session, 0, len(s.m))
	for _, sess := range s.m {
		out = append(out, *sess)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })

	b, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return fmt.Errorf("auth: encoding %s: %w", sessionsFile, err)
	}
	b = append(b, '\n')

	tmp, err := os.CreateTemp(s.dir, sessionsFile+".tmp-*")
	if err != nil {
		return fmt.Errorf("auth: writing %s: %w", sessionsFile, err)
	}
	defer os.Remove(tmp.Name()) // no-op after a successful rename

	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return fmt.Errorf("auth: writing %s: %w", sessionsFile, err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("auth: syncing %s: %w", sessionsFile, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("auth: closing %s: %w", sessionsFile, err)
	}
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return fmt.Errorf("auth: chmod %s: %w", sessionsFile, err)
	}
	if err := os.Rename(tmp.Name(), filepath.Join(s.dir, sessionsFile)); err != nil {
		return fmt.Errorf("auth: replacing %s: %w", sessionsFile, err)
	}
	return nil
}

func (s *fileSessions) Create(_ context.Context, sess *Session) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := *sess
	s.m[sess.ID] = &cp
	return s.persist()
}

func (s *fileSessions) Get(_ context.Context, id string) (*Session, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	sess, ok := s.m[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *sess
	return &cp, nil
}

func (s *fileSessions) Delete(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.m[id]; !ok {
		return nil // idempotent logout
	}
	delete(s.m, id)
	return s.persist()
}

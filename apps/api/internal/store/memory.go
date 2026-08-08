package store

import (
	"context"
	"sync"
)

// NewMemory returns fully in-memory Stores, suitable for dev and tests.
func NewMemory() Stores {
	return Stores{
		Users:             &memUsers{m: map[string]*User{}},
		Projects:          &memProjects{m: map[string]*Project{}},
		DeployTokens:      &memDeployTokens{byProject: map[string][]*DeployToken{}},
		ConnectorAccounts: &memConnectorAccounts{m: map[string]*ConnectorAccount{}},
	}
}

type memUsers struct {
	mu sync.RWMutex
	m  map[string]*User
}

func (s *memUsers) Create(_ context.Context, u *User) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := *u
	s.m[u.ID] = &cp
	return nil
}

func (s *memUsers) Get(_ context.Context, id string) (*User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u, ok := s.m[id]
	if !ok {
		return nil, ErrNotFound
	}
	cp := *u
	return &cp, nil
}

type memProjects struct {
	mu sync.RWMutex
	m  map[string]*Project
}

func (s *memProjects) Create(_ context.Context, p *Project) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := *p
	s.m[p.ID] = &cp
	return nil
}

func (s *memProjects) Get(_ context.Context, id string) (*Project, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.m[id]
	if !ok {
		return nil, ErrNotFound
	}
	cp := *p
	return &cp, nil
}

func (s *memProjects) ListByUser(_ context.Context, userID string) ([]*Project, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []*Project{}
	for _, p := range s.m {
		if p.UserID == userID {
			cp := *p
			out = append(out, &cp)
		}
	}
	return out, nil
}

type memDeployTokens struct {
	mu        sync.RWMutex
	byProject map[string][]*DeployToken
}

func (s *memDeployTokens) Create(_ context.Context, t *DeployToken) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := *t
	s.byProject[t.ProjectID] = append(s.byProject[t.ProjectID], &cp)
	return nil
}

func (s *memDeployTokens) ListByProject(_ context.Context, projectID string) ([]*DeployToken, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	src := s.byProject[projectID]
	out := make([]*DeployToken, 0, len(src))
	for _, t := range src {
		cp := *t
		out = append(out, &cp)
	}
	return out, nil
}

type memConnectorAccounts struct {
	mu sync.RWMutex
	m  map[string]*ConnectorAccount // keyed by userID + "\x00" + connector
}

func accountKey(userID, connector string) string { return userID + "\x00" + connector }

func (s *memConnectorAccounts) Create(_ context.Context, a *ConnectorAccount) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := *a
	s.m[accountKey(a.UserID, a.Connector)] = &cp
	return nil
}

func (s *memConnectorAccounts) GetByUserConnector(_ context.Context, userID, connector string) (*ConnectorAccount, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	a, ok := s.m[accountKey(userID, connector)]
	if !ok {
		return nil, ErrNotFound
	}
	cp := *a
	return &cp, nil
}

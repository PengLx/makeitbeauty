package store

import (
	"context"
	"sort"
	"sync"
	"time"
)

// NewMemory returns fully in-memory Stores, suitable for dev and tests.
func NewMemory() Stores {
	return Stores{
		Users:             &memUsers{m: map[string]*User{}},
		Projects:          &memProjects{m: map[string]*Project{}},
		DeployTokens:      &memDeployTokens{byProject: map[string][]*DeployToken{}},
		ConnectorAccounts: &memConnectorAccounts{m: map[string]*ConnectorAccount{}},
		Components:        &memComponents{m: map[string]*Component{}},
		ComponentVersions: &memComponentVersions{byComponent: map[string][]*ComponentVersion{}},
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

func (s *memUsers) GetByGitHubID(_ context.Context, githubID int64) (*User, error) {
	if githubID == 0 {
		return nil, ErrNotFound
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, u := range s.m {
		if u.GitHubID == githubID {
			cp := *u
			return &cp, nil
		}
	}
	return nil, ErrNotFound
}

func (s *memUsers) Update(_ context.Context, u *User) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.m[u.ID]; !ok {
		return ErrNotFound
	}
	cp := *u
	s.m[u.ID] = &cp
	return nil
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

func (s *memProjects) Update(_ context.Context, p *Project) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.m[p.ID]; !ok {
		return ErrNotFound
	}
	cp := *p
	s.m[p.ID] = &cp
	return nil
}

func (s *memProjects) Delete(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.m[id]; !ok {
		return ErrNotFound
	}
	delete(s.m, id)
	return nil
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

func (s *memDeployTokens) Revoke(_ context.Context, projectID, tokenID string, at time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, t := range s.byProject[projectID] {
		if t.ID == tokenID {
			if t.RevokedAt == nil {
				at := at
				t.RevokedAt = &at
			}
			return nil
		}
	}
	return ErrNotFound
}

type memComponents struct {
	mu sync.RWMutex
	m  map[string]*Component
}

func (s *memComponents) Create(_ context.Context, c *Component) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.m[c.ID]; ok {
		return ErrExists
	}
	cp := *c
	s.m[c.ID] = &cp
	return nil
}

func (s *memComponents) Get(_ context.Context, id string) (*Component, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c, ok := s.m[id]
	if !ok {
		return nil, ErrNotFound
	}
	cp := *c
	return &cp, nil
}

func (s *memComponents) ListByOwner(_ context.Context, ownerID string) ([]*Component, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []*Component{}
	for _, c := range s.m {
		if c.OwnerID == ownerID {
			cp := *c
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (s *memComponents) List(_ context.Context) ([]*Component, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []*Component{}
	for _, c := range s.m {
		cp := *c
		out = append(out, &cp)
	}
	return out, nil
}

func (s *memComponents) Update(_ context.Context, c *Component) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.m[c.ID]; !ok {
		return ErrNotFound
	}
	cp := *c
	s.m[c.ID] = &cp
	return nil
}

type memComponentVersions struct {
	mu          sync.RWMutex
	byComponent map[string][]*ComponentVersion
}

func (s *memComponentVersions) Create(_ context.Context, v *ComponentVersion) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.byComponent[v.ComponentID] {
		if existing.Version == v.Version {
			return ErrExists // versions are immutable, never replaced
		}
	}
	cp := *v
	s.byComponent[v.ComponentID] = append(s.byComponent[v.ComponentID], &cp)
	return nil
}

func (s *memComponentVersions) Get(_ context.Context, componentID string, version int) (*ComponentVersion, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, v := range s.byComponent[componentID] {
		if v.Version == version {
			cp := *v
			return &cp, nil
		}
	}
	return nil, ErrNotFound
}

func (s *memComponentVersions) ListByComponent(_ context.Context, componentID string) ([]*ComponentVersion, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	src := s.byComponent[componentID]
	out := make([]*ComponentVersion, 0, len(src))
	for _, v := range src {
		cp := *v
		out = append(out, &cp)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Version < out[j].Version })
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

func (s *memConnectorAccounts) Update(_ context.Context, a *ConnectorAccount) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := accountKey(a.UserID, a.Connector)
	if _, ok := s.m[key]; !ok {
		return ErrNotFound
	}
	cp := *a
	s.m[key] = &cp
	return nil
}

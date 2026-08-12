package store

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// NewFile returns Stores backed by one JSON file per entity collection under
// dir (users.json, projects.json, deploy_tokens.json, connector_accounts.json,
// components.json, component_versions.json).
// The directory is created on demand (0700), existing files are loaded on
// boot, and every mutation rewrites the affected collection atomically
// (temp file + rename), so a crash mid-write never corrupts data. This makes
// dev and small self-host deployments durable with zero dependencies
// (architecture.md §7); Postgres replaces it behind the same interfaces.
func NewFile(dir string) (Stores, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return Stores{}, fmt.Errorf("store: creating data dir %q: %w", dir, err)
	}
	db := &fileDB{
		dir:        dir,
		users:      map[string]*User{},
		projects:   map[string]*Project{},
		tokens:     map[string][]*DeployToken{},
		accounts:   map[string]*ConnectorAccount{},
		components: map[string]*Component{},
		versions:   map[string][]*ComponentVersion{},
	}
	if err := db.load(); err != nil {
		return Stores{}, err
	}
	return Stores{
		Users:             &fileUsers{db},
		Projects:          &fileProjects{db},
		DeployTokens:      &fileDeployTokens{db},
		ConnectorAccounts: &fileConnectorAccounts{db},
		Components:        &fileComponents{db},
		ComponentVersions: &fileComponentVersions{db},
	}, nil
}

// ---- persisted record shapes --------------------------------------------
// The API structs are not reused directly: Project hides userId from API
// responses (`json:"-"`) but the store must persist it, and token hashes are
// friendlier on disk as hex than as a JSON byte array. Records pin the disk
// format independently of wire-format choices.

const (
	usersFile      = "users.json"
	projectsFile   = "projects.json"
	tokensFile     = "deploy_tokens.json"
	accountsFile   = "connector_accounts.json"
	componentsFile = "components.json"
	versionsFile   = "component_versions.json"
)

type projectRecord struct {
	ID        string          `json:"id"`
	UserID    string          `json:"userId"`
	Name      string          `json:"name"`
	Design    json.RawMessage `json:"design"`
	Bindings  []Binding       `json:"bindings"`
	Outputs   []Output        `json:"outputs"`
	CreatedAt time.Time       `json:"createdAt"`
	UpdatedAt time.Time       `json:"updatedAt"`
}

type tokenRecord struct {
	ID        string     `json:"id"`
	ProjectID string     `json:"projectId"`
	Hash      string     `json:"hash"` // hex(sha256), never the plaintext
	CreatedAt time.Time  `json:"createdAt"`
	RevokedAt *time.Time `json:"revokedAt,omitempty"`
}

type accountRecord struct {
	ID                   string    `json:"id"`
	UserID               string    `json:"userId"`
	Connector            string    `json:"connector"`
	EncryptedCredentials []byte    `json:"encryptedCredentials,omitempty"`
	Status               string    `json:"status"`
	LastRefreshAt        time.Time `json:"lastRefreshAt"`
}

type componentRecord struct {
	ID            string          `json:"id"`
	OwnerID       string          `json:"ownerId"`
	Title         string          `json:"title"`
	Description   string          `json:"description,omitempty"`
	Draft         json.RawMessage `json:"draft"`
	LatestVersion int             `json:"latestVersion"`
	Unlisted      bool            `json:"unlisted,omitempty"`
	CreatedAt     time.Time       `json:"createdAt"`
	UpdatedAt     time.Time       `json:"updatedAt"`
}

type componentVersionRecord struct {
	ComponentID string          `json:"componentId"`
	Version     int             `json:"version"`
	Definition  json.RawMessage `json:"definition"`
	PublishedAt time.Time       `json:"publishedAt"`
}

// ---- shared database ----------------------------------------------------

// fileDB holds all collections in memory under one mutex; files are the
// durable copy, rewritten per collection on every mutation.
type fileDB struct {
	mu         sync.RWMutex
	dir        string
	users      map[string]*User
	projects   map[string]*Project
	tokens     map[string][]*DeployToken // keyed by projectID
	accounts   map[string]*ConnectorAccount
	components map[string]*Component
	versions   map[string][]*ComponentVersion // keyed by componentID
}

func (db *fileDB) load() error {
	var users []User
	if err := db.readFile(usersFile, &users); err != nil {
		return err
	}
	for i := range users {
		db.users[users[i].ID] = &users[i]
	}

	var projects []projectRecord
	if err := db.readFile(projectsFile, &projects); err != nil {
		return err
	}
	for _, rec := range projects {
		db.projects[rec.ID] = &Project{
			ID: rec.ID, UserID: rec.UserID, Name: rec.Name, Design: rec.Design,
			Bindings: rec.Bindings, Outputs: rec.Outputs,
			CreatedAt: rec.CreatedAt, UpdatedAt: rec.UpdatedAt,
		}
	}

	var tokens []tokenRecord
	if err := db.readFile(tokensFile, &tokens); err != nil {
		return err
	}
	for _, rec := range tokens {
		hash, err := hex.DecodeString(rec.Hash)
		if err != nil || len(hash) != len(DeployToken{}.Hash) {
			return fmt.Errorf("store: %s: token %q has a malformed hash", tokensFile, rec.ID)
		}
		t := &DeployToken{ID: rec.ID, ProjectID: rec.ProjectID, CreatedAt: rec.CreatedAt, RevokedAt: rec.RevokedAt}
		copy(t.Hash[:], hash)
		db.tokens[t.ProjectID] = append(db.tokens[t.ProjectID], t)
	}

	var accounts []accountRecord
	if err := db.readFile(accountsFile, &accounts); err != nil {
		return err
	}
	for _, rec := range accounts {
		db.accounts[accountKey(rec.UserID, rec.Connector)] = &ConnectorAccount{
			ID: rec.ID, UserID: rec.UserID, Connector: rec.Connector,
			EncryptedCredentials: rec.EncryptedCredentials,
			Status:               rec.Status, LastRefreshAt: rec.LastRefreshAt,
		}
	}

	var components []componentRecord
	if err := db.readFile(componentsFile, &components); err != nil {
		return err
	}
	for _, rec := range components {
		db.components[rec.ID] = &Component{
			ID: rec.ID, OwnerID: rec.OwnerID, Title: rec.Title, Description: rec.Description,
			Draft: rec.Draft, LatestVersion: rec.LatestVersion, Unlisted: rec.Unlisted,
			CreatedAt: rec.CreatedAt, UpdatedAt: rec.UpdatedAt,
		}
	}

	var versions []componentVersionRecord
	if err := db.readFile(versionsFile, &versions); err != nil {
		return err
	}
	for _, rec := range versions {
		db.versions[rec.ComponentID] = append(db.versions[rec.ComponentID], &ComponentVersion{
			ComponentID: rec.ComponentID, Version: rec.Version,
			Definition: rec.Definition, PublishedAt: rec.PublishedAt,
		})
	}
	return nil
}

// readFile unmarshals one collection file into v; a missing file is an empty
// collection, not an error.
func (db *fileDB) readFile(name string, v any) error {
	b, err := os.ReadFile(filepath.Join(db.dir, name))
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("store: reading %s: %w", name, err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		return fmt.Errorf("store: %s is not valid JSON: %w", name, err)
	}
	return nil
}

// writeFile atomically replaces one collection file: marshal, write to a
// temp file in the same directory, fsync, rename. Readers therefore only
// ever observe either the previous or the new complete file.
func (db *fileDB) writeFile(name string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("store: encoding %s: %w", name, err)
	}
	b = append(b, '\n')

	tmp, err := os.CreateTemp(db.dir, name+".tmp-*")
	if err != nil {
		return fmt.Errorf("store: writing %s: %w", name, err)
	}
	defer os.Remove(tmp.Name()) // no-op after a successful rename

	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return fmt.Errorf("store: writing %s: %w", name, err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("store: syncing %s: %w", name, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("store: closing %s: %w", name, err)
	}
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return fmt.Errorf("store: chmod %s: %w", name, err)
	}
	if err := os.Rename(tmp.Name(), filepath.Join(db.dir, name)); err != nil {
		return fmt.Errorf("store: replacing %s: %w", name, err)
	}
	return nil
}

// The persist* helpers snapshot a collection (caller holds the write lock)
// into a deterministic, ID-sorted array and rewrite its file.

func (db *fileDB) persistUsers() error {
	out := make([]User, 0, len(db.users))
	for _, u := range db.users {
		out = append(out, *u)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return db.writeFile(usersFile, out)
}

func (db *fileDB) persistProjects() error {
	out := make([]projectRecord, 0, len(db.projects))
	for _, p := range db.projects {
		out = append(out, projectRecord{
			ID: p.ID, UserID: p.UserID, Name: p.Name, Design: p.Design,
			Bindings: p.Bindings, Outputs: p.Outputs,
			CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return db.writeFile(projectsFile, out)
}

func (db *fileDB) persistTokens() error {
	out := []tokenRecord{}
	for _, list := range db.tokens {
		for _, t := range list {
			out = append(out, tokenRecord{
				ID: t.ID, ProjectID: t.ProjectID, Hash: hex.EncodeToString(t.Hash[:]),
				CreatedAt: t.CreatedAt, RevokedAt: t.RevokedAt,
			})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ProjectID != out[j].ProjectID {
			return out[i].ProjectID < out[j].ProjectID
		}
		return out[i].ID < out[j].ID
	})
	return db.writeFile(tokensFile, out)
}

func (db *fileDB) persistComponents() error {
	out := make([]componentRecord, 0, len(db.components))
	for _, c := range db.components {
		out = append(out, componentRecord{
			ID: c.ID, OwnerID: c.OwnerID, Title: c.Title, Description: c.Description,
			Draft: c.Draft, LatestVersion: c.LatestVersion, Unlisted: c.Unlisted,
			CreatedAt: c.CreatedAt, UpdatedAt: c.UpdatedAt,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return db.writeFile(componentsFile, out)
}

func (db *fileDB) persistVersions() error {
	out := []componentVersionRecord{}
	for _, list := range db.versions {
		for _, v := range list {
			out = append(out, componentVersionRecord{
				ComponentID: v.ComponentID, Version: v.Version,
				Definition: v.Definition, PublishedAt: v.PublishedAt,
			})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ComponentID != out[j].ComponentID {
			return out[i].ComponentID < out[j].ComponentID
		}
		return out[i].Version < out[j].Version
	})
	return db.writeFile(versionsFile, out)
}

func (db *fileDB) persistAccounts() error {
	out := make([]accountRecord, 0, len(db.accounts))
	for _, a := range db.accounts {
		out = append(out, accountRecord{
			ID: a.ID, UserID: a.UserID, Connector: a.Connector,
			EncryptedCredentials: a.EncryptedCredentials,
			Status:               a.Status, LastRefreshAt: a.LastRefreshAt,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return db.writeFile(accountsFile, out)
}

// ---- interface implementations -----------------------------------------

type fileUsers struct{ db *fileDB }

func (s *fileUsers) Create(_ context.Context, u *User) error {
	s.db.mu.Lock()
	defer s.db.mu.Unlock()
	cp := *u
	s.db.users[u.ID] = &cp
	return s.db.persistUsers()
}

func (s *fileUsers) Get(_ context.Context, id string) (*User, error) {
	s.db.mu.RLock()
	defer s.db.mu.RUnlock()
	u, ok := s.db.users[id]
	if !ok {
		return nil, ErrNotFound
	}
	cp := *u
	return &cp, nil
}

func (s *fileUsers) GetByGitHubID(_ context.Context, githubID int64) (*User, error) {
	if githubID == 0 {
		return nil, ErrNotFound
	}
	s.db.mu.RLock()
	defer s.db.mu.RUnlock()
	for _, u := range s.db.users {
		if u.GitHubID == githubID {
			cp := *u
			return &cp, nil
		}
	}
	return nil, ErrNotFound
}

func (s *fileUsers) Update(_ context.Context, u *User) error {
	s.db.mu.Lock()
	defer s.db.mu.Unlock()
	if _, ok := s.db.users[u.ID]; !ok {
		return ErrNotFound
	}
	cp := *u
	s.db.users[u.ID] = &cp
	return s.db.persistUsers()
}

type fileProjects struct{ db *fileDB }

func (s *fileProjects) Create(_ context.Context, p *Project) error {
	s.db.mu.Lock()
	defer s.db.mu.Unlock()
	cp := *p
	s.db.projects[p.ID] = &cp
	return s.db.persistProjects()
}

func (s *fileProjects) Get(_ context.Context, id string) (*Project, error) {
	s.db.mu.RLock()
	defer s.db.mu.RUnlock()
	p, ok := s.db.projects[id]
	if !ok {
		return nil, ErrNotFound
	}
	cp := *p
	return &cp, nil
}

func (s *fileProjects) ListByUser(_ context.Context, userID string) ([]*Project, error) {
	s.db.mu.RLock()
	defer s.db.mu.RUnlock()
	out := []*Project{}
	for _, p := range s.db.projects {
		if p.UserID == userID {
			cp := *p
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (s *fileProjects) Update(_ context.Context, p *Project) error {
	s.db.mu.Lock()
	defer s.db.mu.Unlock()
	if _, ok := s.db.projects[p.ID]; !ok {
		return ErrNotFound
	}
	cp := *p
	s.db.projects[p.ID] = &cp
	return s.db.persistProjects()
}

func (s *fileProjects) Delete(_ context.Context, id string) error {
	s.db.mu.Lock()
	defer s.db.mu.Unlock()
	if _, ok := s.db.projects[id]; !ok {
		return ErrNotFound
	}
	delete(s.db.projects, id)
	return s.db.persistProjects()
}

type fileDeployTokens struct{ db *fileDB }

func (s *fileDeployTokens) Create(_ context.Context, t *DeployToken) error {
	s.db.mu.Lock()
	defer s.db.mu.Unlock()
	cp := *t
	s.db.tokens[t.ProjectID] = append(s.db.tokens[t.ProjectID], &cp)
	return s.db.persistTokens()
}

func (s *fileDeployTokens) ListByProject(_ context.Context, projectID string) ([]*DeployToken, error) {
	s.db.mu.RLock()
	defer s.db.mu.RUnlock()
	src := s.db.tokens[projectID]
	out := make([]*DeployToken, 0, len(src))
	for _, t := range src {
		cp := *t
		out = append(out, &cp)
	}
	return out, nil
}

func (s *fileDeployTokens) Revoke(_ context.Context, projectID, tokenID string, at time.Time) error {
	s.db.mu.Lock()
	defer s.db.mu.Unlock()
	for _, t := range s.db.tokens[projectID] {
		if t.ID == tokenID {
			if t.RevokedAt == nil {
				at := at
				t.RevokedAt = &at
				return s.db.persistTokens()
			}
			return nil
		}
	}
	return ErrNotFound
}

type fileComponents struct{ db *fileDB }

func (s *fileComponents) Create(_ context.Context, c *Component) error {
	s.db.mu.Lock()
	defer s.db.mu.Unlock()
	if _, ok := s.db.components[c.ID]; ok {
		return ErrExists
	}
	cp := *c
	s.db.components[c.ID] = &cp
	return s.db.persistComponents()
}

func (s *fileComponents) Get(_ context.Context, id string) (*Component, error) {
	s.db.mu.RLock()
	defer s.db.mu.RUnlock()
	c, ok := s.db.components[id]
	if !ok {
		return nil, ErrNotFound
	}
	cp := *c
	return &cp, nil
}

func (s *fileComponents) ListByOwner(_ context.Context, ownerID string) ([]*Component, error) {
	s.db.mu.RLock()
	defer s.db.mu.RUnlock()
	out := []*Component{}
	for _, c := range s.db.components {
		if c.OwnerID == ownerID {
			cp := *c
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (s *fileComponents) List(_ context.Context) ([]*Component, error) {
	s.db.mu.RLock()
	defer s.db.mu.RUnlock()
	out := []*Component{}
	for _, c := range s.db.components {
		cp := *c
		out = append(out, &cp)
	}
	return out, nil
}

func (s *fileComponents) Update(_ context.Context, c *Component) error {
	s.db.mu.Lock()
	defer s.db.mu.Unlock()
	if _, ok := s.db.components[c.ID]; !ok {
		return ErrNotFound
	}
	cp := *c
	s.db.components[c.ID] = &cp
	return s.db.persistComponents()
}

type fileComponentVersions struct{ db *fileDB }

func (s *fileComponentVersions) Create(_ context.Context, v *ComponentVersion) error {
	s.db.mu.Lock()
	defer s.db.mu.Unlock()
	for _, existing := range s.db.versions[v.ComponentID] {
		if existing.Version == v.Version {
			return ErrExists // versions are immutable, never replaced
		}
	}
	cp := *v
	s.db.versions[v.ComponentID] = append(s.db.versions[v.ComponentID], &cp)
	return s.db.persistVersions()
}

func (s *fileComponentVersions) Get(_ context.Context, componentID string, version int) (*ComponentVersion, error) {
	s.db.mu.RLock()
	defer s.db.mu.RUnlock()
	for _, v := range s.db.versions[componentID] {
		if v.Version == version {
			cp := *v
			return &cp, nil
		}
	}
	return nil, ErrNotFound
}

func (s *fileComponentVersions) ListByComponent(_ context.Context, componentID string) ([]*ComponentVersion, error) {
	s.db.mu.RLock()
	defer s.db.mu.RUnlock()
	src := s.db.versions[componentID]
	out := make([]*ComponentVersion, 0, len(src))
	for _, v := range src {
		cp := *v
		out = append(out, &cp)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Version < out[j].Version })
	return out, nil
}

type fileConnectorAccounts struct{ db *fileDB }

func (s *fileConnectorAccounts) Create(_ context.Context, a *ConnectorAccount) error {
	s.db.mu.Lock()
	defer s.db.mu.Unlock()
	cp := *a
	s.db.accounts[accountKey(a.UserID, a.Connector)] = &cp
	return s.db.persistAccounts()
}

func (s *fileConnectorAccounts) GetByUserConnector(_ context.Context, userID, connector string) (*ConnectorAccount, error) {
	s.db.mu.RLock()
	defer s.db.mu.RUnlock()
	a, ok := s.db.accounts[accountKey(userID, connector)]
	if !ok {
		return nil, ErrNotFound
	}
	cp := *a
	return &cp, nil
}

func (s *fileConnectorAccounts) Update(_ context.Context, a *ConnectorAccount) error {
	s.db.mu.Lock()
	defer s.db.mu.Unlock()
	key := accountKey(a.UserID, a.Connector)
	if _, ok := s.db.accounts[key]; !ok {
		return ErrNotFound
	}
	cp := *a
	s.db.accounts[key] = &cp
	return s.db.persistAccounts()
}

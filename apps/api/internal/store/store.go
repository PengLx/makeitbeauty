// Package store defines the persistence interfaces of the API and their
// in-memory implementations. Postgres implements the same interfaces later;
// nothing above this package may assume in-memory semantics.
package store

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"time"
)

// ErrNotFound is returned by Get-style methods when no row matches.
var ErrNotFound = errors.New("store: not found")

// User is an account holder (data model v0, architecture.md §7).
type User struct {
	ID          string    `json:"id"`
	Login       string    `json:"login"`
	DisplayName string    `json:"displayName"`
	CreatedAt   time.Time `json:"createdAt"`
}

// ConnectorAccount is a user-level connector configuration. Credentials are
// stored envelope-encrypted; this scaffold never populates them.
type ConnectorAccount struct {
	ID                   string
	UserID               string
	Connector            string
	EncryptedCredentials []byte
	Status               string // "active" | "expired" | ...
	LastRefreshAt        time.Time
}

// Binding declares which connector fields a project consumes
// (packages/schema/project.schema.json).
type Binding struct {
	Connector string   `json:"connector"`
	AccountID string   `json:"accountId,omitempty"`
	Fields    []string `json:"fields"`
}

// Output is one rendered artifact of a project.
type Output struct {
	ID       string `json:"id"`
	Theme    string `json:"theme,omitempty"` // auto|light|dark, "" == auto
	Format   string `json:"format,omitempty"`
	Filename string `json:"filename"`
}

// Project owns one design plus its bindings and outputs. Design is kept as raw
// JSON: the API routes it to the renderer, which owns validation.
type Project struct {
	ID        string          `json:"id"`
	UserID    string          `json:"-"`
	Name      string          `json:"name"`
	Design    json.RawMessage `json:"design"`
	Bindings  []Binding       `json:"bindings"`
	Outputs   []Output        `json:"outputs"`
	CreatedAt time.Time       `json:"createdAt"`
	UpdatedAt time.Time       `json:"updatedAt"`
}

// DeployToken authorizes pulling rendered output for exactly one project.
// Only the SHA-256 hash of the token is ever stored.
type DeployToken struct {
	ID        string
	ProjectID string
	Hash      [sha256.Size]byte
	CreatedAt time.Time
	RevokedAt *time.Time
}

// HashToken is the canonical token → stored-hash derivation. Hashing before
// comparison also equalizes lengths for the constant-time compare in httpapi.
func HashToken(token string) [sha256.Size]byte {
	return sha256.Sum256([]byte(token))
}

// Users persists accounts.
type Users interface {
	Create(ctx context.Context, u *User) error
	Get(ctx context.Context, id string) (*User, error)
}

// Projects persists image projects.
type Projects interface {
	Create(ctx context.Context, p *Project) error
	Get(ctx context.Context, id string) (*Project, error)
	ListByUser(ctx context.Context, userID string) ([]*Project, error)
	// Update replaces the stored project with p (matched by p.ID).
	// Returns ErrNotFound if no such project exists.
	Update(ctx context.Context, p *Project) error
	// Delete removes a project. Returns ErrNotFound if no such project
	// exists. Token cascade is the caller's job (httpapi), not the store's.
	Delete(ctx context.Context, id string) error
}

// DeployTokens persists per-project deploy tokens.
type DeployTokens interface {
	Create(ctx context.Context, t *DeployToken) error
	// ListByProject returns all tokens (including revoked ones) for a project;
	// an unknown project yields an empty slice, not an error, so auth failures
	// don't leak project existence.
	ListByProject(ctx context.Context, projectID string) ([]*DeployToken, error)
	// Revoke marks one token revoked at the given time. Returns ErrNotFound
	// if the (projectID, tokenID) pair matches nothing; revoking an already
	// revoked token is a no-op that keeps the original RevokedAt.
	Revoke(ctx context.Context, projectID, tokenID string, at time.Time) error
}

// ConnectorAccounts persists user-level connector configurations.
type ConnectorAccounts interface {
	Create(ctx context.Context, a *ConnectorAccount) error
	GetByUserConnector(ctx context.Context, userID, connector string) (*ConnectorAccount, error)
}

// Stores bundles all persistence interfaces for wiring.
type Stores struct {
	Users             Users
	Projects          Projects
	DeployTokens      DeployTokens
	ConnectorAccounts ConnectorAccounts
}

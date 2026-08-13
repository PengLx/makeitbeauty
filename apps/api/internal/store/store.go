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

// ErrExists is returned by Create-style methods when a row with the same key
// already exists and the collection refuses overwrites (component ids,
// immutable component versions).
var ErrExists = errors.New("store: already exists")

// User is an account holder (data model v0, architecture.md §7). GitHub-born
// users are keyed on the immutable numeric GitHub id (logins can change);
// GitHubID stays 0 for the implicit dev user.
type User struct {
	ID          string    `json:"id"`
	Login       string    `json:"login"`
	DisplayName string    `json:"displayName"`
	AvatarURL   string    `json:"avatarUrl,omitempty"`
	GitHubID    int64     `json:"githubId,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
}

// ConnectorAccount is a user-level connector configuration.
// EncryptedCredentials is a crypto.Sealer-sealed JSON blob (the GitHub shape
// is auth.Credentials); it is empty for auth:none connectors and the dev seed.
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
	ID       string          `json:"id"`
	UserID   string          `json:"-"`
	Name     string          `json:"name"`
	Design   json.RawMessage `json:"design"`
	Bindings []Binding       `json:"bindings"`
	Outputs  []Output        `json:"outputs"`
	// ComponentRefs is the design's community-component references —
	// unversioned "{owner}/{name}", sorted, deduped, kit/* excluded. Like
	// Bindings it is DERIVED, never client-authored: httpapi recomputes it
	// from the design on every project write. It is the base of the usage
	// metric (architecture.md §8): usage of a component = number of distinct
	// projects whose ComponentRefs contain it.
	ComponentRefs []string  `json:"componentRefs,omitempty"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
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

// Component is one community-registry component (architecture.md §7.5):
// registry metadata plus the owner's mutable, private draft definition.
// Published versions live in ComponentVersion and never change.
type Component struct {
	ID            string // "{owner}/{name}", owner = login lowercased
	OwnerID       string // User.ID of the owner
	Title         string
	Description   string
	Category      string          // optional palette-menu slug ("" == uncategorized)
	Draft         json.RawMessage // working definition (kit-component shape)
	LatestVersion int             // 0 == never published
	Unlisted      bool            // hidden from browse; pinned versions still serve
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// ComponentVersion is one frozen publish of a component. Immutable by
// contract: the store interface exposes no update or delete for versions —
// pinned usages must keep rendering forever (architecture.md §7.5).
type ComponentVersion struct {
	ComponentID string          // Component.ID
	Version     int             // 1, 2, 3, ... (auto-increment at publish)
	Definition  json.RawMessage // kit-component document, id = "{owner}/{name}@{n}"
	PublishedAt time.Time
}

// Favorite marks that one user favorited one community component
// (architecture.md §8): at most one row per (user, component) pair.
type Favorite struct {
	UserID      string    // User.ID
	ComponentID string    // Component.ID, "{owner}/{name}"
	CreatedAt   time.Time // when the favorite was first set (Set keeps it)
}

// Font is the metadata of one user-uploaded font face (architecture.md §8).
// The binary itself lives on disk under MIB_DATA_DIR/fonts/{userID}/
// ({fontID}.{format}, 0600) — the store persists only this record. User fonts
// are private to their owner: only the owner's designs ever attach them to a
// render request, and community components may reference built-in families
// only.
type Font struct {
	ID        string // "font-{hex}", the route identifier
	UserID    string // owner; fonts are never shared across users
	Family    string // display family name, matched against style.fontFamily
	Weight    int    // 400 | 700
	Format    string // "ttf" | "otf" | "woff" (magic-byte-detected; WOFF2 is rejected at upload)
	Size      int64  // binary size in bytes (≤ 5 MB)
	Hash      string // hex SHA-256 of the binary — ETag + the renderer's LRU cache key
	CreatedAt time.Time
}

// Users persists accounts.
type Users interface {
	Create(ctx context.Context, u *User) error
	Get(ctx context.Context, id string) (*User, error)
	// GetByGitHubID resolves the user owning a GitHub identity — the upsert
	// key of the OAuth callback. githubID 0 (users without a GitHub identity)
	// is never matched.
	GetByGitHubID(ctx context.Context, githubID int64) (*User, error)
	// Update replaces the stored user with u (matched by u.ID).
	// Returns ErrNotFound if no such user exists.
	Update(ctx context.Context, u *User) error
}

// Projects persists image projects.
type Projects interface {
	Create(ctx context.Context, p *Project) error
	Get(ctx context.Context, id string) (*Project, error)
	ListByUser(ctx context.Context, userID string) ([]*Project, error)
	// List returns every project regardless of owner — the boot-time source
	// of the community-component usage index, which is rebuilt from all
	// projects' ComponentRefs on every start (architecture.md §8).
	List(ctx context.Context) ([]*Project, error)
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
	// Update replaces the stored account with a (matched by UserID+Connector,
	// the natural key): resealed credentials after a token refresh, status
	// flips to "expired". Returns ErrNotFound if no such account exists.
	Update(ctx context.Context, a *ConnectorAccount) error
	// Delete removes a user's account for one connector (disconnect: the
	// sealed config is erased, the connector reverts to unconfigured).
	// Returns ErrNotFound if no such account exists.
	Delete(ctx context.Context, userID, connector string) error
}

// Components persists community-component registry entries (metadata +
// draft). Frozen publishes live in ComponentVersions.
type Components interface {
	// Create adds a new component. Returns ErrExists if the id is taken —
	// component ids are permanent namespace claims, never overwritten.
	Create(ctx context.Context, c *Component) error
	Get(ctx context.Context, id string) (*Component, error)
	ListByOwner(ctx context.Context, ownerID string) ([]*Component, error)
	// List returns every component; browse filtering (published, listed, q)
	// is the caller's job.
	List(ctx context.Context) ([]*Component, error)
	// Update replaces the stored component with c (matched by c.ID): draft
	// edits, publish bookkeeping (LatestVersion), unlisting. Returns
	// ErrNotFound if no such component exists.
	Update(ctx context.Context, c *Component) error
}

// ComponentVersions persists frozen component publishes. Deliberately no
// Update or Delete: versions are immutable (architecture.md §7.5) and this
// interface is where that guarantee is enforced structurally.
type ComponentVersions interface {
	// Create freezes one version. Returns ErrExists if
	// (ComponentID, Version) is already taken — a frozen version can never
	// be replaced.
	Create(ctx context.Context, v *ComponentVersion) error
	Get(ctx context.Context, componentID string, version int) (*ComponentVersion, error)
	// ListByComponent returns all versions of a component, ascending by
	// version; an unknown component yields an empty slice, not an error.
	ListByComponent(ctx context.Context, componentID string) ([]*ComponentVersion, error)
}

// Favorites persists per-user community-component favorites
// (architecture.md §8). Both writes are idempotent by contract so the API's
// PUT/DELETE favorite routes can always converge without read-modify-write.
type Favorites interface {
	// Set records the favorite. Setting an already-favorited (user,
	// component) pair is a no-op that keeps the original CreatedAt.
	Set(ctx context.Context, f *Favorite) error
	// Unset removes the favorite. Removing an absent pair is a no-op, never
	// an error.
	Unset(ctx context.Context, userID, componentID string) error
	// CountByComponent returns how many users currently favorite a
	// component; an unknown component counts 0, not an error.
	CountByComponent(ctx context.Context, componentID string) (int, error)
	// ListByUser returns all favorites of one user, unordered (presentation
	// order is the caller's job).
	ListByUser(ctx context.Context, userID string) ([]*Favorite, error)
	// IsFavorited reports, for each queried component id, whether the user
	// currently favorites it — one batched call per browse page, never a
	// per-row query. Every queried id has an entry in the result.
	IsFavorited(ctx context.Context, userID string, componentIDs ...string) (map[string]bool, error)
}

// Fonts persists user-uploaded font metadata; binaries live on disk, keyed
// by the record's ID and Format (httpapi owns the files, the store owns the
// rows — deleting a font removes both, in that order).
type Fonts interface {
	// Create adds a new font. Returns ErrExists when the owner already has a
	// font with the same family and weight — one face per (family, weight)
	// keeps render-time family matching unambiguous; re-uploading requires a
	// delete first.
	Create(ctx context.Context, f *Font) error
	Get(ctx context.Context, id string) (*Font, error)
	// ListByUser returns all fonts of one user, unordered (presentation order
	// is the caller's job). Its length enforces the per-user quota.
	ListByUser(ctx context.Context, userID string) ([]*Font, error)
	// Delete removes a font row. Returns ErrNotFound if no such font exists.
	// Designs referencing the family thereafter fall back to the renderer's
	// default (Inter) with a render warning — deliberately no cascade.
	Delete(ctx context.Context, id string) error
}

// Stores bundles all persistence interfaces for wiring.
type Stores struct {
	Users             Users
	Projects          Projects
	DeployTokens      DeployTokens
	ConnectorAccounts ConnectorAccounts
	Components        Components
	ComponentVersions ComponentVersions
	Favorites         Favorites
	Fonts             Fonts
}

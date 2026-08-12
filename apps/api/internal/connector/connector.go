// Package connector implements the connector layer: a registry of data
// connectors, the per-(user, connector) snapshot cache with
// stale-while-revalidate semantics, and the field filtering that keeps
// components on a filtered view of snapshot data (the security boundary of
// architecture.md §6/§9 — components never see tokens or unbound fields).
package connector

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// ErrUnknown is returned when a binding references a connector that is not
// registered. This indicates a server misconfiguration, not a client error.
var ErrUnknown = errors.New("connector: unknown connector")

// Connector fetches a data snapshot for one user account. Implementations are
// trusted code shipped via reviewed PRs (never sandboxed community code).
type Connector interface {
	// Name is the manifest name, e.g. "github".
	Name() string
	// SnapshotTTL is the manifest-declared cache TTL for snapshots.
	SnapshotTTL() time.Duration
	// Fetch retrieves a fresh snapshot from the upstream API. account may be
	// nil for auth:none connectors (and for dev stubs).
	Fetch(ctx context.Context, account *store.ConnectorAccount) (map[string]any, error)
}

// Registry maps connector names to implementations. Registration happens at
// startup only; lookups afterwards are read-only, so no locking is needed.
type Registry struct {
	byName map[string]Connector
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{byName: map[string]Connector{}}
}

// Register adds c under its manifest name, replacing any previous entry.
func (r *Registry) Register(c Connector) {
	r.byName[c.Name()] = c
}

// Get looks up a connector by name.
func (r *Registry) Get(name string) (Connector, bool) {
	c, ok := r.byName[name]
	return c, ok
}

// Names returns the registered connector names, sorted. Used by binding
// derivation to distinguish real connector references from literal text
// that merely looks like a {{template}}.
func (r *Registry) Names() []string {
	names := make([]string, 0, len(r.byName))
	for name := range r.byName {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

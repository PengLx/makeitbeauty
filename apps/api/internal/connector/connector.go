// Package connector implements the connector layer: a registry of data
// connectors, the per-(user, connector) snapshot cache with
// stale-while-revalidate semantics, and the field filtering that keeps
// components on a filtered view of snapshot data (the security boundary of
// architecture.md §6/§9 — components never see tokens or unbound fields).
package connector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/crypto"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/fixture"
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

// FieldsFor returns the typed field catalog of a connector name — the single
// source of truth behind GET /v1/connectors' picker lists and the binding
// consent display. Unknown names yield nil.
func FieldsFor(name string) []Field {
	switch name {
	case "github":
		return GitHubFields
	case "wakatime":
		return WakaTimeFields
	case "leetcode":
		return LeetCodeFields
	case "rss":
		return RSSFields
	}
	return nil
}

// ---- config-account framework ---------------------------------------------
// Non-OAuth connectors (auth tiers none/api_key, architecture.md §6) are
// configured by the user pasting a small config object once:
// PUT /v1/connectors/{name}/account. The config is sealed into
// ConnectorAccount.EncryptedCredentials exactly like OAuth credentials — an
// API key is a credential, and a feed URL rides along under the same seal so
// there is exactly one at-rest story for account state.

// AccountConfig is the per-user configuration of a config-tier connector.
// Implementations are plain JSON structs; Validate rejects malformed input
// before it is sealed and stored.
type AccountConfig interface {
	Validate() error
}

// ConnectValidator is the optional deeper check an AccountConfig may
// implement on top of Validate: it runs once at connect time
// (PUT /v1/connectors/{name}/account), may perform I/O such as DNS lookups,
// and a failure refuses the configuration before anything is stored.
type ConnectValidator interface {
	ValidateConnect(ctx context.Context) error
}

// NewAccountConfig returns an empty config value for a config-tier connector
// name, ready for strict JSON decoding, or ok=false for OAuth-tier ("github")
// and unknown names.
func NewAccountConfig(name string) (AccountConfig, bool) {
	switch name {
	case "wakatime":
		return &WakaTimeConfig{}, true
	case "leetcode":
		return &LeetCodeConfig{}, true
	case "rss":
		return &RSSConfig{}, true
	}
	return nil, false
}

// openAccountConfig unseals and decodes a connector account's config into
// dst. Shared by the config-tier connectors' Fetch implementations.
func openAccountConfig(sealer crypto.Sealer, name string, account *store.ConnectorAccount, dst any) error {
	if sealer == nil {
		return fmt.Errorf("connector: %s: account has config but no sealer is configured", name)
	}
	raw, err := sealer.Open(account.EncryptedCredentials)
	if err != nil {
		return fmt.Errorf("connector: %s: opening account config: %w", name, err)
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return fmt.Errorf("connector: %s: account config is not valid JSON: %w", name, err)
	}
	return nil
}

// loadFixture loads one connector's dev-fixture snapshot from the merged demo
// document ({"github": {...}, "wakatime": {...}, ...}) under key. An empty
// path means no fixture — the production posture: an unconfigured connector
// then serves an EMPTY snapshot, so designs binding its fields render
// em-dashes instead of demo data. A present file without the key degrades to
// the same empty snapshot rather than failing boot.
func loadFixture(path, key string) (map[string]any, error) {
	if path == "" {
		return nil, nil
	}
	var doc map[string]map[string]any
	if err := fixture.LoadJSON(path, &doc); err != nil {
		return nil, err
	}
	if inner := doc[key]; inner != nil {
		return inner, nil
	}
	return map[string]any{}, nil
}

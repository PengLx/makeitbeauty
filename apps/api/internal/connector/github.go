package connector

import (
	"context"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/fixture"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// GitHub is the scaffold's GitHub connector. The real implementation talks to
// the GitHub App REST/GraphQL APIs with per-user tokens; this stub returns the
// demo fixture so the full render path (cache → filter → renderer) is
// exercised end to end. The cache/SWR machinery around it is production code.
type GitHub struct {
	snapshot map[string]any
}

// NewGitHubStub loads the fixture at path (see internal/fixture for path
// resolution). The fixture is the merged-data shape keyed by connector name
// ({"github": {...}}); the inner object is this connector's snapshot.
func NewGitHubStub(path string) (*GitHub, error) {
	var doc map[string]any
	if err := fixture.LoadJSON(path, &doc); err != nil {
		return nil, err
	}
	if inner, ok := doc["github"].(map[string]any); ok {
		doc = inner
	}
	return &GitHub{snapshot: doc}, nil
}

// Name implements Connector.
func (g *GitHub) Name() string { return "github" }

// SnapshotTTL implements Connector. Mirrors the manifest value the real
// connector will declare (snapshotTtlSeconds).
func (g *GitHub) SnapshotTTL() time.Duration { return 15 * time.Minute }

// Fetch implements Connector. The stub ignores the account and returns the
// fixture; callers must treat the result as read-only.
func (g *GitHub) Fetch(_ context.Context, _ *store.ConnectorAccount) (map[string]any, error) {
	return g.snapshot, nil
}

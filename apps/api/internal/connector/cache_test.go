package connector

import (
	"context"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// scriptedConnector serves pre-scripted snapshots in order. When block is
// set, a Fetch waits on it and returns the "late" marker instead — the shape
// of an in-flight revalidation racing an Invalidate.
type scriptedConnector struct {
	name string
	ttl  time.Duration

	mu      sync.Mutex
	results []map[string]any
	fetched int
	block   chan struct{}
}

func (c *scriptedConnector) Name() string               { return c.name }
func (c *scriptedConnector) SnapshotTTL() time.Duration { return c.ttl }

func (c *scriptedConnector) Fetch(context.Context, *store.ConnectorAccount) (map[string]any, error) {
	c.mu.Lock()
	block := c.block
	c.mu.Unlock()
	if block != nil {
		<-block
		return map[string]any{"src": "late"}, nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	i := c.fetched
	if i >= len(c.results) {
		i = len(c.results) - 1
	}
	c.fetched++
	return c.results[i], nil
}

func (c *scriptedConnector) setBlock(ch chan struct{}) {
	c.mu.Lock()
	c.block = ch
	c.mu.Unlock()
}

func snapshotSrc(t *testing.T, cache *SnapshotCache, name string) string {
	t.Helper()
	data, err := cache.Snapshot(context.Background(), "u1", name, nil)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	src, _ := data["src"].(string)
	return src
}

// Invalidate must drop the cached entry: the next Snapshot refetches instead
// of serving the (still fresh) old data for up to a TTL.
func TestSnapshotCacheInvalidateDropsEntry(t *testing.T) {
	conn := &scriptedConnector{name: "c", ttl: time.Hour, results: []map[string]any{
		{"src": "v1"}, {"src": "v2"},
	}}
	registry := NewRegistry()
	registry.Register(conn)
	cache := NewSnapshotCache(registry, slog.New(slog.DiscardHandler))

	if got := snapshotSrc(t, cache, "c"); got != "v1" {
		t.Fatalf("first Snapshot = %q, want v1", got)
	}
	if got := snapshotSrc(t, cache, "c"); got != "v1" {
		t.Fatalf("cached Snapshot = %q, want v1 (fresh entry must serve)", got)
	}

	cache.Invalidate("u1", "c")
	if got := snapshotSrc(t, cache, "c"); got != "v2" {
		t.Fatalf("Snapshot after Invalidate = %q, want v2 (refetched)", got)
	}

	// Scoped: a different (user, connector) key is untouched.
	cache.Invalidate("someone-else", "c")
	cache.Invalidate("u1", "other")
	if got := snapshotSrc(t, cache, "c"); got != "v2" {
		t.Fatalf("Snapshot after foreign Invalidate = %q, want cached v2", got)
	}
}

// A background revalidation that started before Invalidate must not write its
// (old-account) result back over the invalidation.
func TestSnapshotCacheInvalidateDiscardsLateRevalidation(t *testing.T) {
	conn := &scriptedConnector{name: "c", ttl: time.Minute, results: []map[string]any{
		{"src": "v1"}, {"src": "v3"},
	}}
	registry := NewRegistry()
	registry.Register(conn)
	cache := NewSnapshotCache(registry, slog.New(slog.DiscardHandler))

	now := time.Now()
	cache.now = func() time.Time { return now }

	if got := snapshotSrc(t, cache, "c"); got != "v1" {
		t.Fatalf("first Snapshot = %q, want v1", got)
	}

	// Make the entry stale and gate the next fetch so the background
	// revalidation is provably in flight when Invalidate runs.
	now = now.Add(2 * time.Minute)
	release := make(chan struct{})
	conn.setBlock(release)
	if got := snapshotSrc(t, cache, "c"); got != "v1" {
		t.Fatalf("stale Snapshot = %q, want stale v1 while revalidating", got)
	}

	cache.Invalidate("u1", "c")
	conn.setBlock(nil) // subsequent fetches pop the script again
	close(release)     // let the in-flight revalidation deliver "late"

	// The invalidated key must cold-fetch v3; the "late" result — whenever
	// its goroutine lands — is discarded by the generation guard.
	if got := snapshotSrc(t, cache, "c"); got != "v3" {
		t.Fatalf("Snapshot after Invalidate = %q, want cold-fetched v3", got)
	}
	time.Sleep(20 * time.Millisecond) // give the late writer every chance
	if got := snapshotSrc(t, cache, "c"); got != "v3" {
		t.Fatalf("final Snapshot = %q, want v3 (late write discarded)", got)
	}

	// The guard itself, deterministically: a write carrying a
	// pre-invalidation generation is dropped on the floor.
	key := cacheKey{userID: "u1", connector: "c"}
	cache.mu.Lock()
	gen := cache.gen[key]
	cache.mu.Unlock()
	cache.storeEntry(key, gen-1, time.Hour, map[string]any{"src": "stale-gen"})
	if got := snapshotSrc(t, cache, "c"); got != "v3" {
		t.Fatalf("Snapshot after stale-generation store = %q, want v3", got)
	}
}

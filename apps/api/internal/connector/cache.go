package connector

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// SnapshotCache caches connector snapshots per (user, connector) with the
// connector's manifest TTL and stale-while-revalidate semantics: once a
// snapshot exists, renders are always served from cache — a stale entry is
// returned immediately while a single background refresh runs. An upstream
// rate limit or expired token therefore serves stale data instead of failing
// a render (architecture.md §6). Only a cold miss blocks on the upstream.
type SnapshotCache struct {
	registry     *Registry
	log          *slog.Logger
	now          func() time.Time // injectable clock for tests
	fetchTimeout time.Duration    // budget for background revalidation fetches

	mu       sync.Mutex
	entries  map[cacheKey]*cacheEntry
	inflight map[cacheKey]struct{} // keys with a background refresh running
	gen      map[cacheKey]uint64   // bumped by Invalidate; discards late writes
}

type cacheKey struct {
	userID    string
	connector string
}

type cacheEntry struct {
	data      map[string]any
	fetchedAt time.Time
	ttl       time.Duration
}

func (e *cacheEntry) fresh(now time.Time) bool {
	return now.Sub(e.fetchedAt) < e.ttl
}

// KnownConnectors returns the names of all registered connectors, sorted.
func (c *SnapshotCache) KnownConnectors() []string {
	return c.registry.Names()
}

// NewSnapshotCache returns an empty cache backed by the given registry.
func NewSnapshotCache(registry *Registry, log *slog.Logger) *SnapshotCache {
	return &SnapshotCache{
		registry:     registry,
		log:          log,
		now:          time.Now,
		fetchTimeout: 20 * time.Second,
		entries:      map[cacheKey]*cacheEntry{},
		inflight:     map[cacheKey]struct{}{},
		gen:          map[cacheKey]uint64{},
	}
}

// Invalidate drops the cached snapshot for (userID, connectorName) and bumps
// the key's generation so any in-flight fetch that started under the old
// account discards its result. Called when the account changes — connect,
// reconfigure, disconnect — because what Fetch returns depends on the
// account, and the old snapshot must not keep serving for up to a TTL.
func (c *SnapshotCache) Invalidate(userID, connectorName string) {
	key := cacheKey{userID: userID, connector: connectorName}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.gen[key]++
	delete(c.entries, key)
}

// Snapshot returns the snapshot for (userID, connectorName), fetching on a
// cold miss and revalidating stale entries in the background. The returned
// map must be treated as read-only by callers (Filter copies out of it).
func (c *SnapshotCache) Snapshot(ctx context.Context, userID, connectorName string, account *store.ConnectorAccount) (map[string]any, error) {
	conn, ok := c.registry.Get(connectorName)
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnknown, connectorName)
	}
	key := cacheKey{userID: userID, connector: connectorName}

	c.mu.Lock()
	if e, ok := c.entries[key]; ok {
		if !e.fresh(c.now()) {
			c.revalidateLocked(key, conn, account)
		}
		data := e.data
		c.mu.Unlock()
		return data, nil
	}
	gen := c.gen[key]
	c.mu.Unlock()

	// Cold miss: fetch synchronously — there is nothing stale to serve.
	// Concurrent cold misses may fetch twice; harmless for a cache warm-up.
	data, err := conn.Fetch(ctx, account)
	if err != nil {
		return nil, fmt.Errorf("connector %q: fetch: %w", connectorName, err)
	}
	c.storeEntry(key, gen, conn.SnapshotTTL(), data)
	return data, nil
}

// revalidateLocked starts a background refresh for key unless one is already
// running. Caller must hold c.mu.
func (c *SnapshotCache) revalidateLocked(key cacheKey, conn Connector, account *store.ConnectorAccount) {
	if _, running := c.inflight[key]; running {
		return
	}
	c.inflight[key] = struct{}{}
	gen := c.gen[key]

	go func() {
		// Detached from the request context on purpose: the render that
		// triggered revalidation is served from stale data and must not be
		// tied to this fetch.
		ctx, cancel := context.WithTimeout(context.Background(), c.fetchTimeout)
		defer cancel()

		data, err := conn.Fetch(ctx, account)

		c.mu.Lock()
		delete(c.inflight, key)
		c.mu.Unlock()

		if err != nil {
			// Keep serving stale data; the next stale hit retries.
			c.log.Warn("snapshot revalidation failed; serving stale",
				"connector", key.connector, "user", key.userID, "err", err)
			return
		}
		c.storeEntry(key, gen, conn.SnapshotTTL(), data)
	}()
}

// storeEntry caches data for key unless the key was invalidated (generation
// bumped) after the fetch began — a snapshot fetched under an account that
// has since changed must not resurrect itself past the invalidation.
func (c *SnapshotCache) storeEntry(key cacheKey, gen uint64, ttl time.Duration, data map[string]any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.gen[key] != gen {
		return
	}
	c.entries[key] = &cacheEntry{data: data, fetchedAt: c.now(), ttl: ttl}
}

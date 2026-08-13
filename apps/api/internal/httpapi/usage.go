package httpapi

import (
	"context"
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// Usage of a community component = the number of DISTINCT projects currently
// referencing it at any pinned version (architecture.md §8) — an honest,
// unfakeable popularity signal: it only grows when a real design actually
// uses the component and shrinks when designs stop.
//
// The counters are derived state, never persisted. Every project carries
// ComponentRefs (unversioned refs recomputed from its design on every
// write); the index here is rebuilt from those refs at boot — O(projects),
// once — then maintained incrementally from ref diffs on project
// create/update/delete. This was chosen deliberately over a persisted Usage
// store: zero new persistence to migrate or corrupt, and any drift (a crash
// between a store write and an index update) self-heals on the next restart.

// componentRefPattern matches an unversioned community component reference
// "{owner}/{name}" (after the "@{n}" pin is stripped).
var componentRefPattern = regexp.MustCompile(`^[a-z0-9-]{1,64}/[a-z0-9-]{1,64}$`)

// designComponentRefs derives Project.ComponentRefs from a design: every
// instance node's community component reference with the "@{n}" pin
// stripped, kit/* excluded (official-kit usage is not a community metric),
// deduped and sorted so ref diffs and the persisted form are deterministic.
// Malformed references contribute nothing, and an unparseable design yields
// nil — schema validation is the renderer's job.
func designComponentRefs(design json.RawMessage) []string {
	seen := map[string]bool{}
	for _, ref := range instanceComponents(design) {
		base, _, _ := strings.Cut(ref, "@")
		if strings.HasPrefix(base, "kit/") || !componentRefPattern.MatchString(base) {
			continue
		}
		seen[base] = true
	}
	if len(seen) == 0 {
		return nil
	}
	refs := make([]string, 0, len(seen))
	for ref := range seen {
		refs = append(refs, ref)
	}
	sort.Strings(refs)
	return refs
}

// usageIndex counts distinct referencing projects per community component id.
// All methods are safe for concurrent use.
type usageIndex struct {
	mu    sync.Mutex
	built bool
	count map[string]int // component id → distinct projects; zeros are deleted
}

func newUsageIndex() *usageIndex { return &usageIndex{} }

// ensure builds the index from every project's persisted ComponentRefs if it
// is not built yet. Boot calls this before serving (Server.BuildUsageIndex);
// the lazy path exists for direct-constructed servers in tests — a first
// build racing concurrent project writes could miss one diff, which is
// exactly the drift class a restart heals.
func (x *usageIndex) ensure(ctx context.Context, projects store.Projects) error {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.built {
		return nil
	}
	list, err := projects.List(ctx)
	if err != nil {
		return err
	}
	count := map[string]int{}
	for _, p := range list {
		// ComponentRefs is deduped per project, so ++ counts distinct projects.
		for _, ref := range p.ComponentRefs {
			count[ref]++
		}
	}
	x.count, x.built = count, true
	return nil
}

// apply moves the index across one project write: create is (nil → refs),
// delete is (refs → nil), update diffs the stored refs against the new ones.
// Before the boot build this is a deliberate no-op — the pending ensure()
// reads the store, which already contains the write.
func (x *usageIndex) apply(oldRefs, newRefs []string) {
	x.mu.Lock()
	defer x.mu.Unlock()
	if !x.built {
		return
	}
	removed := make(map[string]bool, len(oldRefs))
	for _, ref := range oldRefs {
		removed[ref] = true
	}
	for _, ref := range newRefs {
		if removed[ref] {
			delete(removed, ref) // present before and after: unchanged
			continue
		}
		x.count[ref]++
	}
	for ref := range removed {
		if x.count[ref] <= 1 {
			delete(x.count, ref) // never keep zeros: get() defaults to 0
		} else {
			x.count[ref]--
		}
	}
}

// get returns the usage count for one component id (0 when unreferenced).
func (x *usageIndex) get(componentID string) int {
	x.mu.Lock()
	defer x.mu.Unlock()
	return x.count[componentID]
}

// BuildUsageIndex builds the community-component usage index from every
// project's persisted ComponentRefs — called at boot, before the server
// accepts traffic (architecture.md §8).
func (s *Server) BuildUsageIndex(ctx context.Context) error {
	return s.usage.ensure(ctx, s.stores.Projects)
}

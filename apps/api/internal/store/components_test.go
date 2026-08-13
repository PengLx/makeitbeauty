package store

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

// Both implementations must behave identically; every subtest runs against
// memory and file-backed stores.
func componentStores(t *testing.T) map[string]func(t *testing.T) (Stores, func() Stores) {
	t.Helper()
	return map[string]func(t *testing.T) (Stores, func() Stores){
		"memory": func(t *testing.T) (Stores, func() Stores) {
			s := NewMemory()
			return s, func() Stores { return s } // no restart semantics
		},
		"file": func(t *testing.T) (Stores, func() Stores) {
			s, dir := newFileStores(t)
			return s, func() Stores { return reopen(t, dir) }
		},
	}
}

func TestComponentStoreRoundTrip(t *testing.T) {
	for name, open := range componentStores(t) {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			stores, restart := open(t)
			now := time.Date(2026, 8, 12, 12, 0, 0, 0, time.UTC)

			component := &Component{
				ID: "alice/glow-card", OwnerID: "u1", Title: "Glow card",
				Description: "A glowing card.",
				Category:    "stats",
				Kind:        "code", // §7.6 sandboxed code component
				Draft:       json.RawMessage(`{"id":"glow-card","title":"Glow card","frame":{"w":260,"h":140},"props":{},"nodes":[]}`),
				CreatedAt:   now, UpdatedAt: now,
			}
			if err := stores.Components.Create(ctx, component); err != nil {
				t.Fatal(err)
			}
			// The id is a permanent namespace claim: re-creating is refused.
			if err := stores.Components.Create(ctx, &Component{ID: "alice/glow-card", OwnerID: "u2"}); !errors.Is(err, ErrExists) {
				t.Errorf("duplicate Create = %v, want ErrExists", err)
			}

			if err := stores.ComponentVersions.Create(ctx, &ComponentVersion{
				ComponentID: "alice/glow-card", Version: 1,
				Definition:  json.RawMessage(`{"id":"alice/glow-card@1"}`),
				PublishedAt: now,
			}); err != nil {
				t.Fatal(err)
			}
			component.LatestVersion = 1
			component.UpdatedAt = now.Add(time.Minute)
			if err := stores.Components.Update(ctx, component); err != nil {
				t.Fatal(err)
			}
			if err := stores.Components.Update(ctx, &Component{ID: "alice/ghost"}); !errors.Is(err, ErrNotFound) {
				t.Errorf("Update(ghost) = %v, want ErrNotFound", err)
			}

			reloaded := restart()

			c, err := reloaded.Components.Get(ctx, "alice/glow-card")
			if err != nil {
				t.Fatal(err)
			}
			if c.OwnerID != "u1" || c.Title != "Glow card" || c.Description != "A glowing card." ||
				c.Category != "stats" || c.Kind != "code" ||
				c.LatestVersion != 1 || c.Unlisted || !c.CreatedAt.Equal(now) || !c.UpdatedAt.Equal(now.Add(time.Minute)) {
				t.Errorf("reloaded component = %+v", c)
			}
			if compactJSON(t, c.Draft) != compactJSON(t, component.Draft) {
				t.Errorf("draft round-trip mismatch: %s", c.Draft)
			}
			if _, err := reloaded.Components.Get(ctx, "alice/ghost"); !errors.Is(err, ErrNotFound) {
				t.Errorf("Get(ghost) = %v, want ErrNotFound", err)
			}

			mine, err := reloaded.Components.ListByOwner(ctx, "u1")
			if err != nil || len(mine) != 1 || mine[0].ID != "alice/glow-card" {
				t.Errorf("ListByOwner = %v, %v", mine, err)
			}
			other, err := reloaded.Components.ListByOwner(ctx, "u2")
			if err != nil || len(other) != 0 {
				t.Errorf("ListByOwner(u2) = %v, %v (want empty, not error)", other, err)
			}
			all, err := reloaded.Components.List(ctx)
			if err != nil || len(all) != 1 {
				t.Errorf("List = %v, %v", all, err)
			}

			v, err := reloaded.ComponentVersions.Get(ctx, "alice/glow-card", 1)
			if err != nil {
				t.Fatal(err)
			}
			if v.Version != 1 || !v.PublishedAt.Equal(now) || compactJSON(t, v.Definition) != compactJSON(t, json.RawMessage(`{"id":"alice/glow-card@1"}`)) {
				t.Errorf("reloaded version = %+v", v)
			}
			if _, err := reloaded.ComponentVersions.Get(ctx, "alice/glow-card", 2); !errors.Is(err, ErrNotFound) {
				t.Errorf("Get(v2) = %v, want ErrNotFound", err)
			}
		})
	}
}

// Versions are immutable: the interface exposes no update or delete, and
// Create refuses to replace an existing (componentId, version) — even across
// a restart, the original definition survives any overwrite attempt.
func TestComponentVersionsImmutable(t *testing.T) {
	for name, open := range componentStores(t) {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			stores, restart := open(t)
			now := time.Now().UTC().Truncate(time.Second)

			original := json.RawMessage(`{"id":"alice/x@1","title":"original"}`)
			if err := stores.ComponentVersions.Create(ctx, &ComponentVersion{
				ComponentID: "alice/x", Version: 1, Definition: original, PublishedAt: now,
			}); err != nil {
				t.Fatal(err)
			}

			err := stores.ComponentVersions.Create(ctx, &ComponentVersion{
				ComponentID: "alice/x", Version: 1,
				Definition:  json.RawMessage(`{"id":"alice/x@1","title":"MALICIOUS UPDATE"}`),
				PublishedAt: now.Add(time.Hour),
			})
			if !errors.Is(err, ErrExists) {
				t.Fatalf("overwriting a frozen version = %v, want ErrExists", err)
			}
			// Same version number under a different component is fine.
			if err := stores.ComponentVersions.Create(ctx, &ComponentVersion{
				ComponentID: "alice/y", Version: 1, Definition: json.RawMessage(`{}`), PublishedAt: now,
			}); err != nil {
				t.Fatal(err)
			}

			reloaded := restart()
			v, err := reloaded.ComponentVersions.Get(ctx, "alice/x", 1)
			if err != nil {
				t.Fatal(err)
			}
			if compactJSON(t, v.Definition) != compactJSON(t, original) || !v.PublishedAt.Equal(now) {
				t.Errorf("frozen version changed: %s (publishedAt %v)", v.Definition, v.PublishedAt)
			}
		})
	}
}

func TestComponentVersionsListAscending(t *testing.T) {
	ctx := context.Background()
	stores := NewMemory()
	now := time.Now().UTC()

	for _, n := range []int{2, 1, 3} { // insertion order is not version order
		if err := stores.ComponentVersions.Create(ctx, &ComponentVersion{
			ComponentID: "alice/x", Version: n, Definition: json.RawMessage(`{}`), PublishedAt: now,
		}); err != nil {
			t.Fatal(err)
		}
	}
	versions, err := stores.ComponentVersions.ListByComponent(ctx, "alice/x")
	if err != nil {
		t.Fatal(err)
	}
	if len(versions) != 3 || versions[0].Version != 1 || versions[1].Version != 2 || versions[2].Version != 3 {
		t.Errorf("versions out of order: %+v", versions)
	}
	empty, err := stores.ComponentVersions.ListByComponent(ctx, "alice/ghost")
	if err != nil || len(empty) != 0 {
		t.Errorf("ListByComponent(ghost) = %v, %v (want empty, not error)", empty, err)
	}
}

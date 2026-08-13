package store

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// Favorites must behave identically in memory and on disk, and survive a
// restart of the file store (favorites.json).
func TestFavoritesStoreRoundTrip(t *testing.T) {
	for name, open := range componentStores(t) {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			stores, restart := open(t)
			now := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)

			set := func(user, component string, at time.Time) {
				t.Helper()
				if err := stores.Favorites.Set(ctx, &Favorite{UserID: user, ComponentID: component, CreatedAt: at}); err != nil {
					t.Fatal(err)
				}
			}
			set("u1", "alice/card", now)
			set("u1", "alice/badge", now.Add(time.Minute))
			set("u2", "alice/card", now.Add(2*time.Minute))
			// Idempotent Set: the pair exists, the original CreatedAt stands.
			set("u1", "alice/card", now.Add(time.Hour))

			if n, err := stores.Favorites.CountByComponent(ctx, "alice/card"); err != nil || n != 2 {
				t.Errorf("CountByComponent(card) = %d, %v, want 2", n, err)
			}
			if n, err := stores.Favorites.CountByComponent(ctx, "alice/ghost"); err != nil || n != 0 {
				t.Errorf("CountByComponent(ghost) = %d, %v, want 0 (unknown counts 0, not error)", n, err)
			}

			list, err := stores.Favorites.ListByUser(ctx, "u1")
			if err != nil || len(list) != 2 {
				t.Fatalf("ListByUser(u1) = %v, %v, want 2 rows", list, err)
			}
			for _, f := range list {
				if f.ComponentID == "alice/card" && !f.CreatedAt.Equal(now) {
					t.Errorf("re-Set overwrote CreatedAt: %v, want %v", f.CreatedAt, now)
				}
			}
			if list, err := stores.Favorites.ListByUser(ctx, "u3"); err != nil || len(list) != 0 {
				t.Errorf("ListByUser(u3) = %v, %v, want empty", list, err)
			}

			// Batched membership: every queried id gets an entry.
			got, err := stores.Favorites.IsFavorited(ctx, "u1", "alice/card", "alice/badge", "alice/ghost")
			if err != nil {
				t.Fatal(err)
			}
			if !got["alice/card"] || !got["alice/badge"] || got["alice/ghost"] {
				t.Errorf("IsFavorited(u1) = %v", got)
			}
			if v, present := got["alice/ghost"]; !present || v {
				t.Errorf("queried id missing from result: %v", got)
			}

			// Unset is idempotent: removing twice is fine.
			if err := stores.Favorites.Unset(ctx, "u1", "alice/badge"); err != nil {
				t.Fatal(err)
			}
			if err := stores.Favorites.Unset(ctx, "u1", "alice/badge"); err != nil {
				t.Errorf("second Unset = %v, want nil (idempotent)", err)
			}
			if n, _ := stores.Favorites.CountByComponent(ctx, "alice/badge"); n != 0 {
				t.Errorf("count after Unset = %d, want 0", n)
			}

			reloaded := restart()
			if n, err := reloaded.Favorites.CountByComponent(ctx, "alice/card"); err != nil || n != 2 {
				t.Errorf("count after restart = %d, %v, want 2", n, err)
			}
			got, err = reloaded.Favorites.IsFavorited(ctx, "u1", "alice/card", "alice/badge")
			if err != nil || !got["alice/card"] || got["alice/badge"] {
				t.Errorf("IsFavorited after restart = %v, %v", got, err)
			}
		})
	}
}

// favorites.json is the durable copy: it exists after a write and never
// stores anything but (userId, componentId, createdAt) rows.
func TestFavoritesFilePinned(t *testing.T) {
	ctx := context.Background()
	stores, dir := newFileStores(t)
	now := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)
	if err := stores.Favorites.Set(ctx, &Favorite{UserID: "u1", ComponentID: "alice/card", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "favorites.json"))
	if err != nil {
		t.Fatal(err)
	}
	var records []map[string]any
	if err := json.Unmarshal(b, &records); err != nil {
		t.Fatalf("favorites.json is not a JSON array: %v", err)
	}
	if len(records) != 1 || records[0]["userId"] != "u1" || records[0]["componentId"] != "alice/card" {
		t.Errorf("favorites.json = %s", b)
	}
}

// Projects.List returns every project regardless of owner (the usage-index
// boot source), and ComponentRefs round-trips through the file store.
func TestProjectsListAndComponentRefsRoundTrip(t *testing.T) {
	for name, open := range componentStores(t) {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			stores, restart := open(t)
			now := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)

			design := json.RawMessage(`{"version":0,"canvas":{"width":1,"height":1},"nodes":[]}`)
			for _, p := range []*Project{
				{ID: "p1", UserID: "u1", Name: "One", Design: design,
					ComponentRefs: []string{"alice/card", "bob/badge"}, CreatedAt: now, UpdatedAt: now},
				{ID: "p2", UserID: "u2", Name: "Two", Design: design,
					ComponentRefs: []string{"alice/card"}, CreatedAt: now, UpdatedAt: now},
				{ID: "p3", UserID: "u2", Name: "Three", Design: design, CreatedAt: now, UpdatedAt: now},
			} {
				if err := stores.Projects.Create(ctx, p); err != nil {
					t.Fatal(err)
				}
			}

			reloaded := restart()
			list, err := reloaded.Projects.List(ctx)
			if err != nil || len(list) != 3 {
				t.Fatalf("List = %d projects, %v, want 3", len(list), err)
			}
			ids := []string{}
			for _, p := range list {
				ids = append(ids, p.ID)
			}
			sort.Strings(ids)
			if strings.Join(ids, ",") != "p1,p2,p3" {
				t.Errorf("List ids = %v", ids)
			}

			p1, err := reloaded.Projects.Get(ctx, "p1")
			if err != nil {
				t.Fatal(err)
			}
			if strings.Join(p1.ComponentRefs, ",") != "alice/card,bob/badge" {
				t.Errorf("p1.ComponentRefs = %v, want [alice/card bob/badge]", p1.ComponentRefs)
			}
			p3, err := reloaded.Projects.Get(ctx, "p3")
			if err != nil || len(p3.ComponentRefs) != 0 {
				t.Errorf("p3.ComponentRefs = %v, %v, want empty", p3.ComponentRefs, err)
			}
		})
	}
}

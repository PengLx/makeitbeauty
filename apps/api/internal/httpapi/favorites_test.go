package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// ---- PUT/DELETE /v1/components/{owner}/{name}/favorite -----------------------

func TestFavoriteLifecycle(t *testing.T) {
	s, h := newTestServer(t)
	ctx := context.Background()
	seedComponent(t, s, "dev/card", "dev", "Card", "", 1, false, time.Now().UTC())

	count := func() int {
		t.Helper()
		n, err := s.stores.Favorites.CountByComponent(ctx, "dev/card")
		if err != nil {
			t.Fatal(err)
		}
		return n
	}

	// Set, then set again: idempotent 204s, one favorite.
	for i := range 2 {
		rec := doJSON(t, h, http.MethodPut, "/v1/components/dev/card/favorite", "")
		if rec.Code != http.StatusNoContent {
			t.Fatalf("PUT #%d status = %d, body = %s", i+1, rec.Code, rec.Body.String())
		}
	}
	if count() != 1 {
		t.Fatalf("favorite count after double set = %d, want 1", count())
	}

	// Unset, then unset again: idempotent 204s, zero favorites.
	for i := range 2 {
		rec := doJSON(t, h, http.MethodDelete, "/v1/components/dev/card/favorite", "")
		if rec.Code != http.StatusNoContent {
			t.Fatalf("DELETE #%d status = %d, body = %s", i+1, rec.Code, rec.Body.String())
		}
	}
	if count() != 0 {
		t.Fatalf("favorite count after double unset = %d, want 0", count())
	}
}

// Favoriting requires a published component; drafts, unknown ids, and (to
// non-owners) unlisted ones are the same 404 as the public detail route.
func TestFavoriteVisibilityMatrix(t *testing.T) {
	s, h := newVisibilityServer(t) // alice/pub published, alice/hidden unlisted, alice/wip draft-only
	owner := sessionCookie(t, s, "u-alice")
	if err := s.stores.Users.Create(context.Background(), &store.User{
		ID: "u-bob", Login: "bob", CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	bob := sessionCookie(t, s, "u-bob")

	tests := []struct {
		name       string
		path       string
		cookie     *http.Cookie
		wantStatus int
	}{
		{"published favoritable", "/v1/components/alice/pub/favorite", bob, http.StatusNoContent},
		{"draft-only 404s", "/v1/components/alice/wip/favorite", bob, http.StatusNotFound},
		{"unknown 404s", "/v1/components/alice/ghost/favorite", bob, http.StatusNotFound},
		{"unlisted 404s for non-owners", "/v1/components/alice/hidden/favorite", bob, http.StatusNotFound},
		{"unlisted stays favoritable for the owner", "/v1/components/alice/hidden/favorite", owner, http.StatusNoContent},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := doJSONAs(t, h, http.MethodPut, tt.path, "", tt.cookie)
			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, tt.wantStatus, rec.Body.String())
			}
		})
	}

	// All favorite routes require a session.
	for _, c := range []struct{ method, path string }{
		{http.MethodPut, "/v1/components/alice/pub/favorite"},
		{http.MethodDelete, "/v1/components/alice/pub/favorite"},
		{http.MethodGet, "/v1/components/favorites"},
	} {
		rec := doJSONAs(t, h, c.method, c.path, "", nil)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s anonymous: status = %d, want 401", c.method, c.path, rec.Code)
		}
	}
}

// ---- GET /v1/components/favorites ---------------------------------------------

func TestListFavorites(t *testing.T) {
	s, h := newVisibilityServer(t)
	ctx := context.Background()
	now := time.Now().UTC()
	if err := s.stores.Users.Create(ctx, &store.User{ID: "u-bob", Login: "bob", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	bob := sessionCookie(t, s, "u-bob")
	seedComponent(t, s, "alice/extra", "u-alice", "Extra", "", 1, false, now)

	// Direct store seeding controls CreatedAt ordering; the ghost row
	// simulates a favorite whose component vanished from the registry.
	for _, f := range []store.Favorite{
		{UserID: "u-bob", ComponentID: "alice/pub", CreatedAt: now.Add(-time.Hour)},
		{UserID: "u-bob", ComponentID: "alice/extra", CreatedAt: now},
		{UserID: "u-bob", ComponentID: "ghost/none", CreatedAt: now.Add(time.Hour)},
		{UserID: "u-alice", ComponentID: "alice/extra", CreatedAt: now}, // someone else's favorite
	} {
		if err := s.stores.Favorites.Set(ctx, &f); err != nil {
			t.Fatal(err)
		}
	}

	rec := doJSONAs(t, h, http.MethodGet, "/v1/components/favorites", "", bob)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Components []struct {
			ID            string     `json:"id"`
			PublishedAt   *time.Time `json:"publishedAt"`
			UsageCount    *int       `json:"usageCount"`
			FavoriteCount *int       `json:"favoriteCount"`
			Favorited     *bool      `json:"favorited"`
			Draft         any        `json:"draft"`
		} `json:"components"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}

	// Vanished component skipped; newest favorite first.
	ids := []string{}
	for _, c := range out.Components {
		ids = append(ids, c.ID)
	}
	if strings.Join(ids, ",") != "alice/extra,alice/pub" {
		t.Fatalf("favorites = %v, want [alice/extra alice/pub] (ghost skipped, newest first)", ids)
	}
	for _, c := range out.Components {
		if c.PublishedAt == nil || c.UsageCount == nil || c.FavoriteCount == nil {
			t.Errorf("%s: missing publishedAt/usageCount/favoriteCount: %s", c.ID, rec.Body.String())
		}
		if c.Favorited == nil || !*c.Favorited {
			t.Errorf("%s: favorited = %v, want true", c.ID, c.Favorited)
		}
		if c.Draft != nil {
			t.Errorf("%s: favorites list leaks a draft", c.ID)
		}
	}
	// alice/extra is favorited by bob AND alice: the count is global.
	if got := *out.Components[0].FavoriteCount; got != 2 {
		t.Errorf("alice/extra favoriteCount = %d, want 2", got)
	}
	if got := *out.Components[1].FavoriteCount; got != 1 {
		t.Errorf("alice/pub favoriteCount = %d, want 1", got)
	}
}

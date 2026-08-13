package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/auth"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// newBrowseSortServer builds a non-dev server (anonymous is truly anonymous)
// with a fixed usage/favorite landscape:
//
//	component    published    usage    favorites    category  description
//	alice/one    base+3h      0        2            —         "Alpha widget."
//	alice/two    base+2h      2        0            stats     "Tiny stat."
//	alice/three  base+1h      1        1            stats     "Alpha meter."
//	alice/four   base+1h      0        0            —         ""            (publishedAt tie with three)
func newBrowseSortServer(t *testing.T) (*Server, http.Handler) {
	t.Helper()
	s, _ := newTestServer(t)
	s.cfg = testConfig()
	s.sessions = auth.NewMemorySessions()
	ctx := context.Background()
	base := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)

	for _, u := range []string{"u-alice", "u-fan", "u-fan2"} {
		if err := s.stores.Users.Create(ctx, &store.User{
			ID: u, Login: strings.TrimPrefix(u, "u-"), CreatedAt: base,
		}); err != nil {
			t.Fatal(err)
		}
	}
	seedComponent(t, s, "alice/one", "u-alice", "One", "Alpha widget.", 1, false, base.Add(3*time.Hour))
	seedCategorizedComponent(t, s, "alice/two", "u-alice", "Two", "Tiny stat.", "stats", 1, false, base.Add(2*time.Hour))
	seedCategorizedComponent(t, s, "alice/three", "u-alice", "Three", "Alpha meter.", "stats", 1, false, base.Add(time.Hour))
	seedComponent(t, s, "alice/four", "u-alice", "Four", "", 1, false, base.Add(time.Hour))

	// Usage: refs are what the index counts (sorted + deduped, like the
	// derivation produces them). two ← p1+p2, three ← p1.
	blank := json.RawMessage(`{"version":0,"canvas":{"width":1,"height":1},"nodes":[]}`)
	for id, refs := range map[string][]string{
		"p1": {"alice/three", "alice/two"},
		"p2": {"alice/two"},
	} {
		if err := s.stores.Projects.Create(ctx, &store.Project{
			ID: id, UserID: "u-alice", Name: id, Design: blank,
			ComponentRefs: refs, CreatedAt: base, UpdatedAt: base,
		}); err != nil {
			t.Fatal(err)
		}
	}

	// Favorites: one ← fan+fan2, three ← fan.
	for _, f := range []store.Favorite{
		{UserID: "u-fan", ComponentID: "alice/one", CreatedAt: base},
		{UserID: "u-fan2", ComponentID: "alice/one", CreatedAt: base},
		{UserID: "u-fan", ComponentID: "alice/three", CreatedAt: base},
	} {
		if err := s.stores.Favorites.Set(ctx, &f); err != nil {
			t.Fatal(err)
		}
	}
	return s, s.Handler()
}

func browseIDs(t *testing.T, h http.Handler, query string, cookie *http.Cookie) []string {
	t.Helper()
	rec := doJSONAs(t, h, http.MethodGet, "/v1/community/components"+query, "", cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("browse%s status = %d, body = %s", query, rec.Code, rec.Body.String())
	}
	var out struct {
		Components []struct {
			ID string `json:"id"`
		} `json:"components"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, len(out.Components))
	for _, c := range out.Components {
		ids = append(ids, c.ID)
	}
	return ids
}

func TestBrowseSortMatrix(t *testing.T) {
	_, h := newBrowseSortServer(t)

	tests := []struct {
		name  string
		query string
		want  string // comma-joined ids in response order
	}{
		// newest: publishedAt desc; three/four tie on publishedAt → id asc.
		{"default is newest", "", "alice/one,alice/two,alice/four,alice/three"},
		{"explicit newest", "?sort=newest", "alice/one,alice/two,alice/four,alice/three"},
		// uses: count desc; one/four tie at 0 → publishedAt desc.
		{"uses", "?sort=uses", "alice/two,alice/three,alice/one,alice/four"},
		// favorites: count desc; two/four tie at 0 → publishedAt desc.
		{"favorites", "?sort=favorites", "alice/one,alice/three,alice/two,alice/four"},
		// Composition: filters cut the set, the sort still orders it.
		{"uses composes with category", "?sort=uses&category=stats", "alice/two,alice/three"},
		{"favorites composes with category", "?sort=favorites&category=stats", "alice/three,alice/two"},
		{"favorites composes with q", "?sort=favorites&q=alpha", "alice/one,alice/three"},
		{"uses composes with q", "?sort=uses&q=alpha", "alice/three,alice/one"},
		{"q with newest keeps publish order", "?q=alpha", "alice/one,alice/three"},
		{"all three compose", "?sort=uses&category=stats&q=tiny", "alice/two"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := strings.Join(browseIDs(t, h, tt.query, nil), ","); got != tt.want {
				t.Errorf("ids = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestBrowseSortInvalid(t *testing.T) {
	_, h := newBrowseSortServer(t)
	rec := doJSONAs(t, h, http.MethodGet, "/v1/community/components?sort=popular", "", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body: %s)", rec.Code, rec.Body.String())
	}
	if code := errorCode(t, rec); code != "invalid_request" {
		t.Errorf("error.code = %q, want invalid_request", code)
	}
}

// Rows always carry usageCount + favoriteCount; favorited appears only with
// a session (resolved best-effort — anonymous browse still works).
func TestBrowseCountsAndFavoritedFlag(t *testing.T) {
	s, h := newBrowseSortServer(t)

	type row struct {
		ID            string `json:"id"`
		UsageCount    *int   `json:"usageCount"`
		FavoriteCount *int   `json:"favoriteCount"`
		Favorited     *bool  `json:"favorited"`
	}
	fetch := func(cookie *http.Cookie) map[string]row {
		t.Helper()
		rec := doJSONAs(t, h, http.MethodGet, "/v1/community/components", "", cookie)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
		}
		var out struct {
			Components []row `json:"components"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		rows := map[string]row{}
		for _, c := range out.Components {
			rows[c.ID] = c
		}
		return rows
	}

	// Anonymous: counts always present (zeros included), favorited absent.
	rows := fetch(nil)
	wantCounts := map[string][2]int{ // id → {usage, favorites}
		"alice/one": {0, 2}, "alice/two": {2, 0}, "alice/three": {1, 1}, "alice/four": {0, 0},
	}
	for id, want := range wantCounts {
		r, ok := rows[id]
		if !ok {
			t.Fatalf("row %s missing", id)
		}
		if r.UsageCount == nil || *r.UsageCount != want[0] {
			t.Errorf("%s usageCount = %v, want %d", id, r.UsageCount, want[0])
		}
		if r.FavoriteCount == nil || *r.FavoriteCount != want[1] {
			t.Errorf("%s favoriteCount = %v, want %d", id, r.FavoriteCount, want[1])
		}
		if r.Favorited != nil {
			t.Errorf("%s: anonymous browse must omit favorited, got %v", id, *r.Favorited)
		}
	}

	// With a session: favorited present on every row, true only where set.
	rows = fetch(sessionCookie(t, s, "u-fan"))
	wantFavorited := map[string]bool{
		"alice/one": true, "alice/two": false, "alice/three": true, "alice/four": false,
	}
	for id, want := range wantFavorited {
		r := rows[id]
		if r.Favorited == nil || *r.Favorited != want {
			t.Errorf("%s favorited = %v, want %v", id, r.Favorited, want)
		}
	}
}

package connector

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/crypto"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// fakeLeetCode scripts POST /graphql: a known username gets the profile
// payload, anything else the matchedUser:null shape LeetCode serves for
// unknown accounts.
type fakeLeetCode struct {
	username string
	body     string // "" => derive from the request; set to force a payload
	status   int    // 0 => 200
}

func (f *fakeLeetCode) server(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /graphql", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Query     string            `json:"query"`
			Variables map[string]string `json:"variables"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("request body is not JSON: %v", err)
		}
		if !strings.Contains(req.Query, "matchedUser") || !strings.Contains(req.Query, "acSubmissionNum") {
			t.Errorf("query missing the public profile selections: %s", req.Query)
		}
		if f.status != 0 {
			w.WriteHeader(f.status)
			return
		}
		if f.body != "" {
			_, _ = w.Write([]byte(f.body))
			return
		}
		if req.Variables["username"] != f.username {
			_, _ = w.Write([]byte(`{"errors": [{"message": "That user does not exist."}], "data": {"matchedUser": null}}`))
			return
		}
		_, _ = w.Write([]byte(`{"data": {"matchedUser": {
			"profile": {"ranking": 8421},
			"submitStatsGlobal": {"acSubmissionNum": [
				{"difficulty": "All", "count": 312},
				{"difficulty": "Easy", "count": 150},
				{"difficulty": "Medium", "count": 130},
				{"difficulty": "Hard", "count": 32}
			]}
		}}}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func newTestLeetCode(t *testing.T, fake *fakeLeetCode) *LeetCode {
	t.Helper()
	srv := fake.server(t)
	l, err := NewLeetCode("", LeetCodeDeps{APIBaseURL: srv.URL, Sealer: crypto.PlainSealer{}})
	if err != nil {
		t.Fatal(err)
	}
	return l
}

func TestLeetCodeFetchWithoutConfigServesFixture(t *testing.T) {
	l, err := NewLeetCode(testFixturePath, LeetCodeDeps{})
	if err != nil {
		t.Fatal(err)
	}
	for name, account := range map[string]*store.ConnectorAccount{
		"nil account":            nil,
		"account without config": {ID: "acct-x", UserID: "dev", Connector: "leetcode", Status: "active"},
	} {
		t.Run(name, func(t *testing.T) {
			snap, err := l.Fetch(context.Background(), account)
			if err != nil {
				t.Fatal(err)
			}
			if got := lookupPath(t, snap, "solved", "total"); got != float64(486) {
				t.Errorf("solved.total = %v, want the fixture value 486", got)
			}
			if got := lookupPath(t, snap, "profile", "ranking"); got != float64(15234) {
				t.Errorf("profile.ranking = %v, want 15234", got)
			}
			assertCatalogResolves(t, LeetCodeFields, snap)
		})
	}
}

func TestLeetCodeFetchUnconfiguredWithoutFixtureIsEmpty(t *testing.T) {
	l, err := NewLeetCode("", LeetCodeDeps{})
	if err != nil {
		t.Fatal(err)
	}
	snap, err := l.Fetch(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if snap == nil || len(snap) != 0 {
		t.Errorf("snapshot = %#v, want empty non-nil map", snap)
	}
}

func TestLeetCodeFetchLiveSnapshot(t *testing.T) {
	l := newTestLeetCode(t, &fakeLeetCode{username: "grace_42"})
	account := sealConfigAccount(t, "leetcode", LeetCodeConfig{Username: "grace_42"})

	snap, err := l.Fetch(context.Background(), account)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]int{"total": 312, "easy": 150, "medium": 130, "hard": 32}
	for key, count := range want {
		if got := lookupPath(t, snap, "solved", key); got != count {
			t.Errorf("solved.%s = %v, want %d", key, got, count)
		}
	}
	if got := lookupPath(t, snap, "profile", "ranking"); got != 8421 {
		t.Errorf("profile.ranking = %v, want 8421", got)
	}
	assertCatalogResolves(t, LeetCodeFields, snap)
}

// An unknown username errors; the SnapshotCache's SWR semantics absorb it by
// serving the last good snapshot stale.
func TestLeetCodeFetchUnknownUsername(t *testing.T) {
	l := newTestLeetCode(t, &fakeLeetCode{username: "grace_42"})
	account := sealConfigAccount(t, "leetcode", LeetCodeConfig{Username: "nobody"})

	if _, err := l.Fetch(context.Background(), account); err == nil {
		t.Fatal("Fetch succeeded for an unknown username")
	}
}

func TestLeetCodeFetchMalformedPayloads(t *testing.T) {
	tests := []struct {
		name string
		fake *fakeLeetCode
	}{
		{"not JSON", &fakeLeetCode{body: "<html>rate limited</html>"}},
		{"http 500", &fakeLeetCode{status: http.StatusInternalServerError}},
		{"matchedUser null without errors", &fakeLeetCode{body: `{"data": {"matchedUser": null}}`}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			l := newTestLeetCode(t, tt.fake)
			account := sealConfigAccount(t, "leetcode", LeetCodeConfig{Username: "someone"})
			if _, err := l.Fetch(context.Background(), account); err == nil {
				t.Fatal("Fetch succeeded on a malformed payload")
			}
		})
	}
}

func TestLeetCodeConfigValidate(t *testing.T) {
	for _, ok := range []string{"grace", "a", "A_b-42", strings.Repeat("x", 40)} {
		if err := (&LeetCodeConfig{Username: ok}).Validate(); err != nil {
			t.Errorf("username %q rejected: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "has space", "semi;colon", "uniçode", strings.Repeat("x", 41)} {
		if err := (&LeetCodeConfig{Username: bad}).Validate(); err == nil {
			t.Errorf("username %q accepted", bad)
		}
	}
}

func TestLeetCodeFieldsCatalogTypes(t *testing.T) {
	want := map[string]string{
		"solved.total":    "number",
		"solved.easy":     "number",
		"solved.medium":   "number",
		"solved.hard":     "number",
		"profile.ranking": "number",
	}
	if len(LeetCodeFields) != len(want) {
		t.Fatalf("LeetCodeFields has %d entries, want %d", len(LeetCodeFields), len(want))
	}
	for _, f := range LeetCodeFields {
		if want[f.Path] == "" {
			t.Errorf("unexpected field %q", f.Path)
		} else if f.Type != want[f.Path] {
			t.Errorf("field %q type = %q, want %q", f.Path, f.Type, want[f.Path])
		}
		if f.Description == "" {
			t.Errorf("field %q has no description", f.Path)
		}
	}
}

package connector

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/crypto"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// sealConfigAccount builds a ConnectorAccount carrying cfg sealed with the
// PlainSealer — the shape PUT /v1/connectors/{name}/account persists. Shared
// by the wakatime, leetcode, and rss connector tests.
func sealConfigAccount(t *testing.T, connectorName string, cfg any) *store.ConnectorAccount {
	t.Helper()
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := crypto.PlainSealer{}.Seal(raw)
	if err != nil {
		t.Fatal(err)
	}
	return &store.ConnectorAccount{
		ID: "acct-1", UserID: "u1", Connector: connectorName,
		EncryptedCredentials: sealed, Status: "active",
	}
}

// assertCatalogResolves checks that every advertised picker field resolves in
// a snapshot — catalog and snapshot shape must never drift.
func assertCatalogResolves(t *testing.T, fields []Field, snapshot map[string]any) {
	t.Helper()
	for _, f := range fields {
		if got := Filter(snapshot, []string{f.Path}); len(got) == 0 {
			t.Errorf("catalog path %q missing from the snapshot", f.Path)
		}
	}
}

// fakeWakaTime scripts the two endpoints the connector touches. Any response
// field left empty serves a valid default.
type fakeWakaTime struct {
	apiKey        string
	statsBody     string // "" => default valid body
	summariesBody string // "" => default valid body
}

const fakeWakaStats = `{"data": {
	"total_seconds": 63000,
	"daily_average": 9000,
	"languages": [
		{"name": "Go", "percent": 52.347},
		{"name": "TypeScript", "percent": 30.05},
		{"name": "Rust", "percent": 10.0},
		{"name": "Python", "percent": 4.0},
		{"name": "Shell", "percent": 2.5},
		{"name": "Other", "percent": 1.1}
	]
}}`

const fakeWakaSummaries = `{"data": [
	{"range": {"date": "2026-08-07"}, "grand_total": {"total_seconds": 3600}},
	{"range": {"date": "2026-08-08"}, "grand_total": {"total_seconds": 5430}}
]}`

func (f *fakeWakaTime) server(t *testing.T) *httptest.Server {
	t.Helper()
	authorized := func(r *http.Request) bool {
		want := "Basic " + base64.StdEncoding.EncodeToString([]byte(f.apiKey+":"))
		return r.Header.Get("Authorization") == want
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/users/current/stats/last_7_days", func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		body := f.statsBody
		if body == "" {
			body = fakeWakaStats
		}
		_, _ = w.Write([]byte(body))
	})
	mux.HandleFunc("GET /api/v1/users/current/summaries", func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if got := r.URL.Query().Get("range"); got != "last_7_days" {
			t.Errorf("summaries range = %q, want last_7_days", got)
		}
		body := f.summariesBody
		if body == "" {
			body = fakeWakaSummaries
		}
		_, _ = w.Write([]byte(body))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func newTestWakaTime(t *testing.T, fake *fakeWakaTime) *WakaTime {
	t.Helper()
	srv := fake.server(t)
	w, err := NewWakaTime("", WakaTimeDeps{APIBaseURL: srv.URL, Sealer: crypto.PlainSealer{}})
	if err != nil {
		t.Fatal(err)
	}
	return w
}

// No config (dev, not connected): the fixture is served unchanged, and every
// catalog path resolves in it.
func TestWakaTimeFetchWithoutConfigServesFixture(t *testing.T) {
	w, err := NewWakaTime(testFixturePath, WakaTimeDeps{})
	if err != nil {
		t.Fatal(err)
	}
	for name, account := range map[string]*store.ConnectorAccount{
		"nil account":            nil,
		"account without config": {ID: "acct-x", UserID: "dev", Connector: "wakatime", Status: "active"},
	} {
		t.Run(name, func(t *testing.T) {
			snap, err := w.Fetch(context.Background(), account)
			if err != nil {
				t.Fatal(err)
			}
			if got := lookupPath(t, snap, "stats", "weeklyHours"); got != 32.5 {
				t.Errorf("stats.weeklyHours = %v, want the fixture value 32.5", got)
			}
			if got := lookupPath(t, snap, "stats", "topLanguage"); got != "TypeScript" {
				t.Errorf("stats.topLanguage = %v, want TypeScript", got)
			}
			days, ok := lookupPath(t, snap, "stats", "days").([]any)
			if !ok || len(days) != 7 {
				t.Errorf("stats.days has %d entries, want 7", len(days))
			}
			assertCatalogResolves(t, WakaTimeFields, snap)
		})
	}
}

// Production posture: no fixture wired, no config → an EMPTY snapshot, so
// bound fields render as em-dashes instead of demo data.
func TestWakaTimeFetchUnconfiguredWithoutFixtureIsEmpty(t *testing.T) {
	w, err := NewWakaTime("", WakaTimeDeps{})
	if err != nil {
		t.Fatal(err)
	}
	snap, err := w.Fetch(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if snap == nil || len(snap) != 0 {
		t.Errorf("snapshot = %#v, want empty non-nil map", snap)
	}
}

func TestWakaTimeFetchLiveSnapshot(t *testing.T) {
	w := newTestWakaTime(t, &fakeWakaTime{apiKey: "wk_live"})
	account := sealConfigAccount(t, "wakatime", WakaTimeConfig{APIKey: "wk_live"})

	snap, err := w.Fetch(context.Background(), account)
	if err != nil {
		t.Fatal(err)
	}
	// 63000 s / 3600 = 17.5 h, one decimal by contract.
	if got := lookupPath(t, snap, "stats", "weeklyHours"); got != 17.5 {
		t.Errorf("stats.weeklyHours = %v, want 17.5", got)
	}
	// 9000 s / 60 = 150 min.
	if got := lookupPath(t, snap, "stats", "dailyAvgMinutes"); got != 150 {
		t.Errorf("stats.dailyAvgMinutes = %v, want 150", got)
	}
	if got := lookupPath(t, snap, "stats", "topLanguage"); got != "Go" {
		t.Errorf("stats.topLanguage = %v, want Go", got)
	}
	// Top five only, percents rounded to one decimal.
	wantLangs := []any{
		map[string]any{"name": "Go", "percent": 52.3},
		map[string]any{"name": "TypeScript", "percent": 30.1},
		map[string]any{"name": "Rust", "percent": 10.0},
		map[string]any{"name": "Python", "percent": 4.0},
		map[string]any{"name": "Shell", "percent": 2.5},
	}
	if got := lookupPath(t, snap, "stats", "topLanguages"); !reflect.DeepEqual(got, wantLangs) {
		t.Errorf("stats.topLanguages = %#v, want %#v", got, wantLangs)
	}
	// Summaries → days series: seconds to whole minutes, upstream order.
	wantDays := []any{
		map[string]any{"date": "2026-08-07", "minutes": 60},
		map[string]any{"date": "2026-08-08", "minutes": 91}, // 5430 s rounds to 91
	}
	if got := lookupPath(t, snap, "stats", "days"); !reflect.DeepEqual(got, wantDays) {
		t.Errorf("stats.days = %#v, want %#v", got, wantDays)
	}
	assertCatalogResolves(t, WakaTimeFields, snap)
}

// A wrong or revoked API key is an error the SnapshotCache absorbs as a
// stale-serve — never fixture fallback, never a silent empty snapshot.
func TestWakaTimeFetchAuthFailure(t *testing.T) {
	w := newTestWakaTime(t, &fakeWakaTime{apiKey: "wk_valid"})
	account := sealConfigAccount(t, "wakatime", WakaTimeConfig{APIKey: "wk_wrong"})

	_, err := w.Fetch(context.Background(), account)
	if err == nil {
		t.Fatal("Fetch succeeded with a rejected API key")
	}
	if !strings.Contains(err.Error(), "401") {
		t.Errorf("err = %v, want a 401 mention", err)
	}
}

func TestWakaTimeFetchMalformedPayloads(t *testing.T) {
	tests := []struct {
		name string
		fake *fakeWakaTime
	}{
		{"stats not JSON", &fakeWakaTime{apiKey: "k", statsBody: "<html>maintenance</html>"}},
		{"summaries not JSON", &fakeWakaTime{apiKey: "k", summariesBody: "{"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := newTestWakaTime(t, tt.fake)
			account := sealConfigAccount(t, "wakatime", WakaTimeConfig{APIKey: "k"})
			if _, err := w.Fetch(context.Background(), account); err == nil {
				t.Fatal("Fetch succeeded on a malformed payload")
			}
		})
	}
}

func TestWakaTimeConfigValidate(t *testing.T) {
	if err := (&WakaTimeConfig{APIKey: "waka_x"}).Validate(); err != nil {
		t.Errorf("valid key rejected: %v", err)
	}
	for _, key := range []string{"", "   "} {
		if err := (&WakaTimeConfig{APIKey: key}).Validate(); err == nil {
			t.Errorf("apiKey %q accepted", key)
		}
	}
}

func TestWakaTimeFieldsCatalogTypes(t *testing.T) {
	want := map[string]string{
		"stats.weeklyHours":     "number",
		"stats.dailyAvgMinutes": "number",
		"stats.topLanguage":     "string",
		"stats.topLanguages":    "series",
		"stats.days":            "series",
	}
	if len(WakaTimeFields) != len(want) {
		t.Fatalf("WakaTimeFields has %d entries, want %d", len(WakaTimeFields), len(want))
	}
	for _, f := range WakaTimeFields {
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

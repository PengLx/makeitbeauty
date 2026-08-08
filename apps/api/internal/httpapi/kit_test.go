package httpapi

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/config"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/kit"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// testConfig: non-dev, so the handler stack under test is the production one.
func testConfig() config.Config { return config.Config{Env: "test"} }

// GET /v1/kit through the full handler stack: public (no auth), sorted
// array response, cache header (architecture.md §8).
func TestHandleKitHTTP(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	s := NewServer(testConfig(), log, Deps{Stores: store.NewMemory(), Kit: []kit.Component{
		{ID: "kit/progress-bar", Title: "Progress bar", Frame: kit.Frame{W: 260, H: 32}, Props: json.RawMessage(`{}`)},
		{ID: "kit/stat-card", Title: "Stat card", Description: "A headline metric.", Frame: kit.Frame{W: 260, H: 140}, Props: json.RawMessage(`{"label":{"type":"string"}}`)},
	}})

	req := httptest.NewRequest(http.MethodGet, "/v1/kit", nil) // no Authorization header
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "max-age=300" {
		t.Errorf("Cache-Control = %q, want %q", got, "max-age=300")
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q, want %q", got, "application/json; charset=utf-8")
	}

	var components []struct {
		ID          string                 `json:"id"`
		Title       string                 `json:"title"`
		Description string                 `json:"description"`
		Frame       struct{ W, H float64 } `json:"frame"`
		Props       json.RawMessage        `json:"props"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &components); err != nil {
		t.Fatalf("body is not a JSON array: %v (body: %s)", err, rec.Body.String())
	}
	if len(components) != 2 {
		t.Fatalf("got %d components, want 2", len(components))
	}
	if components[0].ID != "kit/progress-bar" || components[1].ID != "kit/stat-card" {
		t.Errorf("ids = [%s, %s], want sorted [kit/progress-bar, kit/stat-card]", components[0].ID, components[1].ID)
	}
	c := components[1]
	if c.Title != "Stat card" || c.Description != "A headline metric." {
		t.Errorf("title/description = %q/%q, want Stat card/A headline metric.", c.Title, c.Description)
	}
	if c.Frame.W != 260 || c.Frame.H != 140 {
		t.Errorf("frame = %+v, want {260 140}", c.Frame)
	}
	if string(c.Props) != `{"label":{"type":"string"}}` {
		t.Errorf("props = %s, want the raw object passed through", c.Props)
	}
	// Optional description is omitted, not "".
	var raw []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if _, present := raw[0]["description"]; present {
		t.Error("description should be omitted when empty")
	}
}

// A server with no kit components must serve [] — never null.
func TestHandleKitEmpty(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	s := NewServer(testConfig(), log, Deps{Stores: store.NewMemory()})

	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/kit", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var components []any
	if err := json.Unmarshal(rec.Body.Bytes(), &components); err != nil || components == nil {
		t.Fatalf("body = %s, want the empty JSON array []", rec.Body.String())
	}
}

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
		// Native: nodes are the static palette preview (normalized to [] by
		// the loader when the file declares none).
		{ID: "kit/contribution-heatmap", Title: "Contribution heatmap", Frame: kit.Frame{W: 720, H: 140}, Props: json.RawMessage(`{}`), Native: true, DataFields: []string{"stats.calendar"}, Nodes: json.RawMessage(`[]`)},
		{ID: "kit/progress-bar", Title: "Progress bar", Frame: kit.Frame{W: 260, H: 32}, Props: json.RawMessage(`{}`),
			Nodes:    json.RawMessage(`[{"id":"fill","type":"rect"}]`),
			Computed: json.RawMessage(`[{"node":"fill","field":"w","prop":"percent","scale":4.4}]`)},
		{ID: "kit/stat-card", Title: "Stat card", Description: "A headline metric.", Frame: kit.Frame{W: 260, H: 140}, Props: json.RawMessage(`{"label":{"type":"string"}}`),
			Nodes: json.RawMessage(`[{"id":"bg","type":"rect"}]`)},
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
		Native      bool                   `json:"native"`
		DataFields  []string               `json:"dataFields"`
		Nodes       json.RawMessage        `json:"nodes"`
		Computed    json.RawMessage        `json:"computed"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &components); err != nil {
		t.Fatalf("body is not a JSON array: %v (body: %s)", err, rec.Body.String())
	}
	if len(components) != 3 {
		t.Fatalf("got %d components, want 3", len(components))
	}
	if components[0].ID != "kit/contribution-heatmap" || components[1].ID != "kit/progress-bar" || components[2].ID != "kit/stat-card" {
		t.Errorf("ids = [%s, %s, %s], want sorted [kit/contribution-heatmap, kit/progress-bar, kit/stat-card]",
			components[0].ID, components[1].ID, components[2].ID)
	}
	c := components[2]
	if c.Title != "Stat card" || c.Description != "A headline metric." {
		t.Errorf("title/description = %q/%q, want Stat card/A headline metric.", c.Title, c.Description)
	}
	if c.Frame.W != 260 || c.Frame.H != 140 {
		t.Errorf("frame = %+v, want {260 140}", c.Frame)
	}
	if string(c.Props) != `{"label":{"type":"string"}}` {
		t.Errorf("props = %s, want the raw object passed through", c.Props)
	}
	// Definition bodies pass through so the editor can expand instances
	// client-side: nodes always an array, computed only when present.
	if string(c.Nodes) != `[{"id":"bg","type":"rect"}]` {
		t.Errorf("nodes = %s, want the raw node array passed through", c.Nodes)
	}
	bar := components[1]
	if string(bar.Nodes) != `[{"id":"fill","type":"rect"}]` {
		t.Errorf("progress-bar nodes = %s, want the raw node array passed through", bar.Nodes)
	}
	if string(bar.Computed) != `[{"node":"fill","field":"w","prop":"percent","scale":4.4}]` {
		t.Errorf("progress-bar computed = %s, want the raw rule array passed through", bar.Computed)
	}
	// Native metadata passes through so the editor can label natives and
	// show their auto-consumed fields.
	native := components[0]
	if !native.Native {
		t.Error("kit/contribution-heatmap native = false, want true")
	}
	if len(native.DataFields) != 1 || native.DataFields[0] != "stats.calendar" {
		t.Errorf("kit/contribution-heatmap dataFields = %v, want [stats.calendar]", native.DataFields)
	}
	// Optional fields are omitted, not zero-valued: no description on
	// components[1], no native/dataFields keys on declarative components,
	// no computed key on components without rules. nodes is always present
	// (a native's static preview may be the empty array, never absent).
	var raw []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if _, present := raw[1]["description"]; present {
		t.Error("description should be omitted when empty")
	}
	for _, i := range []int{1, 2} {
		if _, present := raw[i]["native"]; present {
			t.Errorf("components[%d]: native should be omitted on declarative components", i)
		}
		if _, present := raw[i]["dataFields"]; present {
			t.Errorf("components[%d]: dataFields should be omitted on declarative components", i)
		}
	}
	for _, i := range []int{0, 2} {
		if _, present := raw[i]["computed"]; present {
			t.Errorf("components[%d]: computed should be omitted when absent", i)
		}
	}
	for i := range raw {
		if _, present := raw[i]["nodes"]; !present {
			t.Errorf("components[%d]: nodes should always be present", i)
		}
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

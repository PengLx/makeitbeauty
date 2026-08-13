package kit

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var discard = slog.New(slog.NewTextHandler(io.Discard, nil))

// writeFiles materializes name→content pairs in a fresh temp dir.
func writeFiles(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

const validStatCard = `{
	"id": "stat-card",
	"title": "Stat card",
	"description": "A headline metric.",
	"frame": {"w": 260, "h": 140},
	"props": {"label": {"type": "string", "default": "FOLLOWERS"}},
	"nodes": [{"id": "bg", "type": "rect"}]
}`

func TestLoad(t *testing.T) {
	tests := []struct {
		name    string
		files   map[string]string // name → content
		wantIDs []string          // loaded component ids, in order
	}{
		{
			name:    "empty dir is not an error",
			files:   map[string]string{},
			wantIDs: []string{},
		},
		{
			name:    "single valid component",
			files:   map[string]string{"stat-card.json": validStatCard},
			wantIDs: []string{"kit/stat-card"},
		},
		{
			name: "output is sorted by id regardless of file order",
			files: map[string]string{
				"z-banner.json": `{"id": "banner", "title": "Banner", "frame": {"w": 10, "h": 10}, "props": {}, "nodes": [{"id": "bg", "type": "rect"}]}`,
				"a-card.json":   validStatCard,
			},
			wantIDs: []string{"kit/banner", "kit/stat-card"},
		},
		{
			name: "malformed files are skipped, valid ones survive",
			files: map[string]string{
				"good.json":          validStatCard,
				"not-json.json":      `{"id": "broken"`,
				"missing-id.json":    `{"title": "No id", "frame": {"w": 10, "h": 10}}`,
				"missing-title.json": `{"id": "untitled", "frame": {"w": 10, "h": 10}}`,
				"zero-frame.json":    `{"id": "flat", "title": "Flat", "frame": {"w": 0, "h": 10}}`,
				"no-frame.json":      `{"id": "unframed", "title": "Unframed"}`,
				// Declarative components: the nodes ARE the component, so
				// missing/empty/non-array nodes are malformed (schema else-branch).
				"no-nodes.json":    `{"id": "hollow", "title": "Hollow", "frame": {"w": 10, "h": 10}}`,
				"empty-nodes.json": `{"id": "vacant", "title": "Vacant", "frame": {"w": 10, "h": 10}, "nodes": []}`,
				"bad-nodes.json":   `{"id": "warped", "title": "Warped", "frame": {"w": 10, "h": 10}, "nodes": {"id": "bg"}}`,
				"bad-computed.json": `{"id": "twisted", "title": "Twisted", "frame": {"w": 10, "h": 10},
					"nodes": [{"id": "bg", "type": "rect"}], "computed": {"node": "bg"}}`,
			},
			wantIDs: []string{"kit/stat-card"},
		},
		{
			name: "non-json files are ignored",
			files: map[string]string{
				"stat-card.json": validStatCard,
				"README.md":      "# not a component",
			},
			wantIDs: []string{"kit/stat-card"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := writeFiles(t, tt.files)
			components, err := Load(dir, discard)
			if err != nil {
				t.Fatalf("Load() error: %v", err)
			}
			if components == nil {
				t.Fatal("Load() returned a nil slice; want non-nil for a JSON [] response")
			}
			gotIDs := make([]string, len(components))
			for i, c := range components {
				gotIDs[i] = c.ID
			}
			if len(gotIDs) != len(tt.wantIDs) {
				t.Fatalf("Load() ids = %v, want %v", gotIDs, tt.wantIDs)
			}
			for i := range gotIDs {
				if gotIDs[i] != tt.wantIDs[i] {
					t.Fatalf("Load() ids = %v, want %v", gotIDs, tt.wantIDs)
				}
			}
		})
	}
}

func TestLoadParsesFields(t *testing.T) {
	dir := writeFiles(t, map[string]string{"stat-card.json": validStatCard})
	components, err := Load(dir, discard)
	if err != nil {
		t.Fatal(err)
	}
	if len(components) != 1 {
		t.Fatalf("got %d components, want 1", len(components))
	}
	c := components[0]
	if c.Title != "Stat card" {
		t.Errorf("Title = %q, want %q", c.Title, "Stat card")
	}
	if c.Description != "A headline metric." {
		t.Errorf("Description = %q, want %q", c.Description, "A headline metric.")
	}
	if c.Frame.W != 260 || c.Frame.H != 140 {
		t.Errorf("Frame = %+v, want {260 140}", c.Frame)
	}
	// Props pass through verbatim as a JSON object.
	var props map[string]any
	if err := json.Unmarshal(c.Props, &props); err != nil {
		t.Fatalf("Props is not a JSON object: %v", err)
	}
	if _, ok := props["label"]; !ok {
		t.Errorf("Props = %s, want the label declaration passed through", c.Props)
	}
	// The definition body passes through verbatim so the editor can expand
	// instances client-side.
	if got := string(c.Nodes); got != `[{"id": "bg", "type": "rect"}]` {
		t.Errorf("Nodes = %s, want the raw node array passed through", got)
	}
	if c.Computed != nil {
		t.Errorf("Computed = %s, want nil (omitted) for a component without computed", c.Computed)
	}
}

// Computed-geometry rules pass through verbatim when present, so client-side
// expansion can apply the same prop-driven geometry as the renderer.
func TestLoadParsesComputed(t *testing.T) {
	dir := writeFiles(t, map[string]string{
		"bar.json": `{"id": "bar", "title": "Bar", "frame": {"w": 480, "h": 72},
			"nodes": [{"id": "fill", "type": "rect"}],
			"computed": [{"node": "fill", "field": "w", "prop": "percent", "scale": 4.4, "clamp": [0, 440]}]}`,
	})
	components, err := Load(dir, discard)
	if err != nil {
		t.Fatal(err)
	}
	if len(components) != 1 {
		t.Fatalf("got %d components, want 1", len(components))
	}
	want := `[{"node": "fill", "field": "w", "prop": "percent", "scale": 4.4, "clamp": [0, 440]}]`
	if got := string(components[0].Computed); got != want {
		t.Errorf("Computed = %s, want the raw rule array passed through", got)
	}
}

// Native components' nodes are only the static palette preview and may be []
// or absent (schema then-branch); absent normalizes to [] so /v1/kit always
// serves an array.
func TestLoadNativeNodesOptional(t *testing.T) {
	dir := writeFiles(t, map[string]string{
		"no-nodes.json": `{"id": "a-bare", "title": "Bare native", "native": true,
			"dataFields": ["stats.calendar"], "frame": {"w": 10, "h": 10}}`,
		"empty-nodes.json": `{"id": "b-empty", "title": "Empty native", "native": true,
			"dataFields": ["stats.calendar"], "frame": {"w": 10, "h": 10}, "nodes": []}`,
	})
	components, err := Load(dir, discard)
	if err != nil {
		t.Fatal(err)
	}
	if len(components) != 2 {
		t.Fatalf("got %d components, want 2", len(components))
	}
	for _, c := range components {
		if got := string(c.Nodes); got != "[]" {
			t.Errorf("%s: Nodes = %s, want []", c.ID, got)
		}
	}
}

const validHeatmap = `{
	"id": "contribution-heatmap",
	"title": "Contribution heatmap",
	"native": true,
	"dataFields": ["stats.calendar"],
	"frame": {"w": 720, "h": 140},
	"props": {"accent": {"type": "string", "default": "#39d353"}},
	"nodes": [{"id": "bg", "type": "rect"}]
}`

// Native kit components carry native + dataFields through to /v1/kit;
// declarative components must not gain the fields.
func TestLoadParsesNativeDataFields(t *testing.T) {
	dir := writeFiles(t, map[string]string{
		"heatmap.json":   validHeatmap,
		"stat-card.json": validStatCard,
	})
	components, err := Load(dir, discard)
	if err != nil {
		t.Fatal(err)
	}
	if len(components) != 2 {
		t.Fatalf("got %d components, want 2", len(components))
	}
	heatmap, statCard := components[0], components[1]
	if heatmap.ID != "kit/contribution-heatmap" || statCard.ID != "kit/stat-card" {
		t.Fatalf("ids = %s, %s", heatmap.ID, statCard.ID)
	}
	if !heatmap.Native {
		t.Error("heatmap.Native = false, want true")
	}
	if len(heatmap.DataFields) != 1 || heatmap.DataFields[0] != "stats.calendar" {
		t.Errorf("heatmap.DataFields = %v, want [stats.calendar]", heatmap.DataFields)
	}
	if statCard.Native || statCard.DataFields != nil {
		t.Errorf("declarative component parsed as native: %v / %v", statCard.Native, statCard.DataFields)
	}
}

// The optional dataConnector slug qualifies a native's dataFields with the
// connector they address; absent stays absent (binding derivation defaults
// it to github), and the value passes through verbatim for /v1/kit.
func TestLoadParsesDataConnector(t *testing.T) {
	dir := writeFiles(t, map[string]string{
		"wakatime-days.json": `{
			"id": "wakatime-days", "title": "WakaTime days",
			"native": true, "dataConnector": "wakatime", "dataFields": ["stats.days"],
			"frame": {"w": 720, "h": 120}
		}`,
		"heatmap.json": validHeatmap, // native, no dataConnector
	})
	components, err := Load(dir, discard)
	if err != nil {
		t.Fatal(err)
	}
	if len(components) != 2 {
		t.Fatalf("got %d components, want 2", len(components))
	}
	heatmap, days := components[0], components[1]
	if days.ID != "kit/wakatime-days" || days.DataConnector != "wakatime" {
		t.Errorf("wakatime-days = %s / dataConnector %q, want kit/wakatime-days / wakatime", days.ID, days.DataConnector)
	}
	// Absent stays absent: the github default is derivation's job, so files
	// that predate the qualifier keep their exact serialized shape.
	if heatmap.DataConnector != "" {
		t.Errorf("heatmap.DataConnector = %q, want empty (defaulting happens at derivation)", heatmap.DataConnector)
	}
}

// dataConnector qualifies dataFields, so it is invalid on declarative
// components and must be a slug; bad files are malformed and skipped.
func TestLoadRejectsBadDataConnector(t *testing.T) {
	dir := writeFiles(t, map[string]string{
		"declarative-with-connector.json": `{
			"id": "a", "title": "A", "dataConnector": "wakatime",
			"frame": {"w": 10, "h": 10}, "nodes": [{"id": "bg", "type": "rect"}]
		}`,
		"bad-slug.json": `{
			"id": "b", "title": "B", "native": true,
			"dataConnector": "Waka Time", "dataFields": ["stats.days"],
			"frame": {"w": 10, "h": 10}
		}`,
		"good.json": validHeatmap,
	})
	components, err := Load(dir, discard)
	if err != nil {
		t.Fatal(err)
	}
	if len(components) != 1 || components[0].ID != "kit/contribution-heatmap" {
		t.Fatalf("components = %+v, want only kit/contribution-heatmap", components)
	}
}

// native and dataFields imply each other (kit-component.schema.json
// dependentRequired); half-declared files are malformed and skipped.
func TestLoadRejectsHalfNativeComponents(t *testing.T) {
	dir := writeFiles(t, map[string]string{
		"native-no-fields.json": `{"id": "a", "title": "A", "native": true, "frame": {"w": 10, "h": 10}}`,
		"fields-no-native.json": `{"id": "b", "title": "B", "dataFields": ["stats.calendar"], "frame": {"w": 10, "h": 10}}`,
		"good.json":             validHeatmap,
	})
	components, err := Load(dir, discard)
	if err != nil {
		t.Fatal(err)
	}
	if len(components) != 1 || components[0].ID != "kit/contribution-heatmap" {
		t.Fatalf("components = %+v, want only kit/contribution-heatmap", components)
	}
}

// The optional category slug (kit-component.schema.json) passes through to
// /v1/kit so the editor can group the palette menu; absent stays absent
// (omitempty), and an invalid slug is a malformed file (skipped) — a typo'd
// category must not silently strand the component in the catch-all bucket.
func TestLoadParsesCategory(t *testing.T) {
	dir := writeFiles(t, map[string]string{
		"categorized.json": `{"id": "a-card", "title": "Card", "category": "stats",
			"frame": {"w": 10, "h": 10}, "nodes": [{"id": "bg", "type": "rect"}]}`,
		"uncategorized.json": `{"id": "b-bare", "title": "Bare",
			"frame": {"w": 10, "h": 10}, "nodes": [{"id": "bg", "type": "rect"}]}`,
	})
	components, err := Load(dir, discard)
	if err != nil {
		t.Fatal(err)
	}
	if len(components) != 2 {
		t.Fatalf("got %d components, want 2", len(components))
	}
	if got := components[0].Category; got != "stats" {
		t.Errorf("Category = %q, want %q", got, "stats")
	}
	if got := components[1].Category; got != "" {
		t.Errorf("uncategorized Category = %q, want empty (omitted on the wire)", got)
	}
	// omitempty: the JSON encoding of an uncategorized component has no key.
	b, err := json.Marshal(components[1])
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if _, present := m["category"]; present {
		t.Errorf("category key present on an uncategorized component: %s", b)
	}
}

func TestLoadRejectsInvalidCategory(t *testing.T) {
	invalid := []string{"Stats", "1stats", "-stats", "sta ts", "stats!", strings.Repeat("s", 25)}
	files := map[string]string{"good.json": validStatCard}
	for i, cat := range invalid {
		files[fmt.Sprintf("bad-%d.json", i)] = fmt.Sprintf(
			`{"id": "bad-%d", "title": "Bad", "category": %q, "frame": {"w": 10, "h": 10}, "nodes": [{"id": "bg", "type": "rect"}]}`, i, cat)
	}
	dir := writeFiles(t, files)
	components, err := Load(dir, discard)
	if err != nil {
		t.Fatal(err)
	}
	if len(components) != 1 || components[0].ID != "kit/stat-card" {
		t.Fatalf("components = %+v, want only kit/stat-card (invalid categories skipped)", components)
	}
}

// Every shipped kit component carries a category from the recommended
// taxonomy — the palette menu must never show an official component in the
// catch-all bucket.
func TestShippedKitComponentsAreCategorized(t *testing.T) {
	components, err := Load("../../../../packages/kit/components", discard)
	if err != nil {
		t.Fatal(err)
	}
	if len(components) == 0 {
		t.Fatal("no shipped components loaded")
	}
	taxonomy := map[string]bool{"cards": true, "stats": true, "data": true, "banners": true, "decor": true}
	for _, c := range components {
		if c.Category == "" {
			t.Errorf("%s: no category", c.ID)
		} else if !taxonomy[c.Category] {
			t.Errorf("%s: category %q is outside the recommended taxonomy", c.ID, c.Category)
		}
	}
}

func TestLoadDefaultsMissingProps(t *testing.T) {
	dir := writeFiles(t, map[string]string{
		"bare.json": `{"id": "bare", "title": "Bare", "frame": {"w": 10, "h": 10}, "nodes": [{"id": "bg", "type": "rect"}]}`,
	})
	components, err := Load(dir, discard)
	if err != nil {
		t.Fatal(err)
	}
	if len(components) != 1 {
		t.Fatalf("got %d components, want 1", len(components))
	}
	if got := string(components[0].Props); got != "{}" {
		t.Errorf("Props = %s, want {} for a component without props", got)
	}
}

func TestLoadMissingDir(t *testing.T) {
	if _, err := Load(filepath.Join(t.TempDir(), "does-not-exist"), discard); err == nil {
		t.Error("Load() on a missing absolute dir = nil error, want error")
	}
}

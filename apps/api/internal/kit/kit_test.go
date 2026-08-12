package kit

import (
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
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
				"z-banner.json": `{"id": "banner", "title": "Banner", "frame": {"w": 10, "h": 10}, "props": {}}`,
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

func TestLoadDefaultsMissingProps(t *testing.T) {
	dir := writeFiles(t, map[string]string{
		"bare.json": `{"id": "bare", "title": "Bare", "frame": {"w": 10, "h": 10}}`,
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

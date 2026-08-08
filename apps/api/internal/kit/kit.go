// Package kit loads the official component kit (packages/kit/components)
// into the palette metadata served by GET /v1/kit (architecture.md §8).
// Components are parsed minimally — id, title, frame, props — the API never
// interprets fragment nodes; expansion is the renderer's job (§5.7).
package kit

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// Frame is the design-time bounding box of a component.
type Frame struct {
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// Component is the palette metadata of one kit component
// ([{id: "kit/stat-card", title, description?, frame, props}]).
type Component struct {
	// ID is the registry id: "kit/" + the file's id field.
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	Frame       Frame  `json:"frame"`
	// Props is the file's prop-declaration object, passed through verbatim.
	Props json.RawMessage `json:"props"`
}

// ResolveDir returns an existing directory path for p. Like fixture.Resolve,
// the API is started from different working directories, so a single relative
// default is not enough. Order of attempts:
//  1. p as given (absolute, or relative to the current working directory —
//     this covers the default "../../packages/kit/components" when running
//     from apps/api).
//  2. packages/kit/components in the working directory and up to 8 of its
//     ancestors (covers running from the repo root or a nested package dir).
func ResolveDir(p string) (string, error) {
	if dirExists(p) {
		return p, nil
	}
	if filepath.IsAbs(p) {
		return "", fmt.Errorf("kit dir %q not found", p)
	}
	dir, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("kit dir %q not found (getwd: %w)", p, err)
	}
	for range 8 {
		cand := filepath.Join(dir, "packages", "kit", "components")
		if dirExists(cand) {
			return cand, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", fmt.Errorf("kit dir %q not found (tried the path as given and packages/kit/components in working-directory ancestors)", p)
}

// Load resolves dir and parses every *.json component file in it, sorted by
// id for deterministic output. Malformed files are skipped with a warning —
// one bad community file must never take the palette down. An empty directory
// yields an empty (non-nil) slice, not an error.
func Load(dir string, log *slog.Logger) ([]Component, error) {
	resolved, err := ResolveDir(dir)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(resolved)
	if err != nil {
		return nil, fmt.Errorf("kit dir %q: %w", resolved, err)
	}

	components := []Component{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(resolved, entry.Name())
		component, err := parseFile(path)
		if err != nil {
			log.Warn("skipping malformed kit component", "file", path, "err", err)
			continue
		}
		components = append(components, component)
	}
	slices.SortFunc(components, func(a, b Component) int { return strings.Compare(a.ID, b.ID) })
	return components, nil
}

// parseFile reads one component file and validates the palette-relevant
// fields. The full format is pinned by kit-component.schema.json; here only
// what /v1/kit serves is checked.
func parseFile(path string) (Component, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Component{}, err
	}
	var raw struct {
		ID          string          `json:"id"`
		Title       string          `json:"title"`
		Description string          `json:"description"`
		Frame       Frame           `json:"frame"`
		Props       json.RawMessage `json:"props"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return Component{}, fmt.Errorf("invalid JSON: %w", err)
	}
	if raw.ID == "" {
		return Component{}, fmt.Errorf("missing id")
	}
	if raw.Title == "" {
		return Component{}, fmt.Errorf("missing title")
	}
	if raw.Frame.W <= 0 || raw.Frame.H <= 0 {
		return Component{}, fmt.Errorf("frame.w and frame.h must be positive")
	}
	props := raw.Props
	if len(props) == 0 {
		props = json.RawMessage("{}") // a component may declare no props
	}
	return Component{
		ID:          "kit/" + raw.ID,
		Title:       raw.Title,
		Description: raw.Description,
		Frame:       raw.Frame,
		Props:       props,
	}, nil
}

func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

// Package kit loads the official component kit (packages/kit/components)
// into the palette metadata served by GET /v1/kit (architecture.md §8).
// Components are parsed minimally — id, title, frame, props — plus the
// definition body (nodes, computed) passed through verbatim so the editor
// can expand kit instances client-side for canvas preview. The API still
// never interprets fragment nodes; render expansion is the renderer's job
// (§5.7).
package kit

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// CategoryPattern constrains the optional palette-menu category slug
// (kit-component.schema.json). Shared with the community-component write
// validation in httpapi so kit and registry categories can never drift.
var CategoryPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,23}$`)

// connectorSlugPattern constrains the optional dataConnector slug of a
// native component ("github", "wakatime", ...). Slug-shaped like categories,
// but a distinct pattern: connector naming must never drift with the palette
// taxonomy.
var connectorSlugPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,23}$`)

// Frame is the design-time bounding box of a component.
type Frame struct {
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// Component is the palette metadata of one kit component
// ([{id: "kit/stat-card", title, description?, frame, props, native?,
// dataFields?}]).
type Component struct {
	// ID is the registry id: "kit/" + the file's id field.
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	// Category is the optional palette-menu group (lowercase slug per
	// CategoryPattern; recommended taxonomy: cards, stats, data, banners,
	// decor). The editor buckets uncategorized components separately, so an
	// absent category is omitted, never "".
	Category string `json:"category,omitempty"`
	Frame    Frame  `json:"frame"`
	// Props is the file's prop-declaration object, passed through verbatim.
	Props json.RawMessage `json:"props"`
	// Native marks a component whose nodes are produced by a trusted
	// generator in the renderer from (props, data, frame) — official kit
	// only. /v1/kit passes it through so the editor can label natives.
	Native bool `json:"native,omitempty"`
	// DataConnector is the connector whose snapshot a native component's
	// DataFields address (a slug like "wakatime"). Optional: absent means
	// github — the original native set predates multi-connector natives, so
	// derivation defaults it rather than requiring every file to say so.
	// /v1/kit passes it through verbatim (omitted when the file omits it).
	DataConnector string `json:"dataConnector,omitempty"`
	// DataFields are the connector snapshot paths a native component
	// consumes directly (e.g. "stats.calendar"). Binding derivation unions
	// them into the design's binding for the component's DataConnector for
	// every instance of the component.
	DataFields []string `json:"dataFields,omitempty"`
	// Nodes is the component's definition body: its design-schema fragment
	// node array, passed through verbatim (the API never interprets nodes).
	// Serving it lets the editor expand kit instances client-side so the
	// canvas shows real component content instead of placeholder boxes.
	// For declarative components these are the real render nodes; for
	// native components they are the file's static preview nodes — the
	// renderer's trusted generator supplies the real nodes at render time,
	// so the static preview is exactly what a canvas approximation should
	// draw. Always a JSON array; [] when a native file declares none.
	Nodes json.RawMessage `json:"nodes"`
	// Computed is the file's computed-geometry rule list, passed through
	// verbatim when present so client-side expansion applies the same
	// prop-driven geometry as the renderer. Omitted when the file has none.
	Computed json.RawMessage `json:"computed,omitempty"`
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
		ID            string          `json:"id"`
		Title         string          `json:"title"`
		Description   string          `json:"description"`
		Category      string          `json:"category"`
		Frame         Frame           `json:"frame"`
		Props         json.RawMessage `json:"props"`
		Native        bool            `json:"native"`
		DataConnector string          `json:"dataConnector"`
		DataFields    []string        `json:"dataFields"`
		Nodes         json.RawMessage `json:"nodes"`
		Computed      json.RawMessage `json:"computed"`
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
	// Mirror the schema: category is optional, but when present it must be a
	// valid slug — a typo'd category would silently strand the component in
	// the palette's catch-all bucket, so it is a load error instead.
	if raw.Category != "" && !CategoryPattern.MatchString(raw.Category) {
		return Component{}, fmt.Errorf("category %q must match %s", raw.Category, CategoryPattern)
	}
	// Mirror the schema's dependentRequired: native and dataFields imply
	// each other (kit-component.schema.json).
	if raw.Native && len(raw.DataFields) == 0 {
		return Component{}, fmt.Errorf("native component must declare dataFields")
	}
	if !raw.Native && len(raw.DataFields) > 0 {
		return Component{}, fmt.Errorf("dataFields requires native: true")
	}
	// dataConnector qualifies dataFields, so it is native-only too; when
	// present it must be a connector slug (absent means github — binding
	// derivation applies the default).
	if raw.DataConnector != "" && !raw.Native {
		return Component{}, fmt.Errorf("dataConnector requires native: true")
	}
	if raw.DataConnector != "" && !connectorSlugPattern.MatchString(raw.DataConnector) {
		return Component{}, fmt.Errorf("dataConnector %q must match %s", raw.DataConnector, connectorSlugPattern)
	}
	props := raw.Props
	if len(props) == 0 {
		props = json.RawMessage("{}") // a component may declare no props
	}
	nodes, err := parseNodes(raw.Nodes, raw.Native)
	if err != nil {
		return Component{}, err
	}
	computed, err := parseComputed(raw.Computed)
	if err != nil {
		return Component{}, err
	}
	return Component{
		ID:            "kit/" + raw.ID,
		Title:         raw.Title,
		Description:   raw.Description,
		Category:      raw.Category,
		Frame:         raw.Frame,
		Props:         props,
		Native:        raw.Native,
		DataConnector: raw.DataConnector,
		DataFields:    raw.DataFields,
		Nodes:         nodes,
		Computed:      computed,
	}, nil
}

// parseNodes validates the definition body's node array, mirroring the
// schema's if/else on native (kit-component.schema.json): declarative
// components require at least one node — the nodes ARE the component —
// while native components' nodes are only the static preview and may be []
// or absent (normalized to [] so /v1/kit always serves an array).
func parseNodes(raw json.RawMessage, native bool) (json.RawMessage, error) {
	if len(raw) == 0 || string(raw) == "null" {
		if !native {
			return nil, fmt.Errorf("declarative component must declare nodes")
		}
		return json.RawMessage("[]"), nil
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, fmt.Errorf("nodes must be a JSON array: %w", err)
	}
	if !native && len(items) == 0 {
		return nil, fmt.Errorf("declarative component must declare at least one node")
	}
	return raw, nil
}

// parseComputed validates the optional computed-geometry rule list; absent
// (or null) stays absent so /v1/kit omits the key.
func parseComputed(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, fmt.Errorf("computed must be a JSON array: %w", err)
	}
	return raw, nil
}

func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

package httpapi

import (
	"encoding/json"
	"regexp"
	"sort"
	"strings"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/kit"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// templatePattern matches {{connector.path.to.field}} references. Template
// chars are never JSON-escaped, so scanning the raw design document is
// equivalent to walking every string value in it.
var templatePattern = regexp.MustCompile(`\{\{\s*([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\s*\}\}`)

// nativeConnector is the connector native kit components consume. v0
// assumption: every native component reads GitHub data — kit metadata
// declares dataFields as bare snapshot paths ("stats.calendar") without a
// connector prefix, and derivation pins them to the github binding. When a
// second connector grows natives, dataFields will need a connector qualifier
// and this constant dissolves.
const nativeConnector = "github"

// deriveBindings scans a design for {{connector.field}} templates and returns
// the bindings the design actually consumes. Bindings are derived, never
// client-authored: they are the consent record ("this image will publicly
// display: ...") and the render-time data filter, so they must always match
// the design — a stale or missing binding renders fields as "—" in production
// while previews look fine.
//
// Native kit components have no templates — the renderer's trusted generator
// consumes connector data directly — so every instance node referencing a
// native component unions that component's declared dataFields into the
// github binding (v0: natives are fixed to github, see nativeConnector).
// Without this, native visuals would be filtered to nothing at render time
// and the consent record would omit what the image publicly displays.
//
// Rules: the first path segment must be a registered connector ("props.*" is
// kit-prop templating, and literal text that merely looks like a template is
// ignored); fields are deduped and sorted; connectors are emitted in sorted
// order so derivation is deterministic.
func deriveBindings(design json.RawMessage, knownConnectors []string, kitComponents []kit.Component) []store.Binding {
	known := make(map[string]bool, len(knownConnectors))
	for _, name := range knownConnectors {
		known[name] = true
	}

	fields := map[string]map[string]bool{}
	for _, m := range templatePattern.FindAllStringSubmatch(string(design), -1) {
		conn, rest, _ := strings.Cut(m[1], ".")
		if !known[conn] {
			continue
		}
		if fields[conn] == nil {
			fields[conn] = map[string]bool{}
		}
		fields[conn][rest] = true
	}

	if known[nativeConnector] {
		for _, f := range nativeDataFields(design, kitComponents) {
			if fields[nativeConnector] == nil {
				fields[nativeConnector] = map[string]bool{}
			}
			fields[nativeConnector][f] = true
		}
	}

	connectors := make([]string, 0, len(fields))
	for conn := range fields {
		connectors = append(connectors, conn)
	}
	sort.Strings(connectors)

	bindings := make([]store.Binding, 0, len(connectors))
	for _, conn := range connectors {
		fs := make([]string, 0, len(fields[conn]))
		for f := range fields[conn] {
			fs = append(fs, f)
		}
		sort.Strings(fs)
		bindings = append(bindings, store.Binding{Connector: conn, Fields: fs})
	}
	return bindings
}

// nativeDataFields returns the union of dataFields declared by every native
// kit component the design instantiates. An unparseable design contributes
// nothing — schema validation is the renderer's job, and template-derived
// bindings already work on the raw bytes.
func nativeDataFields(design json.RawMessage, kitComponents []kit.Component) []string {
	byID := map[string][]string{}
	for _, c := range kitComponents {
		if c.Native && len(c.DataFields) > 0 {
			byID[c.ID] = c.DataFields
		}
	}
	if len(byID) == 0 {
		return nil
	}

	var doc struct {
		Nodes []struct {
			Type      string `json:"type"`
			Component string `json:"component"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(design, &doc); err != nil {
		return nil
	}

	var out []string
	for _, node := range doc.Nodes {
		if node.Type != "instance" {
			continue
		}
		out = append(out, byID[node.Component]...)
	}
	return out
}

// deriveBindings binds the package-level derivation to the server's
// registered connectors and loaded kit (native dataFields awareness).
func (s *Server) deriveBindings(design json.RawMessage) []store.Binding {
	return deriveBindings(design, s.cache.KnownConnectors(), s.kit)
}

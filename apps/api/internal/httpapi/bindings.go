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

// defaultNativeConnector is the connector a native kit component consumes
// when its metadata declares no dataConnector: the original native set reads
// GitHub data and predates the qualifier, so absence means github.
const defaultNativeConnector = "github"

// instanceComponents returns the component reference of every instance node
// in a design, in document order, duplicates and empties included — the one
// shared parse behind binding derivation (kit fragments, native dataFields),
// render-path component resolution, and ComponentRefs/usage derivation.
// An unparseable design yields nil: schema validation is the renderer's job.
func instanceComponents(design json.RawMessage) []string {
	var doc struct {
		Nodes []struct {
			Type      string `json:"type"`
			Component string `json:"component"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(design, &doc); err != nil {
		return nil
	}
	var refs []string
	for _, node := range doc.Nodes {
		if node.Type == "instance" {
			refs = append(refs, node.Component)
		}
	}
	return refs
}

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
// binding of the component's dataConnector (default github, see
// defaultNativeConnector). Without this, native visuals would be filtered to
// nothing at render time and the consent record would omit what the image
// publicly displays.
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

	for conn, fs := range nativeDataFields(design, kitComponents) {
		if !known[conn] {
			// A native pointing at an unregistered connector contributes
			// nothing — same rule as template references.
			continue
		}
		if fields[conn] == nil {
			fields[conn] = map[string]bool{}
		}
		for _, f := range fs {
			fields[conn][f] = true
		}
	}

	kitFragmentFields(design, kitComponents, known, fields)

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

// kitFragmentFields unions {{connector.field}} templates found inside the
// fragments of DECLARATIVE kit components the design instantiates. Kit
// fragments are trusted first-party content and may bind connector data
// directly (e.g. wakatime-badge's "{{wakatime.stats.weeklyHours}}h" —
// community fragments cannot: the props-only publish rule blocks them).
// What a fragment displays must land in the consent record exactly like a
// design-level template, or production filters the field away and the
// component renders an em-dash despite a connected account. Native
// components are skipped: their preview nodes are static and their real
// data flows through dataFields.
func kitFragmentFields(design json.RawMessage, kitComponents []kit.Component, known map[string]bool, fields map[string]map[string]bool) {
	fragments := map[string]json.RawMessage{}
	for _, c := range kitComponents {
		if !c.Native && len(c.Nodes) > 0 {
			fragments[c.ID] = c.Nodes
		}
	}
	if len(fragments) == 0 {
		return
	}

	scanned := map[string]bool{}
	for _, ref := range instanceComponents(design) {
		if scanned[ref] {
			continue
		}
		scanned[ref] = true
		nodes, ok := fragments[ref]
		if !ok {
			continue
		}
		for _, m := range templatePattern.FindAllStringSubmatch(string(nodes), -1) {
			conn, rest, _ := strings.Cut(m[1], ".")
			if !known[conn] { // "props" is never a known connector
				continue
			}
			if fields[conn] == nil {
				fields[conn] = map[string]bool{}
			}
			fields[conn][rest] = true
		}
	}
}

// nativeDataFields returns the dataFields declared by every native kit
// component the design instantiates, grouped by each component's
// dataConnector (defaulted to github). An unparseable design contributes
// nothing — schema validation is the renderer's job, and template-derived
// bindings already work on the raw bytes.
func nativeDataFields(design json.RawMessage, kitComponents []kit.Component) map[string][]string {
	type native struct {
		connector string
		fields    []string
	}
	byID := map[string]native{}
	for _, c := range kitComponents {
		if c.Native && len(c.DataFields) > 0 {
			conn := c.DataConnector
			if conn == "" {
				conn = defaultNativeConnector
			}
			byID[c.ID] = native{connector: conn, fields: c.DataFields}
		}
	}
	if len(byID) == 0 {
		return nil
	}

	out := map[string][]string{}
	for _, ref := range instanceComponents(design) {
		if n, ok := byID[ref]; ok {
			out[n.connector] = append(out[n.connector], n.fields...)
		}
	}
	return out
}

// deriveBindings binds the package-level derivation to the server's
// registered connectors and loaded kit (native dataFields awareness).
func (s *Server) deriveBindings(design json.RawMessage) []store.Binding {
	return deriveBindings(design, s.cache.KnownConnectors(), s.kit)
}

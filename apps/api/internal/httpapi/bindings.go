package httpapi

import (
	"encoding/json"
	"regexp"
	"sort"
	"strings"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// templatePattern matches {{connector.path.to.field}} references. Template
// chars are never JSON-escaped, so scanning the raw design document is
// equivalent to walking every string value in it.
var templatePattern = regexp.MustCompile(`\{\{\s*([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\s*\}\}`)

// deriveBindings scans a design for {{connector.field}} templates and returns
// the bindings the design actually consumes. Bindings are derived, never
// client-authored: they are the consent record ("this image will publicly
// display: ...") and the render-time data filter, so they must always match
// the design — a stale or missing binding renders fields as "—" in production
// while previews look fine.
//
// Rules: the first path segment must be a registered connector ("props.*" is
// kit-prop templating, and literal text that merely looks like a template is
// ignored); fields are deduped and sorted; connectors are emitted in sorted
// order so derivation is deterministic.
func deriveBindings(design json.RawMessage, knownConnectors []string) []store.Binding {
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

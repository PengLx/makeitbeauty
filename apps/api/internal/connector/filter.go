package connector

import "strings"

// Filter returns a new map containing only the values of snapshot reachable
// via the given dot-separated field paths (e.g. "user.name",
// "stats.totalStars"). This is the enforcement point for the binding consent
// model: whatever is not listed in a project's bindings never reaches the
// renderer or the public SVG.
//
// Semantics:
//   - Missing paths are silently skipped — the renderer turns unresolved
//     templates into warnings + placeholders, never render failures.
//   - A path naming a subtree ("user") includes that whole subtree.
//   - Selected values are deep-copied, so the result never aliases the shared
//     cache entry.
func Filter(snapshot map[string]any, fields []string) map[string]any {
	out := map[string]any{}
	for _, field := range fields {
		path := strings.Split(field, ".")
		val, ok := lookup(snapshot, path)
		if !ok {
			continue
		}
		insert(out, path, val)
	}
	return out
}

// lookup walks a dot path through nested maps.
func lookup(m map[string]any, path []string) (any, bool) {
	var cur any = m
	for _, p := range path {
		obj, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		if cur, ok = obj[p]; !ok {
			return nil, false
		}
	}
	return cur, true
}

// insert places val at path in dst, creating intermediate maps. A non-map
// value sitting at an intermediate key (overlapping fields) is replaced by a
// map — deterministic, and the deeper selection wins.
func insert(dst map[string]any, path []string, val any) {
	for _, p := range path[:len(path)-1] {
		next, ok := dst[p].(map[string]any)
		if !ok {
			next = map[string]any{}
			dst[p] = next
		}
		dst = next
	}
	dst[path[len(path)-1]] = deepCopy(val)
}

// deepCopy copies the JSON-shaped subset of values (maps, slices, scalars).
func deepCopy(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, e := range t {
			out[k] = deepCopy(e)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = deepCopy(e)
		}
		return out
	default:
		return v
	}
}

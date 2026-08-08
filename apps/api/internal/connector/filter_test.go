package connector

import (
	"encoding/json"
	"reflect"
	"testing"
)

// snapshot mirrors the demo fixture's github object, extended with fields
// that must NOT leak through filtering.
func testSnapshot(t *testing.T) map[string]any {
	t.Helper()
	const raw = `{
		"user":  {"name": "Ada Lovelace", "login": "ada", "followers": 1234, "email": "secret@example.com"},
		"stats": {"totalStars": 5678, "topLanguage": "TypeScript"},
		"internalToken": "must-never-leak"
	}`
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestFilter(t *testing.T) {
	tests := []struct {
		name   string
		fields []string
		want   string // expected result as JSON
	}{
		{
			name:   "single leaf",
			fields: []string{"user.name"},
			want:   `{"user":{"name":"Ada Lovelace"}}`,
		},
		{
			name: "demo binding fields",
			fields: []string{
				"user.name", "user.login", "user.followers",
				"stats.totalStars", "stats.topLanguage",
			},
			want: `{
				"user":  {"name":"Ada Lovelace","login":"ada","followers":1234},
				"stats": {"totalStars":5678,"topLanguage":"TypeScript"}
			}`,
		},
		{
			name:   "missing paths are skipped, not errors",
			fields: []string{"user.name", "user.doesNotExist", "nope.at.all"},
			want:   `{"user":{"name":"Ada Lovelace"}}`,
		},
		{
			name:   "whole subtree selection",
			fields: []string{"stats"},
			want:   `{"stats":{"totalStars":5678,"topLanguage":"TypeScript"}}`,
		},
		{
			name:   "overlapping subtree then leaf",
			fields: []string{"stats", "stats.totalStars"},
			want:   `{"stats":{"totalStars":5678,"topLanguage":"TypeScript"}}`,
		},
		{
			name:   "path through a non-map value",
			fields: []string{"user.name.first"},
			want:   `{}`,
		},
		{
			name:   "no fields yields empty data",
			fields: []string{},
			want:   `{}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			snapshot := testSnapshot(t)
			got := Filter(snapshot, tt.fields)

			var want map[string]any
			if err := json.Unmarshal([]byte(tt.want), &want); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("Filter(%v)\n got:  %#v\n want: %#v", tt.fields, got, want)
			}

			// Unbound fields must never appear, whatever the selection.
			if _, leaked := got["internalToken"]; leaked {
				t.Error("unbound top-level field leaked through filter")
			}
			if user, ok := got["user"].(map[string]any); ok {
				if _, leaked := user["email"]; leaked {
					t.Error("unbound nested field leaked through filter")
				}
			}
		})
	}
}

// The result must not alias the (shared, cached) snapshot: mutating it must
// leave the source untouched.
func TestFilterDeepCopies(t *testing.T) {
	snapshot := testSnapshot(t)
	got := Filter(snapshot, []string{"user"})

	got["user"].(map[string]any)["name"] = "MUTATED"

	if snapshot["user"].(map[string]any)["name"] != "Ada Lovelace" {
		t.Error("mutating the filtered result changed the source snapshot")
	}
}

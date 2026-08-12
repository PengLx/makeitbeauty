package httpapi

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

func TestDeriveBindings(t *testing.T) {
	known := []string{"github", "wakatime"}

	tests := []struct {
		name   string
		design string
		want   []store.Binding
	}{
		{
			name:   "no templates",
			design: `{"nodes":[{"type":"text","text":"hello"}]}`,
			want:   []store.Binding{},
		},
		{
			name:   "text node fields, deduped and sorted",
			design: `{"nodes":[{"text":"{{github.user.name}} has {{github.stats.totalStars}} stars"},{"text":"again {{github.user.name}}"}]}`,
			want: []store.Binding{
				{Connector: "github", Fields: []string{"stats.totalStars", "user.name"}},
			},
		},
		{
			name:   "instance props count too",
			design: `{"nodes":[{"type":"instance","component":"kit/stat-card","props":{"value":"{{github.user.followers}}"}}]}`,
			want: []store.Binding{
				{Connector: "github", Fields: []string{"user.followers"}},
			},
		},
		{
			name:   "props.* is kit templating, not a connector",
			design: `{"nodes":[{"text":"{{props.label}}: {{props.percent}}"}]}`,
			want:   []store.Binding{},
		},
		{
			name:   "unknown connector prefix ignored",
			design: `{"nodes":[{"text":"{{spotify.track.name}} {{github.user.login}}"}]}`,
			want: []store.Binding{
				{Connector: "github", Fields: []string{"user.login"}},
			},
		},
		{
			name:   "multiple connectors sorted",
			design: `{"nodes":[{"text":"{{wakatime.weekly.hours}}"},{"text":"{{github.user.login}}"}]}`,
			want: []store.Binding{
				{Connector: "github", Fields: []string{"user.login"}},
				{Connector: "wakatime", Fields: []string{"weekly.hours"}},
			},
		},
		{
			name:   "whitespace inside braces tolerated",
			design: `{"nodes":[{"text":"{{ github.user.login }}"}]}`,
			want: []store.Binding{
				{Connector: "github", Fields: []string{"user.login"}},
			},
		},
		{
			name:   "bare connector name without field ignored",
			design: `{"nodes":[{"text":"{{github}}"}]}`,
			want:   []store.Binding{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := deriveBindings(json.RawMessage(tt.design), known)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("deriveBindings() = %#v, want %#v", got, tt.want)
			}
		})
	}
}

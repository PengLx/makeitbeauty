package httpapi

import (
	"encoding/json"
	"io"
	"log/slog"
	"reflect"
	"slices"
	"testing"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/kit"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// testKit mirrors the shape of the loaded official kit: native components
// with and without a dataConnector qualifier (absent means github), one
// pointing at an unregistered connector, plus a declarative one that must
// contribute nothing.
var testKit = []kit.Component{
	{ID: "kit/contribution-heatmap", Title: "Contribution heatmap", Frame: kit.Frame{W: 720, H: 140}, Native: true, DataFields: []string{"stats.calendar"}},
	{ID: "kit/streak-flame", Title: "Streak flame", Frame: kit.Frame{W: 360, H: 140}, Native: true, DataFields: []string{"stats.currentStreak", "stats.longestStreak"}},
	{ID: "kit/wakatime-days", Title: "WakaTime days", Frame: kit.Frame{W: 720, H: 120}, Native: true, DataConnector: "wakatime", DataFields: []string{"stats.days"}},
	{ID: "kit/spotify-now", Title: "Now playing", Frame: kit.Frame{W: 360, H: 120}, Native: true, DataConnector: "spotify", DataFields: []string{"track.name"}},
	{ID: "kit/stat-card", Title: "Stat card", Frame: kit.Frame{W: 260, H: 140}},
	{ID: "kit/wakatime-badge", Title: "WakaTime badge", Frame: kit.Frame{W: 220, H: 56},
		Nodes: json.RawMessage(`[{"id":"t","type":"text","x":0,"y":0,"w":220,"h":56,"text":"{{wakatime.stats.weeklyHours}}h {{props.label}}"}]`)},
}

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
		{
			name:   "native instance unions its dataFields into the github binding",
			design: `{"nodes":[{"type":"instance","component":"kit/contribution-heatmap"}]}`,
			want: []store.Binding{
				{Connector: "github", Fields: []string{"stats.calendar"}},
			},
		},
		{
			name:   "native dataFields merge with template fields, deduped and sorted",
			design: `{"nodes":[{"type":"instance","component":"kit/streak-flame"},{"text":"{{github.user.login}} — {{github.stats.currentStreak}}"}]}`,
			want: []store.Binding{
				{Connector: "github", Fields: []string{"stats.currentStreak", "stats.longestStreak", "user.login"}},
			},
		},
		{
			name:   "two native instances, fields still deduped",
			design: `{"nodes":[{"type":"instance","component":"kit/contribution-heatmap"},{"type":"instance","component":"kit/contribution-heatmap"},{"type":"instance","component":"kit/streak-flame"}]}`,
			want: []store.Binding{
				{Connector: "github", Fields: []string{"stats.calendar", "stats.currentStreak", "stats.longestStreak"}},
			},
		},
		{
			name:   "native with dataConnector unions into THAT connector's binding",
			design: `{"nodes":[{"type":"instance","component":"kit/wakatime-days"}]}`,
			want: []store.Binding{
				{Connector: "wakatime", Fields: []string{"stats.days"}},
			},
		},
		{
			name:   "multi-connector natives split per connector, merged with templates",
			design: `{"nodes":[{"type":"instance","component":"kit/contribution-heatmap"},{"type":"instance","component":"kit/wakatime-days"},{"text":"{{github.user.login}}"}]}`,
			want: []store.Binding{
				{Connector: "github", Fields: []string{"stats.calendar", "user.login"}},
				{Connector: "wakatime", Fields: []string{"stats.days"}},
			},
		},
		{
			name:   "native with unregistered dataConnector contributes nothing",
			design: `{"nodes":[{"type":"instance","component":"kit/spotify-now"}]}`,
			want:   []store.Binding{},
		},
		{
			name:   "declarative kit instance contributes no native fields",
			design: `{"nodes":[{"type":"instance","component":"kit/stat-card"}]}`,
			want:   []store.Binding{},
		},
		{
			name:   "declarative kit fragment with a connector template derives its binding",
			design: `{"nodes":[{"type":"instance","component":"kit/wakatime-badge"}]}`,
			want: []store.Binding{
				{Connector: "wakatime", Fields: []string{"stats.weeklyHours"}},
			},
		},
		{
			name:   "fragment templates merge with design templates across connectors",
			design: `{"nodes":[{"type":"instance","component":"kit/wakatime-badge"},{"text":"{{github.user.login}}"}]}`,
			want: []store.Binding{
				{Connector: "github", Fields: []string{"user.login"}},
				{Connector: "wakatime", Fields: []string{"stats.weeklyHours"}},
			},
		},
		{
			name:   "non-instance node referencing a native component id is ignored",
			design: `{"nodes":[{"type":"text","component":"kit/contribution-heatmap","text":"x"}]}`,
			want:   []store.Binding{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := deriveBindings(json.RawMessage(tt.design), known, testKit)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("deriveBindings() = %#v, want %#v", got, tt.want)
			}
		})
	}
}

// A native's dataConnector (default github) must be a registered connector;
// otherwise the union must not invent a binding for it.
func TestDeriveBindingsNativeRequiresRegisteredConnector(t *testing.T) {
	design := json.RawMessage(`{"nodes":[{"type":"instance","component":"kit/contribution-heatmap"}]}`)
	got := deriveBindings(design, []string{"wakatime"}, testKit)
	if len(got) != 0 {
		t.Fatalf("deriveBindings() = %#v, want no bindings without a github connector", got)
	}
}

// An unparseable design must not panic and must still fall back to
// template-scanning the raw bytes.
func TestDeriveBindingsMalformedDesign(t *testing.T) {
	design := json.RawMessage(`{"nodes": "{{github.user.login}} not-an-array`)
	got := deriveBindings(design, []string{"github"}, testKit)
	want := []store.Binding{{Connector: "github", Fields: []string{"user.login"}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("deriveBindings() = %#v, want %#v", got, want)
	}
}

// End to end against the REAL official kit: the shipped
// kit/contribution-heatmap declares stats.calendar, so a design instantiating
// it derives a github binding containing it (the consent record covers what
// the native generator will render).
func TestDeriveBindingsWithLoadedKit(t *testing.T) {
	components, err := kit.Load("../../../../packages/kit/components", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("loading the official kit: %v", err)
	}
	design := json.RawMessage(`{
		"version": 0,
		"canvas": {"width": 800, "height": 400},
		"nodes": [
			{"id": "hm", "type": "instance", "x": 20, "y": 20, "w": 720, "h": 140, "component": "kit/contribution-heatmap"},
			{"id": "hello", "type": "text", "x": 20, "y": 180, "w": 300, "h": 20, "text": "hi {{github.user.login}}"}
		]
	}`)
	got := deriveBindings(design, []string{"github"}, components)
	if len(got) != 1 || got[0].Connector != "github" {
		t.Fatalf("bindings = %#v, want a single github binding", got)
	}
	for _, field := range []string{"stats.calendar", "user.login"} {
		if !slices.Contains(got[0].Fields, field) {
			t.Errorf("github binding %v is missing %q", got[0].Fields, field)
		}
	}
}

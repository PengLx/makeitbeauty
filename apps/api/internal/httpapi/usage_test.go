package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// ---- designComponentRefs -----------------------------------------------------

func TestDesignComponentRefs(t *testing.T) {
	design := func(components ...string) string {
		nodes := make([]string, 0, len(components))
		for i, c := range components {
			nodes = append(nodes, fmt.Sprintf(`{"id":"n%d","type":"instance","x":0,"y":0,"w":10,"h":10,"component":%q}`, i, c))
		}
		return `{"version":0,"canvas":{"width":100,"height":100},"nodes":[` + strings.Join(nodes, ",") + `]}`
	}

	tests := []struct {
		name   string
		design string
		want   string // comma-joined expected refs
	}{
		{"versions stripped", design("dev/card@3"), "dev/card"},
		{"two versions of one component dedupe", design("dev/card@1", "dev/card@2"), "dev/card"},
		{"kit refs ignored", design("kit/stat-card", "dev/card@1"), "dev/card"},
		{"kit-only design has no refs", design("kit/stat-card", "kit/marquee"), ""},
		{"deduped and sorted", design("zoe/z@1", "abe/a@2", "zoe/z@1", "abe/a@2"), "abe/a,zoe/z"},
		{"unpinned bare ref still counts", design("dev/card"), "dev/card"},
		{"malformed refs contribute nothing", design("", "no-slash", "UPPER/case@1"), ""},
		{"non-instance nodes ignored",
			`{"version":0,"canvas":{"width":1,"height":1},"nodes":[{"id":"t","type":"text","component":"dev/card@1"}]}`, ""},
		{"empty design", `{"version":0,"canvas":{"width":1,"height":1},"nodes":[]}`, ""},
		{"unparseable design", `{oops`, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := strings.Join(designComponentRefs(json.RawMessage(tt.design)), ",")
			if got != tt.want {
				t.Errorf("refs = %q, want %q", got, tt.want)
			}
		})
	}
}

// ---- usage index over the API --------------------------------------------------

// browseUsage fetches /v1/community/components and returns id → usageCount.
func browseUsage(t *testing.T, h http.Handler) map[string]int {
	t.Helper()
	rec := doJSON(t, h, http.MethodGet, "/v1/community/components", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("browse status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Components []struct {
			ID         string `json:"id"`
			UsageCount *int   `json:"usageCount"`
		} `json:"components"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	usage := map[string]int{}
	for _, c := range out.Components {
		if c.UsageCount == nil {
			t.Fatalf("browse row %s lacks usageCount", c.ID)
		}
		usage[c.ID] = *c.UsageCount
	}
	return usage
}

// instanceOnlyDesign builds a design whose nodes are instances of the given
// component references.
func instanceOnlyDesign(components ...string) string {
	nodes := make([]string, 0, len(components))
	for i, c := range components {
		nodes = append(nodes, fmt.Sprintf(`{"id":"n%d","type":"instance","x":0,"y":0,"w":10,"h":10,"component":%q}`, i, c))
	}
	return `{"version":0,"canvas":{"width":100,"height":100},"nodes":[` + strings.Join(nodes, ",") + `]}`
}

// Usage counts distinct projects (any pinned version), maintained across
// project create, update-with-changed-refs, and delete.
func TestUsageIndexLifecycle(t *testing.T) {
	s, h := newTestServer(t)
	now := time.Now().UTC()
	seedComponent(t, s, "dev/card", "dev", "Card", "", 2, false, now)
	seedComponent(t, s, "dev/badge", "dev", "Badge", "", 1, false, now)

	if usage := browseUsage(t, h); usage["dev/card"] != 0 || usage["dev/badge"] != 0 {
		t.Fatalf("initial usage = %v, want zeros", usage)
	}

	// Create: p1 pins card@1 twice (distinct projects, not instances).
	rec := doJSON(t, h, http.MethodPost, "/v1/projects",
		`{"id":"p1","name":"P1","design":`+instanceOnlyDesign("dev/card@1", "dev/card@1")+`}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create p1 = %d, body = %s", rec.Code, rec.Body.String())
	}
	// The project response carries the derived refs, versions stripped.
	if !strings.Contains(rec.Body.String(), `"componentRefs":["dev/card"]`) {
		t.Errorf("p1 componentRefs missing/wrong: %s", rec.Body.String())
	}
	if usage := browseUsage(t, h); usage["dev/card"] != 1 {
		t.Fatalf("usage after p1 = %v, want card 1", usage)
	}

	// A second project on a DIFFERENT pinned version still counts the same
	// component: usage is per component, any pinned version.
	rec = doJSON(t, h, http.MethodPost, "/v1/projects",
		`{"id":"p2","name":"P2","design":`+instanceOnlyDesign("dev/card@2", "dev/badge@1", "kit/stat-card")+`}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create p2 = %d, body = %s", rec.Code, rec.Body.String())
	}
	usage := browseUsage(t, h)
	if usage["dev/card"] != 2 || usage["dev/badge"] != 1 {
		t.Fatalf("usage after p2 = %v, want card 2, badge 1", usage)
	}

	// Update with changed refs: p2 drops the card, keeps the badge.
	rec = doJSON(t, h, http.MethodPut, "/v1/projects/p2",
		`{"name":"P2","design":`+instanceOnlyDesign("dev/badge@1")+`}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("update p2 = %d, body = %s", rec.Code, rec.Body.String())
	}
	usage = browseUsage(t, h)
	if usage["dev/card"] != 1 || usage["dev/badge"] != 1 {
		t.Fatalf("usage after update = %v, want card 1, badge 1", usage)
	}

	// Delete: p1 stops referencing the card.
	rec = doJSON(t, h, http.MethodDelete, "/v1/projects/p1", "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete p1 = %d", rec.Code)
	}
	usage = browseUsage(t, h)
	if usage["dev/card"] != 0 || usage["dev/badge"] != 1 {
		t.Fatalf("usage after delete = %v, want card 0, badge 1", usage)
	}
}

// The index is derived state: a fresh server over the same file store
// rebuilds identical counters from the persisted ComponentRefs at boot.
func TestUsageIndexRestartRebuild(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	stores, err := store.NewFile(dir)
	if err != nil {
		t.Fatal(err)
	}
	s, h := newTestServerWith(t, stores)
	now := time.Now().UTC()
	seedComponent(t, s, "dev/card", "dev", "Card", "", 1, false, now)

	rec := doJSON(t, h, http.MethodPost, "/v1/projects",
		`{"id":"p1","name":"P1","design":`+instanceOnlyDesign("dev/card@1")+`}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d, body = %s", rec.Code, rec.Body.String())
	}
	if usage := browseUsage(t, h); usage["dev/card"] != 1 {
		t.Fatalf("usage before restart = %v, want card 1", usage)
	}
	// The refs are on disk, not only in memory.
	b, err := os.ReadFile(filepath.Join(dir, "projects.json"))
	if err != nil || !strings.Contains(string(b), `"componentRefs"`) {
		t.Fatalf("projects.json lacks componentRefs: %v, %s", err, b)
	}

	// "Restart": fresh stores over the same dir, fresh server, explicit boot
	// build (what main.go does before serving).
	reopened, err := store.NewFile(dir)
	if err != nil {
		t.Fatal(err)
	}
	s2, h2 := newTestServerWith(t, reopened)
	if err := s2.BuildUsageIndex(t.Context()); err != nil {
		t.Fatal(err)
	}
	if usage := browseUsage(t, h2); usage["dev/card"] != 1 {
		t.Fatalf("usage after restart = %v, want card 1 (rebuilt from ComponentRefs)", usage)
	}
}

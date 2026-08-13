package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/config"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/connector"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// fakeGitHub registers the "github" name so binding derivation recognizes it;
// Fetch serves a tiny fixed snapshot for any test that resolves data.
type fakeGitHub struct{}

func (fakeGitHub) Name() string               { return "github" }
func (fakeGitHub) SnapshotTTL() time.Duration { return time.Minute }
func (fakeGitHub) Fetch(context.Context, *store.ConnectorAccount) (map[string]any, error) {
	return map[string]any{"user": map[string]any{"login": "dev"}}, nil
}

// newTestServer wires a Server with dev config, in-memory stores, and a
// snapshot cache whose registry knows the "github" name (project writes
// derive bindings from the design, which consults the registry). The
// renderer stays nil because these tests never render.
func newTestServer(t *testing.T) (*Server, http.Handler) {
	t.Helper()
	return newTestServerWith(t, store.NewMemory())
}

// newTestServerWith is newTestServer over caller-provided stores (e.g. a
// file store, for restart-rebuild tests).
func newTestServerWith(t *testing.T, stores store.Stores) (*Server, http.Handler) {
	t.Helper()
	log := slog.New(slog.DiscardHandler)
	registry := connector.NewRegistry()
	registry.Register(fakeGitHub{})
	s := &Server{
		cfg:    config.Config{Env: "dev"},
		log:    log,
		stores: stores,
		cache:  connector.NewSnapshotCache(registry, log),
		usage:  newUsageIndex(),
	}
	return s, s.Handler()
}

// seedProject creates a project owned by the dev user directly in the store.
func seedProject(t *testing.T, s *Server, id string) {
	t.Helper()
	now := time.Now().UTC()
	err := s.stores.Projects.Create(context.Background(), &store.Project{
		ID: id, UserID: "dev", Name: "Seeded", Design: json.RawMessage(`{"version":0,"canvas":{"width":1,"height":1},"nodes":[]}`),
		Bindings: []store.Binding{}, Outputs: []store.Output{{ID: "default", Filename: "card.svg"}},
		CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
}

func doJSON(t *testing.T, h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var envelope struct {
		Error struct{ Code, Message string } `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("body is not the JSON error envelope: %s", rec.Body.String())
	}
	if envelope.Error.Message == "" {
		t.Error("error.message is empty")
	}
	return envelope.Error.Code
}

func TestCreateProjectDefaults(t *testing.T) {
	_, h := newTestServer(t)

	rec := doJSON(t, h, http.MethodPost, "/v1/projects", `{"name":"My Café Card!"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var p struct {
		ID      string          `json:"id"`
		Design  json.RawMessage `json:"design"`
		Outputs []store.Output  `json:"outputs"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	if p.ID != "my-caf-card" {
		t.Errorf("slug id = %q, want %q", p.ID, "my-caf-card")
	}
	if len(p.Design) == 0 || !json.Valid(p.Design) {
		t.Error("default design missing or invalid")
	}
	if len(p.Outputs) != 1 || p.Outputs[0].ID != "default" || p.Outputs[0].Filename != "card.svg" {
		t.Errorf("default outputs = %+v", p.Outputs)
	}

	// Same name again: uniqueness suffix, no conflict.
	rec = doJSON(t, h, http.MethodPost, "/v1/projects", `{"name":"My Café Card!"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("second create status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	if p.ID != "my-caf-card-2" {
		t.Errorf("suffixed slug id = %q, want %q", p.ID, "my-caf-card-2")
	}
}

func TestUpdateProjectValidationTable(t *testing.T) {
	validDesign := `{"version":0,"canvas":{"width":10,"height":10},"nodes":[]}`

	tests := []struct {
		name       string
		body       string
		wantStatus int
		wantCode   string
	}{
		{"valid full update",
			`{"name":"Renamed","design":` + validDesign + `,"bindings":[{"connector":"github","fields":["user.login"]}],"outputs":[{"id":"default","theme":"dark","filename":"out.svg"}]}`,
			http.StatusOK, ""},
		{"valid minimal update (bindings/outputs kept)",
			`{"name":"Renamed","design":` + validDesign + `}`,
			http.StatusOK, ""},
		{"not JSON", `{oops`, http.StatusBadRequest, "invalid_request"},
		{"unknown field politely rejected",
			`{"name":"x","design":` + validDesign + `,"designer":"me"}`,
			http.StatusBadRequest, "invalid_request"},
		{"missing name", `{"design":` + validDesign + `}`, http.StatusBadRequest, "invalid_request"},
		{"name too long", `{"name":"` + strings.Repeat("x", 201) + `","design":` + validDesign + `}`, http.StatusBadRequest, "invalid_request"},
		{"missing design", `{"name":"x"}`, http.StatusBadRequest, "invalid_request"},
		{"empty outputs violates minItems 1",
			`{"name":"x","design":` + validDesign + `,"outputs":[]}`,
			http.StatusBadRequest, "invalid_request"},
		{"bad output filename",
			`{"name":"x","design":` + validDesign + `,"outputs":[{"id":"default","filename":"card.png"}]}`,
			http.StatusBadRequest, "invalid_request"},
		{"bad output theme",
			`{"name":"x","design":` + validDesign + `,"outputs":[{"id":"default","theme":"sepia","filename":"card.svg"}]}`,
			http.StatusBadRequest, "invalid_request"},
		{"client bindings ignored, even malformed ones",
			`{"name":"Renamed","design":` + validDesign + `,"bindings":[{"connector":"GitHub!","fields":[]}]}`,
			http.StatusOK, ""},
		{"id change rejected",
			`{"id":"other","name":"x","design":` + validDesign + `}`,
			http.StatusBadRequest, "invalid_request"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, h := newTestServer(t)
			seedProject(t, s, "p1")

			rec := doJSON(t, h, http.MethodPut, "/v1/projects/p1", tt.body)
			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if tt.wantCode != "" {
				if code := errorCode(t, rec); code != tt.wantCode {
					t.Errorf("error.code = %q, want %q", code, tt.wantCode)
				}
				return
			}
			// Success: updatedAt maintained, changes persisted.
			var p store.Project
			if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
				t.Fatal(err)
			}
			if p.Name != "Renamed" {
				t.Errorf("name = %q after update", p.Name)
			}
			if !p.UpdatedAt.After(p.CreatedAt) {
				t.Errorf("updatedAt %v not after createdAt %v", p.UpdatedAt, p.CreatedAt)
			}
			stored, err := s.stores.Projects.Get(context.Background(), "p1")
			if err != nil || stored.Name != "Renamed" {
				t.Errorf("update not persisted: %+v, %v", stored, err)
			}
		})
	}
}

func TestUpdateProjectUnknownFieldMessageNamesField(t *testing.T) {
	s, h := newTestServer(t)
	seedProject(t, s, "p1")

	rec := doJSON(t, h, http.MethodPut, "/v1/projects/p1", `{"name":"x","design":{},"designer":"me"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "designer") {
		t.Errorf("400 message does not name the unknown field: %s", rec.Body.String())
	}
}

func TestUpdateProjectNotFound(t *testing.T) {
	_, h := newTestServer(t)
	rec := doJSON(t, h, http.MethodPut, "/v1/projects/ghost", `{"name":"x","design":{}}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestDeleteProjectCascadesTokenRevocation(t *testing.T) {
	s, h := newTestServer(t)
	ctx := context.Background()
	seedProject(t, s, "p1")
	if err := s.stores.DeployTokens.Create(ctx, &store.DeployToken{
		ID: "tok-1", ProjectID: "p1", Hash: store.HashToken("mib_secret"), CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}

	rec := doJSON(t, h, http.MethodDelete, "/v1/projects/p1", "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	if _, err := s.stores.Projects.Get(ctx, "p1"); err == nil {
		t.Error("project still exists after delete")
	}
	tokens, err := s.stores.DeployTokens.ListByProject(ctx, "p1")
	if err != nil {
		t.Fatal(err)
	}
	for _, tok := range tokens {
		if tok.RevokedAt == nil {
			t.Errorf("token %s not revoked by project delete", tok.ID)
		}
	}
	// And the render auth path rejects the orphaned token.
	if err := authenticateDeployToken(ctx, s.stores.DeployTokens, "p1", "Bearer mib_secret"); err == nil {
		t.Error("revoked-by-cascade token still authenticates")
	}

	// Deleting again: 404.
	rec = doJSON(t, h, http.MethodDelete, "/v1/projects/p1", "")
	if rec.Code != http.StatusNotFound {
		t.Errorf("second delete status = %d, want 404", rec.Code)
	}
}

// Bindings are derived from the design on every write: what the design
// references is what gets bound — client-sent bindings never survive.
func TestBindingsDerivedFromDesign(t *testing.T) {
	s, h := newTestServer(t)
	seedProject(t, s, "p1")

	design := `{"version":0,"canvas":{"width":10,"height":10},"nodes":[` +
		`{"id":"a","type":"text","x":0,"y":0,"w":5,"h":5,"text":"{{github.user.login}} / {{github.stats.totalStars}}"},` +
		`{"id":"b","type":"text","x":0,"y":5,"w":5,"h":5,"text":"{{props.ignored}} {{unknownconn.field}}"}]}`

	rec := doJSON(t, h, http.MethodPut, "/v1/projects/p1",
		`{"name":"Bound","design":`+design+`,"bindings":[{"connector":"bogus","fields":["nope"]}]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (body: %s)", rec.Code, rec.Body.String())
	}

	var p store.Project
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	want := []store.Binding{{Connector: "github", Fields: []string{"stats.totalStars", "user.login"}}}
	if len(p.Bindings) != 1 || p.Bindings[0].Connector != want[0].Connector ||
		strings.Join(p.Bindings[0].Fields, ",") != strings.Join(want[0].Fields, ",") {
		t.Fatalf("derived bindings = %#v, want %#v", p.Bindings, want)
	}

	// A design with no templates derives empty bindings, replacing old ones.
	rec = doJSON(t, h, http.MethodPut, "/v1/projects/p1",
		`{"name":"Bound","design":{"version":0,"canvas":{"width":10,"height":10},"nodes":[]}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (body: %s)", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	if len(p.Bindings) != 0 {
		t.Fatalf("bindings after template-free design = %#v, want empty", p.Bindings)
	}
}

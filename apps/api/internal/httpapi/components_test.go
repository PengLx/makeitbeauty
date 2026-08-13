package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/auth"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/render"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// sessionCookie creates a real session for uid and returns its cookie —
// requests carrying it authenticate as uid instead of the dev fallback.
func sessionCookie(t *testing.T, s *Server, uid string) *http.Cookie {
	t.Helper()
	if s.sessions == nil {
		s.sessions = auth.NewMemorySessions()
	}
	now := time.Now().UTC()
	sess := &auth.Session{ID: auth.NewSessionID(), UserID: uid, CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
	if err := s.sessions.Create(context.Background(), sess); err != nil {
		t.Fatal(err)
	}
	return &http.Cookie{Name: sessionCookieName, Value: sess.ID}
}

// doJSONAs is doJSON with an optional session cookie.
func doJSONAs(t *testing.T, h http.Handler, method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	if cookie != nil {
		r.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

// seedComponent stores a component directly; publish freezes versions 1..n.
func seedComponent(t *testing.T, s *Server, id, ownerID, title, description string, published int, unlisted bool, publishedAt time.Time) {
	t.Helper()
	seedCategorizedComponent(t, s, id, ownerID, title, description, "", published, unlisted, publishedAt)
}

// seedCategorizedComponent is seedComponent with a palette-menu category.
func seedCategorizedComponent(t *testing.T, s *Server, id, ownerID, title, description, category string, published int, unlisted bool, publishedAt time.Time) {
	t.Helper()
	ctx := context.Background()
	now := publishedAt
	draft := json.RawMessage(fmt.Sprintf(`{"id":%q,"title":%q,"frame":{"w":100,"h":50},"props":{},"nodes":[{"id":"bg","type":"rect","x":0,"y":0,"w":100,"h":50,"fill":"#111"}]}`,
		id, title))
	if err := s.stores.Components.Create(ctx, &store.Component{
		ID: id, OwnerID: ownerID, Title: title, Description: description, Category: category,
		Draft: draft, LatestVersion: published, Unlisted: unlisted,
		CreatedAt: now.Add(-time.Hour), UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	for n := 1; n <= published; n++ {
		if err := s.stores.ComponentVersions.Create(ctx, &store.ComponentVersion{
			ComponentID: id, Version: n,
			Definition:  json.RawMessage(fmt.Sprintf(`{"id":"%s@%d","title":%q,"frame":{"w":100,"h":50},"props":{},"nodes":[]}`, id, n, title)),
			PublishedAt: publishedAt.Add(time.Duration(n) * time.Minute),
		}); err != nil {
			t.Fatal(err)
		}
	}
}

// ---- POST /v1/components ---------------------------------------------------

func TestCreateComponent(t *testing.T) {
	s, h := newTestServer(t)

	rec := doJSON(t, h, http.MethodPost, "/v1/components", `{"name":"glow-card","title":"Glow card","frame":{"w":260,"h":140}}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var view struct {
		ID            string          `json:"id"`
		Title         string          `json:"title"`
		LatestVersion int             `json:"latestVersion"`
		Draft         json.RawMessage `json:"draft"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	if view.ID != "dev/glow-card" { // {login lowercased}/{name}; dev user → "dev"
		t.Errorf("id = %q, want dev/glow-card", view.ID)
	}
	if view.LatestVersion != 0 {
		t.Errorf("latestVersion = %d, want 0 (draft, never published)", view.LatestVersion)
	}
	var draft struct {
		ID    string `json:"id"`
		Title string `json:"title"`
		Frame struct{ W, H float64 }
		Props json.RawMessage `json:"props"`
		Nodes json.RawMessage `json:"nodes"`
	}
	if err := json.Unmarshal(view.Draft, &draft); err != nil {
		t.Fatalf("draft is not a JSON document: %v", err)
	}
	// Draft ids carry the unversioned qualified form the renderer's
	// validator requires; the "@{n}" pin only appears at publish.
	if draft.ID != "dev/glow-card" || draft.Title != "Glow card" || draft.Frame.W != 260 || draft.Frame.H != 140 {
		t.Errorf("draft = %s", view.Draft)
	}
	if string(draft.Props) != "{}" || string(draft.Nodes) != "[]" {
		t.Errorf("draft props/nodes = %s / %s, want {} / []", draft.Props, draft.Nodes)
	}

	// Store: owner recorded, retrievable.
	c, err := s.stores.Components.Get(context.Background(), "dev/glow-card")
	if err != nil || c.OwnerID != "dev" {
		t.Errorf("stored component = %+v, %v", c, err)
	}

	// Duplicate id → 409.
	rec = doJSON(t, h, http.MethodPost, "/v1/components", `{"name":"glow-card","title":"Again","frame":{"w":10,"h":10}}`)
	if rec.Code != http.StatusConflict || errorCode(t, rec) != "conflict" {
		t.Errorf("duplicate: status = %d, code = %s", rec.Code, rec.Body.String())
	}
}

func TestCreateComponentValidationTable(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{"not JSON", `{oops`},
		{"unknown field", `{"name":"x","title":"T","frame":{"w":1,"h":1},"owner":"me"}`},
		{"missing name", `{"title":"T","frame":{"w":1,"h":1}}`},
		{"uppercase name", `{"name":"Glow","title":"T","frame":{"w":1,"h":1}}`},
		{"name with slash", `{"name":"a/b","title":"T","frame":{"w":1,"h":1}}`},
		{"name with space", `{"name":"a b","title":"T","frame":{"w":1,"h":1}}`},
		{"name too long", `{"name":"` + strings.Repeat("a", 65) + `","title":"T","frame":{"w":1,"h":1}}`},
		{"missing title", `{"name":"x","frame":{"w":1,"h":1}}`},
		{"title too long", `{"name":"x","title":"` + strings.Repeat("t", 101) + `","frame":{"w":1,"h":1}}`},
		{"missing frame", `{"name":"x","title":"T"}`},
		{"zero frame", `{"name":"x","title":"T","frame":{"w":0,"h":10}}`},
		{"negative frame", `{"name":"x","title":"T","frame":{"w":10,"h":-1}}`},
		{"oversized frame", `{"name":"x","title":"T","frame":{"w":5000,"h":10}}`},
		{"uppercase category", `{"name":"x","title":"T","category":"Stats","frame":{"w":1,"h":1}}`},
		{"category leading digit", `{"name":"x","title":"T","category":"1stats","frame":{"w":1,"h":1}}`},
		{"category with space", `{"name":"x","title":"T","category":"my stats","frame":{"w":1,"h":1}}`},
		{"category too long", `{"name":"x","title":"T","category":"` + strings.Repeat("c", 25) + `","frame":{"w":1,"h":1}}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, h := newTestServer(t)
			rec := doJSON(t, h, http.MethodPost, "/v1/components", tt.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body: %s)", rec.Code, rec.Body.String())
			}
			if code := errorCode(t, rec); code != "invalid_request" {
				t.Errorf("error.code = %q", code)
			}
		})
	}
}

// The "kit" namespace is reserved for the official set — even if a login
// could ever collide with it (belt and braces, §7.5).
func TestCreateComponentReservedNamespace(t *testing.T) {
	s, _ := newTestServer(t)
	now := time.Now().UTC()
	if err := s.stores.Users.Create(context.Background(), &store.User{
		ID: "u-kit", Login: "Kit", DisplayName: "Kit Impersonator", CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	cookie := sessionCookie(t, s, "u-kit")
	h := s.Handler()

	rec := doJSONAs(t, h, http.MethodPost, "/v1/components", `{"name":"stat-card","title":"T","frame":{"w":1,"h":1}}`, cookie)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (body: %s)", rec.Code, rec.Body.String())
	}
	if code := errorCode(t, rec); code != "reserved_namespace" {
		t.Errorf("error.code = %q, want reserved_namespace", code)
	}
}

// The namespace is the login LOWERCASED.
func TestCreateComponentLowercasesLogin(t *testing.T) {
	s, _ := newTestServer(t)
	now := time.Now().UTC()
	if err := s.stores.Users.Create(context.Background(), &store.User{
		ID: "gh-7", Login: "PengLX", DisplayName: "Peng", GitHubID: 7, CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	cookie := sessionCookie(t, s, "gh-7")
	h := s.Handler()

	rec := doJSONAs(t, h, http.MethodPost, "/v1/components", `{"name":"badge","title":"Badge","frame":{"w":1,"h":1}}`, cookie)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"id":"penglx/badge"`) {
		t.Errorf("id not lowercased: %s", rec.Body.String())
	}
}

// ---- ownership: non-owner writes are 404, like projects ---------------------

func TestComponentWriteAuthz(t *testing.T) {
	s, _ := newTestServer(t)
	seedComponent(t, s, "dev/mine", "dev", "Mine", "", 0, false, time.Now().UTC())
	if err := s.stores.Users.Create(context.Background(), &store.User{
		ID: "u2", Login: "mallory", CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	cookie := sessionCookie(t, s, "u2")
	h := s.Handler()

	calls := []struct {
		method, path, body string
	}{
		{http.MethodPut, "/v1/components/dev/mine", `{"title":"Stolen","frame":{"w":1,"h":1}}`},
		{http.MethodPost, "/v1/components/dev/mine/publish", ""},
		{http.MethodDelete, "/v1/components/dev/mine", ""},
	}
	for _, c := range calls {
		rec := doJSONAs(t, h, c.method, c.path, c.body, cookie)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s %s as non-owner: status = %d, want 404 (not-yours == not-found)", c.method, c.path, rec.Code)
		}
	}

	// GET /v1/components only lists the session user's own components.
	rec := doJSONAs(t, h, http.MethodGet, "/v1/components", "", cookie)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"components":[]`) {
		t.Errorf("non-owner list = %d %s, want empty", rec.Code, rec.Body.String())
	}
	// ... and the owner sees the draft.
	rec = doJSON(t, h, http.MethodGet, "/v1/components", "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"dev/mine"`) || !strings.Contains(rec.Body.String(), `"draft"`) {
		t.Errorf("owner list = %d %s, want dev/mine with draft", rec.Code, rec.Body.String())
	}
}

// ---- PUT /v1/components/{owner}/{name} --------------------------------------

func TestUpdateComponentDraft(t *testing.T) {
	s, h := newTestServer(t)
	seedComponent(t, s, "dev/card", "dev", "Old title", "", 0, false, time.Now().UTC())

	body := `{"title":"New title","description":"Now with nodes.","frame":{"w":300,"h":120},` +
		`"props":{"label":{"type":"string","default":"hi"}},` +
		`"nodes":[{"id":"t","type":"text","x":0,"y":0,"w":300,"h":120,"text":"{{props.label}}"}],` +
		`"computed":[{"node":"t","prop":"n","field":"w","scale":1,"clamp":[0,300]}]}`
	rec := doJSON(t, h, http.MethodPut, "/v1/components/dev/card", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	c, err := s.stores.Components.Get(context.Background(), "dev/card")
	if err != nil {
		t.Fatal(err)
	}
	if c.Title != "New title" || c.Description != "Now with nodes." {
		t.Errorf("metadata not mirrored: %+v", c)
	}
	var draft struct {
		ID       string          `json:"id"`
		Nodes    []any           `json:"nodes"`
		Computed json.RawMessage `json:"computed"`
	}
	if err := json.Unmarshal(c.Draft, &draft); err != nil {
		t.Fatal(err)
	}
	if draft.ID != "dev/card" {
		t.Errorf("draft id = %q, want the unversioned qualified form until publish", draft.ID)
	}
	if len(draft.Nodes) != 1 || len(draft.Computed) == 0 {
		t.Errorf("draft nodes/computed not stored: %s", c.Draft)
	}
	if !c.UpdatedAt.After(c.CreatedAt) {
		t.Error("updatedAt not bumped")
	}
}

func TestUpdateComponentDraftValidationTable(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{"id change rejected", `{"id":"other","title":"T","frame":{"w":1,"h":1}}`},
		{"missing title", `{"frame":{"w":1,"h":1}}`},
		{"missing frame", `{"title":"T"}`},
		{"description too long", `{"title":"T","description":"` + strings.Repeat("d", 1001) + `","frame":{"w":1,"h":1}}`},
		{"props not an object", `{"title":"T","frame":{"w":1,"h":1},"props":[1]}`},
		{"nodes not an array", `{"title":"T","frame":{"w":1,"h":1},"nodes":{}}`},
		{"computed not an array", `{"title":"T","frame":{"w":1,"h":1},"computed":{}}`},
		{"unknown field", `{"title":"T","frame":{"w":1,"h":1},"animation":"pulse"}`},
		{"uppercase category", `{"title":"T","category":"Stats","frame":{"w":1,"h":1}}`},
		{"category with slash", `{"title":"T","category":"a/b","frame":{"w":1,"h":1}}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, h := newTestServer(t)
			seedComponent(t, s, "dev/card", "dev", "Old", "", 0, false, time.Now().UTC())
			rec := doJSON(t, h, http.MethodPut, "/v1/components/dev/card", tt.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body: %s)", rec.Code, rec.Body.String())
			}
		})
	}
}

// ---- category lifecycle -------------------------------------------------------
// The optional palette-menu category flows create → draft → update → publish:
// stored on the component, embedded in the draft definition, frozen into
// published versions, and omitted (never "") wherever it is unset.

func TestComponentCategoryLifecycle(t *testing.T) {
	s, h := newTestServer(t)

	// Create with a category.
	rec := doJSON(t, h, http.MethodPost, "/v1/components", `{"name":"badge","title":"Badge","category":"stats","frame":{"w":200,"h":56}}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"category":"stats"`) {
		t.Errorf("create view lacks category: %s", rec.Body.String())
	}
	c, err := s.stores.Components.Get(context.Background(), "dev/badge")
	if err != nil || c.Category != "stats" {
		t.Fatalf("stored category = %q, %v, want stats", c.Category, err)
	}
	if !strings.Contains(string(c.Draft), `"category":"stats"`) {
		t.Errorf("draft definition lacks category: %s", c.Draft)
	}

	// Update to another category.
	rec = doJSON(t, h, http.MethodPut, "/v1/components/dev/badge",
		`{"title":"Badge","category":"decor","frame":{"w":200,"h":56},"nodes":[{"id":"bg","type":"rect","x":0,"y":0,"w":200,"h":56,"fill":"#111"}]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("update status = %d, body = %s", rec.Code, rec.Body.String())
	}
	c, _ = s.stores.Components.Get(context.Background(), "dev/badge")
	if c.Category != "decor" || !strings.Contains(string(c.Draft), `"category":"decor"`) {
		t.Errorf("updated category = %q, draft = %s, want decor in both", c.Category, c.Draft)
	}

	// Publish freezes the category into the immutable definition.
	_, _, _ = mockValidator(t, s, http.StatusOK, `{"ok":true}`)
	rec = doJSON(t, h, http.MethodPost, "/v1/components/dev/badge/publish", "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("publish status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"category":"decor"`) {
		t.Errorf("frozen definition lacks category: %s", rec.Body.String())
	}
	frozen, err := s.stores.ComponentVersions.Get(context.Background(), "dev/badge", 1)
	if err != nil || !strings.Contains(string(frozen.Definition), `"category":"decor"`) {
		t.Errorf("stored frozen definition = %s, %v, want category decor", frozen.Definition, err)
	}

	// Omitting category on update clears it — and it disappears from the
	// wire (omitempty), it never serializes as "".
	rec = doJSON(t, h, http.MethodPut, "/v1/components/dev/badge", `{"title":"Badge","frame":{"w":200,"h":56}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("clearing update status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"category"`) {
		t.Errorf("cleared category still on the wire: %s", rec.Body.String())
	}
	c, _ = s.stores.Components.Get(context.Background(), "dev/badge")
	if c.Category != "" || strings.Contains(string(c.Draft), `"category"`) {
		t.Errorf("category not cleared: %q / %s", c.Category, c.Draft)
	}
}

// ---- publish flow ------------------------------------------------------------

// mockValidator is an httptest renderer implementing only
// POST /internal/validate-component.
func mockValidator(t *testing.T, s *Server, status int, response string) (*httptest.Server, *atomic.Int32, *[]byte) {
	t.Helper()
	var calls atomic.Int32
	var lastBody []byte
	mux := http.NewServeMux()
	mux.HandleFunc("POST /internal/validate-component", func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		lastBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(response))
	})
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	s.renderer = render.NewClient(ts.URL, time.Second)
	return ts, &calls, &lastBody
}

func TestPublishComponentFreezesVersions(t *testing.T) {
	s, h := newTestServer(t)
	seedComponent(t, s, "dev/card", "dev", "Card", "", 0, false, time.Now().UTC())
	_, calls, lastBody := mockValidator(t, s, http.StatusOK, `{"ok":true}`)

	rec := doJSON(t, h, http.MethodPost, "/v1/components/dev/card/publish", "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if calls.Load() != 1 {
		t.Fatalf("validator called %d times, want 1", calls.Load())
	}
	// The validator received {"definition": <draft>} — the renderer's wire
	// shape — with the unversioned id (the @{n} rewrite happens after).
	if !strings.Contains(string(*lastBody), `"definition"`) ||
		!strings.Contains(string(*lastBody), `"id":"dev/card"`) ||
		strings.Contains(string(*lastBody), "dev/card@") {
		t.Errorf("validator body = %s, want {\"definition\": <unpinned draft>}", *lastBody)
	}

	var v struct {
		ComponentID string          `json:"componentId"`
		Version     int             `json:"version"`
		Definition  json.RawMessage `json:"definition"`
		PublishedAt time.Time       `json:"publishedAt"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatal(err)
	}
	if v.ComponentID != "dev/card" || v.Version != 1 || v.PublishedAt.IsZero() {
		t.Errorf("version view = %+v", v)
	}
	// The frozen definition's id is the fully-qualified pinned form.
	if !strings.Contains(string(v.Definition), `"id":"dev/card@1"`) {
		t.Errorf("frozen definition id not rewritten: %s", v.Definition)
	}

	ctx := context.Background()
	c, err := s.stores.Components.Get(ctx, "dev/card")
	if err != nil || c.LatestVersion != 1 {
		t.Errorf("latestVersion = %d, %v, want 1", c.LatestVersion, err)
	}
	// The stored draft keeps its unpinned working-state id: publish froze a COPY.
	if !strings.Contains(string(c.Draft), `"id":"dev/card"`) || strings.Contains(string(c.Draft), "dev/card@") {
		t.Errorf("draft mutated by publish: %s", c.Draft)
	}

	// Second publish → version 2.
	rec = doJSON(t, h, http.MethodPost, "/v1/components/dev/card/publish", "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("second publish status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatal(err)
	}
	if v.Version != 2 || !strings.Contains(string(v.Definition), `"id":"dev/card@2"`) {
		t.Errorf("second publish = %+v", v)
	}
	if frozen, err := s.stores.ComponentVersions.Get(ctx, "dev/card", 1); err != nil || !strings.Contains(string(frozen.Definition), "@1") {
		t.Errorf("version 1 disturbed by second publish: %v, %v", frozen, err)
	}
}

func TestPublishComponentValidationFailurePassesEnvelopeThrough(t *testing.T) {
	s, h := newTestServer(t)
	seedComponent(t, s, "dev/card", "dev", "Card", "", 0, false, time.Now().UTC())
	mockValidator(t, s, http.StatusUnprocessableEntity,
		`{"error":{"code":"invalid_component","message":"nested instance nodes are not allowed"}}`)

	rec := doJSON(t, h, http.MethodPost, "/v1/components/dev/card/publish", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body: %s)", rec.Code, rec.Body.String())
	}
	if code := errorCode(t, rec); code != "invalid_component" {
		t.Errorf("error.code = %q, want the renderer's code passed through", code)
	}
	if !strings.Contains(rec.Body.String(), "nested instance nodes are not allowed") {
		t.Errorf("renderer message not passed through: %s", rec.Body.String())
	}
	// Nothing was frozen.
	if c, _ := s.stores.Components.Get(context.Background(), "dev/card"); c.LatestVersion != 0 {
		t.Errorf("latestVersion = %d after failed publish, want 0", c.LatestVersion)
	}
	if _, err := s.stores.ComponentVersions.Get(context.Background(), "dev/card", 1); err == nil {
		t.Error("a version was frozen despite failed validation")
	}
}

func TestPublishComponentRendererDown(t *testing.T) {
	s, h := newTestServer(t)
	seedComponent(t, s, "dev/card", "dev", "Card", "", 0, false, time.Now().UTC())
	ts, _, _ := mockValidator(t, s, http.StatusOK, `{"ok":true}`)
	ts.Close() // renderer unreachable

	rec := doJSON(t, h, http.MethodPost, "/v1/components/dev/card/publish", "")
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 (body: %s)", rec.Code, rec.Body.String())
	}
}

// ---- visibility matrix ---------------------------------------------------------

// Visibility uses a non-dev config so anonymous requests are truly anonymous
// (no dev fallback user): public reads must work without any session.
func newVisibilityServer(t *testing.T) (*Server, http.Handler) {
	t.Helper()
	s, _ := newTestServer(t)
	s.cfg = testConfig() // Env "test": no implicit user
	s.sessions = auth.NewMemorySessions()
	now := time.Now().UTC()
	if err := s.stores.Users.Create(context.Background(), &store.User{ID: "u-alice", Login: "alice", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	seedComponent(t, s, "alice/pub", "u-alice", "Published card", "Shiny.", 2, false, now)
	seedComponent(t, s, "alice/hidden", "u-alice", "Unlisted card", "", 1, true, now)
	seedComponent(t, s, "alice/wip", "u-alice", "Draft only", "", 0, false, now)
	return s, s.Handler()
}

func TestComponentVisibilityMatrix(t *testing.T) {
	s, h := newVisibilityServer(t)
	owner := sessionCookie(t, s, "u-alice")

	tests := []struct {
		name       string
		path       string
		cookie     *http.Cookie
		wantStatus int
	}{
		{"anon reads published", "/v1/components/alice/pub", nil, http.StatusOK},
		{"anon blocked from unlisted", "/v1/components/alice/hidden", nil, http.StatusNotFound},
		{"anon blocked from never-published", "/v1/components/alice/wip", nil, http.StatusNotFound},
		{"anon blocked from unknown", "/v1/components/alice/ghost", nil, http.StatusNotFound},
		{"owner reads unlisted", "/v1/components/alice/hidden", owner, http.StatusOK},
		{"owner reads never-published", "/v1/components/alice/wip", owner, http.StatusOK},
		{"pinned version of unlisted still serves", "/v1/components/alice/hidden/versions/1", nil, http.StatusOK},
		{"pinned version of published serves", "/v1/components/alice/pub/versions/1", nil, http.StatusOK},
		{"unknown version 404s", "/v1/components/alice/pub/versions/9", nil, http.StatusNotFound},
		{"malformed version 404s", "/v1/components/alice/pub/versions/latest", nil, http.StatusNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := doJSONAs(t, h, http.MethodGet, tt.path, "", tt.cookie)
			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, tt.wantStatus, rec.Body.String())
			}
		})
	}

	// Public detail: latest published definition, no draft, no unlisted flag.
	rec := doJSONAs(t, h, http.MethodGet, "/v1/components/alice/pub", "", nil)
	body := rec.Body.String()
	if !strings.Contains(body, `"latestVersion":2`) || !strings.Contains(body, `"alice/pub@2"`) {
		t.Errorf("public detail lacks the latest published definition: %s", body)
	}
	if strings.Contains(body, `"draft"`) {
		t.Errorf("public detail leaks the draft: %s", body)
	}

	// Owner detail on the unlisted component keeps the private state.
	rec = doJSONAs(t, h, http.MethodGet, "/v1/components/alice/hidden", "", owner)
	if !strings.Contains(rec.Body.String(), `"unlisted":true`) || !strings.Contains(rec.Body.String(), `"draft"`) {
		t.Errorf("owner detail = %s, want unlisted flag + draft", rec.Body.String())
	}

	// Session-only routes reject anonymous callers outright.
	for _, c := range []struct{ method, path string }{
		{http.MethodGet, "/v1/components"},
		{http.MethodPost, "/v1/components"},
		{http.MethodPut, "/v1/components/alice/pub"},
		{http.MethodDelete, "/v1/components/alice/pub"},
		{http.MethodPost, "/v1/components/alice/pub/publish"},
	} {
		rec := doJSONAs(t, h, c.method, c.path, `{}`, nil)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s anonymous: status = %d, want 401", c.method, c.path, rec.Code)
		}
	}

	// Immutable versions carry an immutable cache header.
	rec = doJSONAs(t, h, http.MethodGet, "/v1/components/alice/pub/versions/1", "", nil)
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Errorf("version Cache-Control = %q, want immutable", cc)
	}
}

func TestUnlistComponent(t *testing.T) {
	s, h := newVisibilityServer(t)
	owner := sessionCookie(t, s, "u-alice")

	rec := doJSONAs(t, h, http.MethodDelete, "/v1/components/alice/pub", "", owner)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	// Idempotent.
	rec = doJSONAs(t, h, http.MethodDelete, "/v1/components/alice/pub", "", owner)
	if rec.Code != http.StatusNoContent {
		t.Errorf("second delete status = %d, want 204", rec.Code)
	}

	// Hidden from anonymous detail + browse, but the pinned version survives.
	if rec := doJSONAs(t, h, http.MethodGet, "/v1/components/alice/pub", "", nil); rec.Code != http.StatusNotFound {
		t.Errorf("unlisted detail status = %d, want 404", rec.Code)
	}
	if rec := doJSONAs(t, h, http.MethodGet, "/v1/community/components", "", nil); strings.Contains(rec.Body.String(), "alice/pub") {
		t.Errorf("unlisted component still browsable: %s", rec.Body.String())
	}
	if rec := doJSONAs(t, h, http.MethodGet, "/v1/components/alice/pub/versions/2", "", nil); rec.Code != http.StatusOK {
		t.Errorf("pinned version after unlist status = %d, want 200 (pinned usages keep rendering)", rec.Code)
	}
}

// ---- GET /v1/community/components ------------------------------------------------

func TestBrowseComponents(t *testing.T) {
	s, h := newVisibilityServer(t)
	base := time.Now().UTC()
	// alice/pub (published base+2min) exists from the seed; add two more.
	seedComponent(t, s, "alice/older", "u-alice", "Sparkline", "Tiny chart.", 1, false, base.Add(-time.Hour))
	seedComponent(t, s, "alice/newest", "u-alice", "Marquee", "", 1, false, base.Add(time.Hour))

	rec := doJSONAs(t, h, http.MethodGet, "/v1/community/components", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Components []struct {
			ID          string     `json:"id"`
			PublishedAt *time.Time `json:"publishedAt"`
			Draft       any        `json:"draft"`
		} `json:"components"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	// Unlisted and draft-only components are absent; newest-published first.
	ids := []string{}
	for _, c := range out.Components {
		ids = append(ids, c.ID)
		if c.Draft != nil {
			t.Errorf("browse leaks a draft for %s", c.ID)
		}
		if c.PublishedAt == nil {
			t.Errorf("browse entry %s lacks publishedAt", c.ID)
		}
	}
	if want := "alice/newest,alice/pub,alice/older"; strings.Join(ids, ",") != want {
		t.Errorf("browse order = %v, want %s", ids, want)
	}

	// q= filters id/title/description case-insensitively.
	for query, want := range map[string]string{
		"MARQUEE":    "alice/newest", // title, case-insensitive
		"tiny chart": "alice/older",  // description
		"alice/pub":  "alice/pub",    // id
	} {
		rec := doJSONAs(t, h, http.MethodGet, "/v1/community/components?q="+strings.ReplaceAll(query, " ", "+"), "", nil)
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if len(out.Components) != 1 || out.Components[0].ID != want {
			t.Errorf("q=%q → %v, want [%s]", query, out.Components, want)
		}
	}
	rec = doJSONAs(t, h, http.MethodGet, "/v1/community/components?q=zzz-no-match", "", nil)
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || len(out.Components) != 0 {
		t.Errorf("no-match browse = %s", rec.Body.String())
	}
}

// &category= filters by exact slug and composes with q; ordering (newest
// published first) is untouched by filtering.
func TestBrowseComponentsCategoryFilterMatrix(t *testing.T) {
	s, h := newVisibilityServer(t) // seeds alice/pub (published, no category)
	base := time.Now().UTC()
	seedCategorizedComponent(t, s, "alice/badge", "u-alice", "Badge", "Tiny stat.", "stats", 1, false, base.Add(-time.Hour))
	seedCategorizedComponent(t, s, "alice/graph", "u-alice", "Graph", "Line chart.", "data", 1, false, base.Add(time.Hour))
	seedCategorizedComponent(t, s, "alice/gauge", "u-alice", "Gauge", "Round meter.", "stats", 1, false, base.Add(2*time.Hour))
	// Unlisted stays hidden even when its category matches the filter.
	seedCategorizedComponent(t, s, "alice/secret", "u-alice", "Secret", "", "stats", 1, true, base.Add(3*time.Hour))

	tests := []struct {
		name    string
		query   string
		wantIDs string // comma-joined, in response order
	}{
		{"no filters keeps full browse order", "", "alice/gauge,alice/graph,alice/pub,alice/badge"},
		{"category exact match, order preserved", "?category=stats", "alice/gauge,alice/badge"},
		{"another category", "?category=data", "alice/graph"},
		{"category composes with q", "?category=stats&q=tiny", "alice/badge"},
		{"category AND q can rule everything out", "?category=stats&q=line", ""},
		{"unknown category matches nothing", "?category=ghost", ""},
		{"category param is case-forgiving", "?category=STATS", "alice/gauge,alice/badge"},
		{"uncategorized components match no category", "?category=uncategorized", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := doJSONAs(t, h, http.MethodGet, "/v1/community/components"+tt.query, "", nil)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
			}
			var out struct {
				Components []struct {
					ID       string `json:"id"`
					Category string `json:"category"`
				} `json:"components"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
				t.Fatal(err)
			}
			ids := []string{}
			for _, c := range out.Components {
				ids = append(ids, c.ID)
			}
			if got := strings.Join(ids, ","); got != tt.wantIDs {
				t.Errorf("ids = %q, want %q", got, tt.wantIDs)
			}
		})
	}

	// Browse entries carry the category (and omit it when unset).
	rec := doJSONAs(t, h, http.MethodGet, "/v1/community/components", "", nil)
	var raw struct {
		Components []map[string]any `json:"components"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	for _, c := range raw.Components {
		id, _ := c["id"].(string)
		cat, present := c["category"]
		switch id {
		case "alice/badge", "alice/gauge":
			if cat != "stats" {
				t.Errorf("%s: category = %v, want stats", id, cat)
			}
		case "alice/graph":
			if cat != "data" {
				t.Errorf("%s: category = %v, want data", id, cat)
			}
		case "alice/pub":
			if present {
				t.Errorf("%s: category should be omitted when unset, got %v", id, cat)
			}
		}
	}
}

func TestBrowseComponentsCap(t *testing.T) {
	s, h := newVisibilityServer(t)
	now := time.Now().UTC()
	for i := range 105 {
		seedComponent(t, s, fmt.Sprintf("alice/bulk-%03d", i), "u-alice", "Bulk", "", 1, false, now.Add(time.Duration(i)*time.Second))
	}
	rec := doJSONAs(t, h, http.MethodGet, "/v1/community/components?q=bulk", "", nil)
	var out struct {
		Components []json.RawMessage `json:"components"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Components) != 100 {
		t.Errorf("browse returned %d entries, want the 100 cap", len(out.Components))
	}
}

// ---- render-path resolution --------------------------------------------------

// mockRenderer implements POST /internal/render, capturing the request body.
func mockRenderer(t *testing.T, s *Server) (*atomic.Int32, *[]byte) {
	t.Helper()
	var calls atomic.Int32
	var lastBody []byte
	mux := http.NewServeMux()
	mux.HandleFunc("POST /internal/render", func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		lastBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"svg":"<svg xmlns=\"http://www.w3.org/2000/svg\"/>","warnings":[]}`))
	})
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	s.renderer = render.NewClient(ts.URL, time.Second)
	return &calls, &lastBody
}

const instanceDesign = `{"version":0,"canvas":{"width":400,"height":200},"nodes":[` +
	`{"id":"a","type":"instance","x":0,"y":0,"w":200,"h":100,"component":"dev/card@1","props":{"label":"hi"}},` +
	`{"id":"b","type":"instance","x":200,"y":0,"w":200,"h":100,"component":"kit/stat-card"},` +
	`{"id":"c","type":"instance","x":0,"y":100,"w":200,"h":100,"component":"dev/card@1"}]}`

func TestRenderResolvesPinnedComponents(t *testing.T) {
	s, h := newTestServer(t)
	calls, lastBody := mockRenderer(t, s)
	seedComponent(t, s, "dev/card", "dev", "Card", "", 1, false, time.Now().UTC())

	rec := doJSON(t, h, http.MethodPost, "/v1/preview", `{"design":`+instanceDesign+`,"data":{}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if calls.Load() != 1 {
		t.Fatalf("renderer called %d times, want 1", calls.Load())
	}

	var req struct {
		Components []json.RawMessage `json:"components"`
	}
	if err := json.Unmarshal(*lastBody, &req); err != nil {
		t.Fatal(err)
	}
	// Exactly one definition: the pinned community version, deduped; kit/*
	// stays out (it resolves inside the renderer).
	if len(req.Components) != 1 {
		t.Fatalf("renderer received %d components, want 1 (deduped, no kit/*): %s", len(req.Components), *lastBody)
	}
	if !strings.Contains(string(req.Components[0]), `"id":"dev/card@1"`) {
		t.Errorf("renderer received the wrong definition: %s", req.Components[0])
	}
}

func TestRenderUnknownComponentFailsPolitely(t *testing.T) {
	tests := []struct {
		name, component string
	}{
		{"missing version", "dev/card@7"},
		{"unknown component", "dev/ghost@1"},
		{"unpinned community ref", "dev/card"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, h := newTestServer(t)
			calls, _ := mockRenderer(t, s)
			seedComponent(t, s, "dev/card", "dev", "Card", "", 1, false, time.Now().UTC())

			design := `{"version":0,"canvas":{"width":10,"height":10},"nodes":[` +
				`{"id":"a","type":"instance","x":0,"y":0,"w":5,"h":5,"component":"` + tt.component + `"}]}`
			rec := doJSON(t, h, http.MethodPost, "/v1/preview", `{"design":`+design+`,"data":{}}`)

			// The error envelope, not a broken render: non-200 so the GitHub
			// Action fails soft, with the offending ref named.
			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d, want 422 (body: %s)", rec.Code, rec.Body.String())
			}
			if code := errorCode(t, rec); code != "unknown_component" {
				t.Errorf("error.code = %q, want unknown_component", code)
			}
			if !strings.Contains(rec.Body.String(), tt.component) {
				t.Errorf("error does not name the ref %q: %s", tt.component, rec.Body.String())
			}
			if calls.Load() != 0 {
				t.Errorf("renderer was called %d times despite the unresolvable ref", calls.Load())
			}
		})
	}
}

// The deploy-token render path resolves components identically (shared path).
func TestDeployRenderResolvesComponents(t *testing.T) {
	s, h := newTestServer(t)
	calls, lastBody := mockRenderer(t, s)
	seedComponent(t, s, "dev/card", "dev", "Card", "", 1, false, time.Now().UTC())

	ctx := context.Background()
	now := time.Now().UTC()
	if err := s.stores.Projects.Create(ctx, &store.Project{
		ID: "p1", UserID: "dev", Name: "P", Design: json.RawMessage(instanceDesign),
		Outputs:   []store.Output{{ID: "default", Filename: "card.svg"}},
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.stores.DeployTokens.Create(ctx, &store.DeployToken{
		ID: "tok-1", ProjectID: "p1", Hash: store.HashToken("mib_test"), CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	r := httptest.NewRequest(http.MethodPost, "/v1/projects/p1/render", nil)
	r.Header.Set("Authorization", "Bearer mib_test")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if calls.Load() != 1 || !strings.Contains(string(*lastBody), `"dev/card@1"`) {
		t.Errorf("renderer calls = %d, body = %s", calls.Load(), *lastBody)
	}
}

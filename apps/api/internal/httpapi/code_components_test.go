package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// Code components (architecture.md §7.6): the API's job is definition
// PASSTHROUGH with a strict shape gate — kind ("declarative"|"code") and
// code (required iff kind is "code", ≤64 KiB) ride the draft PUT, freeze at
// publish, and travel in definition payloads; browse rows carry only the
// kind metadata. Sandbox execution itself is the renderer's publish-time
// job (POST /internal/validate-component) — never the API's.

const testRenderFn = `function render({ props, frame }) { return [{ id: "bg", type: "rect", x: 0, y: 0, w: frame.w, h: frame.h, fill: props.fill }]; }`

// codeDraftBody builds a draft PUT body for a code component.
func codeDraftBody(code string) string {
	b, _ := json.Marshal(map[string]any{
		"title": "Glow fn", "kind": "code", "code": code,
		"frame": map[string]any{"w": 200, "h": 100},
		"props": map[string]any{"fill": map[string]any{"type": "string", "default": "#111"}},
	})
	return string(b)
}

// ---- draft PUT round-trip ---------------------------------------------------

func TestUpdateComponentDraftCodeKindRoundTrips(t *testing.T) {
	s, h := newTestServer(t)
	seedComponent(t, s, "dev/glow-fn", "dev", "Old", "", 0, false, time.Now().UTC())

	rec := doJSON(t, h, http.MethodPut, "/v1/components/dev/glow-fn", codeDraftBody(testRenderFn))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	// The owner view carries the kind metadata.
	if !strings.Contains(rec.Body.String(), `"kind":"code"`) {
		t.Errorf("view lacks kind: %s", rec.Body.String())
	}

	c, err := s.stores.Components.Get(context.Background(), "dev/glow-fn")
	if err != nil {
		t.Fatal(err)
	}
	if c.Kind != "code" {
		t.Errorf("stored Kind = %q, want code", c.Kind)
	}
	var draft struct {
		ID    string          `json:"id"`
		Kind  string          `json:"kind"`
		Code  string          `json:"code"`
		Nodes json.RawMessage `json:"nodes"`
	}
	if err := json.Unmarshal(c.Draft, &draft); err != nil {
		t.Fatal(err)
	}
	if draft.Kind != "code" || draft.Code != testRenderFn {
		t.Errorf("draft kind/code not stored verbatim: %s", c.Draft)
	}
	// nodes stays an optional static palette preview, normalized to [].
	if string(draft.Nodes) != "[]" {
		t.Errorf("draft nodes = %s, want []", draft.Nodes)
	}

	// Updating back to declarative clears kind AND code from the definition
	// (kind defaults absent — it never serializes as "").
	rec = doJSON(t, h, http.MethodPut, "/v1/components/dev/glow-fn",
		`{"title":"Glow fn","frame":{"w":200,"h":100},"nodes":[{"id":"bg","type":"rect","x":0,"y":0,"w":200,"h":100,"fill":"#111"}]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("declarative update status = %d, body = %s", rec.Code, rec.Body.String())
	}
	c, _ = s.stores.Components.Get(context.Background(), "dev/glow-fn")
	if c.Kind != "" || strings.Contains(string(c.Draft), `"kind"`) || strings.Contains(string(c.Draft), `"code"`) {
		t.Errorf("kind/code not cleared: Kind=%q draft=%s", c.Kind, c.Draft)
	}
}

// An explicit kind:"declarative" passes through verbatim (honest metadata),
// it is not silently normalized away.
func TestUpdateComponentDraftExplicitDeclarativeKind(t *testing.T) {
	s, h := newTestServer(t)
	seedComponent(t, s, "dev/card", "dev", "Card", "", 0, false, time.Now().UTC())

	rec := doJSON(t, h, http.MethodPut, "/v1/components/dev/card",
		`{"title":"Card","kind":"declarative","frame":{"w":10,"h":10},"nodes":[{"id":"bg","type":"rect"}]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	c, _ := s.stores.Components.Get(context.Background(), "dev/card")
	if c.Kind != "declarative" || !strings.Contains(string(c.Draft), `"kind":"declarative"`) {
		t.Errorf("explicit declarative kind not passed through: Kind=%q draft=%s", c.Kind, c.Draft)
	}
	if strings.Contains(string(c.Draft), `"code"`) {
		t.Errorf("declarative draft grew a code key: %s", c.Draft)
	}
}

// ---- shape gate: reject and warn rather than permit -------------------------

func TestUpdateComponentDraftKindCodeValidationTable(t *testing.T) {
	tests := []struct {
		name        string
		body        string
		wantMessage string // substring of the polite 400 message
	}{
		{"declarative with code",
			`{"title":"T","kind":"declarative","code":"function render() {}","frame":{"w":1,"h":1},"nodes":[{"id":"a","type":"rect"}]}`,
			`code is only allowed when kind is "code"`},
		{"absent kind with code",
			`{"title":"T","code":"function render() {}","frame":{"w":1,"h":1},"nodes":[{"id":"a","type":"rect"}]}`,
			`code is only allowed when kind is "code"`},
		{"absent kind with empty code",
			`{"title":"T","code":"","frame":{"w":1,"h":1},"nodes":[{"id":"a","type":"rect"}]}`,
			`code is only allowed when kind is "code"`},
		{"kind code without code",
			`{"title":"T","kind":"code","frame":{"w":1,"h":1}}`,
			`code is required when kind is "code"`},
		{"kind code with empty code",
			`{"title":"T","kind":"code","code":"","frame":{"w":1,"h":1}}`,
			`code is required when kind is "code"`},
		{"kind code with null code",
			`{"title":"T","kind":"code","code":null,"frame":{"w":1,"h":1}}`,
			`code is required when kind is "code"`},
		{"unknown kind",
			`{"title":"T","kind":"javascript","code":"function render() {}","frame":{"w":1,"h":1}}`,
			`kind must be "declarative" or "code"`},
		{"kind is case-sensitive",
			`{"title":"T","kind":"Code","code":"function render() {}","frame":{"w":1,"h":1}}`,
			`kind must be "declarative" or "code"`},
		{"empty-string kind means declarative, so code is forbidden",
			`{"title":"T","kind":"","code":"function render() {}","frame":{"w":1,"h":1},"nodes":[{"id":"a","type":"rect"}]}`,
			`code is only allowed when kind is "code"`},
		{"code over the 64 KiB source limit",
			codeDraftBody("//" + strings.Repeat("a", 65535)),
			"code must be at most 65536 bytes"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, h := newTestServer(t)
			seedComponent(t, s, "dev/card", "dev", "Card", "", 0, false, time.Now().UTC())
			rec := doJSON(t, h, http.MethodPut, "/v1/components/dev/card", tt.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body: %s)", rec.Code, rec.Body.String())
			}
			if code := errorCode(t, rec); code != "invalid_request" {
				t.Errorf("error.code = %q", code)
			}
			var envelope struct {
				Error struct {
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(envelope.Error.Message, tt.wantMessage) {
				t.Errorf("message %q not in %q", tt.wantMessage, envelope.Error.Message)
			}
			// Nothing was stored.
			if c, _ := s.stores.Components.Get(context.Background(), "dev/card"); c.Kind != "" || strings.Contains(string(c.Draft), `"code"`) {
				t.Errorf("rejected request mutated the draft: Kind=%q draft=%s", c.Kind, c.Draft)
			}
		})
	}
}

// The source limit is exact: 65536 bytes is accepted, 65537 is not (the
// over-limit case lives in the table above). UTF-8 bytes are what count —
// the sandbox's maxSourceBytes is a byte budget.
func TestUpdateComponentDraftCodeSizeBoundary(t *testing.T) {
	s, h := newTestServer(t)
	seedComponent(t, s, "dev/card", "dev", "Card", "", 0, false, time.Now().UTC())

	exact := "//" + strings.Repeat("a", 65534) // 65536 bytes total
	rec := doJSON(t, h, http.MethodPut, "/v1/components/dev/card", codeDraftBody(exact))
	if rec.Code != http.StatusOK {
		t.Fatalf("65536-byte code: status = %d, want 200 (body: %s)", rec.Code, rec.Body.String()[:min(200, rec.Body.Len())])
	}
	if c, _ := s.stores.Components.Get(context.Background(), "dev/card"); c.Kind != "code" {
		t.Errorf("boundary code draft not stored: Kind=%q", c.Kind)
	}
}

// POST /v1/components creates only the declarative skeleton — kind/code are
// not part of the create surface and stay unknown fields (strict decode).
// A code component becomes one via draft PUT.
func TestCreateComponentRejectsKindCode(t *testing.T) {
	for _, body := range []string{
		`{"name":"x","title":"T","frame":{"w":1,"h":1},"kind":"code"}`,
		`{"name":"x","title":"T","frame":{"w":1,"h":1},"code":"function render() {}"}`,
	} {
		_, h := newTestServer(t)
		rec := doJSON(t, h, http.MethodPost, "/v1/components", body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %s: status = %d, want 400", body, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "unknown field") {
			t.Errorf("body %s: want an unknown-field 400, got %s", body, rec.Body.String())
		}
	}
}

// native/dataFields/dataConnector remain kit-loader-only concepts: the
// community strict decode rejects them as unknown fields — a stranger's
// component can never claim trusted-generator powers or connector access
// (§7.5/§7.6: data reaches components exclusively through props).
func TestCommunityDraftRejectsKitOnlyFields(t *testing.T) {
	for _, field := range []string{
		`"native":true`,
		`"dataFields":["stats.calendar"]`,
		`"dataConnector":"github"`,
	} {
		s, h := newTestServer(t)
		seedComponent(t, s, "dev/card", "dev", "Card", "", 0, false, time.Now().UTC())
		body := `{"title":"T","frame":{"w":1,"h":1},"nodes":[{"id":"a","type":"rect"}],` + field + `}`
		rec := doJSON(t, h, http.MethodPut, "/v1/components/dev/card", body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("field %s: status = %d, want 400 (body: %s)", field, rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "unknown field") {
			t.Errorf("field %s: want an unknown-field 400, got %s", field, rec.Body.String())
		}
	}
}

// ---- publish freezes kind/code -----------------------------------------------

func TestPublishComponentFreezesKindCode(t *testing.T) {
	s, h := newTestServer(t)
	seedComponent(t, s, "dev/glow-fn", "dev", "Glow fn", "", 0, false, time.Now().UTC())
	_, calls, lastBody := mockValidator(t, s, http.StatusOK, `{"ok":true}`)

	if rec := doJSON(t, h, http.MethodPut, "/v1/components/dev/glow-fn", codeDraftBody(testRenderFn)); rec.Code != http.StatusOK {
		t.Fatalf("draft PUT status = %d, body = %s", rec.Code, rec.Body.String())
	}
	rec := doJSON(t, h, http.MethodPost, "/v1/components/dev/glow-fn/publish", "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("publish status = %d, body = %s", rec.Code, rec.Body.String())
	}
	// The renderer's validator received the FULL code definition — it is the
	// component that gets sandbox-executed, not a stripped copy.
	if calls.Load() != 1 || !strings.Contains(string(*lastBody), `"kind":"code"`) ||
		!strings.Contains(string(*lastBody), `"code":`) {
		t.Errorf("validator calls = %d, body = %s, want the kind/code definition", calls.Load(), *lastBody)
	}

	var v struct {
		Version    int             `json:"version"`
		Definition json.RawMessage `json:"definition"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatal(err)
	}
	var frozen struct {
		ID   string `json:"id"`
		Kind string `json:"kind"`
		Code string `json:"code"`
	}
	if err := json.Unmarshal(v.Definition, &frozen); err != nil {
		t.Fatal(err)
	}
	if v.Version != 1 || frozen.ID != "dev/glow-fn@1" || frozen.Kind != "code" || frozen.Code != testRenderFn {
		t.Errorf("frozen definition = %s, want pinned id + kind/code intact", v.Definition)
	}

	// The stored immutable version carries the same bytes.
	stored, err := s.stores.ComponentVersions.Get(context.Background(), "dev/glow-fn", 1)
	if err != nil || !strings.Contains(string(stored.Definition), `"kind":"code"`) {
		t.Errorf("stored version = %s, %v", stored.Definition, err)
	}
}

// A renderer rejection (e.g. the sandbox refusing the code) freezes nothing —
// same pass-through envelope as declarative validation failures.
func TestPublishCodeComponentSandboxRejection(t *testing.T) {
	s, h := newTestServer(t)
	seedComponent(t, s, "dev/glow-fn", "dev", "Glow fn", "", 0, false, time.Now().UTC())
	mockValidator(t, s, http.StatusUnprocessableEntity,
		`{"error":{"code":"invalid_component","message":"code did not produce deterministic output"}}`)

	if rec := doJSON(t, h, http.MethodPut, "/v1/components/dev/glow-fn", codeDraftBody(testRenderFn)); rec.Code != http.StatusOK {
		t.Fatalf("draft PUT status = %d, body = %s", rec.Code, rec.Body.String())
	}
	rec := doJSON(t, h, http.MethodPost, "/v1/components/dev/glow-fn/publish", "")
	if rec.Code != http.StatusBadRequest || errorCode(t, rec) != "invalid_component" {
		t.Fatalf("status = %d, body = %s, want the renderer envelope as 400", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "deterministic") {
		t.Errorf("renderer message not passed through: %s", rec.Body.String())
	}
	if c, _ := s.stores.Components.Get(context.Background(), "dev/glow-fn"); c.LatestVersion != 0 {
		t.Errorf("latestVersion = %d after rejected publish, want 0", c.LatestVersion)
	}
}

// ---- wire visibility: code in definitions, never in browse rows ---------------

func TestCodeComponentWireVisibility(t *testing.T) {
	s, h := newTestServer(t)
	seedComponent(t, s, "dev/glow-fn", "dev", "Glow fn", "", 0, false, time.Now().UTC())
	mockValidator(t, s, http.StatusOK, `{"ok":true}`)

	if rec := doJSON(t, h, http.MethodPut, "/v1/components/dev/glow-fn", codeDraftBody(testRenderFn)); rec.Code != http.StatusOK {
		t.Fatalf("draft PUT status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if rec := doJSON(t, h, http.MethodPost, "/v1/components/dev/glow-fn/publish", ""); rec.Code != http.StatusCreated {
		t.Fatalf("publish status = %d, body = %s", rec.Code, rec.Body.String())
	}

	// Browse rows: kind metadata yes, code never (rows stay light).
	rec := doJSON(t, h, http.MethodGet, "/v1/community/components", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("browse status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var browse struct {
		Components []map[string]any `json:"components"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &browse); err != nil {
		t.Fatal(err)
	}
	if len(browse.Components) != 1 {
		t.Fatalf("browse rows = %d, want 1", len(browse.Components))
	}
	row := browse.Components[0]
	if row["kind"] != "code" {
		t.Errorf("browse row kind = %v, want code", row["kind"])
	}
	for _, key := range []string{"code", "definition", "draft"} {
		if _, present := row[key]; present {
			t.Errorf("browse row carries %q — rows must stay light: %v", key, row)
		}
	}

	// Detail: the definition payload includes the code (public content once
	// published, same as nodes).
	rec = doJSON(t, h, http.MethodGet, "/v1/components/dev/glow-fn", "")
	var detail struct {
		Kind       string `json:"kind"`
		Definition struct {
			Kind string `json:"kind"`
			Code string `json:"code"`
		} `json:"definition"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if detail.Kind != "code" || detail.Definition.Kind != "code" || detail.Definition.Code != testRenderFn {
		t.Errorf("detail = %s, want kind metadata + full code definition", rec.Body.String())
	}

	// Version fetch: the immutable definition includes the code.
	rec = doJSON(t, h, http.MethodGet, "/v1/components/dev/glow-fn/versions/1", "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), fmt.Sprintf("%q", testRenderFn)) {
		t.Errorf("version fetch = %d %s, want the code inside the definition", rec.Code, rec.Body.String())
	}
}

// The render path passes frozen code definitions through to the renderer
// untouched — same stateless resolution as declarative components (§7.5),
// the sandbox execution happens renderer-side.
func TestRenderResolvesCodeComponentDefinition(t *testing.T) {
	s, h := newTestServer(t)
	seedComponent(t, s, "dev/glow-fn", "dev", "Glow fn", "", 0, false, time.Now().UTC())
	mockValidator(t, s, http.StatusOK, `{"ok":true}`)
	if rec := doJSON(t, h, http.MethodPut, "/v1/components/dev/glow-fn", codeDraftBody(testRenderFn)); rec.Code != http.StatusOK {
		t.Fatalf("draft PUT status = %d", rec.Code)
	}
	if rec := doJSON(t, h, http.MethodPost, "/v1/components/dev/glow-fn/publish", ""); rec.Code != http.StatusCreated {
		t.Fatalf("publish status = %d", rec.Code)
	}
	calls, lastBody := mockRenderer(t, s) // replaces the validator client with a render mock

	design := `{"version":0,"canvas":{"width":200,"height":100},"nodes":[` +
		`{"id":"a","type":"instance","x":0,"y":0,"w":200,"h":100,"component":"dev/glow-fn@1","props":{"fill":"#0f0"}}]}`
	rec := doJSON(t, h, http.MethodPost, "/v1/preview", `{"design":`+design+`,"data":{}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("preview status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if calls.Load() != 1 {
		t.Fatalf("renderer calls = %d, want 1", calls.Load())
	}
	var req struct {
		Components []json.RawMessage `json:"components"`
	}
	if err := json.Unmarshal(*lastBody, &req); err != nil {
		t.Fatal(err)
	}
	if len(req.Components) != 1 ||
		!strings.Contains(string(req.Components[0]), `"kind":"code"`) ||
		!strings.Contains(string(req.Components[0]), `"id":"dev/glow-fn@1"`) {
		t.Errorf("renderer received %s, want the pinned code definition", *lastBody)
	}
}

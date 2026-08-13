package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/render"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// ---- helpers -------------------------------------------------------------

// fontBytes fabricates a font binary: the magic prefix plus padding to size.
func fontBytes(magic string, size int) []byte {
	b := make([]byte, size)
	copy(b, magic)
	return b
}

// ttfMagic is the binary TTF signature 0x00010000.
var ttfMagic = string([]byte{0x00, 0x01, 0x00, 0x00})

// uploadFont posts a multipart font upload. Empty weight omits the field.
func uploadFont(t *testing.T, h http.Handler, family, weight string, file []byte) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	if err := mw.WriteField("family", family); err != nil {
		t.Fatal(err)
	}
	if weight != "" {
		if err := mw.WriteField("weight", weight); err != nil {
			t.Fatal(err)
		}
	}
	fw, err := mw.CreateFormFile("file", "upload.bin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write(file); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/v1/fonts", &buf)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

// recordedFonts decodes the fonts array of one recorded render request.
func recordedFonts(t *testing.T, body []byte) []render.Font {
	t.Helper()
	var req struct {
		Fonts []render.Font `json:"fonts"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		t.Fatalf("render request is not JSON: %v", err)
	}
	return req.Fonts
}

// ---- upload matrix -------------------------------------------------------

func TestUploadFontMatrix(t *testing.T) {
	tests := []struct {
		name       string
		family     string
		weight     string
		file       []byte
		wantStatus int
		wantCode   string // error code, or "" for success
		wantFormat string
		wantWeight int
	}{
		{"ttf (0x00010000)", "My Font", "", fontBytes(ttfMagic, 128), http.StatusCreated, "", "ttf", 400},
		{"ttf (true, Apple)", "My Font", "", fontBytes("true", 128), http.StatusCreated, "", "ttf", 400},
		{"otf (OTTO)", "My Font", "400", fontBytes("OTTO", 128), http.StatusCreated, "", "otf", 400},
		{"woff (wOFF)", "My Font", "700", fontBytes("wOFF", 128), http.StatusCreated, "", "woff", 700},
		{"woff2 rejected with explanation", "My Font", "", fontBytes("wOF2", 128), http.StatusBadRequest, "woff2_unsupported", "", 0},
		{"unrecognized magic", "My Font", "", fontBytes("GIF8", 128), http.StatusBadRequest, "invalid_font", "", 0},
		{"too short for a signature", "My Font", "", []byte{0x00}, http.StatusBadRequest, "invalid_font", "", 0},
		{"missing family", "", "", fontBytes(ttfMagic, 128), http.StatusBadRequest, "invalid_request", "", 0},
		{"family too long", strings.Repeat("x", 65), "", fontBytes(ttfMagic, 128), http.StatusBadRequest, "invalid_request", "", 0},
		{"family with control chars", "My\x01Font", "", fontBytes(ttfMagic, 128), http.StatusBadRequest, "invalid_request", "", 0},
		{"builtin family clash", "Inter", "", fontBytes(ttfMagic, 128), http.StatusBadRequest, "invalid_request", "", 0},
		{"builtin clash is case-insensitive", "jetbrains mono", "", fontBytes(ttfMagic, 128), http.StatusBadRequest, "invalid_request", "", 0},
		{"invalid weight", "My Font", "500", fontBytes(ttfMagic, 128), http.StatusBadRequest, "invalid_request", "", 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, h := newTestServer(t)
			rec := uploadFont(t, h, tt.family, tt.weight, tt.file)
			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if tt.wantCode != "" {
				if code := errorCode(t, rec); code != tt.wantCode {
					t.Errorf("error.code = %q, want %q", code, tt.wantCode)
				}
				return
			}
			var v fontView
			if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
				t.Fatal(err)
			}
			if v.ID == "" || v.Family != tt.family || v.Format != tt.wantFormat ||
				v.Weight != tt.wantWeight || v.Size != int64(len(tt.file)) {
				t.Errorf("upload response = %+v", v)
			}
			// The binary landed on disk, 0600, under the owner's directory.
			f, err := s.stores.Fonts.Get(context.Background(), v.ID)
			if err != nil {
				t.Fatal(err)
			}
			info, err := os.Stat(s.fontFilePath(f))
			if err != nil {
				t.Fatalf("binary not on disk: %v", err)
			}
			if info.Mode().Perm() != 0o600 {
				t.Errorf("binary mode = %o, want 0600", info.Mode().Perm())
			}
			if info.Size() != int64(len(tt.file)) {
				t.Errorf("binary size = %d, want %d", info.Size(), len(tt.file))
			}
		})
	}
}

func TestUploadFontWOFF2MessageExplainsLimitation(t *testing.T) {
	_, h := newTestServer(t)
	rec := uploadFont(t, h, "My Font", "", fontBytes("wOF2", 64))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "WOFF2") || !strings.Contains(body, "satori") {
		t.Errorf("WOFF2 rejection does not explain the limitation: %s", body)
	}
}

func TestUploadFontOversize(t *testing.T) {
	_, h := newTestServer(t)

	// One byte over the 5 MB file cap, inside the body cap: polite 400.
	rec := uploadFont(t, h, "My Font", "", fontBytes(ttfMagic, maxFontFileBytes+1))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("5MB+1 status = %d, want 400 (body: %s)", rec.Code, rec.Body.String())
	}
	if code := errorCode(t, rec); code != "file_too_large" {
		t.Errorf("error.code = %q, want file_too_large", code)
	}

	// Beyond the whole-body cap: hard 413.
	rec = uploadFont(t, h, "My Font", "", fontBytes(ttfMagic, maxFontFileBytes+fontUploadSlack+1))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body status = %d, want 413 (body: %s)", rec.Code, rec.Body.String())
	}
}

func TestUploadFontQuota(t *testing.T) {
	s, h := newTestServer(t)
	ctx := context.Background()
	for i := 0; i < maxFontsPerUser; i++ {
		if err := s.stores.Fonts.Create(ctx, &store.Font{
			ID: "font-seed-" + string(rune('a'+i)), UserID: "dev",
			Family: "Seed " + string(rune('A'+i)), Weight: 400,
			Format: "ttf", Size: 1, Hash: "h", CreatedAt: time.Now().UTC(),
		}); err != nil {
			t.Fatal(err)
		}
	}
	rec := uploadFont(t, h, "One Too Many", "", fontBytes(ttfMagic, 64))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (body: %s)", rec.Code, rec.Body.String())
	}
	if code := errorCode(t, rec); code != "quota_exceeded" {
		t.Errorf("error.code = %q, want quota_exceeded", code)
	}
}

func TestUploadFontDuplicateFace(t *testing.T) {
	_, h := newTestServer(t)
	if rec := uploadFont(t, h, "My Font", "400", fontBytes(ttfMagic, 64)); rec.Code != http.StatusCreated {
		t.Fatalf("first upload status = %d", rec.Code)
	}
	// Same (family, weight): 409.
	rec := uploadFont(t, h, "My Font", "400", fontBytes("OTTO", 64))
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate face status = %d, want 409 (body: %s)", rec.Code, rec.Body.String())
	}
	if code := errorCode(t, rec); code != "conflict" {
		t.Errorf("error.code = %q, want conflict", code)
	}
	// Same family, other weight: fine.
	if rec := uploadFont(t, h, "My Font", "700", fontBytes(ttfMagic, 64)); rec.Code != http.StatusCreated {
		t.Errorf("bold face of the same family status = %d, want 201 (body: %s)", rec.Code, rec.Body.String())
	}
}

// ---- listing -------------------------------------------------------------

func TestListFontsBuiltinFallbackAndMine(t *testing.T) {
	// The test server has no renderer at all — the builtin list must be the
	// hardcoded fallback, so boot (and this route) never depends on the
	// renderer being reachable.
	_, h := newTestServer(t)
	uploadFont(t, h, "Zeta", "", fontBytes(ttfMagic, 64))
	uploadFont(t, h, "Alpha", "700", fontBytes("wOFF", 64))
	uploadFont(t, h, "Alpha", "400", fontBytes(ttfMagic, 64))

	rec := doJSON(t, h, http.MethodGet, "/v1/fonts", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Builtin []render.BuiltinFont `json:"builtin"`
		Mine    []fontView           `json:"mine"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	families := make([]string, 0, len(resp.Builtin))
	for _, b := range resp.Builtin {
		families = append(families, b.Family)
		if len(b.Weights) == 0 {
			t.Errorf("builtin %q has no weights", b.Family)
		}
	}
	if strings.Join(families, ",") != "Inter,JetBrains Mono,Lora" {
		t.Errorf("builtin families = %v, want the fallback list", families)
	}
	// mine: sorted by family then weight.
	got := make([]string, 0, len(resp.Mine))
	for _, f := range resp.Mine {
		got = append(got, f.Family+"/"+map[int]string{400: "400", 700: "700"}[f.Weight])
	}
	if strings.Join(got, ",") != "Alpha/400,Alpha/700,Zeta/400" {
		t.Errorf("mine = %v, want sorted by family then weight", got)
	}
}

func TestBuiltinFontsFromRenderer(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /internal/fonts", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"builtin":[{"family":"Inter","weights":[400,700]},{"family":"Noto Sans SC","weights":[400]}]}`))
	})
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)

	fonts, err := render.NewClient(ts.URL, time.Second).BuiltinFonts(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(fonts) != 2 || fonts[1].Family != "Noto Sans SC" {
		t.Errorf("fonts = %+v", fonts)
	}

	// Renderer down: an error — main falls back to render.FallbackBuiltinFonts.
	ts.Close()
	if _, err := render.NewClient(ts.URL, time.Second).BuiltinFonts(context.Background()); err == nil {
		t.Error("BuiltinFonts against a down renderer did not error")
	}

	// A fetched list overrides the fallback everywhere: the clash check too.
	s, h := newTestServer(t)
	s.builtinFonts = fonts
	rec := uploadFont(t, h, "noto sans sc", "", fontBytes(ttfMagic, 64))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("clash with a renderer-provided builtin: status = %d, want 400", rec.Code)
	}
}

// ---- file route ----------------------------------------------------------

func TestFontFileRouteOwnerOnly(t *testing.T) {
	s, h := newTestServer(t)
	file := fontBytes("wOFF", 256)
	rec := uploadFont(t, h, "My Font", "", file)
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload status = %d", rec.Code)
	}
	var v fontView
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatal(err)
	}

	rec = doJSON(t, h, http.MethodGet, "/v1/fonts/"+v.ID+"/file", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("file status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "font/woff" {
		t.Errorf("Content-Type = %q, want font/woff", ct)
	}
	etag := rec.Header().Get("ETag")
	if etag == "" || !strings.HasPrefix(etag, `"`) {
		t.Errorf("ETag = %q, want a quoted hash", etag)
	}
	if !bytes.Equal(rec.Body.Bytes(), file) {
		t.Error("file route did not return the uploaded bytes")
	}

	// Conditional fetch: the hash ETag short-circuits to 304.
	r := httptest.NewRequest(http.MethodGet, "/v1/fonts/"+v.ID+"/file", nil)
	r.Header.Set("If-None-Match", etag)
	cond := httptest.NewRecorder()
	h.ServeHTTP(cond, r)
	if cond.Code != http.StatusNotModified {
		t.Errorf("If-None-Match status = %d, want 304", cond.Code)
	}

	// Another user's font: same 404 as not-found — no existence leak.
	other := &store.Font{
		ID: "font-other", UserID: "someone-else", Family: "Their Font", Weight: 400,
		Format: "ttf", Size: 64, Hash: "deadbeef", CreatedAt: time.Now().UTC(),
	}
	if err := s.stores.Fonts.Create(context.Background(), other); err != nil {
		t.Fatal(err)
	}
	if err := s.writeFontFile(other, fontBytes(ttfMagic, 64)); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/v1/fonts/font-other/file", "/v1/fonts/font-ghost/file"} {
		rec := doJSON(t, h, http.MethodGet, path, "")
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s status = %d, want 404", path, rec.Code)
		}
	}
}

// ---- delete lifecycle ----------------------------------------------------

func TestDeleteFontLifecycle(t *testing.T) {
	s, h := newTestServer(t)
	rec := uploadFont(t, h, "My Font", "", fontBytes(ttfMagic, 64))
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload status = %d", rec.Code)
	}
	var v fontView
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatal(err)
	}
	f, err := s.stores.Fonts.Get(context.Background(), v.ID)
	if err != nil {
		t.Fatal(err)
	}
	path := s.fontFilePath(f)

	if rec := doJSON(t, h, http.MethodDelete, "/v1/fonts/"+v.ID, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body = %s", rec.Code, rec.Body.String())
	}
	// Metadata and binary are both gone; the routes agree.
	if _, err := s.stores.Fonts.Get(context.Background(), v.ID); err == nil {
		t.Error("metadata still present after delete")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("binary still on disk after delete: %v", err)
	}
	if rec := doJSON(t, h, http.MethodGet, "/v1/fonts/"+v.ID+"/file", ""); rec.Code != http.StatusNotFound {
		t.Errorf("file route after delete = %d, want 404", rec.Code)
	}
	if rec := doJSON(t, h, http.MethodDelete, "/v1/fonts/"+v.ID, ""); rec.Code != http.StatusNotFound {
		t.Errorf("second delete = %d, want 404", rec.Code)
	}

	// Deleting someone else's font: 404, nothing removed.
	other := &store.Font{
		ID: "font-other", UserID: "someone-else", Family: "Their Font", Weight: 400,
		Format: "ttf", Size: 64, Hash: "deadbeef", CreatedAt: time.Now().UTC(),
	}
	if err := s.stores.Fonts.Create(context.Background(), other); err != nil {
		t.Fatal(err)
	}
	if rec := doJSON(t, h, http.MethodDelete, "/v1/fonts/font-other", ""); rec.Code != http.StatusNotFound {
		t.Errorf("cross-user delete = %d, want 404", rec.Code)
	}
	if _, err := s.stores.Fonts.Get(context.Background(), "font-other"); err != nil {
		t.Error("cross-user delete removed the other user's font")
	}
}

// ---- render-path attachment ----------------------------------------------

// designWithFamilies builds a minimal design whose text nodes reference the
// given families via style.fontFamily.
func designWithFamilies(families ...string) string {
	nodes := make([]string, 0, len(families))
	for i, fam := range families {
		nodes = append(nodes, `{"id":"t`+string(rune('0'+i))+`","type":"text","x":0,"y":0,"w":5,"h":5,"text":"hi","style":{"fontFamily":`+strconv.Quote(fam)+`}}`)
	}
	return `{"version":0,"canvas":{"width":10,"height":10},"nodes":[` + strings.Join(nodes, ",") + `]}`
}

func TestPreviewAttachesReferencedOwnerFonts(t *testing.T) {
	s, h := newTestServer(t)
	calls, lastBody := mockRenderer(t, s)

	file := fontBytes(ttfMagic, 96)
	if rec := uploadFont(t, h, "My Font", "", file); rec.Code != http.StatusCreated {
		t.Fatalf("upload status = %d", rec.Code)
	}
	// A second upload the design does NOT reference must not be attached.
	if rec := uploadFont(t, h, "Unused Font", "", fontBytes("OTTO", 96)); rec.Code != http.StatusCreated {
		t.Fatalf("upload status = %d", rec.Code)
	}

	// Referencing a builtin plus the upload: only the upload travels (the
	// builtin lives renderer-side).
	design := designWithFamilies("Inter", "My Font")
	rec := doJSON(t, h, http.MethodPost, "/v1/preview", `{"design":`+design+`,"data":{}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("preview status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if calls.Load() != 1 {
		t.Fatalf("renderer called %d times, want 1", calls.Load())
	}
	fonts := recordedFonts(t, *lastBody)
	if len(fonts) != 1 {
		t.Fatalf("attached fonts = %d, want exactly the referenced upload (%+v)", len(fonts), fonts)
	}
	if fonts[0].Family != "My Font" || fonts[0].Weight != 400 {
		t.Errorf("attached font = %+v", fonts[0])
	}
	if fonts[0].Data != base64.StdEncoding.EncodeToString(file) {
		t.Error("attached font data is not the uploaded binary as base64")
	}

	// A design referencing no uploads attaches nothing.
	rec = doJSON(t, h, http.MethodPost, "/v1/preview", `{"design":`+designWithFamilies("Inter")+`,"data":{}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("second preview status = %d", rec.Code)
	}
	if fonts := recordedFonts(t, *lastBody); len(fonts) != 0 {
		t.Errorf("unreferenced fonts attached: %+v", fonts)
	}
}

func TestProjectRenderAttachesProjectOwnerFonts(t *testing.T) {
	s, h := newTestServer(t)
	calls, lastBody := mockRenderer(t, s)
	ctx := context.Background()

	// The session user ("dev") owns the project and the font. A same-family
	// font of ANOTHER user must never attach to dev's render.
	file := fontBytes("wOFF", 96)
	if rec := uploadFont(t, h, "My Font", "700", file); rec.Code != http.StatusCreated {
		t.Fatalf("upload status = %d", rec.Code)
	}
	stranger := &store.Font{
		ID: "font-stranger", UserID: "stranger", Family: "My Font", Weight: 400,
		Format: "ttf", Size: 96, Hash: "beef", CreatedAt: time.Now().UTC(),
	}
	if err := s.stores.Fonts.Create(ctx, stranger); err != nil {
		t.Fatal(err)
	}
	if err := s.writeFontFile(stranger, fontBytes(ttfMagic, 96)); err != nil {
		t.Fatal(err)
	}

	now := time.Now().UTC()
	if err := s.stores.Projects.Create(ctx, &store.Project{
		ID: "p1", UserID: "dev", Name: "Card",
		Design:   json.RawMessage(designWithFamilies("My Font")),
		Bindings: []store.Binding{}, Outputs: []store.Output{{ID: "default", Filename: "card.svg"}},
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.stores.DeployTokens.Create(ctx, &store.DeployToken{
		ID: "tok-1", ProjectID: "p1", Hash: store.HashToken("mib_render"), CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	// Deploy-token render: no session at all — fonts resolve against the
	// PROJECT OWNER.
	r := httptest.NewRequest(http.MethodPost, "/v1/projects/p1/render", nil)
	r.Header.Set("Authorization", "Bearer mib_render")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("render status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if calls.Load() != 1 {
		t.Fatalf("renderer called %d times, want 1", calls.Load())
	}
	fonts := recordedFonts(t, *lastBody)
	if len(fonts) != 1 || fonts[0].Family != "My Font" || fonts[0].Weight != 700 {
		t.Fatalf("attached fonts = %+v, want exactly the owner's 700 face", fonts)
	}
	if fonts[0].Data != base64.StdEncoding.EncodeToString(file) {
		t.Error("attached data is the stranger's binary, not the owner's")
	}
}

func TestDeletedFontFallsBackSilently(t *testing.T) {
	// Delete the font, keep the design referencing it: the render must
	// proceed with no fonts attached (renderer falls back to Inter with a
	// warning — documented no-cascade behavior).
	s, h := newTestServer(t)
	_, lastBody := mockRenderer(t, s)

	rec := uploadFont(t, h, "My Font", "", fontBytes(ttfMagic, 64))
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload status = %d", rec.Code)
	}
	var v fontView
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatal(err)
	}
	if rec := doJSON(t, h, http.MethodDelete, "/v1/fonts/"+v.ID, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d", rec.Code)
	}

	rec = doJSON(t, h, http.MethodPost, "/v1/preview", `{"design":`+designWithFamilies("My Font")+`,"data":{}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("preview after delete status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if fonts := recordedFonts(t, *lastBody); len(fonts) != 0 {
		t.Errorf("deleted font still attached: %+v", fonts)
	}
}

func TestDesignFontFamiliesWalk(t *testing.T) {
	design := `{
		"canvas": {"width": 10, "height": 10},
		"nodes": [
			{"type": "text", "style": {"fontFamily": "A"}},
			{"type": "text", "style": {"fontFamily": "A"}},
			{"type": "group", "children": [{"style": {"fontFamily": "B"}}]},
			{"type": "text", "text": "fontFamily is just prose here"},
			{"type": "text", "style": {"fontFamily": ""}},
			{"type": "text", "style": {"fontFamily": 42}}
		]
	}`
	got := designFontFamilies([]byte(design))
	if len(got) != 2 || !got["A"] || !got["B"] {
		t.Errorf("families = %v, want {A, B}", got)
	}
	if designFontFamilies([]byte(`not json`)) != nil {
		t.Error("unparseable design should contribute nothing")
	}
}

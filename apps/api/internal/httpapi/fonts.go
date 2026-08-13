package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/render"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// User fonts (architecture.md §5/§8). Built-in OFL families (Inter,
// JetBrains Mono, Lora) are available to everyone and live renderer-side;
// uploaded TTF/OTF/WOFF faces are private to their owner and travel inside
// the render request as base64 — the renderer stays stateless. Output stays
// text-to-path vectors, so Camo-safety and size are unaffected by which font
// rendered the text.

const (
	// maxFontFileBytes caps one uploaded font binary (contract: 5 MB).
	maxFontFileBytes = 5 << 20
	// fontUploadSlack is multipart framing + form-field headroom on top of
	// the file cap; a body beyond file cap + slack is a hard 413, a file
	// beyond the cap inside an accepted body is a polite 400.
	fontUploadSlack = 1 << 20
	// maxFontsPerUser is the per-user quota (contract: 10 fonts/user).
	maxFontsPerUser = 10
	// fontFamilyMaxRunes caps the family name length (contract: ≤64 chars).
	fontFamilyMaxRunes = 64
)

// ---- magic-byte format detection ----------------------------------------

// errWOFF2 marks the one rejected-but-recognized format: satori (the
// renderer's layout engine) cannot parse WOFF2, so accepting it would only
// defer the failure to render time with a worse message.
var errWOFF2 = errors.New("WOFF2 is not supported: the renderer's satori engine cannot parse WOFF2 — convert the font to TTF, OTF, or WOFF and upload that")

// detectFontFormat sniffs the upload's magic bytes and returns the storage
// format/extension: 0x00010000 or "true" → ttf, "OTTO" → otf, "wOFF" → woff.
// "wOF2" returns errWOFF2 (a 400 explaining the limitation, not a generic
// rejection); anything else is not a font container we can pass to satori.
func detectFontFormat(data []byte) (string, error) {
	if len(data) < 4 {
		return "", errors.New("file is not a TTF, OTF, or WOFF font (too short to carry a font signature)")
	}
	switch {
	case bytes.Equal(data[:4], []byte{0x00, 0x01, 0x00, 0x00}) || bytes.Equal(data[:4], []byte("true")):
		return "ttf", nil
	case bytes.Equal(data[:4], []byte("OTTO")):
		return "otf", nil
	case bytes.Equal(data[:4], []byte("wOFF")):
		return "woff", nil
	case bytes.Equal(data[:4], []byte("wOF2")):
		return "", errWOFF2
	default:
		return "", errors.New("file is not a TTF, OTF, or WOFF font (unrecognized magic bytes)")
	}
}

// fontContentType maps a stored format to the media type of the file route.
func fontContentType(format string) string {
	switch format {
	case "ttf":
		return "font/ttf"
	case "otf":
		return "font/otf"
	default:
		return "font/woff"
	}
}

// ---- validation ----------------------------------------------------------

// builtinFontList returns the renderer-provided built-in families, or the
// hardcoded fallback when the renderer was down at boot (see
// render.FallbackBuiltinFonts for why the fallback exists).
func (s *Server) builtinFontList() []render.BuiltinFont {
	if s.builtinFonts != nil {
		return s.builtinFonts
	}
	return render.FallbackBuiltinFonts
}

// validateFontFamily checks an uploaded family name: printable, 1..64 runes,
// and not one of the built-in families — a user font named "Inter" would
// shadow the builtin in every family match, silently changing designs that
// meant the builtin (case-insensitive so "inter" cannot sneak past while
// still colliding visually in the editor's font picker).
func (s *Server) validateFontFamily(family string) error {
	if family == "" {
		return errors.New("family is required")
	}
	if utf8.RuneCountInString(family) > fontFamilyMaxRunes {
		return fmt.Errorf("family must be at most %d characters", fontFamilyMaxRunes)
	}
	for _, r := range family {
		if !unicode.IsPrint(r) {
			return errors.New("family must contain only printable characters")
		}
	}
	for _, b := range s.builtinFontList() {
		if strings.EqualFold(family, b.Family) {
			return fmt.Errorf("%q is a built-in family and cannot be replaced; pick another name", b.Family)
		}
	}
	return nil
}

// ---- binary storage ------------------------------------------------------
// Binaries live under {fontsDir}/{userID}/{fontID}.{format} (dirs 0700,
// files 0600): metadata in the store, bytes on disk, joined by the font id.

func (s *Server) fontFilePath(f *store.Font) string {
	return filepath.Join(s.fontsDir, f.UserID, f.ID+"."+f.Format)
}

func (s *Server) writeFontFile(f *store.Font, data []byte) error {
	dir := filepath.Join(s.fontsDir, f.UserID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return os.WriteFile(s.fontFilePath(f), data, 0o600)
}

// newFontID generates the public identifier of a font.
func newFontID() string {
	var b [8]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read never fails on supported platforms
	return "font-" + hex.EncodeToString(b[:])
}

// fontView is the wire shape of one uploaded font (never the binary, never
// the storage path).
type fontView struct {
	ID        string    `json:"id"`
	Family    string    `json:"family"`
	Weight    int       `json:"weight"`
	Format    string    `json:"format"`
	Size      int64     `json:"size"`
	CreatedAt time.Time `json:"createdAt"`
}

func viewOfFont(f *store.Font) fontView {
	return fontView{ID: f.ID, Family: f.Family, Weight: f.Weight, Format: f.Format, Size: f.Size, CreatedAt: f.CreatedAt}
}

// ---- POST /v1/fonts ------------------------------------------------------
// Multipart upload: file (the binary) + family + optional weight (400|700,
// default 400). Session auth; the font belongs to the session user.

func (s *Server) handleUploadFont(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxFontFileBytes+fontUploadSlack)
	if err := r.ParseMultipartForm(maxFontFileBytes + fontUploadSlack); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "file_too_large",
				fmt.Sprintf("font uploads are capped at %d MB", maxFontFileBytes>>20))
			return
		}
		writeError(w, http.StatusBadRequest, "invalid_request", "body must be multipart/form-data with fields: file, family, weight?")
		return
	}

	family := strings.TrimSpace(r.FormValue("family"))
	if err := s.validateFontFamily(family); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	weight := 400
	switch r.FormValue("weight") {
	case "", "400":
	case "700":
		weight = 700
	default:
		writeError(w, http.StatusBadRequest, "invalid_request", "weight must be 400 or 700")
		return
	}

	file, _, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", `multipart field "file" is required`)
		return
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "reading the uploaded file failed")
		return
	}
	if len(data) > maxFontFileBytes {
		writeError(w, http.StatusBadRequest, "file_too_large",
			fmt.Sprintf("font files are capped at %d MB", maxFontFileBytes>>20))
		return
	}
	format, err := detectFontFormat(data)
	if err != nil {
		code := "invalid_font"
		if errors.Is(err, errWOFF2) {
			code = "woff2_unsupported"
		}
		writeError(w, http.StatusBadRequest, code, err.Error())
		return
	}

	uid := userID(r)
	existing, err := s.stores.Fonts.ListByUser(r.Context(), uid)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "listing fonts failed")
		return
	}
	if len(existing) >= maxFontsPerUser {
		writeError(w, http.StatusConflict, "quota_exceeded",
			fmt.Sprintf("you can store at most %d fonts; delete one first", maxFontsPerUser))
		return
	}

	hash := sha256.Sum256(data)
	font := &store.Font{
		ID:        newFontID(),
		UserID:    uid,
		Family:    family,
		Weight:    weight,
		Format:    format,
		Size:      int64(len(data)),
		Hash:      hex.EncodeToString(hash[:]),
		CreatedAt: time.Now().UTC(),
	}
	// Binary first, row second: a row without its binary would 500 on the
	// file route and silently skip at render time, while an orphaned binary
	// is unreachable garbage — the safer failure. On row failure the binary
	// is unlinked again.
	if err := s.writeFontFile(font, data); err != nil {
		s.log.Error("writing font binary failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "storing font failed")
		return
	}
	if err := s.stores.Fonts.Create(r.Context(), font); err != nil {
		_ = os.Remove(s.fontFilePath(font))
		if errors.Is(err, store.ErrExists) {
			writeError(w, http.StatusConflict, "conflict",
				fmt.Sprintf("a font with family %q and weight %d already exists; delete it first", family, weight))
			return
		}
		writeError(w, http.StatusInternalServerError, "internal", "storing font failed")
		return
	}
	writeJSON(w, http.StatusCreated, viewOfFont(font))
}

// ---- GET /v1/fonts -------------------------------------------------------
// The families the editor's font picker offers: built-ins (usable by every
// design and the only families community components may reference) plus the
// session user's uploads.

func (s *Server) handleListFonts(w http.ResponseWriter, r *http.Request) {
	mine, err := s.stores.Fonts.ListByUser(r.Context(), userID(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "listing fonts failed")
		return
	}
	sort.Slice(mine, func(i, j int) bool {
		if mine[i].Family != mine[j].Family {
			return mine[i].Family < mine[j].Family
		}
		if mine[i].Weight != mine[j].Weight {
			return mine[i].Weight < mine[j].Weight
		}
		return mine[i].ID < mine[j].ID
	})
	views := make([]fontView, 0, len(mine))
	for _, f := range mine {
		views = append(views, viewOfFont(f))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"builtin": s.builtinFontList(),
		"mine":    views,
	})
}

// ---- GET /v1/fonts/{id}/file ---------------------------------------------
// Owner-only binary fetch, for the editor's FontFace registration (canvas
// text must be drawn with the real glyphs). Not-found and not-yours are the
// same 404 so font ids never leak across users.

func (s *Server) handleFontFile(w http.ResponseWriter, r *http.Request) {
	font, ok := s.ownedFont(w, r)
	if !ok {
		return
	}
	etag := `"` + font.Hash + `"`
	if strings.Contains(r.Header.Get("If-None-Match"), etag) {
		w.Header().Set("ETag", etag)
		w.WriteHeader(http.StatusNotModified)
		return
	}
	data, err := os.ReadFile(s.fontFilePath(font))
	if err != nil {
		s.log.Error("font binary missing from storage", "font", font.ID, "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "font binary is missing from storage")
		return
	}
	w.Header().Set("Content-Type", fontContentType(font.Format))
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "private, max-age=31536000")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// ---- DELETE /v1/fonts/{id} -----------------------------------------------
// Removes metadata + binary. Deliberately no cascade into designs: any
// design still naming the family simply falls back to the renderer's default
// (Inter) with a render warning from then on — a design can go plain but can
// never break (documented in architecture.md §8).

func (s *Server) handleDeleteFont(w http.ResponseWriter, r *http.Request) {
	font, ok := s.ownedFont(w, r)
	if !ok {
		return
	}
	if err := s.stores.Fonts.Delete(r.Context(), font.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "deleting font failed")
		return
	}
	// The row is gone (nothing can resolve the binary anymore); a failed
	// unlink leaves unreachable bytes, not broken state.
	if err := os.Remove(s.fontFilePath(font)); err != nil && !os.IsNotExist(err) {
		s.log.Warn("removing font binary failed", "font", font.ID, "err", err)
	}
	w.WriteHeader(http.StatusNoContent)
}

// ownedFont loads the {id} font and enforces ownership; on failure it writes
// the 404 envelope (not-found and not-yours are indistinguishable on
// purpose, like projects) and returns ok=false.
func (s *Server) ownedFont(w http.ResponseWriter, r *http.Request) (*store.Font, bool) {
	font, err := s.stores.Fonts.Get(r.Context(), r.PathValue("id"))
	if err != nil || font.UserID != userID(r) {
		writeError(w, http.StatusNotFound, "not_found", "font not found")
		return nil, false
	}
	return font, true
}

// ---- render-path font resolution -----------------------------------------

// designFontFamilies collects every string value keyed "fontFamily" anywhere
// in the design document (style.fontFamily today, at any nesting depth
// tomorrow), deduped. A targeted walk of the decoded JSON rather than a
// schema-aware parse: the renderer owns design validation, and over-matching
// merely attaches a font the render may not use — never misses one. An
// unparseable design contributes nothing (the renderer's 422 to raise).
func designFontFamilies(design []byte) map[string]bool {
	var doc any
	if err := json.Unmarshal(design, &doc); err != nil {
		return nil
	}
	families := map[string]bool{}
	collectFontFamilies(doc, families)
	return families
}

func collectFontFamilies(v any, families map[string]bool) {
	switch node := v.(type) {
	case map[string]any:
		for key, val := range node {
			if key == "fontFamily" {
				if fam, ok := val.(string); ok && fam != "" {
					families[fam] = true
				}
				continue
			}
			collectFontFamilies(val, families)
		}
	case []any:
		for _, item := range node {
			collectFontFamilies(item, families)
		}
	}
}

// resolveDesignFonts collects the OWNER's uploaded fonts whose family the
// design references and returns them as base64 render-request fonts
// (architecture.md §5): project.UserID for deploy renders, the session user
// for previews — a stranger's design can never carry someone's private font.
//
// Scanning the design level suffices even though instance expansion is
// renderer-side: community components may reference BUILT-IN families only
// (publish-time rejection), kit fragments are first-party and stick to
// builtins too, so a non-builtin family can only ever appear in the design
// document itself. A referenced family with no matching upload (deleted, or
// never the owner's) is attached as nothing — the renderer falls back to its
// default with a warning, never a failure.
func (s *Server) resolveDesignFonts(ctx context.Context, ownerID string, design []byte) ([]render.Font, error) {
	families := designFontFamilies(design)
	if len(families) == 0 {
		return nil, nil
	}
	owned, err := s.stores.Fonts.ListByUser(ctx, ownerID)
	if err != nil {
		return nil, err
	}
	matched := owned[:0]
	for _, f := range owned {
		if families[f.Family] {
			matched = append(matched, f)
		}
	}
	// Deterministic request order (renders are byte-identical by contract).
	sort.Slice(matched, func(i, j int) bool {
		if matched[i].Family != matched[j].Family {
			return matched[i].Family < matched[j].Family
		}
		return matched[i].Weight < matched[j].Weight
	})
	var fonts []render.Font
	for _, f := range matched {
		data, err := os.ReadFile(s.fontFilePath(f))
		if err != nil {
			// Metadata without its binary: render with the fallback (plus the
			// renderer's unknown-family warning) instead of failing the card.
			s.log.Error("font binary missing at render time; family will fall back", "font", f.ID, "family", f.Family, "err", err)
			continue
		}
		fonts = append(fonts, render.Font{
			Family: f.Family,
			Weight: f.Weight,
			Data:   base64.StdEncoding.EncodeToString(data),
		})
	}
	return fonts, nil
}

package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/connector"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/kit"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/render"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// ---- GET /healthz ------------------------------------------------------

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---- GET /v1/kit --------------------------------------------------------
// Public kit metadata for the editor palette (architecture.md §8). The list
// is loaded once at startup and immutable, so a short client cache matches
// the Camo/raw cadence used elsewhere.

func (s *Server) handleKit(w http.ResponseWriter, _ *http.Request) {
	components := s.kit
	if components == nil {
		components = []kit.Component{} // always a JSON array, never null
	}
	w.Header().Set("Cache-Control", "max-age=300")
	writeJSON(w, http.StatusOK, components)
}

// ---- POST /v1/projects/{id}/render?output={outputId} -------------------
// Deploy-token auth is enforced by requireDeployToken before this runs.
// This is the endpoint the GitHub Action calls.

func (s *Server) handleRender(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	project, err := s.stores.Projects.Get(ctx, r.PathValue("id"))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// A valid deploy token for a missing project means the project was
			// deleted underneath its tokens; still a 404.
			writeError(w, http.StatusNotFound, "not_found", "project not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "internal", "project lookup failed")
		return
	}

	output, ok := selectOutput(project.Outputs, r.URL.Query().Get("output"))
	if !ok {
		writeError(w, http.StatusBadRequest, "unknown_output", "no such output for this project")
		return
	}

	data, ok := s.resolveBindingData(w, r, project.UserID, project.Bindings)
	if !ok {
		return
	}

	s.renderAndReply(w, r, project.Design, data, output.Theme)
}

// resolveBindingData merges the (cached) connector snapshots for a set of
// bindings, filtered down to exactly the bound fields. This filtering is the
// consent/security boundary — the renderer never sees unbound data. On
// failure it writes the error envelope and returns ok=false.
func (s *Server) resolveBindingData(w http.ResponseWriter, r *http.Request, ownerID string, bindings []store.Binding) (map[string]any, bool) {
	data := map[string]any{}
	for _, b := range bindings {
		account := s.resolveAccount(r, ownerID, b)
		snapshot, err := s.cache.Snapshot(r.Context(), ownerID, b.Connector, account)
		if err != nil {
			if errors.Is(err, connector.ErrUnknown) {
				s.log.Error("binding references unregistered connector", "connector", b.Connector)
				writeError(w, http.StatusInternalServerError, "unknown_connector", "bound connector is unavailable")
				return nil, false
			}
			// Cold-miss upstream failure: nothing stale to serve, fail soft.
			writeError(w, http.StatusBadGateway, "connector_unavailable", "connector data is unavailable")
			return nil, false
		}
		data[b.Connector] = connector.Filter(snapshot, b.Fields)
	}
	return data, true
}

// resolveAccount finds the ConnectorAccount for a binding. Missing accounts
// are fine for the dev stub / auth:none connectors — Fetch accepts nil.
func (s *Server) resolveAccount(r *http.Request, ownerID string, b store.Binding) *store.ConnectorAccount {
	account, err := s.stores.ConnectorAccounts.GetByUserConnector(r.Context(), ownerID, b.Connector)
	if err != nil {
		return nil
	}
	return account
}

// selectOutput picks the requested output, defaulting to the first one.
func selectOutput(outputs []store.Output, id string) (store.Output, bool) {
	if id == "" {
		if len(outputs) == 0 {
			return store.Output{}, false
		}
		return outputs[0], true
	}
	for _, o := range outputs {
		if o.ID == id {
			return o, true
		}
	}
	return store.Output{}, false
}

// ---- POST /v1/preview ---------------------------------------------------
// The editor's live preview goes through the exact same render path as
// production output — byte for byte (architecture.md §5). Session auth is
// enforced by requireSession (the implicit dev user in dev-without-auth, a
// real session everywhere else — architecture.md §4).

func (s *Server) handlePreview(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Design json.RawMessage `json:"design"`
		Data   map[string]any  `json:"data"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "body must be JSON: {design, data?}")
		return
	}
	if len(req.Design) == 0 {
		writeError(w, http.StatusBadRequest, "invalid_request", "design is required")
		return
	}
	data := req.Data
	if data == nil {
		// No explicit data: resolve the session user's own connector
		// snapshots for exactly the fields the design references — the same
		// path production renders take, so preview = production for data
		// too. (The dev stub connector serves the demo fixture, preserving
		// the logged-out dev experience.)
		bindings := deriveBindings(req.Design, s.cache.KnownConnectors())
		resolved, ok := s.resolveBindingData(w, r, userID(r), bindings)
		if !ok {
			return
		}
		data = resolved
	}

	s.renderAndReply(w, r, req.Design, data, "")
}

// renderAndReply resolves the design's pinned community components, calls the
// renderer, and streams the SVG (or the mapped error envelope — always
// non-200 on failure).
func (s *Server) renderAndReply(w http.ResponseWriter, r *http.Request, design json.RawMessage, data map[string]any, theme string) {
	components, ok := s.resolveDesignComponents(w, r, design)
	if !ok {
		return
	}
	result, err := s.renderer.Render(r.Context(), design, data, theme, components)
	if err != nil {
		var re *render.Error
		if errors.As(err, &re) {
			writeError(w, re.Status, re.Code, re.Message)
			return
		}
		writeError(w, http.StatusBadGateway, "render_failed", "render failed")
		return
	}
	for _, warning := range result.Warnings {
		s.log.Warn("render warning", "path", r.URL.Path, "warning", warning)
	}
	w.Header().Set("Content-Type", "image/svg+xml; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(result.SVG))
}

// ---- project CRUD (session auth, stubbed) ------------------------------

// blankDesign is the default design of a project created without one: a
// small empty canvas, valid per design.schema.json, ready for the editor.
const blankDesign = `{"version":0,"canvas":{"width":600,"height":240,"background":"#0d1117","radius":8},"nodes":[]}`

// projectWriteRequest is the body of POST /v1/projects and
// PUT /v1/projects/{id}. Decoded strictly: unknown fields are a 400.
type projectWriteRequest struct {
	ID       string          `json:"id"` // POST only; rejected on PUT
	Name     string          `json:"name"`
	Design   json.RawMessage `json:"design"`
	Bindings []store.Binding `json:"bindings"`
	Outputs  []store.Output  `json:"outputs"`
}

func decodeProjectWrite(w http.ResponseWriter, r *http.Request, req *projectWriteRequest) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", decodeErrorMessage(err))
		return false
	}
	return true
}

func (s *Server) handleCreateProject(w http.ResponseWriter, r *http.Request) {
	var req projectWriteRequest
	if !decodeProjectWrite(w, r, &req) {
		return
	}
	if err := validateName(req.Name); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if len(req.Design) == 0 {
		req.Design = json.RawMessage(blankDesign)
	}
	if req.ID == "" {
		req.ID = s.uniqueProjectID(r.Context(), slugify(req.Name))
	}
	if !projectIDPattern.MatchString(req.ID) {
		writeError(w, http.StatusBadRequest, "invalid_request", "id must match ^[a-z0-9][a-z0-9-]{0,63}$")
		return
	}
	if _, err := s.stores.Projects.Get(r.Context(), req.ID); err == nil {
		writeError(w, http.StatusConflict, "conflict", "a project with this id already exists")
		return
	}
	// Bindings are always derived from the design, never client-authored —
	// they are the consent record and render-time data filter, so they must
	// track what the design actually references. Client-sent bindings are
	// accepted on the wire for compatibility but ignored.
	req.Bindings = deriveBindings(req.Design, s.cache.KnownConnectors())
	if len(req.Outputs) == 0 {
		req.Outputs = []store.Output{{ID: "default", Filename: "card.svg"}}
	}
	if err := validateOutputs(req.Outputs); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}

	now := time.Now().UTC()
	project := &store.Project{
		ID:        req.ID,
		UserID:    userID(r),
		Name:      req.Name,
		Design:    req.Design,
		Bindings:  req.Bindings,
		Outputs:   req.Outputs,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := s.stores.Projects.Create(r.Context(), project); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "creating project failed")
		return
	}
	writeJSON(w, http.StatusCreated, project)
}

func (s *Server) handleUpdateProject(w http.ResponseWriter, r *http.Request) {
	project, ok := s.ownedProject(w, r)
	if !ok {
		return
	}

	var req projectWriteRequest
	if !decodeProjectWrite(w, r, &req) {
		return
	}
	if req.ID != "" && req.ID != project.ID {
		writeError(w, http.StatusBadRequest, "invalid_request", "id cannot be changed; omit it or repeat the current id")
		return
	}
	if err := validateName(req.Name); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if len(req.Design) == 0 {
		writeError(w, http.StatusBadRequest, "invalid_request", "design is required")
		return
	}
	// Bindings are recomputed from the design on every write (see
	// handleCreateProject); client-sent bindings are ignored. Omitted
	// outputs keep their stored values.
	req.Bindings = deriveBindings(req.Design, s.cache.KnownConnectors())
	if req.Outputs == nil {
		req.Outputs = project.Outputs
	}
	if err := validateOutputs(req.Outputs); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}

	project.Name = req.Name
	project.Design = req.Design
	project.Bindings = req.Bindings
	project.Outputs = req.Outputs
	project.UpdatedAt = time.Now().UTC()
	if err := s.stores.Projects.Update(r.Context(), project); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "updating project failed")
		return
	}
	writeJSON(w, http.StatusOK, project)
}

func (s *Server) handleDeleteProject(w http.ResponseWriter, r *http.Request) {
	project, ok := s.ownedProject(w, r)
	if !ok {
		return
	}
	if err := s.stores.Projects.Delete(r.Context(), project.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "deleting project failed")
		return
	}
	// Cascade: revoke the project's deploy tokens so a recreated project
	// with the same id can never be pulled with old credentials.
	tokens, err := s.stores.DeployTokens.ListByProject(r.Context(), project.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "revoking deploy tokens failed")
		return
	}
	now := time.Now().UTC()
	for _, t := range tokens {
		if t.RevokedAt != nil {
			continue
		}
		if err := s.stores.DeployTokens.Revoke(r.Context(), project.ID, t.ID, now); err != nil {
			writeError(w, http.StatusInternalServerError, "internal", "revoking deploy tokens failed")
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// ownedProject loads the {id} project and enforces ownership; on failure it
// writes the 404 envelope (not-found and not-yours are indistinguishable on
// purpose) and returns ok=false.
func (s *Server) ownedProject(w http.ResponseWriter, r *http.Request) (*store.Project, bool) {
	project, err := s.stores.Projects.Get(r.Context(), r.PathValue("id"))
	if err != nil || project.UserID != userID(r) {
		writeError(w, http.StatusNotFound, "not_found", "project not found")
		return nil, false
	}
	return project, true
}

// uniqueProjectID makes base unique among existing projects by suffixing
// "-2", "-3", ... A random id is the last resort, not an expected path.
func (s *Server) uniqueProjectID(ctx context.Context, base string) string {
	if _, err := s.stores.Projects.Get(ctx, base); err != nil {
		return base
	}
	for n := 2; n <= 100; n++ {
		candidate := fmt.Sprintf("%s-%d", base, n)
		if _, err := s.stores.Projects.Get(ctx, candidate); err != nil {
			return candidate
		}
	}
	return randomID()
}

func (s *Server) handleListProjects(w http.ResponseWriter, r *http.Request) {
	projects, err := s.stores.Projects.ListByUser(r.Context(), userID(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "listing projects failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": projects})
}

func (s *Server) handleGetProject(w http.ResponseWriter, r *http.Request) {
	project, err := s.stores.Projects.Get(r.Context(), r.PathValue("id"))
	if err != nil || project.UserID != userID(r) {
		// Not found and not-yours are indistinguishable on purpose.
		writeError(w, http.StatusNotFound, "not_found", "project not found")
		return
	}
	writeJSON(w, http.StatusOK, project)
}

// randomID generates an URL-safe lowercase hex project id.
func randomID() string {
	var b [8]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read never fails on supported platforms
	return "p-" + hex.EncodeToString(b[:])
}

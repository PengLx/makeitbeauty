package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/connector"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/render"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// ---- GET /healthz ------------------------------------------------------

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
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

	// Resolve bindings → merged data: for each binding, take the (cached)
	// connector snapshot and filter it down to exactly the bound fields.
	// This filtering is the consent/security boundary — the renderer never
	// sees unbound data.
	data := map[string]any{}
	for _, b := range project.Bindings {
		account := s.resolveAccount(r, project.UserID, b)
		snapshot, err := s.cache.Snapshot(ctx, project.UserID, b.Connector, account)
		if err != nil {
			if errors.Is(err, connector.ErrUnknown) {
				s.log.Error("binding references unregistered connector", "project", project.ID, "connector", b.Connector)
				writeError(w, http.StatusInternalServerError, "unknown_connector", "project is bound to an unavailable connector")
				return
			}
			// Cold-miss upstream failure: nothing stale to serve, fail soft.
			writeError(w, http.StatusBadGateway, "connector_unavailable", "connector data is unavailable")
			return
		}
		data[b.Connector] = connector.Filter(snapshot, b.Fields)
	}

	s.renderAndReply(w, r, project.Design, data, output.Theme)
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

// ---- POST /v1/preview (dev only) ---------------------------------------
// The editor's live preview goes through the exact same render path as
// production output — byte for byte (architecture.md §5).

func (s *Server) handlePreview(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.Dev() {
		writeError(w, http.StatusNotFound, "not_found", "preview is only available in dev")
		return
	}

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
		data = s.demoData // omitted data falls back to the demo fixture
	}

	s.renderAndReply(w, r, req.Design, data, "")
}

// renderAndReply calls the renderer and streams the SVG (or the mapped error
// envelope — always non-200 on failure).
func (s *Server) renderAndReply(w http.ResponseWriter, r *http.Request, design json.RawMessage, data map[string]any, theme string) {
	result, err := s.renderer.Render(r.Context(), design, data, theme)
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

var projectIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

func (s *Server) handleCreateProject(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID       string          `json:"id"`
		Name     string          `json:"name"`
		Design   json.RawMessage `json:"design"`
		Bindings []store.Binding `json:"bindings"`
		Outputs  []store.Output  `json:"outputs"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "body must be JSON: {id?, name, design, bindings?, outputs?}")
		return
	}
	if req.Name == "" || len(req.Design) == 0 {
		writeError(w, http.StatusBadRequest, "invalid_request", "name and design are required")
		return
	}
	if req.ID == "" {
		req.ID = randomID()
	}
	if !projectIDPattern.MatchString(req.ID) {
		writeError(w, http.StatusBadRequest, "invalid_request", "id must match ^[a-z0-9][a-z0-9-]{0,63}$")
		return
	}
	if _, err := s.stores.Projects.Get(r.Context(), req.ID); err == nil {
		writeError(w, http.StatusConflict, "conflict", "a project with this id already exists")
		return
	}
	if req.Bindings == nil {
		req.Bindings = []store.Binding{}
	}
	if len(req.Outputs) == 0 {
		req.Outputs = []store.Output{{ID: "default", Filename: "card.svg"}}
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

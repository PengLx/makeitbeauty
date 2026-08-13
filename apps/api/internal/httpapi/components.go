package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/kit"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/render"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// Community component registry routes (architecture.md §7.5/§8).
// Namespace = owner's login lowercased: ids are "{owner}/{name}". Drafts are
// mutable and private; published versions are immutable and pinned by
// designs as "{owner}/{name}@{n}". Unpublish only unlists — pinned usages
// keep rendering.

var (
	// componentNamePattern constrains the {name} half of a component id.
	componentNamePattern = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)
	// pinnedComponentPattern matches a fully-qualified pinned reference,
	// "{owner}/{name}@{version}" (design.schema.json instanceNode).
	pinnedComponentPattern = regexp.MustCompile(`^([a-z0-9-]+)/([a-z0-9-]+)@([0-9]+)$`)
)

const (
	// reservedNamespace is the official in-repo kit's namespace. No GitHub
	// login can be "kit" today, but the registry does not get to depend on
	// GitHub's reserved-name list (belt and braces).
	reservedNamespace = "kit"
	// browseLimit caps GET /v1/community/components.
	browseLimit = 100
	// kit-component.schema.json string limits.
	componentTitleMaxLength       = 100
	componentDescriptionMaxLength = 1000
	// componentFrameMax is the schema's frame dimension cap.
	componentFrameMax = 4096
)

// componentDefinition is the kit-component document shape the API composes
// and stores (kit-component.schema.json). Props, nodes, and computed pass
// through raw: the renderer owns their validation at publish time
// (POST /internal/validate-component), the API never interprets fragments.
type componentDefinition struct {
	ID          string          `json:"id"`
	Title       string          `json:"title"`
	Description string          `json:"description,omitempty"`
	Category    string          `json:"category,omitempty"`
	Frame       kit.Frame       `json:"frame"`
	Props       json.RawMessage `json:"props"`
	Nodes       json.RawMessage `json:"nodes"`
	Computed    json.RawMessage `json:"computed,omitempty"`
}

// componentView is the wire shape of registry metadata. Draft and Unlisted
// appear only in owner views; Definition is the latest published definition
// on detail responses; PublishedAt is the latest publish time where known.
type componentView struct {
	ID            string          `json:"id"`
	Title         string          `json:"title"`
	Description   string          `json:"description,omitempty"`
	Category      string          `json:"category,omitempty"`
	LatestVersion int             `json:"latestVersion"`
	Unlisted      bool            `json:"unlisted,omitempty"`
	CreatedAt     time.Time       `json:"createdAt"`
	UpdatedAt     time.Time       `json:"updatedAt"`
	PublishedAt   *time.Time      `json:"publishedAt,omitempty"`
	Draft         json.RawMessage `json:"draft,omitempty"`
	Definition    json.RawMessage `json:"definition,omitempty"`
	// Community enrichments (architecture.md §8), carried by browse and the
	// favorites list. Pointers so 0/false still serialize on the routes that
	// set them while every other route omits them entirely. Favorited is
	// resolved only when the caller has a session; anonymous browse omits it.
	UsageCount    *int  `json:"usageCount,omitempty"`
	FavoriteCount *int  `json:"favoriteCount,omitempty"`
	Favorited     *bool `json:"favorited,omitempty"`
}

// componentVersionView is the wire shape of one immutable published version.
type componentVersionView struct {
	ComponentID string          `json:"componentId"`
	Version     int             `json:"version"`
	Definition  json.RawMessage `json:"definition"`
	PublishedAt time.Time       `json:"publishedAt"`
}

// publicComponentView hides owner-only state (draft, unlisted flag).
func publicComponentView(c *store.Component) componentView {
	return componentView{
		ID: c.ID, Title: c.Title, Description: c.Description, Category: c.Category,
		LatestVersion: c.LatestVersion, CreatedAt: c.CreatedAt, UpdatedAt: c.UpdatedAt,
	}
}

// ownerComponentView additionally carries the private draft and the
// unlisted flag.
func ownerComponentView(c *store.Component) componentView {
	v := publicComponentView(c)
	v.Unlisted = c.Unlisted
	v.Draft = c.Draft
	return v
}

// ---- shared helpers ------------------------------------------------------

// componentPathID rebuilds the component id from the {owner}/{name} path.
func componentPathID(r *http.Request) string {
	return r.PathValue("owner") + "/" + r.PathValue("name")
}

// ownedComponent loads the {owner}/{name} component and enforces ownership;
// on failure it writes the 404 envelope (not-found and not-yours are
// indistinguishable on purpose, like projects) and returns ok=false.
func (s *Server) ownedComponent(w http.ResponseWriter, r *http.Request) (*store.Component, bool) {
	c, err := s.stores.Components.Get(r.Context(), componentPathID(r))
	if err != nil || c.OwnerID != userID(r) {
		writeError(w, http.StatusNotFound, "not_found", "component not found")
		return nil, false
	}
	return c, true
}

// sessionLogin resolves the session user's login, lowercased — the component
// namespace (architecture.md §7.5). The implicit dev user may have no stored
// row (memory store before the seed); its login is the fixed "dev". On
// failure it writes the error envelope and returns ok=false.
func (s *Server) sessionLogin(w http.ResponseWriter, r *http.Request) (string, bool) {
	uid := userID(r)
	user, err := s.stores.Users.Get(r.Context(), uid)
	switch {
	case err == nil:
		return strings.ToLower(user.Login), true
	case errors.Is(err, store.ErrNotFound) && uid == devUserID:
		return devUserID, true
	case errors.Is(err, store.ErrNotFound):
		// A session pointing at a deleted user is a dead session.
		writeError(w, http.StatusUnauthorized, "unauthenticated", "sign in at /v1/auth/github/login")
		return "", false
	default:
		writeError(w, http.StatusInternalServerError, "internal", "user lookup failed")
		return "", false
	}
}

// decodeComponentBody strict-decodes a JSON body into v; unknown fields are a
// 400 naming the field, shape describes the allowed body in the message.
func decodeComponentBody(w http.ResponseWriter, r *http.Request, v any, shape string) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		if rest, ok := strings.CutPrefix(err.Error(), "json: unknown field "); ok {
			writeError(w, http.StatusBadRequest, "invalid_request", fmt.Sprintf("unknown field %s — body must be JSON: %s", rest, shape))
		} else {
			writeError(w, http.StatusBadRequest, "invalid_request", "body must be JSON: "+shape)
		}
		return false
	}
	return true
}

// validateComponentCategory checks the optional palette-menu category slug
// (kit-component.schema.json); "" means uncategorized and is always fine.
func validateComponentCategory(category string) error {
	if category != "" && !kit.CategoryPattern.MatchString(category) {
		return fmt.Errorf("category must be a lowercase slug matching %s (e.g. cards, stats, data, banners, decor)", kit.CategoryPattern)
	}
	return nil
}

// validateComponentMeta checks the API-owned definition fields against
// kit-component.schema.json limits; everything deeper is the renderer's
// publish-time job.
func validateComponentMeta(title, description string, frame *kit.Frame) error {
	if title == "" {
		return errors.New("title is required")
	}
	if len(title) > componentTitleMaxLength {
		return fmt.Errorf("title must be at most %d characters", componentTitleMaxLength)
	}
	if len(description) > componentDescriptionMaxLength {
		return fmt.Errorf("description must be at most %d characters", componentDescriptionMaxLength)
	}
	if frame == nil {
		return errors.New("frame is required")
	}
	if !(frame.W > 0 && frame.W <= componentFrameMax && frame.H > 0 && frame.H <= componentFrameMax) {
		return fmt.Errorf("frame.w and frame.h must be positive and at most %d", componentFrameMax)
	}
	return nil
}

// leadingJSONByte returns the first non-whitespace byte of raw (0 if none) —
// enough to tell an object from an array from null without decoding.
func leadingJSONByte(raw json.RawMessage) byte {
	for _, b := range raw {
		switch b {
		case ' ', '\t', '\r', '\n':
			continue
		}
		return b
	}
	return 0
}

// normalizeRawField validates that an optional raw JSON field is the wanted
// kind ('{' or '['), treating absent/null as fallback (may be nil = omit).
func normalizeRawField(raw json.RawMessage, want byte, fallback json.RawMessage, name string) (json.RawMessage, error) {
	lead := leadingJSONByte(raw)
	if len(raw) == 0 || lead == 'n' { // absent or JSON null
		return fallback, nil
	}
	if lead != want {
		kind := "an object"
		if want == '[' {
			kind = "an array"
		}
		return nil, fmt.Errorf("%s must be %s", name, kind)
	}
	return raw, nil
}

// ---- POST /v1/components --------------------------------------------------

type createComponentRequest struct {
	Name     string     `json:"name"`
	Title    string     `json:"title"`
	Category string     `json:"category"` // optional palette-menu slug
	Frame    *kit.Frame `json:"frame"`
}

func (s *Server) handleCreateComponent(w http.ResponseWriter, r *http.Request) {
	var req createComponentRequest
	if !decodeComponentBody(w, r, &req, "{name, title, category?, frame:{w,h}}") {
		return
	}
	if !componentNamePattern.MatchString(req.Name) {
		writeError(w, http.StatusBadRequest, "invalid_request", "name must match ^[a-z0-9-]{1,64}$")
		return
	}
	if err := validateComponentMeta(req.Title, "", req.Frame); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if err := validateComponentCategory(req.Category); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	login, ok := s.sessionLogin(w, r)
	if !ok {
		return
	}
	if login == reservedNamespace {
		writeError(w, http.StatusForbidden, "reserved_namespace", `the "kit" namespace is reserved for the official component kit`)
		return
	}

	id := login + "/" + req.Name
	// The draft starts as a valid document skeleton; nodes stay empty until
	// the editor fills them in (publish validation requires at least one).
	// Draft ids carry the unversioned qualified form "{owner}/{name}" — the
	// renderer's validator requires it; the "@{n}" pin is added at publish.
	draft, err := json.Marshal(componentDefinition{
		ID: id, Title: req.Title, Category: req.Category, Frame: *req.Frame,
		Props: json.RawMessage(`{}`), Nodes: json.RawMessage(`[]`),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "encoding draft failed")
		return
	}
	now := time.Now().UTC()
	component := &store.Component{
		ID: id, OwnerID: userID(r), Title: req.Title, Category: req.Category, Draft: draft,
		CreatedAt: now, UpdatedAt: now,
	}
	err = s.stores.Components.Create(r.Context(), component)
	switch {
	case err == nil:
		writeJSON(w, http.StatusCreated, ownerComponentView(component))
	case errors.Is(err, store.ErrExists):
		writeError(w, http.StatusConflict, "conflict", fmt.Sprintf("component %q already exists", id))
	default:
		writeError(w, http.StatusInternalServerError, "internal", "creating component failed")
	}
}

// ---- GET /v1/components ----------------------------------------------------
// The session user's own components: drafts + published metadata.

func (s *Server) handleListMyComponents(w http.ResponseWriter, r *http.Request) {
	components, err := s.stores.Components.ListByOwner(r.Context(), userID(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "listing components failed")
		return
	}
	sort.Slice(components, func(i, j int) bool { return components[i].ID < components[j].ID })
	views := make([]componentView, 0, len(components))
	for _, c := range components {
		views = append(views, ownerComponentView(c))
	}
	writeJSON(w, http.StatusOK, map[string]any{"components": views})
}

// ---- PUT /v1/components/{owner}/{name} -------------------------------------
// Owner-only draft replacement. Published versions are never touched: the
// stored draft is working state, frozen copies live in ComponentVersions.

type componentDraftRequest struct {
	ID          string          `json:"id"`
	Title       string          `json:"title"`
	Description string          `json:"description"`
	Category    string          `json:"category"` // optional palette-menu slug; "" clears it
	Frame       *kit.Frame      `json:"frame"`
	Props       json.RawMessage `json:"props"`
	Nodes       json.RawMessage `json:"nodes"`
	Computed    json.RawMessage `json:"computed"`
}

func (s *Server) handleUpdateComponentDraft(w http.ResponseWriter, r *http.Request) {
	component, ok := s.ownedComponent(w, r)
	if !ok {
		return
	}
	var req componentDraftRequest
	if !decodeComponentBody(w, r, &req, "{id?, title, description?, category?, frame:{w,h}, props?, nodes?, computed?}") {
		return
	}
	if req.ID != "" && req.ID != component.ID {
		writeError(w, http.StatusBadRequest, "invalid_request", fmt.Sprintf("id cannot be changed; omit it or repeat %q", component.ID))
		return
	}
	if err := validateComponentMeta(req.Title, req.Description, req.Frame); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if err := validateComponentCategory(req.Category); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	props, err := normalizeRawField(req.Props, '{', json.RawMessage(`{}`), "props")
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	nodes, err := normalizeRawField(req.Nodes, '[', json.RawMessage(`[]`), "nodes")
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	computed, err := normalizeRawField(req.Computed, '[', nil, "computed")
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}

	draft, err := json.Marshal(componentDefinition{
		ID: component.ID, Title: req.Title, Description: req.Description,
		Category: req.Category, Frame: *req.Frame,
		Props: props, Nodes: nodes, Computed: computed,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "encoding draft failed")
		return
	}
	component.Title = req.Title
	component.Description = req.Description
	component.Category = req.Category
	component.Draft = draft
	component.UpdatedAt = time.Now().UTC()
	if err := s.stores.Components.Update(r.Context(), component); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "updating component failed")
		return
	}
	writeJSON(w, http.StatusOK, ownerComponentView(component))
}

// ---- POST /v1/components/{owner}/{name}/publish -----------------------------
// Freezes the draft as the next immutable version after renderer validation
// (architecture.md §7.5). The frozen definition's id is rewritten to the
// fully-qualified pinned form "{owner}/{name}@{n}" — exactly what designs
// reference and what the render path ships to the renderer.

func (s *Server) handlePublishComponent(w http.ResponseWriter, r *http.Request) {
	component, ok := s.ownedComponent(w, r)
	if !ok {
		return
	}
	if err := s.renderer.ValidateComponent(r.Context(), component.Draft); err != nil {
		var re *render.Error
		if errors.As(err, &re) {
			// Renderer validation failures arrive as 400 with the renderer's
			// error envelope passed through verbatim.
			writeError(w, re.Status, re.Code, re.Message)
			return
		}
		writeError(w, http.StatusBadGateway, "renderer_unavailable", "component validation failed")
		return
	}

	next := component.LatestVersion + 1
	var def componentDefinition
	if err := json.Unmarshal(component.Draft, &def); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "stored draft is malformed")
		return
	}
	def.ID = fmt.Sprintf("%s@%d", component.ID, next)
	frozen, err := json.Marshal(def)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "encoding version failed")
		return
	}

	now := time.Now().UTC()
	version := &store.ComponentVersion{
		ComponentID: component.ID, Version: next, Definition: frozen, PublishedAt: now,
	}
	err = s.stores.ComponentVersions.Create(r.Context(), version)
	switch {
	case err == nil:
	case errors.Is(err, store.ErrExists):
		// Two concurrent publishes raced for the same number; the loser retries.
		writeError(w, http.StatusConflict, "conflict", "a concurrent publish took this version; retry")
		return
	default:
		writeError(w, http.StatusInternalServerError, "internal", "freezing version failed")
		return
	}
	component.LatestVersion = next
	component.UpdatedAt = now
	if err := s.stores.Components.Update(r.Context(), component); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "updating component failed")
		return
	}
	writeJSON(w, http.StatusCreated, componentVersionView{
		ComponentID: version.ComponentID, Version: version.Version,
		Definition: version.Definition, PublishedAt: version.PublishedAt,
	})
}

// ---- GET /v1/components/{owner}/{name} --------------------------------------
// Public once published and listed; the owner always sees it (including the
// private draft). Not-found, not-published, and unlisted are all the same 404
// to non-owners so existence never leaks.

func (s *Server) handleGetComponent(w http.ResponseWriter, r *http.Request) {
	component, err := s.stores.Components.Get(r.Context(), componentPathID(r))
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "component not found")
		return
	}
	uid, _, authed := s.resolveSession(r)
	isOwner := authed && uid == component.OwnerID
	if !isOwner && (component.LatestVersion == 0 || component.Unlisted) {
		writeError(w, http.StatusNotFound, "not_found", "component not found")
		return
	}

	view := publicComponentView(component)
	if isOwner {
		view = ownerComponentView(component)
	}
	if component.LatestVersion > 0 {
		latest, err := s.stores.ComponentVersions.Get(r.Context(), component.ID, component.LatestVersion)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", "version lookup failed")
			return
		}
		view.Definition = latest.Definition
		view.PublishedAt = &latest.PublishedAt
	}
	writeJSON(w, http.StatusOK, view)
}

// ---- GET /v1/components/{owner}/{name}/versions/{n} --------------------------
// Public immutable definition fetch. Unlisted components still serve here:
// pinned usages keep rendering forever (architecture.md §7.5 — immutability
// beats deletion).

func (s *Server) handleGetComponentVersion(w http.ResponseWriter, r *http.Request) {
	n, err := strconv.Atoi(r.PathValue("n"))
	if err != nil || n < 1 {
		writeError(w, http.StatusNotFound, "not_found", "component version not found")
		return
	}
	version, err := s.stores.ComponentVersions.Get(r.Context(), componentPathID(r), n)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "component version not found")
		return
	}
	// Versions never change, so clients may cache them forever.
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	writeJSON(w, http.StatusOK, componentVersionView{
		ComponentID: version.ComponentID, Version: version.Version,
		Definition: version.Definition, PublishedAt: version.PublishedAt,
	})
}

// ---- DELETE /v1/components/{owner}/{name} ------------------------------------
// Unpublish = unlist (owner-only, idempotent): hidden from browse and the
// public detail route, but published versions stay served — abuse is a
// moderation action, not a 404.

func (s *Server) handleUnlistComponent(w http.ResponseWriter, r *http.Request) {
	component, ok := s.ownedComponent(w, r)
	if !ok {
		return
	}
	if !component.Unlisted {
		component.Unlisted = true
		component.UpdatedAt = time.Now().UTC()
		if err := s.stores.Components.Update(r.Context(), component); err != nil {
			writeError(w, http.StatusInternalServerError, "internal", "unlisting component failed")
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- GET /v1/community/components?q=&category=&sort= ---------------------------
// Public browse of published + listed components. q= substring-matches
// id/title/description; category= is an exact slug match; both compose (AND)
// and never change the ordering contract. sort= picks the ordering — newest
// (default): latest publish first; uses: usage count (distinct referencing
// projects) descending; favorites: favorite count descending — and every
// ordering breaks ties by publishedAt desc, then id. Rows always carry
// usageCount + favoriteCount; favorited is added only when the caller has a
// session, resolved best-effort so browse stays public.

func (s *Server) handleBrowseComponents(w http.ResponseWriter, r *http.Request) {
	sortKey := r.URL.Query().Get("sort")
	if sortKey == "" {
		sortKey = "newest"
	}
	switch sortKey {
	case "newest", "uses", "favorites":
	default:
		writeError(w, http.StatusBadRequest, "invalid_request", `sort must be "newest", "uses", or "favorites"`)
		return
	}
	if err := s.usage.ensure(r.Context(), s.stores.Projects); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "usage index unavailable")
		return
	}
	components, err := s.stores.Components.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "listing components failed")
		return
	}
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	// Stored categories are lowercase slugs, so lowercasing the param keeps
	// the match exact while forgiving pasted capitalization. A slug that
	// matches nothing yields an empty list, not an error.
	category := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("category")))

	type entry struct {
		view        componentView
		publishedAt time.Time
		uses        int
		favorites   int
	}
	entries := []entry{}
	for _, c := range components {
		if c.LatestVersion == 0 || c.Unlisted {
			continue
		}
		if category != "" && c.Category != category {
			continue
		}
		if q != "" && !strings.Contains(strings.ToLower(c.ID), q) &&
			!strings.Contains(strings.ToLower(c.Title), q) &&
			!strings.Contains(strings.ToLower(c.Description), q) {
			continue
		}
		latest, err := s.stores.ComponentVersions.Get(r.Context(), c.ID, c.LatestVersion)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", "version lookup failed")
			return
		}
		favoriteCount, err := s.stores.Favorites.CountByComponent(r.Context(), c.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", "favorite count failed")
			return
		}
		usageCount := s.usage.get(c.ID)
		view := publicComponentView(c)
		view.PublishedAt = &latest.PublishedAt
		view.UsageCount = &usageCount
		view.FavoriteCount = &favoriteCount
		entries = append(entries, entry{
			view: view, publishedAt: latest.PublishedAt,
			uses: usageCount, favorites: favoriteCount,
		})
	}

	// favorited: best-effort session resolution — a valid session marks each
	// row, anonymous browse omits the field entirely (never 401s).
	if uid, _, ok := s.resolveSession(r); ok && len(entries) > 0 {
		ids := make([]string, 0, len(entries))
		for i := range entries {
			ids = append(ids, entries[i].view.ID)
		}
		favorited, err := s.stores.Favorites.IsFavorited(r.Context(), uid, ids...)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", "favorite lookup failed")
			return
		}
		for i := range entries {
			f := favorited[entries[i].view.ID]
			entries[i].view.Favorited = &f
		}
	}

	sort.Slice(entries, func(i, j int) bool {
		switch sortKey {
		case "uses":
			if entries[i].uses != entries[j].uses {
				return entries[i].uses > entries[j].uses
			}
		case "favorites":
			if entries[i].favorites != entries[j].favorites {
				return entries[i].favorites > entries[j].favorites
			}
		}
		if !entries[i].publishedAt.Equal(entries[j].publishedAt) {
			return entries[i].publishedAt.After(entries[j].publishedAt)
		}
		return entries[i].view.ID < entries[j].view.ID // deterministic tie-break
	})
	if len(entries) > browseLimit {
		entries = entries[:browseLimit]
	}
	views := make([]componentView, 0, len(entries))
	for _, e := range entries {
		views = append(views, e.view)
	}
	writeJSON(w, http.StatusOK, map[string]any{"components": views})
}

// ---- render-path resolution ---------------------------------------------------

// resolveDesignComponents collects the pinned community component versions a
// design's instance nodes reference and returns their frozen definitions for
// the render request — the render path stays stateless: the API resolves the
// registry, the renderer merges the definitions over the built-in kit per
// request (architecture.md §7.5). kit/* references resolve inside the
// renderer and are skipped here. A missing or unpinned community reference
// fails the render politely (422 envelope naming the ref — never a broken
// image; the Action fails soft). On failure it writes the error envelope and
// returns ok=false.
func (s *Server) resolveDesignComponents(w http.ResponseWriter, r *http.Request, design json.RawMessage) ([]json.RawMessage, bool) {
	// An unparseable design yields no refs — it is the renderer's 422 to
	// raise, not ours.
	var defs []json.RawMessage
	seen := map[string]bool{}
	for _, ref := range instanceComponents(design) {
		if strings.HasPrefix(ref, "kit/") || seen[ref] {
			continue
		}
		seen[ref] = true

		m := pinnedComponentPattern.FindStringSubmatch(ref)
		if m == nil {
			writeError(w, http.StatusUnprocessableEntity, "unknown_component",
				fmt.Sprintf("component %q is not a pinned community reference ({owner}/{name}@{version})", ref))
			return nil, false
		}
		version, err := strconv.Atoi(m[3])
		if err != nil || version < 1 {
			writeError(w, http.StatusUnprocessableEntity, "unknown_component",
				fmt.Sprintf("component %q pins an invalid version", ref))
			return nil, false
		}
		frozen, err := s.stores.ComponentVersions.Get(r.Context(), m[1]+"/"+m[2], version)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusUnprocessableEntity, "unknown_component",
				fmt.Sprintf("component %q does not exist", ref))
			return nil, false
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", "component lookup failed")
			return nil, false
		}
		defs = append(defs, frozen.Definition)
	}
	return defs, true
}

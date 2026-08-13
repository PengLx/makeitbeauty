package httpapi

import (
	"errors"
	"net/http"
	"sort"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// Community-component favorites (architecture.md §8): a personal bookmark
// that doubles as the browse popularity signal (favoriteCount, sort=favorites).
// Both writes are idempotent so clients can always converge without reads.

// ---- PUT /v1/components/{owner}/{name}/favorite ----------------------------
// Session auth. Favoriting follows the public detail route's visibility:
// unknown, never-published, and unlisted-to-non-owners are the same 404, so
// the favorite routes cannot be used to probe for drafts or unlisted
// components. Idempotent: re-favoriting keeps the original CreatedAt.

func (s *Server) handleSetFavorite(w http.ResponseWriter, r *http.Request) {
	component, err := s.stores.Components.Get(r.Context(), componentPathID(r))
	if err != nil || component.LatestVersion == 0 ||
		(component.Unlisted && component.OwnerID != userID(r)) {
		writeError(w, http.StatusNotFound, "not_found", "component not found")
		return
	}
	favorite := &store.Favorite{
		UserID: userID(r), ComponentID: component.ID, CreatedAt: time.Now().UTC(),
	}
	if err := s.stores.Favorites.Set(r.Context(), favorite); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "saving favorite failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- DELETE /v1/components/{owner}/{name}/favorite --------------------------
// Session auth. Idempotent and component-blind: unfavoriting something that
// vanished, was unlisted, or was never favorited is still a 204 — the client
// state "not favorited" is always reachable.

func (s *Server) handleUnsetFavorite(w http.ResponseWriter, r *http.Request) {
	if err := s.stores.Favorites.Unset(r.Context(), userID(r), componentPathID(r)); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "removing favorite failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- GET /v1/components/favorites -------------------------------------------
// Session auth: the caller's favorited components as published metadata
// (public view + publishedAt + counts), newest favorite first, ties by id.
// Components that vanished from the registry are skipped — the stale
// favorite row is harmless. Unlisted favorites stay visible: this is a
// personal list, not browse, and the favoriter already knows the component.

func (s *Server) handleListFavorites(w http.ResponseWriter, r *http.Request) {
	favorites, err := s.stores.Favorites.ListByUser(r.Context(), userID(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "listing favorites failed")
		return
	}
	if err := s.usage.ensure(r.Context(), s.stores.Projects); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "usage index unavailable")
		return
	}
	sort.Slice(favorites, func(i, j int) bool {
		if !favorites[i].CreatedAt.Equal(favorites[j].CreatedAt) {
			return favorites[i].CreatedAt.After(favorites[j].CreatedAt)
		}
		return favorites[i].ComponentID < favorites[j].ComponentID
	})

	views := make([]componentView, 0, len(favorites))
	for _, f := range favorites {
		component, err := s.stores.Components.Get(r.Context(), f.ComponentID)
		if errors.Is(err, store.ErrNotFound) {
			continue // component vanished; skip, keep the rest of the list
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", "component lookup failed")
			return
		}
		if component.LatestVersion == 0 {
			continue // unreachable via the favorite route; guard anyway
		}
		latest, err := s.stores.ComponentVersions.Get(r.Context(), component.ID, component.LatestVersion)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", "version lookup failed")
			return
		}
		favoriteCount, err := s.stores.Favorites.CountByComponent(r.Context(), component.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", "favorite count failed")
			return
		}
		usageCount := s.usage.get(component.ID)
		favorited := true
		view := publicComponentView(component)
		view.PublishedAt = &latest.PublishedAt
		view.UsageCount = &usageCount
		view.FavoriteCount = &favoriteCount
		view.Favorited = &favorited
		views = append(views, view)
	}
	writeJSON(w, http.StatusOK, map[string]any{"components": views})
}

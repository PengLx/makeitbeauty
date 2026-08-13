package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/auth"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/connector"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// GitHub App user OAuth + sessions (architecture.md §8): the browser only
// ever holds the mib_session cookie; GitHub tokens are sealed into the
// ConnectorAccount and never reach the client (BFF).

const (
	// sessionCookieName carries the server-side session id.
	sessionCookieName = "mib_session"
	// stateCookieName carries the CSRF state between login and callback.
	stateCookieName = "mib_oauth_state"
	stateTTL        = 10 * time.Minute
)

// setCookie writes an HttpOnly SameSite=Lax cookie, Secure in production.
// maxAge <= 0 deletes the cookie.
func (s *Server) setCookie(w http.ResponseWriter, name, value string, maxAge time.Duration) {
	c := &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   s.cfg.Production(),
	}
	if maxAge > 0 {
		c.MaxAge = int(maxAge / time.Second)
	} else {
		c.MaxAge = -1
	}
	http.SetCookie(w, c)
}

// ---- GET /v1/auth/github/login ------------------------------------------

func (s *Server) handleGitHubLogin(w http.ResponseWriter, r *http.Request) {
	if s.oauth == nil {
		writeError(w, http.StatusServiceUnavailable, "auth_unconfigured", "GitHub sign-in is not configured (set MIB_GITHUB_CLIENT_ID)")
		return
	}
	state := newStateToken()
	s.setCookie(w, stateCookieName, state, stateTTL)
	http.Redirect(w, r, s.oauth.AuthorizeURL(state), http.StatusFound)
}

// newStateToken returns hex(16 random bytes) — the CSRF nonce tying the
// callback to the browser that initiated login.
func newStateToken() string {
	var b [16]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read never fails on supported platforms
	return hex.EncodeToString(b[:])
}

// ---- GET /v1/auth/github/callback ---------------------------------------

func (s *Server) handleGitHubCallback(w http.ResponseWriter, r *http.Request) {
	if s.oauth == nil {
		writeError(w, http.StatusServiceUnavailable, "auth_unconfigured", "GitHub sign-in is not configured (set MIB_GITHUB_CLIENT_ID)")
		return
	}
	ctx := r.Context()

	// CSRF check: the state parameter must equal the value we set on this
	// browser at login time. The cookie is single-use either way.
	stateCookie, err := r.Cookie(stateCookieName)
	s.setCookie(w, stateCookieName, "", -1)
	state := r.URL.Query().Get("state")
	if err != nil || state == "" || subtle.ConstantTimeCompare([]byte(state), []byte(stateCookie.Value)) != 1 {
		writeError(w, http.StatusBadRequest, "invalid_state", "state mismatch — restart the login flow")
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "missing code parameter")
		return
	}

	token, err := s.oauth.Exchange(ctx, code)
	if err != nil {
		s.log.Error("github code exchange failed", "err", err)
		writeError(w, http.StatusBadGateway, "auth_failed", "GitHub code exchange failed")
		return
	}
	ghUser, err := s.oauth.FetchUser(ctx, token.AccessToken)
	if err != nil {
		s.log.Error("github user fetch failed", "err", err)
		writeError(w, http.StatusBadGateway, "auth_failed", "fetching the GitHub user failed")
		return
	}

	user, err := s.upsertGitHubUser(ctx, ghUser)
	if err != nil {
		s.log.Error("user upsert failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "storing the user failed")
		return
	}
	if err := s.upsertGitHubAccount(ctx, user.ID, token); err != nil {
		s.log.Error("connector account upsert failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "storing the connector account failed")
		return
	}
	// Fresh credentials: drop any snapshot cached under the previous account
	// state (e.g. expired-token stale data) so the next render refetches.
	s.invalidateSnapshot(user.ID, "github")

	now := time.Now().UTC()
	session := &auth.Session{
		ID:        auth.NewSessionID(),
		UserID:    user.ID,
		CreatedAt: now,
		ExpiresAt: now.Add(auth.SessionTTL),
	}
	if err := s.sessions.Create(ctx, session); err != nil {
		s.log.Error("session create failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "creating the session failed")
		return
	}
	s.setCookie(w, sessionCookieName, session.ID, auth.SessionTTL)
	http.Redirect(w, r, s.cfg.PublicURL, http.StatusFound)
}

// upsertGitHubUser creates or refreshes the User owning a GitHub identity,
// keyed on the immutable numeric GitHub id (logins can change).
func (s *Server) upsertGitHubUser(ctx context.Context, gh *auth.GitHubUser) (*store.User, error) {
	displayName := gh.Name
	if displayName == "" {
		displayName = gh.Login
	}
	user, err := s.stores.Users.GetByGitHubID(ctx, gh.ID)
	switch {
	case err == nil:
		user.Login = gh.Login
		user.DisplayName = displayName
		user.AvatarURL = gh.AvatarURL
		return user, s.stores.Users.Update(ctx, user)
	case errors.Is(err, store.ErrNotFound):
		user = &store.User{
			ID:          fmt.Sprintf("gh-%d", gh.ID),
			Login:       gh.Login,
			DisplayName: displayName,
			AvatarURL:   gh.AvatarURL,
			GitHubID:    gh.ID,
			CreatedAt:   time.Now().UTC(),
		}
		return user, s.stores.Users.Create(ctx, user)
	default:
		return nil, err
	}
}

// upsertGitHubAccount seals the fresh token into the user's github
// ConnectorAccount — login is the first connector (architecture.md §6).
func (s *Server) upsertGitHubAccount(ctx context.Context, userID string, token *auth.Token) error {
	now := time.Now().UTC()
	creds := token.Credentials(now)
	raw, err := json.Marshal(creds)
	if err != nil {
		return err
	}
	sealed, err := s.sealer.Seal(raw)
	if err != nil {
		return err
	}

	account, err := s.stores.ConnectorAccounts.GetByUserConnector(ctx, userID, "github")
	if errors.Is(err, store.ErrNotFound) {
		return s.stores.ConnectorAccounts.Create(ctx, &store.ConnectorAccount{
			ID:                   newAccountID(),
			UserID:               userID,
			Connector:            "github",
			EncryptedCredentials: sealed,
			Status:               "active",
			LastRefreshAt:        now,
		})
	}
	if err != nil {
		return err
	}
	account.EncryptedCredentials = sealed
	account.Status = "active"
	account.LastRefreshAt = now
	return s.stores.ConnectorAccounts.Update(ctx, account)
}

// newAccountID generates the public identifier of a connector account.
func newAccountID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return "acct-" + hex.EncodeToString(b[:])
}

// ---- POST /v1/auth/logout -----------------------------------------------

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookieName); err == nil && c.Value != "" && s.sessions != nil {
		if err := s.sessions.Delete(r.Context(), c.Value); err != nil {
			writeError(w, http.StatusInternalServerError, "internal", "deleting the session failed")
			return
		}
	}
	s.setCookie(w, sessionCookieName, "", -1)
	w.WriteHeader(http.StatusNoContent)
}

// ---- GET /v1/me ----------------------------------------------------------

type userView struct {
	ID          string `json:"id"`
	Login       string `json:"login"`
	DisplayName string `json:"displayName"`
	AvatarURL   string `json:"avatarUrl"`
}

type connectorStatusView struct {
	Connector string `json:"connector"`
	Status    string `json:"status"` // "connected" | "unconfigured" | "expired"
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	uid, devFallback, ok := s.resolveSession(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthenticated", "sign in at /v1/auth/github/login")
		return
	}
	view := userView{ID: devUserID, Login: devUserID, DisplayName: "Dev User"}
	user, err := s.stores.Users.Get(r.Context(), uid)
	switch {
	case err == nil:
		view = userView{ID: user.ID, Login: user.Login, DisplayName: user.DisplayName, AvatarURL: user.AvatarURL}
	case errors.Is(err, store.ErrNotFound) && devFallback:
		// Dev fallback before the seed ran (memory store): synthesize the view.
	case errors.Is(err, store.ErrNotFound):
		// A session pointing at a deleted user is a dead session.
		writeError(w, http.StatusUnauthorized, "unauthenticated", "sign in at /v1/auth/github/login")
		return
	default:
		writeError(w, http.StatusInternalServerError, "internal", "user lookup failed")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"user":       view,
		"dev":        devFallback,
		"connectors": s.connectorStatuses(r.Context(), uid),
	})
}

// connectorNames lists the connectors /v1/me and /v1/connectors report:
// every registered connector (sorted) when the snapshot registry is wired,
// falling back to github alone otherwise (some tests wire no cache, and
// github always exists — login is the first connector).
func (s *Server) connectorNames() []string {
	if s.cache != nil {
		if names := s.cache.KnownConnectors(); len(names) > 0 {
			return names
		}
	}
	return []string{"github"}
}

// connectorStatuses summarizes the user's connector accounts for /v1/me and
// /v1/connectors: "unconfigured" without an account, "expired" when the
// account is flagged for re-auth, "connected" otherwise.
func (s *Server) connectorStatuses(ctx context.Context, uid string) []connectorStatusView {
	names := s.connectorNames()
	out := make([]connectorStatusView, 0, len(names))
	for _, name := range names {
		status := "unconfigured"
		if account, err := s.stores.ConnectorAccounts.GetByUserConnector(ctx, uid, name); err == nil {
			if account.Status == "expired" {
				status = "expired"
			} else {
				status = "connected"
			}
		}
		out = append(out, connectorStatusView{Connector: name, Status: status})
	}
	return out
}

// ---- GET /v1/connectors --------------------------------------------------
// Session auth (wrapped by requireSession). Every registered connector is
// listed with its status and typed field catalog; the per-connector Fields
// vars (connector.FieldsFor) are the single source of truth driving the
// editor's insert-binding picker and the binding consent display
// (architecture.md §8).

type connectorView struct {
	Connector string            `json:"connector"`
	Status    string            `json:"status"`
	Fields    []connector.Field `json:"fields"`
}

func (s *Server) handleConnectors(w http.ResponseWriter, r *http.Request) {
	statuses := s.connectorStatuses(r.Context(), userID(r))
	out := make([]connectorView, 0, len(statuses))
	for _, st := range statuses {
		fields := connector.FieldsFor(st.Connector)
		if fields == nil {
			fields = []connector.Field{} // never null on the wire
		}
		out = append(out, connectorView{Connector: st.Connector, Status: st.Status, Fields: fields})
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- GET /v1/connectors/data ---------------------------------------------
// Session auth (wrapped by requireSession). The session user's merged
// UNFILTERED snapshots for every registered connector, keyed by connector
// name ({"github": {...}}), served through the same SnapshotCache renders
// use. It powers the editor canvas's live-data display.
//
// Unfiltered is deliberate: the bindings filter (resolveBindingData) is a
// PUBLISH boundary — it scopes what a rendered image may publicly display —
// not a self-view one. This endpoint only ever shows the session user their
// own connector data, so nothing is withheld here.

func (s *Server) handleConnectorData(w http.ResponseWriter, r *http.Request) {
	uid := userID(r)
	data := map[string]any{}
	for _, name := range s.cache.KnownConnectors() {
		// Missing accounts resolve to nil, exactly like render: the connector
		// serves its no-credential path (the dev fixture for github).
		account := s.resolveAccount(r, uid, store.Binding{Connector: name})
		snapshot, err := s.cache.Snapshot(r.Context(), uid, name, account)
		if err != nil {
			// Upstream failure: omit this connector rather than failing the
			// request — the canvas degrades to literal templates for it.
			s.log.Warn("connector data unavailable", "connector", name, "err", err)
			continue
		}
		data[name] = snapshot
	}
	writeJSON(w, http.StatusOK, data)
}

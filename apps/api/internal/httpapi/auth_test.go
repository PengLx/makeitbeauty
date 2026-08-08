package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/auth"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/config"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/connector"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/crypto"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// fakeGitHubWeb mocks the endpoints the auth flow touches: the token
// exchange and GET /user.
type fakeGitHubWeb struct {
	t           *testing.T
	accessToken string     // token issued by the exchange
	userJSON    string     // GET /user response body
	lastForm    url.Values // last token-endpoint form post
}

func (f *fakeGitHubWeb) mux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /login/oauth/access_token", func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Accept"); got != "application/json" {
			f.t.Errorf("token endpoint Accept = %q, want application/json", got)
		}
		if err := r.ParseForm(); err != nil {
			f.t.Fatal(err)
		}
		f.lastForm = r.PostForm
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": f.accessToken, "expires_in": 28800,
			"refresh_token": "ghr_cb", "refresh_token_expires_in": 15897600,
		})
	})
	mux.HandleFunc("GET /user", func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer "+f.accessToken {
			f.t.Errorf("/user Authorization = %q", got)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(f.userJSON))
	})
	return mux
}

// authFixture is a Server wired with memory stores/sessions, a PlainSealer,
// and OAuth pointed at the fake GitHub.
type authFixture struct {
	s       *Server
	h       http.Handler
	github  *fakeGitHubWeb
	baseCfg config.Config
}

// newAuthFixture wires the fixture. mutate adjusts the config before wiring
// (nil keeps the default: dev with GitHub auth configured, so the implicit
// dev fallback is OFF and real sessions are exercised).
func newAuthFixture(t *testing.T, mutate func(*config.Config)) *authFixture {
	t.Helper()
	fake := &fakeGitHubWeb{
		t:           t,
		accessToken: "ghu_cb",
		userJSON:    `{"id": 583231, "login": "octocat", "name": "The Octocat", "avatar_url": "https://avatars.example/583231"}`,
	}
	srv := httptest.NewServer(fake.mux())
	t.Cleanup(srv.Close)

	cfg := config.Config{
		Env:                "dev",
		PublicURL:          "http://localhost:5173",
		GitHubClientID:     "Iv1.test",
		GitHubClientSecret: "test-secret",
		GitHubURL:          srv.URL,
		GitHubAPIURL:       srv.URL,
	}
	if mutate != nil {
		mutate(&cfg)
	}
	var oauth *auth.GitHubOAuth
	if cfg.GitHubClientID != "" {
		oauth = auth.NewGitHubOAuth(cfg.GitHubURL, cfg.GitHubAPIURL, cfg.GitHubClientID, cfg.GitHubClientSecret)
	}
	s := NewServer(cfg, slog.New(slog.DiscardHandler), Deps{
		Stores:   store.NewMemory(),
		Sessions: auth.NewMemorySessions(),
		Sealer:   crypto.PlainSealer{},
		OAuth:    oauth,
	})
	return &authFixture{s: s, h: s.Handler(), github: fake, baseCfg: cfg}
}

// seedSession creates a session for uid and returns its cookie.
func seedSession(t *testing.T, f *authFixture, uid string, expiresAt time.Time) *http.Cookie {
	t.Helper()
	sess := &auth.Session{ID: auth.NewSessionID(), UserID: uid, CreatedAt: time.Now(), ExpiresAt: expiresAt}
	if err := f.s.sessions.Create(context.Background(), sess); err != nil {
		t.Fatal(err)
	}
	return &http.Cookie{Name: sessionCookieName, Value: sess.ID}
}

func findCookie(t *testing.T, rec *httptest.ResponseRecorder, name string) *http.Cookie {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == name {
			return c
		}
	}
	return nil
}

// ---- login ---------------------------------------------------------------

func TestGitHubLoginRedirect(t *testing.T) {
	f := newAuthFixture(t, nil)

	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/auth/github/login", nil))

	if rec.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302 (body: %s)", rec.Code, rec.Body.String())
	}
	loc, err := url.Parse(rec.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	base, _ := url.Parse(f.baseCfg.GitHubURL)
	if loc.Host != base.Host || loc.Path != "/login/oauth/authorize" {
		t.Errorf("redirect target = %s, want %s/login/oauth/authorize", loc, base)
	}
	if got := loc.Query().Get("client_id"); got != "Iv1.test" {
		t.Errorf("client_id = %q", got)
	}
	state := loc.Query().Get("state")
	if state == "" {
		t.Fatal("no state in the authorize URL")
	}

	cookie := findCookie(t, rec, stateCookieName)
	if cookie == nil {
		t.Fatal("no state cookie set")
	}
	if cookie.Value != state {
		t.Error("state cookie does not match the state query parameter")
	}
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/" {
		t.Errorf("state cookie flags = %+v, want HttpOnly SameSite=Lax Path=/", cookie)
	}
	if want := int(stateTTL / time.Second); cookie.MaxAge != want {
		t.Errorf("state cookie MaxAge = %d, want %d", cookie.MaxAge, want)
	}
	if cookie.Secure {
		t.Error("state cookie Secure outside production")
	}
}

func TestGitHubLoginUnconfigured(t *testing.T) {
	f := newAuthFixture(t, func(c *config.Config) { c.GitHubClientID = "" })
	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/auth/github/login", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if code := errorCode(t, rec); code != "auth_unconfigured" {
		t.Errorf("error.code = %q", code)
	}
}

// ---- callback ------------------------------------------------------------

func callback(f *authFixture, state, cookieState, code string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/v1/auth/github/callback?state="+url.QueryEscape(state)+"&code="+url.QueryEscape(code), nil)
	if cookieState != "" {
		req.AddCookie(&http.Cookie{Name: stateCookieName, Value: cookieState})
	}
	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, req)
	return rec
}

func TestGitHubCallbackHappyPath(t *testing.T) {
	f := newAuthFixture(t, nil)
	ctx := context.Background()

	rec := callback(f, "state-1", "state-1", "the-code")
	if rec.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302 (body: %s)", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Location"); got != f.baseCfg.PublicURL {
		t.Errorf("redirect = %q, want the public URL %q", got, f.baseCfg.PublicURL)
	}

	// The exchange sent our client credentials and the code.
	for key, want := range map[string]string{"client_id": "Iv1.test", "client_secret": "test-secret", "code": "the-code"} {
		if got := f.github.lastForm.Get(key); got != want {
			t.Errorf("exchange form %s = %q, want %q", key, got, want)
		}
	}

	// User upserted, keyed on the GitHub numeric id.
	user, err := f.s.stores.Users.GetByGitHubID(ctx, 583231)
	if err != nil {
		t.Fatal(err)
	}
	if user.Login != "octocat" || user.DisplayName != "The Octocat" || user.AvatarURL != "https://avatars.example/583231" {
		t.Errorf("user = %+v", user)
	}

	// Connector account provisioned with sealed credentials.
	account, err := f.s.stores.ConnectorAccounts.GetByUserConnector(ctx, user.ID, "github")
	if err != nil {
		t.Fatal(err)
	}
	if account.Status != "active" {
		t.Errorf("account status = %q", account.Status)
	}
	raw, err := crypto.PlainSealer{}.Open(account.EncryptedCredentials)
	if err != nil {
		t.Fatalf("credentials are not sealed: %v", err)
	}
	var creds auth.Credentials
	if err := json.Unmarshal(raw, &creds); err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "ghu_cb" || creds.RefreshToken != "ghr_cb" {
		t.Errorf("creds = %+v", creds)
	}
	if creds.AccessExpiry.IsZero() || creds.RefreshExpiry.IsZero() {
		t.Errorf("creds missing expiries: %+v", creds)
	}

	// Session cookie set and valid: /v1/me sees the user, dev flag off.
	cookie := findCookie(t, rec, sessionCookieName)
	if cookie == nil {
		t.Fatal("no session cookie set")
	}
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/" {
		t.Errorf("session cookie flags = %+v, want HttpOnly SameSite=Lax Path=/", cookie)
	}
	// The state cookie is cleared on the same response.
	if state := findCookie(t, rec, stateCookieName); state == nil || state.MaxAge >= 0 {
		t.Error("state cookie not cleared by the callback")
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: cookie.Value})
	me := httptest.NewRecorder()
	f.h.ServeHTTP(me, req)
	if me.Code != http.StatusOK {
		t.Fatalf("/v1/me status = %d (body: %s)", me.Code, me.Body.String())
	}
	var payload struct {
		User       userView              `json:"user"`
		Dev        bool                  `json:"dev"`
		Connectors []connectorStatusView `json:"connectors"`
	}
	if err := json.Unmarshal(me.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Dev {
		t.Error("dev = true for a real session")
	}
	if payload.User.Login != "octocat" || payload.User.DisplayName != "The Octocat" || payload.User.AvatarURL == "" {
		t.Errorf("me.user = %+v", payload.User)
	}
	if len(payload.Connectors) != 1 || payload.Connectors[0].Connector != "github" || payload.Connectors[0].Status != "connected" {
		t.Errorf("me.connectors = %+v", payload.Connectors)
	}
}

// A second login for the same GitHub identity updates the user in place.
func TestGitHubCallbackUpsertsExistingUser(t *testing.T) {
	f := newAuthFixture(t, nil)
	ctx := context.Background()

	if rec := callback(f, "s1", "s1", "code-1"); rec.Code != http.StatusFound {
		t.Fatalf("first login status = %d", rec.Code)
	}
	f.github.userJSON = `{"id": 583231, "login": "renamed", "name": "", "avatar_url": "https://avatars.example/new"}`
	if rec := callback(f, "s2", "s2", "code-2"); rec.Code != http.StatusFound {
		t.Fatalf("second login status = %d", rec.Code)
	}

	user, err := f.s.stores.Users.GetByGitHubID(ctx, 583231)
	if err != nil {
		t.Fatal(err)
	}
	// Same identity, refreshed profile; empty name falls back to login.
	if user.Login != "renamed" || user.DisplayName != "renamed" || user.AvatarURL != "https://avatars.example/new" {
		t.Errorf("user after re-login = %+v", user)
	}
	projects, err := f.s.stores.Projects.ListByUser(ctx, user.ID)
	if err != nil || projects == nil {
		t.Fatalf("user id changed across logins: %v", err)
	}
}

func TestGitHubCallbackRejectsBadState(t *testing.T) {
	tests := []struct {
		name        string
		state       string
		cookieState string
	}{
		{"mismatched state", "attacker", "victim"},
		{"missing cookie", "some-state", ""},
		{"missing state param", "", "some-state"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newAuthFixture(t, nil)
			rec := callback(f, tt.state, tt.cookieState, "the-code")
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", rec.Code)
			}
			if code := errorCode(t, rec); code != "invalid_state" {
				t.Errorf("error.code = %q, want invalid_state", code)
			}
			if c := findCookie(t, rec, sessionCookieName); c != nil {
				t.Error("session cookie set despite state failure")
			}
		})
	}
}

// ---- session middleware --------------------------------------------------

// With auth configured the implicit dev user is gone: only cookies count.
func TestSessionMiddleware(t *testing.T) {
	f := newAuthFixture(t, nil)
	now := time.Now()

	valid := seedSession(t, f, "u-1", now.Add(auth.SessionTTL))
	expired := seedSession(t, f, "u-1", now.Add(-time.Minute))

	tests := []struct {
		name       string
		cookie     *http.Cookie
		wantStatus int
	}{
		{"no cookie", nil, http.StatusUnauthorized},
		{"unknown session id", &http.Cookie{Name: sessionCookieName, Value: "bogus"}, http.StatusUnauthorized},
		{"expired session", expired, http.StatusUnauthorized},
		{"valid session", valid, http.StatusOK},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/v1/projects", nil)
			if tt.cookie != nil {
				req.AddCookie(tt.cookie)
			}
			rec := httptest.NewRecorder()
			f.h.ServeHTTP(rec, req)
			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, tt.wantStatus, rec.Body.String())
			}
		})
	}
}

// The session resolves to its user: projects are scoped per session user.
func TestSessionScopesUser(t *testing.T) {
	f := newAuthFixture(t, nil)
	ctx := context.Background()
	now := time.Now().UTC()
	for _, uid := range []string{"u-alice", "u-bob"} {
		if err := f.s.stores.Projects.Create(ctx, &store.Project{
			ID: "p-" + uid, UserID: uid, Name: uid, Design: json.RawMessage(`{}`),
			CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			t.Fatal(err)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/projects", nil)
	req.AddCookie(seedSession(t, f, "u-alice", now.Add(time.Hour)))
	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, req)

	var payload struct {
		Projects []struct {
			ID string `json:"id"`
		} `json:"projects"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Projects) != 1 || payload.Projects[0].ID != "p-u-alice" {
		t.Errorf("projects for alice = %+v", payload.Projects)
	}
}

// Dev without a client id keeps the implicit dev user — the pre-auth flows
// (and every existing test) behave exactly as before.
func TestDevFallbackWithoutClientID(t *testing.T) {
	f := newAuthFixture(t, func(c *config.Config) { c.GitHubClientID = "" })

	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/projects", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("dev fallback project list status = %d", rec.Code)
	}

	me := httptest.NewRecorder()
	f.h.ServeHTTP(me, httptest.NewRequest(http.MethodGet, "/v1/me", nil))
	if me.Code != http.StatusOK {
		t.Fatalf("/v1/me status = %d", me.Code)
	}
	var payload struct {
		User userView `json:"user"`
		Dev  bool     `json:"dev"`
	}
	if err := json.Unmarshal(me.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.Dev || payload.User.Login != "dev" {
		t.Errorf("me = %+v, want the implicit dev user with dev:true", payload)
	}
}

// ---- logout --------------------------------------------------------------

func TestLogout(t *testing.T) {
	f := newAuthFixture(t, nil)
	cookie := seedSession(t, f, "u-1", time.Now().Add(time.Hour))

	req := httptest.NewRequest(http.MethodPost, "/v1/auth/logout", nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	if cleared := findCookie(t, rec, sessionCookieName); cleared == nil || cleared.MaxAge >= 0 {
		t.Error("session cookie not cleared")
	}
	// The session is gone server-side: replaying the old cookie fails.
	replay := httptest.NewRequest(http.MethodGet, "/v1/projects", nil)
	replay.AddCookie(cookie)
	rec = httptest.NewRecorder()
	f.h.ServeHTTP(rec, replay)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("replayed session status = %d, want 401", rec.Code)
	}
	// Logout is idempotent.
	req = httptest.NewRequest(http.MethodPost, "/v1/auth/logout", nil)
	req.AddCookie(cookie)
	rec = httptest.NewRecorder()
	f.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Errorf("second logout status = %d, want 204", rec.Code)
	}
}

// ---- /v1/me and /v1/connectors -------------------------------------------

func TestMeUnauthenticated(t *testing.T) {
	f := newAuthFixture(t, nil) // auth configured: no dev fallback
	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/me", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestConnectorsEndpoint(t *testing.T) {
	f := newAuthFixture(t, nil)
	ctx := context.Background()

	// Unauthenticated: 401.
	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/connectors", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want 401", rec.Code)
	}

	if err := f.s.stores.Users.Create(ctx, &store.User{ID: "u-1", Login: "octo", CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	cookie := seedSession(t, f, "u-1", time.Now().Add(time.Hour))

	get := func() []connectorView {
		req := httptest.NewRequest(http.MethodGet, "/v1/connectors", nil)
		req.AddCookie(cookie)
		rec := httptest.NewRecorder()
		f.h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d (body: %s)", rec.Code, rec.Body.String())
		}
		var out []connectorView
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}

	// No account yet: unconfigured, but the field list is already served —
	// the picker works before connecting.
	out := get()
	if len(out) != 1 || out[0].Connector != "github" || out[0].Status != "unconfigured" {
		t.Fatalf("connectors = %+v", out)
	}
	if len(out[0].Fields) != len(connector.GitHubFields) {
		t.Errorf("fields = %d entries, want %d", len(out[0].Fields), len(connector.GitHubFields))
	}
	for i, field := range out[0].Fields {
		if field.Path != connector.GitHubFields[i].Path || field.Description == "" {
			t.Errorf("fields[%d] = %+v, want %+v", i, field, connector.GitHubFields[i])
		}
	}

	// Connected account.
	account := &store.ConnectorAccount{
		ID: "acct-1", UserID: "u-1", Connector: "github",
		EncryptedCredentials: []byte("sealed"), Status: "active", LastRefreshAt: time.Now(),
	}
	if err := f.s.stores.ConnectorAccounts.Create(ctx, account); err != nil {
		t.Fatal(err)
	}
	if out := get(); out[0].Status != "connected" {
		t.Errorf("status = %q, want connected", out[0].Status)
	}

	// Expired account surfaces as expired (re-login prompt).
	account.Status = "expired"
	if err := f.s.stores.ConnectorAccounts.Update(ctx, account); err != nil {
		t.Fatal(err)
	}
	if out := get(); out[0].Status != "expired" {
		t.Errorf("status = %q, want expired", out[0].Status)
	}
}

// Production semantics: Secure cookies.
func TestProductionCookiesAreSecure(t *testing.T) {
	f := newAuthFixture(t, func(c *config.Config) { c.Env = "production" })
	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/auth/github/login", nil))
	cookie := findCookie(t, rec, stateCookieName)
	if cookie == nil || !cookie.Secure {
		t.Error("state cookie not Secure in production")
	}
}

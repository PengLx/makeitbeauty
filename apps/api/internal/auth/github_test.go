package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestAuthorizeURL(t *testing.T) {
	o := NewGitHubOAuth("https://github.example/", "https://api.github.example", "client-123", "secret")
	raw := o.AuthorizeURL("state-abc")

	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got := u.Scheme + "://" + u.Host + u.Path; got != "https://github.example/login/oauth/authorize" {
		t.Errorf("authorize endpoint = %q", got)
	}
	q := u.Query()
	if q.Get("client_id") != "client-123" {
		t.Errorf("client_id = %q", q.Get("client_id"))
	}
	if q.Get("state") != "state-abc" {
		t.Errorf("state = %q", q.Get("state"))
	}
}

// fakeTokenEndpoint records the last form post and plays back a scripted body.
type fakeTokenEndpoint struct {
	lastForm url.Values
	status   int
	body     any
}

func (f *fakeTokenEndpoint) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/login/oauth/access_token" || r.Method != http.MethodPost {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if got := r.Header.Get("Accept"); got != "application/json" {
			t.Errorf("Accept = %q, want application/json", got)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		f.lastForm = r.PostForm
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(f.status)
		_ = json.NewEncoder(w).Encode(f.body)
	}
}

func TestExchange(t *testing.T) {
	fake := &fakeTokenEndpoint{status: http.StatusOK, body: map[string]any{
		"access_token": "ghu_new", "expires_in": 28800,
		"refresh_token": "ghr_new", "refresh_token_expires_in": 15897600,
		"token_type": "bearer",
	}}
	srv := httptest.NewServer(fake.handler(t))
	defer srv.Close()

	o := NewGitHubOAuth(srv.URL, srv.URL, "cid", "csecret")
	tok, err := o.Exchange(context.Background(), "the-code")
	if err != nil {
		t.Fatal(err)
	}
	if tok.AccessToken != "ghu_new" || tok.RefreshToken != "ghr_new" {
		t.Errorf("token = %+v", tok)
	}
	if tok.ExpiresIn != 28800 || tok.RefreshTokenExpiresIn != 15897600 {
		t.Errorf("expiries = %d/%d", tok.ExpiresIn, tok.RefreshTokenExpiresIn)
	}
	for key, want := range map[string]string{"client_id": "cid", "client_secret": "csecret", "code": "the-code"} {
		if got := fake.lastForm.Get(key); got != want {
			t.Errorf("form %s = %q, want %q", key, got, want)
		}
	}
	if fake.lastForm.Has("grant_type") {
		t.Error("code exchange must not send grant_type")
	}
}

func TestRefreshSendsRefreshGrant(t *testing.T) {
	fake := &fakeTokenEndpoint{status: http.StatusOK, body: map[string]any{
		"access_token": "ghu_refreshed", "expires_in": 28800, "refresh_token": "ghr_rotated",
	}}
	srv := httptest.NewServer(fake.handler(t))
	defer srv.Close()

	o := NewGitHubOAuth(srv.URL, srv.URL, "cid", "csecret")
	tok, err := o.Refresh(context.Background(), "ghr_old")
	if err != nil {
		t.Fatal(err)
	}
	if tok.AccessToken != "ghu_refreshed" {
		t.Errorf("access token = %q", tok.AccessToken)
	}
	if got := fake.lastForm.Get("grant_type"); got != "refresh_token" {
		t.Errorf("grant_type = %q, want refresh_token", got)
	}
	if got := fake.lastForm.Get("refresh_token"); got != "ghr_old" {
		t.Errorf("refresh_token = %q, want ghr_old", got)
	}
}

// GitHub reports token errors inside a 200 body; both shapes must fail.
func TestTokenRequestErrors(t *testing.T) {
	tests := []struct {
		name   string
		status int
		body   any
	}{
		{"error in 200 body", http.StatusOK, map[string]any{"error": "bad_refresh_token", "error_description": "expired"}},
		{"empty 200 body", http.StatusOK, map[string]any{}},
		{"http error", http.StatusBadGateway, map[string]any{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fake := &fakeTokenEndpoint{status: tt.status, body: tt.body}
			srv := httptest.NewServer(fake.handler(t))
			defer srv.Close()

			o := NewGitHubOAuth(srv.URL, srv.URL, "cid", "csecret")
			if _, err := o.Refresh(context.Background(), "ghr_x"); err == nil {
				t.Error("Refresh succeeded, want error")
			}
		})
	}
}

func TestFetchUser(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/user" {
			http.NotFound(w, r)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer ghu_tok" {
			t.Errorf("Authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id": 583231, "login": "octocat", "name": "The Octocat", "avatar_url": "https://avatars.example/583231"}`))
	}))
	defer srv.Close()

	o := NewGitHubOAuth(srv.URL, srv.URL, "cid", "csecret")
	user, err := o.FetchUser(context.Background(), "ghu_tok")
	if err != nil {
		t.Fatal(err)
	}
	want := GitHubUser{ID: 583231, Login: "octocat", Name: "The Octocat", AvatarURL: "https://avatars.example/583231"}
	if *user != want {
		t.Errorf("user = %+v, want %+v", *user, want)
	}
}

func TestTokenCredentials(t *testing.T) {
	now := time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC)

	tok := &Token{AccessToken: "a", ExpiresIn: 3600, RefreshToken: "r", RefreshTokenExpiresIn: 7200}
	c := tok.Credentials(now)
	if !c.AccessExpiry.Equal(now.Add(time.Hour)) || !c.RefreshExpiry.Equal(now.Add(2*time.Hour)) {
		t.Errorf("expiries = %v / %v", c.AccessExpiry, c.RefreshExpiry)
	}

	// Non-expiring tokens keep zero expiries, and those marshal away.
	c = (&Token{AccessToken: "a"}).Credentials(now)
	if !c.AccessExpiry.IsZero() || !c.RefreshExpiry.IsZero() {
		t.Errorf("non-expiring token got expiries: %+v", c)
	}
	b, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "Expiry") || strings.Contains(string(b), "0001-01-01") {
		t.Errorf("zero expiries not omitted: %s", b)
	}
}

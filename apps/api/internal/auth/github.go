package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// GitHubOAuth drives GitHub App user OAuth: the authorize redirect, the code
// exchange, the refresh grant, and the /user identity fetch. Base URLs are
// injectable (MIB_GITHUB_URL / MIB_GITHUB_API_URL) so tests run against
// httptest servers.
type GitHubOAuth struct {
	baseURL      string // web endpoints: authorize, access_token
	apiBaseURL   string // REST API: /user
	clientID     string
	clientSecret string
	http         *http.Client
}

// NewGitHubOAuth returns a client for the GitHub at baseURL/apiBaseURL
// (trailing slashes tolerated).
func NewGitHubOAuth(baseURL, apiBaseURL, clientID, clientSecret string) *GitHubOAuth {
	return &GitHubOAuth{
		baseURL:      strings.TrimSuffix(baseURL, "/"),
		apiBaseURL:   strings.TrimSuffix(apiBaseURL, "/"),
		clientID:     clientID,
		clientSecret: clientSecret,
		http:         &http.Client{Timeout: 15 * time.Second},
	}
}

// AuthorizeURL is the GitHub authorize endpoint the login route 302s to.
// GitHub Apps take the callback URL from the App configuration, so only
// client_id and the CSRF state travel in the query.
func (o *GitHubOAuth) AuthorizeURL(state string) string {
	q := url.Values{"client_id": {o.clientID}, "state": {state}}
	return o.baseURL + "/login/oauth/authorize?" + q.Encode()
}

// Token is a successful access_token-endpoint response. GitHub App user
// tokens expire (8h) and come with a refresh token (~6 months).
type Token struct {
	AccessToken           string `json:"access_token"`
	ExpiresIn             int64  `json:"expires_in"` // seconds; 0 == non-expiring
	RefreshToken          string `json:"refresh_token"`
	RefreshTokenExpiresIn int64  `json:"refresh_token_expires_in"`
}

// Credentials is the sealed-at-rest JSON shape of the github
// ConnectorAccount's EncryptedCredentials. Zero expiries mean non-expiring
// (classic OAuth Apps without token expiry).
type Credentials struct {
	AccessToken   string    `json:"accessToken"`
	AccessExpiry  time.Time `json:"accessExpiry,omitzero"`
	RefreshToken  string    `json:"refreshToken,omitempty"`
	RefreshExpiry time.Time `json:"refreshExpiry,omitzero"`
}

// Credentials converts a token response into the sealed-at-rest shape,
// resolving relative expiries against now.
func (t *Token) Credentials(now time.Time) Credentials {
	c := Credentials{AccessToken: t.AccessToken, RefreshToken: t.RefreshToken}
	if t.ExpiresIn > 0 {
		c.AccessExpiry = now.Add(time.Duration(t.ExpiresIn) * time.Second).UTC()
	}
	if t.RefreshTokenExpiresIn > 0 {
		c.RefreshExpiry = now.Add(time.Duration(t.RefreshTokenExpiresIn) * time.Second).UTC()
	}
	return c
}

// Exchange trades an authorization code for a user token (callback step).
func (o *GitHubOAuth) Exchange(ctx context.Context, code string) (*Token, error) {
	return o.tokenRequest(ctx, url.Values{
		"client_id":     {o.clientID},
		"client_secret": {o.clientSecret},
		"code":          {code},
	})
}

// Refresh trades a refresh token for a fresh user token (refresh grant).
func (o *GitHubOAuth) Refresh(ctx context.Context, refreshToken string) (*Token, error) {
	return o.tokenRequest(ctx, url.Values{
		"client_id":     {o.clientID},
		"client_secret": {o.clientSecret},
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
	})
}

// tokenRequest posts form params to the access_token endpoint. GitHub
// responds 200 even for failures ({"error": ...}), so the body decides.
func (o *GitHubOAuth) tokenRequest(ctx context.Context, form url.Values) (*Token, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		o.baseURL+"/login/oauth/access_token", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("auth: building token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := o.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("auth: token endpoint: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("auth: reading token response: %w", err)
	}

	var parsed struct {
		Token
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil || resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("auth: token endpoint responded %d with a malformed body", resp.StatusCode)
	}
	if parsed.Error != "" {
		return nil, fmt.Errorf("auth: token endpoint: %s (%s)", parsed.Error, parsed.ErrorDescription)
	}
	if parsed.AccessToken == "" {
		return nil, fmt.Errorf("auth: token endpoint returned no access token")
	}
	return &parsed.Token, nil
}

// GitHubUser is the identity subset of GET /user the callback needs.
type GitHubUser struct {
	ID        int64  `json:"id"`
	Login     string `json:"login"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
}

// FetchUser resolves the token owner's identity via the GitHub REST API.
func (o *GitHubOAuth) FetchUser(ctx context.Context, accessToken string) (*GitHubUser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, o.apiBaseURL+"/user", nil)
	if err != nil {
		return nil, fmt.Errorf("auth: building /user request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := o.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("auth: fetching /user: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("auth: /user responded %d", resp.StatusCode)
	}
	var user GitHubUser
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&user); err != nil {
		return nil, fmt.Errorf("auth: decoding /user response: %w", err)
	}
	if user.ID == 0 || user.Login == "" {
		return nil, fmt.Errorf("auth: /user response is missing id or login")
	}
	return &user, nil
}

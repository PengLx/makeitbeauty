package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/auth"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/crypto"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/fixture"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// Field describes one bindable snapshot path for the editor's insert-binding
// picker (GET /v1/connectors, architecture.md §8).
type Field struct {
	Path        string `json:"path"`
	Description string `json:"description"`
	// Type is the value type at this path: "string" or "number". The editor's
	// binding controls filter by it — a numeric prop (e.g. a progress bar's
	// percent) only offers number fields.
	Type string `json:"type"`
}

// GitHubFields is the single source of truth for the github snapshot shape:
// the paths Fetch produces and the picker the editor renders. Keep it in sync
// with buildSnapshot below.
var GitHubFields = []Field{
	{Path: "user.name", Description: "Display name", Type: "string"},
	{Path: "user.login", Description: "GitHub username", Type: "string"},
	{Path: "user.avatarUrl", Description: "Avatar image URL", Type: "string"},
	{Path: "user.followers", Description: "Follower count", Type: "number"},
	{Path: "stats.totalStars", Description: "Stars across owned repositories", Type: "number"},
	{Path: "stats.topLanguage", Description: "Top language, star-weighted", Type: "string"},
	{Path: "stats.totalContributions", Description: "Contributions in the last year", Type: "number"},
}

// githubQuery fetches everything one snapshot needs in a single GraphQL round
// trip. Contribution-calendar data has no anonymous path — this query is why
// the GitHub connector is a login prerequisite (architecture.md §6).
const githubQuery = `query {
  viewer {
    name
    login
    avatarUrl
    followers { totalCount }
    contributionsCollection { contributionCalendar { totalContributions } }
    repositories(first: 100, ownerAffiliations: OWNER) {
      nodes { stargazerCount primaryLanguage { name } }
    }
  }
}`

// GitHub is the GitHub connector. With sealed credentials on the account it
// queries the GraphQL API as that user (refreshing expired tokens in place);
// without credentials — dev, not logged in — it serves the demo fixture so
// the render path works out of the box.
type GitHub struct {
	fixture    map[string]any
	apiBaseURL string
	oauth      *auth.GitHubOAuth
	sealer     crypto.Sealer
	accounts   store.ConnectorAccounts
	http       *http.Client
	now        func() time.Time // injectable clock for tests
}

// GitHubDeps wires the live half of the connector. OAuth may be nil (auth
// unconfigured): credentialed accounts then fail closed into the SWR-stale
// path instead of silently serving fixture data.
type GitHubDeps struct {
	// APIBaseURL is the GitHub API base (MIB_GITHUB_API_URL); the GraphQL
	// endpoint is APIBaseURL + "/graphql".
	APIBaseURL string
	OAuth      *auth.GitHubOAuth
	Sealer     crypto.Sealer
	Accounts   store.ConnectorAccounts
}

// NewGitHub loads the fixture fallback at path (see internal/fixture) and
// wires the live GraphQL client. The fixture is the merged-data shape keyed
// by connector name ({"github": {...}}); the inner object is this connector's
// snapshot.
func NewGitHub(path string, deps GitHubDeps) (*GitHub, error) {
	var doc map[string]any
	if err := fixture.LoadJSON(path, &doc); err != nil {
		return nil, err
	}
	if inner, ok := doc["github"].(map[string]any); ok {
		doc = inner
	}
	return &GitHub{
		fixture:    doc,
		apiBaseURL: deps.APIBaseURL,
		oauth:      deps.OAuth,
		sealer:     deps.Sealer,
		accounts:   deps.Accounts,
		http:       &http.Client{Timeout: 15 * time.Second},
		now:        time.Now,
	}, nil
}

// Name implements Connector.
func (g *GitHub) Name() string { return "github" }

// SnapshotTTL implements Connector. Mirrors the manifest value
// (snapshotTtlSeconds).
func (g *GitHub) SnapshotTTL() time.Duration { return 15 * time.Minute }

// Fetch implements Connector. Accounts without credentials (dev stub, not
// logged in) get the fixture. Errors on the credentialed path are surfaced to
// the SnapshotCache, whose stale-while-revalidate semantics keep serving the
// previous snapshot — an expired token degrades a card to stale, never to a
// failed render.
func (g *GitHub) Fetch(ctx context.Context, account *store.ConnectorAccount) (map[string]any, error) {
	if account == nil || len(account.EncryptedCredentials) == 0 {
		return g.fixture, nil
	}
	if g.sealer == nil {
		return nil, errors.New("connector: github: account has credentials but no sealer is configured")
	}
	raw, err := g.sealer.Open(account.EncryptedCredentials)
	if err != nil {
		return nil, fmt.Errorf("connector: github: opening credentials: %w", err)
	}
	var creds auth.Credentials
	if err := json.Unmarshal(raw, &creds); err != nil {
		return nil, fmt.Errorf("connector: github: credentials are not valid JSON: %w", err)
	}

	// Proactive refresh: a known-expired access token skips the doomed query.
	if !creds.AccessExpiry.IsZero() && !g.now().Before(creds.AccessExpiry) {
		if creds, err = g.refresh(ctx, account, creds); err != nil {
			return nil, err
		}
	}

	snapshot, unauthorized, err := g.query(ctx, creds.AccessToken)
	if unauthorized {
		// The token expired underneath us (or was revoked): refresh once and
		// retry once — never loop.
		if creds, err = g.refresh(ctx, account, creds); err != nil {
			return nil, err
		}
		snapshot, _, err = g.query(ctx, creds.AccessToken)
	}
	return snapshot, err
}

// refresh runs the refresh grant, reseals + persists the new credentials, and
// returns them. Any failure marks the account "expired" (best effort) so
// /v1/me and /v1/connectors can prompt a re-login, and returns an error the
// cache absorbs as a stale-serve.
func (g *GitHub) refresh(ctx context.Context, account *store.ConnectorAccount, creds auth.Credentials) (auth.Credentials, error) {
	if g.oauth == nil || creds.RefreshToken == "" {
		return creds, g.markExpired(ctx, account, errors.New("no refresh token available"))
	}
	tok, err := g.oauth.Refresh(ctx, creds.RefreshToken)
	if err != nil {
		return creds, g.markExpired(ctx, account, err)
	}
	next := tok.Credentials(g.now())
	if next.RefreshToken == "" {
		// The endpoint did not rotate the refresh token; keep the old one.
		next.RefreshToken = creds.RefreshToken
		next.RefreshExpiry = creds.RefreshExpiry
	}
	raw, err := json.Marshal(next)
	if err != nil {
		return creds, fmt.Errorf("connector: github: encoding refreshed credentials: %w", err)
	}
	sealed, err := g.sealer.Seal(raw)
	if err != nil {
		return creds, fmt.Errorf("connector: github: sealing refreshed credentials: %w", err)
	}
	account.EncryptedCredentials = sealed
	account.Status = "active"
	account.LastRefreshAt = g.now().UTC()
	if err := g.accounts.Update(ctx, account); err != nil {
		return creds, fmt.Errorf("connector: github: persisting refreshed credentials: %w", err)
	}
	return next, nil
}

func (g *GitHub) markExpired(ctx context.Context, account *store.ConnectorAccount, cause error) error {
	account.Status = "expired"
	_ = g.accounts.Update(ctx, account) // best effort; the render outcome is decided by the cache
	return fmt.Errorf("connector: github: token refresh failed: %w", cause)
}

// ghViewer mirrors the githubQuery response shape.
type ghViewer struct {
	Name      string `json:"name"`
	Login     string `json:"login"`
	AvatarURL string `json:"avatarUrl"`
	Followers struct {
		TotalCount int `json:"totalCount"`
	} `json:"followers"`
	ContributionsCollection struct {
		ContributionCalendar struct {
			TotalContributions int `json:"totalContributions"`
		} `json:"contributionCalendar"`
	} `json:"contributionsCollection"`
	Repositories struct {
		Nodes []struct {
			StargazerCount  int `json:"stargazerCount"`
			PrimaryLanguage *struct {
				Name string `json:"name"`
			} `json:"primaryLanguage"`
		} `json:"nodes"`
	} `json:"repositories"`
}

// query posts githubQuery and builds the snapshot. unauthorized reports an
// HTTP 401 — the retry-after-refresh trigger — separately from other errors.
func (g *GitHub) query(ctx context.Context, accessToken string) (snapshot map[string]any, unauthorized bool, err error) {
	body, err := json.Marshal(map[string]string{"query": githubQuery})
	if err != nil {
		return nil, false, fmt.Errorf("connector: github: encoding query: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.apiBaseURL+"/graphql", bytes.NewReader(body))
	if err != nil {
		return nil, false, fmt.Errorf("connector: github: building request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := g.http.Do(req)
	if err != nil {
		return nil, false, fmt.Errorf("connector: github: graphql: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return nil, true, fmt.Errorf("connector: github: graphql responded 401")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, false, fmt.Errorf("connector: github: graphql responded %d", resp.StatusCode)
	}

	var parsed struct {
		Data struct {
			Viewer ghViewer `json:"viewer"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&parsed); err != nil {
		return nil, false, fmt.Errorf("connector: github: decoding graphql response: %w", err)
	}
	if len(parsed.Errors) > 0 {
		return nil, false, fmt.Errorf("connector: github: graphql error: %s", parsed.Errors[0].Message)
	}
	if parsed.Data.Viewer.Login == "" {
		return nil, false, errors.New("connector: github: graphql response has no viewer")
	}
	return buildSnapshot(parsed.Data.Viewer), false, nil
}

// buildSnapshot maps the viewer onto the GitHubFields paths. The existing
// fixture paths (user.name/login/followers, stats.totalStars/topLanguage) are
// contractual; additions are additive only.
func buildSnapshot(v ghViewer) map[string]any {
	name := v.Name
	if name == "" {
		name = v.Login
	}

	totalStars := 0
	// Star-weighted language frequency: each repo votes stars+1 for its
	// primary language, so starless repos still count once and starred work
	// dominates. Ties break alphabetically — snapshots must be deterministic
	// (architecture.md §3).
	weights := map[string]int{}
	for _, repo := range v.Repositories.Nodes {
		totalStars += repo.StargazerCount
		if repo.PrimaryLanguage != nil && repo.PrimaryLanguage.Name != "" {
			weights[repo.PrimaryLanguage.Name] += repo.StargazerCount + 1
		}
	}
	topLanguage, best := "", 0
	for lang, weight := range weights {
		if weight > best || (weight == best && lang < topLanguage) {
			topLanguage, best = lang, weight
		}
	}

	return map[string]any{
		"user": map[string]any{
			"name":      name,
			"login":     v.Login,
			"avatarUrl": v.AvatarURL,
			"followers": v.Followers.TotalCount,
		},
		"stats": map[string]any{
			"totalStars":         totalStars,
			"topLanguage":        topLanguage,
			"totalContributions": v.ContributionsCollection.ContributionCalendar.TotalContributions,
		},
	}
}

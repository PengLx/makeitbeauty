package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/crypto"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// leetcodeUsernamePattern constrains the configured username: LeetCode
// usernames are short URL-safe handles, and the pattern doubles as injection
// hygiene for the GraphQL variable.
var leetcodeUsernamePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)

// LeetCodeConfig is the account config of the leetcode connector (auth tier
// none — the profile is public; the config is just WHOSE profile to read).
type LeetCodeConfig struct {
	Username string `json:"username"`
}

// Validate implements AccountConfig.
func (c *LeetCodeConfig) Validate() error {
	if !leetcodeUsernamePattern.MatchString(c.Username) {
		return errors.New("username must match ^[A-Za-z0-9_-]{1,40}$")
	}
	return nil
}

// LeetCodeFields is the single source of truth for the leetcode snapshot
// shape. Keep it in sync with the snapshot built in Fetch below.
var LeetCodeFields = []Field{
	{Path: "solved.total", Description: "Problems solved, all difficulties", Type: "number"},
	{Path: "solved.easy", Description: "Easy problems solved", Type: "number"},
	{Path: "solved.medium", Description: "Medium problems solved", Type: "number"},
	{Path: "solved.hard", Description: "Hard problems solved", Type: "number"},
	{Path: "profile.ranking", Description: "Global ranking", Type: "number"},
}

// leetcodeQuery is the public profile query: matchedUser exposes solved
// counts and ranking without authentication.
const leetcodeQuery = `query ($username: String!) {
  matchedUser(username: $username) {
    profile { ranking }
    submitStatsGlobal { acSubmissionNum { difficulty count } }
  }
}`

// LeetCode is the LeetCode connector. A configured account (sealed
// LeetCodeConfig) queries the public GraphQL API for that username; without
// config it serves the dev fixture (dev) or an empty snapshot (production).
type LeetCode struct {
	fixture    map[string]any
	apiBaseURL string
	sealer     crypto.Sealer
	http       *http.Client
}

// LeetCodeDeps wires the live half of the connector.
type LeetCodeDeps struct {
	// APIBaseURL is the LeetCode base (MIB_LEETCODE_API_URL); the GraphQL
	// endpoint is APIBaseURL + "/graphql".
	APIBaseURL string
	Sealer     crypto.Sealer
}

// NewLeetCode loads the optional fixture fallback (dev only; empty path
// means none) and wires the live GraphQL client.
func NewLeetCode(fixturePath string, deps LeetCodeDeps) (*LeetCode, error) {
	fix, err := loadFixture(fixturePath, "leetcode")
	if err != nil {
		return nil, err
	}
	return &LeetCode{
		fixture:    fix,
		apiBaseURL: deps.APIBaseURL,
		sealer:     deps.Sealer,
		http:       &http.Client{Timeout: 15 * time.Second},
	}, nil
}

// Name implements Connector.
func (l *LeetCode) Name() string { return "leetcode" }

// SnapshotTTL implements Connector (manifest value).
func (l *LeetCode) SnapshotTTL() time.Duration { return 6 * time.Hour }

// Fetch implements Connector. An unknown username (deleted or renamed
// account) is an error, which the SnapshotCache absorbs by serving the last
// good snapshot stale — a card degrades, never breaks.
func (l *LeetCode) Fetch(ctx context.Context, account *store.ConnectorAccount) (map[string]any, error) {
	if account == nil || len(account.EncryptedCredentials) == 0 {
		if l.fixture != nil {
			return l.fixture, nil
		}
		return map[string]any{}, nil // production unconfigured: em-dash semantics
	}
	var cfg LeetCodeConfig
	if err := openAccountConfig(l.sealer, "leetcode", account, &cfg); err != nil {
		return nil, err
	}
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("connector: leetcode: stored config invalid: %w", err)
	}

	body, err := json.Marshal(map[string]any{
		"query":     leetcodeQuery,
		"variables": map[string]string{"username": cfg.Username},
	})
	if err != nil {
		return nil, fmt.Errorf("connector: leetcode: encoding query: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, l.apiBaseURL+"/graphql", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("connector: leetcode: building request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := l.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("connector: leetcode: graphql: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("connector: leetcode: graphql responded %d", resp.StatusCode)
	}

	var parsed struct {
		Data struct {
			MatchedUser *struct {
				Profile struct {
					Ranking int `json:"ranking"`
				} `json:"profile"`
				SubmitStatsGlobal struct {
					ACSubmissionNum []struct {
						Difficulty string `json:"difficulty"`
						Count      int    `json:"count"`
					} `json:"acSubmissionNum"`
				} `json:"submitStatsGlobal"`
			} `json:"matchedUser"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("connector: leetcode: decoding graphql response: %w", err)
	}
	if parsed.Data.MatchedUser == nil {
		if len(parsed.Errors) > 0 {
			return nil, fmt.Errorf("connector: leetcode: graphql error: %s", parsed.Errors[0].Message)
		}
		return nil, fmt.Errorf("connector: leetcode: unknown username %q", cfg.Username)
	}

	solved := map[string]any{"total": 0, "easy": 0, "medium": 0, "hard": 0}
	for _, n := range parsed.Data.MatchedUser.SubmitStatsGlobal.ACSubmissionNum {
		switch n.Difficulty {
		case "All":
			solved["total"] = n.Count
		case "Easy":
			solved["easy"] = n.Count
		case "Medium":
			solved["medium"] = n.Count
		case "Hard":
			solved["hard"] = n.Count
		}
	}
	return map[string]any{
		"solved":  solved,
		"profile": map[string]any{"ranking": parsed.Data.MatchedUser.Profile.Ranking},
	}, nil
}

package connector

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/crypto"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// WakaTimeConfig is the user-pasted account config of the wakatime connector
// (auth tier api_key, architecture.md §6): the user's WakaTime API key,
// sealed at rest via the config-account framework.
type WakaTimeConfig struct {
	APIKey string `json:"apiKey"`
}

// Validate implements AccountConfig.
func (c *WakaTimeConfig) Validate() error {
	if strings.TrimSpace(c.APIKey) == "" {
		return errors.New("apiKey is required")
	}
	return nil
}

// WakaTimeFields is the single source of truth for the wakatime snapshot
// shape: the paths Fetch produces and the picker the editor renders. Keep it
// in sync with buildWakaTimeSnapshot below.
var WakaTimeFields = []Field{
	{Path: "stats.weeklyHours", Description: "Coding hours in the last 7 days (one decimal)", Type: "number"},
	{Path: "stats.dailyAvgMinutes", Description: "Average coding minutes per day, last 7 days", Type: "number"},
	{Path: "stats.topLanguage", Description: "Most-used language, last 7 days", Type: "string"},
	{Path: "stats.topLanguages", Description: "Top 5 languages, last 7 days, as [{name, percent}]", Type: "series"},
	{Path: "stats.days", Description: "Daily coding minutes, last 7 days, as [{date, minutes}]", Type: "series"},
}

// WakaTime is the WakaTime connector. A configured account (sealed
// WakaTimeConfig) queries the REST API with the user's key; without config it
// serves the dev fixture (dev) or an empty snapshot (production — bound
// fields render as em-dashes).
type WakaTime struct {
	fixture    map[string]any
	apiBaseURL string
	sealer     crypto.Sealer
	http       *http.Client
}

// WakaTimeDeps wires the live half of the connector.
type WakaTimeDeps struct {
	// APIBaseURL is the WakaTime API base (MIB_WAKATIME_API_URL); endpoints
	// hang off APIBaseURL + "/api/v1".
	APIBaseURL string
	Sealer     crypto.Sealer
}

// NewWakaTime loads the optional fixture fallback (dev only; empty path
// means none) and wires the live REST client.
func NewWakaTime(fixturePath string, deps WakaTimeDeps) (*WakaTime, error) {
	fix, err := loadFixture(fixturePath, "wakatime")
	if err != nil {
		return nil, err
	}
	return &WakaTime{
		fixture:    fix,
		apiBaseURL: deps.APIBaseURL,
		sealer:     deps.Sealer,
		http:       &http.Client{Timeout: 15 * time.Second},
	}, nil
}

// Name implements Connector.
func (w *WakaTime) Name() string { return "wakatime" }

// SnapshotTTL implements Connector (manifest value).
func (w *WakaTime) SnapshotTTL() time.Duration { return 30 * time.Minute }

// Fetch implements Connector. Errors on the configured path surface to the
// SnapshotCache, whose stale-while-revalidate semantics keep serving the
// previous snapshot (a revoked API key degrades a card to stale, never to a
// failed render).
func (w *WakaTime) Fetch(ctx context.Context, account *store.ConnectorAccount) (map[string]any, error) {
	if account == nil || len(account.EncryptedCredentials) == 0 {
		if w.fixture != nil {
			return w.fixture, nil
		}
		return map[string]any{}, nil // production unconfigured: em-dash semantics
	}
	var cfg WakaTimeConfig
	if err := openAccountConfig(w.sealer, "wakatime", account, &cfg); err != nil {
		return nil, err
	}
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("connector: wakatime: stored config invalid: %w", err)
	}

	stats, err := w.fetchStats(ctx, cfg.APIKey)
	if err != nil {
		return nil, err
	}
	days, err := w.fetchSummaries(ctx, cfg.APIKey)
	if err != nil {
		return nil, err
	}
	return buildWakaTimeSnapshot(stats, days), nil
}

// wkStats mirrors the stats/last_7_days response subset the snapshot needs.
type wkStats struct {
	TotalSeconds float64 `json:"total_seconds"`
	DailyAverage float64 `json:"daily_average"` // seconds
	Languages    []struct {
		Name    string  `json:"name"`
		Percent float64 `json:"percent"`
	} `json:"languages"`
}

// wkDay is one summaries entry reduced to what the days series needs.
type wkDay struct {
	Date    string
	Seconds float64
}

// get performs one authenticated WakaTime API GET. WakaTime uses HTTP Basic
// with the API key as username and an empty password.
func (w *WakaTime) get(ctx context.Context, apiKey, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, w.apiBaseURL+path, nil)
	if err != nil {
		return fmt.Errorf("connector: wakatime: building request: %w", err)
	}
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(apiKey+":")))

	resp, err := w.http.Do(req)
	if err != nil {
		return fmt.Errorf("connector: wakatime: %s: %w", path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return fmt.Errorf("connector: wakatime: %s responded %d (invalid or revoked API key)", path, resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("connector: wakatime: %s responded %d", path, resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(out); err != nil {
		return fmt.Errorf("connector: wakatime: decoding %s response: %w", path, err)
	}
	return nil
}

func (w *WakaTime) fetchStats(ctx context.Context, apiKey string) (wkStats, error) {
	var parsed struct {
		Data wkStats `json:"data"`
	}
	err := w.get(ctx, apiKey, "/api/v1/users/current/stats/last_7_days", &parsed)
	return parsed.Data, err
}

func (w *WakaTime) fetchSummaries(ctx context.Context, apiKey string) ([]wkDay, error) {
	var parsed struct {
		Data []struct {
			Range struct {
				Date string `json:"date"`
			} `json:"range"`
			GrandTotal struct {
				TotalSeconds float64 `json:"total_seconds"`
			} `json:"grand_total"`
		} `json:"data"`
	}
	if err := w.get(ctx, apiKey, "/api/v1/users/current/summaries?range=last_7_days", &parsed); err != nil {
		return nil, err
	}
	days := make([]wkDay, len(parsed.Data))
	for i, d := range parsed.Data {
		days[i] = wkDay{Date: d.Range.Date, Seconds: d.GrandTotal.TotalSeconds}
	}
	return days, nil
}

// round1 rounds to one decimal place — the snapshot precision of hour and
// percent figures (deterministic for a given upstream response).
func round1(v float64) float64 { return math.Round(v*10) / 10 }

// buildWakaTimeSnapshot maps the two API responses onto the WakaTimeFields
// paths. Day order is exactly upstream order (WakaTime serves summaries
// oldest-first), keeping renders deterministic (architecture.md §3).
func buildWakaTimeSnapshot(stats wkStats, days []wkDay) map[string]any {
	langs := stats.Languages
	if len(langs) > 5 {
		langs = langs[:5]
	}
	topLanguage := ""
	topLanguages := make([]any, len(langs))
	for i, l := range langs {
		topLanguages[i] = map[string]any{"name": l.Name, "percent": round1(l.Percent)}
	}
	if len(langs) > 0 {
		topLanguage = langs[0].Name
	}

	series := make([]any, len(days))
	for i, d := range days {
		series[i] = map[string]any{"date": d.Date, "minutes": int(math.Round(d.Seconds / 60))}
	}

	return map[string]any{
		"stats": map[string]any{
			"weeklyHours":     round1(stats.TotalSeconds / 3600),
			"dailyAvgMinutes": int(math.Round(stats.DailyAverage / 60)),
			"topLanguage":     topLanguage,
			"topLanguages":    topLanguages,
			"days":            series,
		},
	}
}

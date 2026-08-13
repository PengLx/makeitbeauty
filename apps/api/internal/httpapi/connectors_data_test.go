package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"reflect"
	"testing"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/config"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/connector"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// stubConnector is a configurable fake for GET /v1/connectors/data tests:
// a fixed snapshot or a fixed fetch error. Fetch tolerates a nil account —
// the no-credential path every connector must support (dev fixture).
type stubConnector struct {
	name string
	data map[string]any
	err  error
}

func (c stubConnector) Name() string               { return c.name }
func (c stubConnector) SnapshotTTL() time.Duration { return time.Minute }
func (c stubConnector) Fetch(context.Context, *store.ConnectorAccount) (map[string]any, error) {
	return c.data, c.err
}

func TestConnectorData(t *testing.T) {
	githubSnapshot := map[string]any{
		"user": map[string]any{"login": "dev", "followers": float64(42)},
		// A field no binding would ever reference: its presence proves the
		// response is the UNFILTERED snapshot (self-view, not the publish
		// boundary — see handleConnectorData).
		"stats": map[string]any{"totalStars": float64(7)},
	}

	tests := []struct {
		name       string
		env        string // "dev" (implicit user) or "test" (no session)
		connectors []connector.Connector
		wantStatus int
		// wantBody is compared against the decoded JSON response ({} when
		// every connector is omitted). Ignored for error statuses.
		wantBody map[string]any
	}{
		{
			name:       "merged unfiltered snapshots for every registered connector",
			env:        "dev",
			connectors: []connector.Connector{stubConnector{name: "github", data: githubSnapshot}},
			wantStatus: http.StatusOK,
			wantBody:   map[string]any{"github": githubSnapshot},
		},
		{
			name: "multiple connectors merge under their own keys",
			env:  "dev",
			connectors: []connector.Connector{
				stubConnector{name: "github", data: githubSnapshot},
				stubConnector{name: "wakatime", data: map[string]any{"hours": float64(12)}},
			},
			wantStatus: http.StatusOK,
			wantBody: map[string]any{
				"github":   githubSnapshot,
				"wakatime": map[string]any{"hours": float64(12)},
			},
		},
		{
			name: "failing connector is omitted, not fatal",
			env:  "dev",
			connectors: []connector.Connector{
				stubConnector{name: "github", data: githubSnapshot},
				stubConnector{name: "broken", err: errors.New("upstream down")},
			},
			wantStatus: http.StatusOK,
			wantBody:   map[string]any{"github": githubSnapshot},
		},
		{
			name:       "every connector failing still responds with an empty object",
			env:        "dev",
			connectors: []connector.Connector{stubConnector{name: "broken", err: errors.New("upstream down")}},
			wantStatus: http.StatusOK,
			wantBody:   map[string]any{},
		},
		{
			name:       "no session outside dev is a 401 envelope",
			env:        "test",
			connectors: []connector.Connector{stubConnector{name: "github", data: githubSnapshot}},
			wantStatus: http.StatusUnauthorized,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			log := slog.New(slog.DiscardHandler)
			registry := connector.NewRegistry()
			for _, c := range tt.connectors {
				registry.Register(c)
			}
			s := &Server{
				cfg:    config.Config{Env: tt.env},
				log:    log,
				stores: store.NewMemory(), // no ConnectorAccounts: the nil-account (dev fixture) path, like render
				cache:  connector.NewSnapshotCache(registry, log),
			}
			h := s.Handler()

			rec := doJSON(t, h, http.MethodGet, "/v1/connectors/data", "")
			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d, body = %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if tt.wantStatus != http.StatusOK {
				if code := errorCode(t, rec); code != "unauthenticated" {
					t.Errorf("error code = %q, want %q", code, "unauthenticated")
				}
				return
			}

			var body map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("body is not a JSON object: %s", rec.Body.String())
			}
			if !reflect.DeepEqual(body, tt.wantBody) {
				t.Errorf("body = %#v, want %#v", body, tt.wantBody)
			}
		})
	}
}

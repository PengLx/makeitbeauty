package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/config"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/connector"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/crypto"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// newAccountsServer wires a dev server (implicit "dev" user) whose registry
// knows all four shipped connectors, with the given sealer and stores.
func newAccountsServer(t *testing.T, sealer crypto.Sealer, stores store.Stores) (*Server, http.Handler) {
	t.Helper()
	log := slog.New(slog.DiscardHandler)
	registry := connector.NewRegistry()
	for _, name := range []string{"github", "wakatime", "leetcode", "rss"} {
		registry.Register(stubConnector{name: name, data: map[string]any{}})
	}
	s := &Server{
		cfg:    config.Config{Env: "dev"},
		log:    log,
		stores: stores,
		sealer: sealer,
		cache:  connector.NewSnapshotCache(registry, log),
	}
	return s, s.Handler()
}

// getConnectors fetches and decodes GET /v1/connectors.
func getConnectors(t *testing.T, h http.Handler) []connectorView {
	t.Helper()
	rec := doJSON(t, h, http.MethodGet, "/v1/connectors", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /v1/connectors status = %d (body: %s)", rec.Code, rec.Body.String())
	}
	var out []connectorView
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func connectorStatus(t *testing.T, views []connectorView, name string) string {
	t.Helper()
	for _, v := range views {
		if v.Connector == name {
			return v.Status
		}
	}
	t.Fatalf("connector %q not listed in %+v", name, views)
	return ""
}

// PUT then DELETE walks the whole account lifecycle: unconfigured →
// connected (sealed at rest) → reconfigured → unconfigured again.
func TestConnectorAccountLifecycle(t *testing.T) {
	s, h := newAccountsServer(t, crypto.PlainSealer{}, store.NewMemory())
	ctx := context.Background()

	// Before: everything unconfigured.
	for _, v := range getConnectors(t, h) {
		if v.Status != "unconfigured" {
			t.Errorf("%s status = %q before setup, want unconfigured", v.Connector, v.Status)
		}
	}

	// Connect.
	rec := doJSON(t, h, http.MethodPut, "/v1/connectors/wakatime/account", `{"apiKey": "wk_secret_1"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d (body: %s)", rec.Code, rec.Body.String())
	}
	var view connectorStatusView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	if view.Connector != "wakatime" || view.Status != "connected" {
		t.Errorf("PUT response = %+v, want wakatime/connected", view)
	}

	// Stored sealed, decodable back to the config.
	account, err := s.stores.ConnectorAccounts.GetByUserConnector(ctx, "dev", "wakatime")
	if err != nil {
		t.Fatal(err)
	}
	if account.Status != "active" || len(account.EncryptedCredentials) == 0 {
		t.Fatalf("stored account = %+v, want active with sealed config", account)
	}
	raw, err := crypto.PlainSealer{}.Open(account.EncryptedCredentials)
	if err != nil {
		t.Fatalf("stored config is not sealed by the wired sealer: %v", err)
	}
	var cfg connector.WakaTimeConfig
	if err := json.Unmarshal(raw, &cfg); err != nil || cfg.APIKey != "wk_secret_1" {
		t.Errorf("unsealed config = %+v (%v), want the stored apiKey", cfg, err)
	}

	if got := connectorStatus(t, getConnectors(t, h), "wakatime"); got != "connected" {
		t.Errorf("status after PUT = %q, want connected", got)
	}

	// Reconfigure: upsert, not duplicate.
	rec = doJSON(t, h, http.MethodPut, "/v1/connectors/wakatime/account", `{"apiKey": "wk_secret_2"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("second PUT status = %d", rec.Code)
	}
	account, err = s.stores.ConnectorAccounts.GetByUserConnector(ctx, "dev", "wakatime")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ = crypto.PlainSealer{}.Open(account.EncryptedCredentials)
	if err := json.Unmarshal(raw, &cfg); err != nil || cfg.APIKey != "wk_secret_2" {
		t.Errorf("reconfigured config = %+v (%v), want the new apiKey", cfg, err)
	}

	// Disconnect.
	rec = doJSON(t, h, http.MethodDelete, "/v1/connectors/wakatime/account", "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE status = %d (body: %s)", rec.Code, rec.Body.String())
	}
	if _, err := s.stores.ConnectorAccounts.GetByUserConnector(ctx, "dev", "wakatime"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("account after DELETE: err = %v, want ErrNotFound", err)
	}
	if got := connectorStatus(t, getConnectors(t, h), "wakatime"); got != "unconfigured" {
		t.Errorf("status after DELETE = %q, want unconfigured", got)
	}

	// Idempotent disconnect.
	if rec := doJSON(t, h, http.MethodDelete, "/v1/connectors/wakatime/account", ""); rec.Code != http.StatusNoContent {
		t.Errorf("second DELETE status = %d, want 204", rec.Code)
	}
}

// stubFeedDNS pins the rss connect-time DNS hook so hostname cases stay
// hermetic (no dependency on the sandbox's resolver); resolve maps host →
// address, anything absent resolves to a public documentation address.
func stubFeedDNS(t *testing.T, resolve map[string]string) {
	t.Helper()
	prev := connector.LookupFeedHostIPs
	connector.LookupFeedHostIPs = func(_ context.Context, host string) ([]net.IP, error) {
		if addr, ok := resolve[host]; ok {
			return []net.IP{net.ParseIP(addr)}, nil
		}
		return []net.IP{net.ParseIP("203.0.113.9")}, nil
	}
	t.Cleanup(func() { connector.LookupFeedHostIPs = prev })
}

func TestConnectorAccountValidation(t *testing.T) {
	_, h := newAccountsServer(t, crypto.PlainSealer{}, store.NewMemory())
	stubFeedDNS(t, nil)

	tests := []struct {
		name string
		path string
		body string
		want int
	}{
		{"wakatime empty key", "/v1/connectors/wakatime/account", `{"apiKey": ""}`, http.StatusBadRequest},
		{"wakatime blank key", "/v1/connectors/wakatime/account", `{"apiKey": "   "}`, http.StatusBadRequest},
		{"wakatime unknown field", "/v1/connectors/wakatime/account", `{"apiKey": "x", "extra": true}`, http.StatusBadRequest},
		{"wakatime not json", "/v1/connectors/wakatime/account", `not json`, http.StatusBadRequest},
		{"wakatime valid", "/v1/connectors/wakatime/account", `{"apiKey": "waka_abc"}`, http.StatusOK},
		{"leetcode empty username", "/v1/connectors/leetcode/account", `{"username": ""}`, http.StatusBadRequest},
		{"leetcode space in username", "/v1/connectors/leetcode/account", `{"username": "bad name"}`, http.StatusBadRequest},
		{"leetcode overlong username", "/v1/connectors/leetcode/account", `{"username": "` + strings.Repeat("a", 41) + `"}`, http.StatusBadRequest},
		{"leetcode valid", "/v1/connectors/leetcode/account", `{"username": "Ada_Lovelace-42"}`, http.StatusOK},
		{"rss http url", "/v1/connectors/rss/account", `{"feedUrl": "http://blog.example.com/rss.xml"}`, http.StatusBadRequest},
		{"rss relative url", "/v1/connectors/rss/account", `{"feedUrl": "/rss.xml"}`, http.StatusBadRequest},
		{"rss garbage url", "/v1/connectors/rss/account", `{"feedUrl": "::not a url::"}`, http.StatusBadRequest},
		{"rss valid", "/v1/connectors/rss/account", `{"feedUrl": "https://blog.example.com/rss.xml"}`, http.StatusOK},
		{"rss loopback ip", "/v1/connectors/rss/account", `{"feedUrl": "https://127.0.0.1/feed.xml"}`, http.StatusBadRequest},
		{"rss ipv6 loopback", "/v1/connectors/rss/account", `{"feedUrl": "https://[::1]/feed.xml"}`, http.StatusBadRequest},
		{"rss metadata ip", "/v1/connectors/rss/account", `{"feedUrl": "https://169.254.169.254/latest/meta-data/"}`, http.StatusBadRequest},
		{"rss private ip", "/v1/connectors/rss/account", `{"feedUrl": "https://192.168.1.1/feed.xml"}`, http.StatusBadRequest},
		{"unknown connector", "/v1/connectors/spotify/account", `{"clientId": "x"}`, http.StatusNotFound},
		{"github is oauth, not config", "/v1/connectors/github/account", `{"apiKey": "x"}`, http.StatusBadRequest},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := doJSON(t, h, http.MethodPut, tt.path, tt.body)
			if rec.Code != tt.want {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, tt.want, rec.Body.String())
			}
			if tt.want != http.StatusOK {
				code := errorCode(t, rec)
				if code != "invalid_request" && code != "not_found" {
					t.Errorf("error code = %q", code)
				}
			}
		})
	}

	// DELETE mirrors the connector gate.
	if rec := doJSON(t, h, http.MethodDelete, "/v1/connectors/spotify/account", ""); rec.Code != http.StatusNotFound {
		t.Errorf("DELETE unknown connector status = %d, want 404", rec.Code)
	}
	if rec := doJSON(t, h, http.MethodDelete, "/v1/connectors/github/account", ""); rec.Code != http.StatusBadRequest {
		t.Errorf("DELETE github status = %d, want 400 (login-provisioned)", rec.Code)
	}
}

// The at-rest guarantee, greppable: with a real AES sealer over the file
// store, no store file may contain the plaintext API key (or any other
// config value).
func TestConnectorAccountConfigSealedAtRest(t *testing.T) {
	dir := t.TempDir()
	stores, err := store.NewFile(dir)
	if err != nil {
		t.Fatal(err)
	}
	var key [32]byte
	if _, err := rand.Read(key[:]); err != nil {
		t.Fatal(err)
	}
	sealer, err := crypto.NewAESSealer(base64.StdEncoding.EncodeToString(key[:]))
	if err != nil {
		t.Fatal(err)
	}
	_, h := newAccountsServer(t, sealer, stores)

	needles := map[string]string{
		"/v1/connectors/wakatime/account": `{"apiKey": "wk_plaintext_needle"}`,
		"/v1/connectors/leetcode/account": `{"username": "needle_username"}`,
		"/v1/connectors/rss/account":      `{"feedUrl": "https://needle.example.com/rss.xml"}`,
	}
	for path, body := range needles {
		if rec := doJSON(t, h, http.MethodPut, path, body); rec.Code != http.StatusOK {
			t.Fatalf("PUT %s status = %d (body: %s)", path, rec.Code, rec.Body.String())
		}
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) == 0 {
		t.Fatal("file store wrote nothing")
	}
	for _, entry := range entries {
		b, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		for _, needle := range []string{"wk_plaintext_needle", "needle_username", "needle.example.com"} {
			if bytes.Contains(b, []byte(needle)) {
				t.Errorf("store file %s contains plaintext config %q", entry.Name(), needle)
			}
		}
	}
}

// The catalog/status matrix: all registered connectors are listed sorted,
// each with its own typed field catalog, and status tracks account state
// per connector independently.
func TestConnectorsCatalogAndStatusMatrix(t *testing.T) {
	s, h := newAccountsServer(t, crypto.PlainSealer{}, store.NewMemory())
	ctx := context.Background()

	// leetcode connected via the route; wakatime expired directly in the
	// store (an upstream refresh flagged it); github + rss untouched.
	if rec := doJSON(t, h, http.MethodPut, "/v1/connectors/leetcode/account", `{"username": "ada"}`); rec.Code != http.StatusOK {
		t.Fatalf("PUT leetcode status = %d", rec.Code)
	}
	if err := s.stores.ConnectorAccounts.Create(ctx, &store.ConnectorAccount{
		ID: "acct-wk", UserID: "dev", Connector: "wakatime",
		EncryptedCredentials: []byte("sealed"), Status: "expired",
	}); err != nil {
		t.Fatal(err)
	}

	out := getConnectors(t, h)
	if len(out) != 4 {
		t.Fatalf("connectors listed = %d, want 4 (%+v)", len(out), out)
	}
	wantOrder := []string{"github", "leetcode", "rss", "wakatime"}
	for i, name := range wantOrder {
		if out[i].Connector != name {
			t.Fatalf("connectors[%d] = %q, want %q (sorted)", i, out[i].Connector, name)
		}
	}
	wantStatus := map[string]string{
		"github":   "unconfigured",
		"leetcode": "connected",
		"rss":      "unconfigured",
		"wakatime": "expired",
	}
	wantFieldCount := map[string]int{
		"github":   len(connector.GitHubFields),
		"leetcode": len(connector.LeetCodeFields),
		"rss":      len(connector.RSSFields),
		"wakatime": len(connector.WakaTimeFields),
	}
	for _, v := range out {
		if v.Status != wantStatus[v.Connector] {
			t.Errorf("%s status = %q, want %q", v.Connector, v.Status, wantStatus[v.Connector])
		}
		if len(v.Fields) != wantFieldCount[v.Connector] {
			t.Errorf("%s fields = %d entries, want %d", v.Connector, len(v.Fields), wantFieldCount[v.Connector])
		}
		for _, f := range v.Fields {
			if f.Type != "string" && f.Type != "number" && f.Type != "series" {
				t.Errorf("%s field %q has unknown type %q", v.Connector, f.Path, f.Type)
			}
		}
	}

	// Spot-check the typed catalogs the pickers rely on.
	fieldType := func(views []connectorView, conn, path string) string {
		for _, v := range views {
			if v.Connector != conn {
				continue
			}
			for _, f := range v.Fields {
				if f.Path == path {
					return f.Type
				}
			}
		}
		return ""
	}
	for _, tt := range []struct{ conn, path, typ string }{
		{"wakatime", "stats.weeklyHours", "number"},
		{"wakatime", "stats.days", "series"},
		{"leetcode", "solved.total", "number"},
		{"rss", "feed.title", "string"},
		{"rss", "posts", "series"},
	} {
		if got := fieldType(out, tt.conn, tt.path); got != tt.typ {
			t.Errorf("%s %s type = %q, want %q", tt.conn, tt.path, got, tt.typ)
		}
	}

	// /v1/me mirrors the same statuses.
	rec := doJSON(t, h, http.MethodGet, "/v1/me", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("/v1/me status = %d", rec.Code)
	}
	var me struct {
		Connectors []connectorStatusView `json:"connectors"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &me); err != nil {
		t.Fatal(err)
	}
	if len(me.Connectors) != 4 {
		t.Fatalf("/v1/me connectors = %d, want 4", len(me.Connectors))
	}
	for _, v := range me.Connectors {
		if v.Status != wantStatus[v.Connector] {
			t.Errorf("/v1/me %s status = %q, want %q", v.Connector, v.Status, wantStatus[v.Connector])
		}
	}
}

// Outside dev without a session, the account routes are locked like every
// session route.
func TestConnectorAccountRequiresSession(t *testing.T) {
	log := slog.New(slog.DiscardHandler)
	registry := connector.NewRegistry()
	registry.Register(stubConnector{name: "wakatime", data: map[string]any{}})
	s := &Server{
		cfg:    config.Config{Env: "test"},
		log:    log,
		stores: store.NewMemory(),
		sealer: crypto.PlainSealer{},
		cache:  connector.NewSnapshotCache(registry, log),
	}
	h := s.Handler()

	if rec := doJSON(t, h, http.MethodPut, "/v1/connectors/wakatime/account", `{"apiKey": "x"}`); rec.Code != http.StatusUnauthorized {
		t.Errorf("PUT without session status = %d, want 401", rec.Code)
	}
	if rec := doJSON(t, h, http.MethodDelete, "/v1/connectors/wakatime/account", ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("DELETE without session status = %d, want 401", rec.Code)
	}
}

// The SSRF connect-time pre-check, through the real route: every crafted URL
// is refused with a polite 400 and NOTHING is stored — including a hostname
// that (per stubbed DNS) resolves to loopback.
func TestRSSAccountSSRFHostsRefusedAndNeverStored(t *testing.T) {
	s, h := newAccountsServer(t, crypto.PlainSealer{}, store.NewMemory())
	stubFeedDNS(t, map[string]string{"localtest.me": "127.0.0.1"})
	ctx := context.Background()

	for _, feedURL := range []string{
		"http://blog.example.com/rss.xml", // scheme, not host
		"https://127.0.0.1/feed.xml",
		"https://[::1]/feed.xml",
		"https://169.254.169.254/latest/meta-data/",
		"https://192.168.1.1/feed.xml",
		"https://10.0.0.7/feed.xml",
		"https://localtest.me/feed.xml", // hostname resolving to loopback
	} {
		body, _ := json.Marshal(map[string]string{"feedUrl": feedURL})
		rec := doJSON(t, h, http.MethodPut, "/v1/connectors/rss/account", string(body))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("PUT feedUrl %q status = %d, want 400 (body: %s)", feedURL, rec.Code, rec.Body.String())
		}
		if code := errorCode(t, rec); code != "invalid_request" {
			t.Errorf("PUT feedUrl %q error code = %q, want invalid_request", feedURL, code)
		}
		if _, err := s.stores.ConnectorAccounts.GetByUserConnector(ctx, "dev", "rss"); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("feedUrl %q: an rss account was stored (err = %v), refused configs must never be stored", feedURL, err)
		}
	}

	// The gate refuses precisely these; a public feed still connects.
	if rec := doJSON(t, h, http.MethodPut, "/v1/connectors/rss/account", `{"feedUrl": "https://blog.example.com/rss.xml"}`); rec.Code != http.StatusOK {
		t.Fatalf("valid PUT after refusals status = %d (body: %s)", rec.Code, rec.Body.String())
	}
}

// accountAwareConnector mirrors the config-tier connectors' fixture-vs-live
// split: what Fetch returns depends on whether an account exists.
type accountAwareConnector struct{ name string }

func (c accountAwareConnector) Name() string               { return c.name }
func (c accountAwareConnector) SnapshotTTL() time.Duration { return time.Hour }
func (c accountAwareConnector) Fetch(_ context.Context, account *store.ConnectorAccount) (map[string]any, error) {
	if account == nil || len(account.EncryptedCredentials) == 0 {
		return map[string]any{"src": "unconfigured"}, nil
	}
	return map[string]any{"src": "connected"}, nil
}

// Connecting or disconnecting an account must invalidate the user's cached
// snapshot: with an hour-long TTL, the next data read still reflects the new
// account state immediately.
func TestConnectorAccountChangeInvalidatesSnapshot(t *testing.T) {
	log := slog.New(slog.DiscardHandler)
	registry := connector.NewRegistry()
	registry.Register(accountAwareConnector{name: "wakatime"})
	s := &Server{
		cfg:    config.Config{Env: "dev"},
		log:    log,
		stores: store.NewMemory(),
		sealer: crypto.PlainSealer{},
		cache:  connector.NewSnapshotCache(registry, log),
	}
	h := s.Handler()

	src := func() string {
		t.Helper()
		rec := doJSON(t, h, http.MethodGet, "/v1/connectors/data", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("GET /v1/connectors/data status = %d", rec.Code)
		}
		var data map[string]map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &data); err != nil {
			t.Fatal(err)
		}
		got, _ := data["wakatime"]["src"].(string)
		return got
	}

	if got := src(); got != "unconfigured" {
		t.Fatalf("initial snapshot src = %q, want unconfigured", got)
	}
	if rec := doJSON(t, h, http.MethodPut, "/v1/connectors/wakatime/account", `{"apiKey": "wk_live"}`); rec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d", rec.Code)
	}
	if got := src(); got != "connected" {
		t.Fatalf("snapshot src after connect = %q, want connected (cache must be invalidated)", got)
	}
	if rec := doJSON(t, h, http.MethodDelete, "/v1/connectors/wakatime/account", ""); rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE status = %d", rec.Code)
	}
	if got := src(); got != "unconfigured" {
		t.Fatalf("snapshot src after disconnect = %q, want unconfigured (cache must be invalidated)", got)
	}
}

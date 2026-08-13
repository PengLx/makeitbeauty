package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/connector"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// Config-account routes (architecture.md §6, auth tiers none/api_key):
// non-OAuth connectors are configured by the session user pasting a small
// per-connector config object, sealed at rest in the same ConnectorAccount
// record OAuth credentials use. GitHub is explicitly not configurable here —
// login is its provisioning path.

// resolveConfigConnector maps {name} to its empty config value, writing the
// error envelope (and returning ok=false) for OAuth-tier and unknown names.
func resolveConfigConnector(w http.ResponseWriter, name string) (connector.AccountConfig, bool) {
	cfg, ok := connector.NewAccountConfig(name)
	if ok {
		return cfg, true
	}
	if name == "github" {
		writeError(w, http.StatusBadRequest, "invalid_request", "the github connector is provisioned by GitHub sign-in, not by config")
		return nil, false
	}
	writeError(w, http.StatusNotFound, "not_found", "no such configurable connector")
	return nil, false
}

// ---- PUT /v1/connectors/{name}/account -----------------------------------
// Body: the connector's config object (strict-decoded), e.g.
// {"apiKey": "..."} for wakatime. On success the config is sealed and the
// account upserted; the connector reports "connected".

func (s *Server) handlePutConnectorAccount(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	cfg, ok := resolveConfigConnector(w, name)
	if !ok {
		return
	}

	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(cfg); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", configDecodeErrorMessage(name, err))
		return
	}
	if err := cfg.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	// Connect-time deep validation (e.g. the rss feed-host SSRF pre-check):
	// a config that fails here is refused before anything is stored.
	if v, ok := cfg.(connector.ConnectValidator); ok {
		if err := v.ValidateConnect(r.Context()); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
			return
		}
	}

	raw, err := json.Marshal(cfg)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "encoding connector config failed")
		return
	}
	// Sealed at rest like every credential (architecture.md §9.1): the store
	// files must never contain a plaintext API key.
	sealed, err := s.sealer.Seal(raw)
	if err != nil {
		s.log.Error("sealing connector config failed", "connector", name, "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "sealing connector config failed")
		return
	}

	uid := userID(r)
	now := time.Now().UTC()
	account, err := s.stores.ConnectorAccounts.GetByUserConnector(r.Context(), uid, name)
	switch {
	case errors.Is(err, store.ErrNotFound):
		err = s.stores.ConnectorAccounts.Create(r.Context(), &store.ConnectorAccount{
			ID:                   newAccountID(),
			UserID:               uid,
			Connector:            name,
			EncryptedCredentials: sealed,
			Status:               "active",
			LastRefreshAt:        now,
		})
	case err == nil:
		account.EncryptedCredentials = sealed
		account.Status = "active"
		account.LastRefreshAt = now
		err = s.stores.ConnectorAccounts.Update(r.Context(), account)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "storing the connector account failed")
		return
	}
	// The account changed, so the cached snapshot (fetched under the old
	// account, or the unconfigured fixture/empty state) is no longer what
	// this user's renders should serve.
	s.invalidateSnapshot(uid, name)
	writeJSON(w, http.StatusOK, connectorStatusView{Connector: name, Status: "connected"})
}

// ---- DELETE /v1/connectors/{name}/account ---------------------------------
// Disconnect: the account (and its sealed config) is removed and the
// connector reverts to "unconfigured". Idempotent — disconnecting an
// unconfigured connector is a no-op 204.

func (s *Server) handleDeleteConnectorAccount(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if _, ok := resolveConfigConnector(w, name); !ok {
		return
	}
	err := s.stores.ConnectorAccounts.Delete(r.Context(), userID(r), name)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusInternalServerError, "internal", "removing the connector account failed")
		return
	}
	// Drop the connected snapshot immediately: after a disconnect the next
	// render must serve the unconfigured state (fixture in dev, em-dashes in
	// production), not up to a TTL of the old account's data.
	s.invalidateSnapshot(userID(r), name)
	w.WriteHeader(http.StatusNoContent)
}

// invalidateSnapshot drops the user's cached connector snapshot after an
// account change so the next render/preview refetches under the new account
// state. Nil-safe: some tests wire no cache.
func (s *Server) invalidateSnapshot(userID, connectorName string) {
	if s.cache != nil {
		s.cache.Invalidate(userID, connectorName)
	}
}

// configDecodeErrorMessage mirrors decodeErrorMessage for the per-connector
// config shapes, naming the connector's allowed fields.
func configDecodeErrorMessage(name string, err error) string {
	allowed := map[string]string{
		"wakatime": "apiKey",
		"leetcode": "username",
		"rss":      "feedUrl",
	}[name]
	if rest, ok := strings.CutPrefix(err.Error(), "json: unknown field "); ok {
		return fmt.Sprintf("unknown field %s — allowed fields: %s", rest, allowed)
	}
	return fmt.Sprintf("body must be JSON: {%s}", allowed)
}

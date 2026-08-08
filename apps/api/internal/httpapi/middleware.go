package httpapi

import (
	"context"
	"crypto/subtle"
	"errors"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// ---- request logging ---------------------------------------------------

// statusRecorder captures the response status for the access log.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

// logRequests emits one structured line per request.
func logRequests(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		log.Info("http",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"dur", time.Since(start).Round(time.Microsecond).String(),
		)
	})
}

// ---- panic recovery ----------------------------------------------------

// recoverPanics turns handler panics into a 500 envelope instead of a
// dropped connection.
func recoverPanics(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				log.Error("panic", "path", r.URL.Path, "value", v, "stack", string(debug.Stack()))
				// Best effort: if the handler already wrote a status this
				// header write is a no-op warning, not a crash.
				writeError(w, http.StatusInternalServerError, "internal", "internal server error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// ---- CORS (dev only) ---------------------------------------------------

// devCORSOrigin is the Vite dev server of apps/web. Production traffic is
// same-site behind the BFF; permissive CORS exists only in dev.
const devCORSOrigin = "http://localhost:5173"

func corsDev(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") == devCORSOrigin {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", devCORSOrigin)
			h.Add("Vary", "Origin")
			h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			h.Set("Access-Control-Max-Age", "600")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// ---- deploy-token auth -------------------------------------------------

var (
	// errNoToken: the Authorization header is missing or not a Bearer token.
	errNoToken = errors.New("httpapi: missing bearer token")
	// errBadToken: a token was presented but matches no active deploy token
	// of the project (wrong, revoked, or cross-project).
	errBadToken = errors.New("httpapi: invalid deploy token")
)

// authenticateDeployToken checks a raw Authorization header value against the
// project's deploy tokens. The presented token is hashed (SHA-256) and
// compared against stored hashes with crypto/subtle so the comparison is
// constant-time and length-independent. All tokens are scanned without early
// exit so a match's position is not observable either.
func authenticateDeployToken(ctx context.Context, tokens store.DeployTokens, projectID, authorization string) error {
	const prefix = "Bearer "
	if len(authorization) <= len(prefix) || !strings.EqualFold(authorization[:len(prefix)], prefix) {
		return errNoToken
	}
	presented := store.HashToken(strings.TrimSpace(authorization[len(prefix):]))

	list, err := tokens.ListByProject(ctx, projectID)
	if err != nil {
		return err
	}
	ok := false
	for _, t := range list {
		match := subtle.ConstantTimeCompare(presented[:], t.Hash[:]) == 1
		if match && t.RevokedAt == nil {
			ok = true
		}
	}
	if !ok {
		return errBadToken // covers unknown projects too: no existence leak
	}
	return nil
}

// requireDeployToken guards a `/v1/projects/{id}/...` handler with
// deploy-token auth.
func (s *Server) requireDeployToken(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		err := authenticateDeployToken(r.Context(), s.stores.DeployTokens, r.PathValue("id"), r.Header.Get("Authorization"))
		switch {
		case err == nil:
			next(w, r)
		case errors.Is(err, errNoToken):
			w.Header().Set("WWW-Authenticate", `Bearer realm="makeitbeauty"`)
			writeError(w, http.StatusUnauthorized, "unauthenticated", "missing or malformed Authorization: Bearer header")
		case errors.Is(err, errBadToken):
			writeError(w, http.StatusUnauthorized, "invalid_token", "unknown, revoked, or wrong-project deploy token")
		default:
			writeError(w, http.StatusInternalServerError, "internal", "token lookup failed")
		}
	}
}

// ---- session stub ------------------------------------------------------

// devUserID is the single implicit user of the dev environment. Real session
// auth (GitHub App sign-in + session cookie via the BFF) replaces this.
const devUserID = "dev"

type ctxKey int

const ctxKeyUserID ctxKey = iota

// requireSession injects the authenticated user into the request context.
// Dev: everyone is the implicit dev user. Non-dev: sessions are not
// implemented in the scaffold, so requests are rejected.
func (s *Server) requireSession(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.cfg.Dev() {
			writeError(w, http.StatusUnauthorized, "unauthenticated", "session auth is not available in this build")
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), ctxKeyUserID, devUserID)))
	}
}

// userID returns the session user injected by requireSession.
func userID(r *http.Request) string {
	id, _ := r.Context().Value(ctxKeyUserID).(string)
	return id
}

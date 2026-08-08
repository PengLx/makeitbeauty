package httpapi

import (
	"encoding/json"
	"net/http"
)

// errorEnvelope is the wire shape of every API error:
// {"error":{"code":"...","message":"..."}} (architecture.md §8).
type errorEnvelope struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// writeError writes the JSON error envelope with the given status.
func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorEnvelope{Error: errorBody{Code: code, Message: message}})
}

// writeJSON writes v as a JSON response body.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	// Encoding failures past this point cannot change the status; ignore them.
	_ = json.NewEncoder(w).Encode(v)
}

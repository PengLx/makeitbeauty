// Package render is the HTTP client for the internal renderer service
// (apps/renderer, POST /internal/render, packages/schema/render.schema.json).
package render

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Error is a render failure already mapped to the status/code/message the
// public API should respond with. Render failures MUST be non-200 so the
// GitHub Action fails soft (architecture.md §8).
type Error struct {
	Status  int    // HTTP status for the public API response
	Code    string // machine-readable error code
	Message string
}

func (e *Error) Error() string {
	return fmt.Sprintf("render: %s: %s", e.Code, e.Message)
}

// Result is a successful render.
type Result struct {
	SVG      string
	Warnings []string
}

// Client calls the renderer. The renderer is internal-only; this client is the
// single place the API talks to it.
type Client struct {
	baseURL string
	http    *http.Client
}

// NewClient returns a client for the renderer at baseURL (no trailing slash
// required). The timeout bounds the whole request including body read.
func NewClient(baseURL string, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	return &Client{baseURL: baseURL, http: &http.Client{Timeout: timeout}}
}

// request/response wire shapes per render.schema.json.
type renderRequest struct {
	Design  json.RawMessage `json:"design"`
	Data    map[string]any  `json:"data"`
	Options *renderOptions  `json:"options,omitempty"`
	// Components carries the community component definitions the design
	// references (kit-component documents with fully-qualified pinned ids,
	// e.g. "penglx/glow-card@3"), resolved by the API — the registry stays
	// out of the renderer (architecture.md §7.5).
	Components []json.RawMessage `json:"components,omitempty"`
}

type renderOptions struct {
	Theme string `json:"theme,omitempty"`
}

type renderResponse struct {
	SVG      string   `json:"svg"`
	Warnings []string `json:"warnings"`
	Error    *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// Render posts (design, data, theme, components) and returns the SVG. data is
// the merged, already-filtered snapshot map keyed by connector name;
// components are the pinned community component definitions the design
// references (nil when it references none). All failures are returned as
// *Error with a public-API-appropriate status:
// renderer 4xx (bad design) → 422, renderer 5xx / unreachable → 502.
func (c *Client) Render(ctx context.Context, design json.RawMessage, data map[string]any, theme string, components []json.RawMessage) (*Result, error) {
	if data == nil {
		data = map[string]any{} // schema requires the field
	}
	var opts *renderOptions
	if theme != "" && theme != "auto" {
		opts = &renderOptions{Theme: theme}
	}
	body, err := json.Marshal(renderRequest{Design: design, Data: data, Options: opts, Components: components})
	if err != nil {
		return nil, &Error{Status: http.StatusInternalServerError, Code: "internal", Message: "encoding render request failed"}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/internal/render", bytes.NewReader(body))
	if err != nil {
		return nil, &Error{Status: http.StatusInternalServerError, Code: "internal", Message: "building render request failed"}
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &Error{Status: http.StatusBadGateway, Code: "renderer_unavailable", Message: "renderer is unreachable"}
	}
	defer resp.Body.Close()

	// Renders are bounded by the Camo ~5MB cap; 8MB is a generous safety net.
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, &Error{Status: http.StatusBadGateway, Code: "renderer_unavailable", Message: "reading renderer response failed"}
	}

	var parsed renderResponse
	// Tolerate an unparseable body on error statuses; require it on 200.
	parseErr := json.Unmarshal(raw, &parsed)

	if resp.StatusCode != http.StatusOK {
		status := http.StatusBadGateway
		code := "render_failed"
		message := fmt.Sprintf("renderer responded %d", resp.StatusCode)
		if resp.StatusCode >= 400 && resp.StatusCode < 500 {
			status = http.StatusUnprocessableEntity
		}
		if parseErr == nil && parsed.Error != nil {
			code, message = parsed.Error.Code, parsed.Error.Message
		}
		return nil, &Error{Status: status, Code: code, Message: message}
	}

	if parseErr != nil || parsed.SVG == "" {
		return nil, &Error{Status: http.StatusBadGateway, Code: "renderer_unavailable", Message: "renderer returned a malformed response"}
	}
	return &Result{SVG: parsed.SVG, Warnings: parsed.Warnings}, nil
}

// ValidateComponent posts a kit-component document to the renderer's
// publish-time validator (POST /internal/validate-component, body
// {"definition": <document>} — same ajv + semantic checks as the kit loader,
// architecture.md §7.5). nil means the definition passed. A renderer 4xx is
// the component failing validation: its error envelope comes back as
// *Error{Status: 400} so the publish route can pass the renderer's message
// through verbatim. Renderer 5xx / unreachable map to 502 like Render.
func (c *Client) ValidateComponent(ctx context.Context, definition json.RawMessage) error {
	body, err := json.Marshal(map[string]json.RawMessage{"definition": definition})
	if err != nil {
		return &Error{Status: http.StatusInternalServerError, Code: "internal", Message: "encoding validate request failed"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/internal/validate-component", bytes.NewReader(body))
	if err != nil {
		return &Error{Status: http.StatusInternalServerError, Code: "internal", Message: "building validate request failed"}
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return &Error{Status: http.StatusBadGateway, Code: "renderer_unavailable", Message: "renderer is unreachable"}
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return &Error{Status: http.StatusBadGateway, Code: "renderer_unavailable", Message: "reading renderer response failed"}
	}
	if resp.StatusCode == http.StatusOK {
		return nil
	}

	var parsed struct {
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	parseErr := json.Unmarshal(raw, &parsed) // tolerate an unparseable body

	if resp.StatusCode >= 400 && resp.StatusCode < 500 {
		code, message := "invalid_component", fmt.Sprintf("component failed validation (renderer responded %d)", resp.StatusCode)
		if parseErr == nil && parsed.Error != nil {
			code, message = parsed.Error.Code, parsed.Error.Message
		}
		return &Error{Status: http.StatusBadRequest, Code: code, Message: message}
	}
	return &Error{Status: http.StatusBadGateway, Code: "renderer_unavailable", Message: fmt.Sprintf("renderer responded %d", resp.StatusCode)}
}

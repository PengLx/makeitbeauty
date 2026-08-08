package httpapi

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// Project write validation, mirroring packages/schema/project.schema.json.
// The design document itself is NOT validated here — the renderer owns
// design validation (architecture.md §5); the API only requires presence.

var (
	projectIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	connectorPattern = regexp.MustCompile(`^[a-z0-9-]+$`)
	fieldPattern     = regexp.MustCompile(`^[a-zA-Z0-9_.]+$`)
	filenamePattern  = regexp.MustCompile(`^[a-zA-Z0-9._-]+\.svg$`)
)

const nameMaxLength = 200 // project.schema.json: name.maxLength

func validateName(name string) error {
	if name == "" {
		return errors.New("name is required")
	}
	if len(name) > nameMaxLength {
		return fmt.Errorf("name must be at most %d characters", nameMaxLength)
	}
	return nil
}

func validateBindings(bindings []store.Binding) error {
	for i, b := range bindings {
		if !connectorPattern.MatchString(b.Connector) {
			return fmt.Errorf("bindings[%d].connector must match ^[a-z0-9-]+$", i)
		}
		if len(b.Fields) == 0 {
			return fmt.Errorf("bindings[%d].fields needs at least one field", i)
		}
		for j, f := range b.Fields {
			if !fieldPattern.MatchString(f) {
				return fmt.Errorf("bindings[%d].fields[%d] must match ^[a-zA-Z0-9_.]+$", i, j)
			}
		}
	}
	return nil
}

func validateOutputs(outputs []store.Output) error {
	if len(outputs) == 0 {
		return errors.New("outputs needs at least one entry")
	}
	seen := map[string]bool{}
	for i, o := range outputs {
		if !projectIDPattern.MatchString(o.ID) {
			return fmt.Errorf("outputs[%d].id must match ^[a-z0-9][a-z0-9-]{0,63}$", i)
		}
		if seen[o.ID] {
			return fmt.Errorf("outputs[%d].id %q is duplicated", i, o.ID)
		}
		seen[o.ID] = true
		switch o.Theme {
		case "", "auto", "light", "dark":
		default:
			return fmt.Errorf("outputs[%d].theme must be auto, light, or dark", i)
		}
		if o.Format != "" && o.Format != "svg" {
			return fmt.Errorf("outputs[%d].format must be svg", i)
		}
		if !filenamePattern.MatchString(o.Filename) {
			return fmt.Errorf(`outputs[%d].filename must match ^[a-zA-Z0-9._-]+\.svg$`, i)
		}
	}
	return nil
}

// decodeErrorMessage turns json.Decoder errors into a polite 400 message,
// naming unknown fields explicitly (strict decoding is part of the contract).
func decodeErrorMessage(err error) string {
	msg := err.Error()
	if rest, ok := strings.CutPrefix(msg, "json: unknown field "); ok {
		return fmt.Sprintf("unknown field %s — allowed fields: id, name, design, bindings, outputs", rest)
	}
	return "body must be JSON: {id?, name, design?, bindings?, outputs?}"
}

// slugify derives a project-id slug from a display name: lowercase, letters
// and digits kept, everything else collapsed to single dashes, trimmed and
// capped so a uniqueness suffix still fits the id pattern.
func slugify(name string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z' || r >= '0' && r <= '9':
			if dash && b.Len() > 0 {
				b.WriteByte('-')
			}
			dash = false
			b.WriteRune(r)
		default:
			dash = true
		}
		if b.Len() >= 48 {
			break
		}
	}
	slug := strings.Trim(b.String(), "-")
	if slug == "" {
		return "project"
	}
	return slug
}

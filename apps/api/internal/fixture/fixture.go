// Package fixture resolves and loads the demo fixture files in examples/.
// The API is started from different working directories (apps/api via
// `make dev-api`, or the repo root via `go run ./apps/api/cmd/api`), so a
// single relative default path is not enough — resolution is best-effort
// against the working directory and its ancestors.
package fixture

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Resolve returns an existing file path for p. Order of attempts:
//  1. p as given (absolute, or relative to the current working directory —
//     this covers the documented default "../../examples/demo-data.json"
//     when running from apps/api).
//  2. examples/<basename of p> in the working directory and up to 8 of its
//     ancestors (covers running from the repo root or a nested package dir).
func Resolve(p string) (string, error) {
	if fileExists(p) {
		return p, nil
	}
	if filepath.IsAbs(p) {
		return "", fmt.Errorf("fixture %q not found", p)
	}
	base := filepath.Base(p)
	dir, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("fixture %q not found (getwd: %w)", p, err)
	}
	for range 8 {
		cand := filepath.Join(dir, "examples", base)
		if fileExists(cand) {
			return cand, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", fmt.Errorf("fixture %q not found (tried the path as given and examples/%s in working-directory ancestors)", p, base)
}

// Read resolves p and returns the file contents.
func Read(p string) ([]byte, error) {
	resolved, err := Resolve(p)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(resolved)
}

// LoadJSON resolves p and unmarshals its JSON contents into v.
func LoadJSON(p string, v any) error {
	b, err := Read(p)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, v); err != nil {
		return fmt.Errorf("fixture %q: invalid JSON: %w", p, err)
	}
	return nil
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

package config

import (
	"strings"
	"testing"
)

// Production boot requirements (architecture.md §4): every auth/crypto var
// must be present, and the error names exactly what is missing.
func TestValidateProductionRequirements(t *testing.T) {
	full := map[string]string{
		"MIB_GITHUB_CLIENT_ID":     "Iv1.abc",
		"MIB_GITHUB_CLIENT_SECRET": "shhh",
		"MIB_PUBLIC_URL":           "https://cards.example.com",
		"MIB_MASTER_KEY":           "a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2U=",
	}

	tests := []struct {
		name        string
		env         string
		unset       []string // vars removed from the full set
		wantMissing []string // var names the error must mention; empty == ok
	}{
		{"production fully configured", "production", nil, nil},
		{"production missing client id", "production", []string{"MIB_GITHUB_CLIENT_ID"}, []string{"MIB_GITHUB_CLIENT_ID"}},
		{"production missing client secret", "production", []string{"MIB_GITHUB_CLIENT_SECRET"}, []string{"MIB_GITHUB_CLIENT_SECRET"}},
		{"production missing public url", "production", []string{"MIB_PUBLIC_URL"}, []string{"MIB_PUBLIC_URL"}},
		{"production missing master key", "production", []string{"MIB_MASTER_KEY"}, []string{"MIB_MASTER_KEY"}},
		{"production missing everything", "production",
			[]string{"MIB_GITHUB_CLIENT_ID", "MIB_GITHUB_CLIENT_SECRET", "MIB_PUBLIC_URL", "MIB_MASTER_KEY"},
			[]string{"MIB_GITHUB_CLIENT_ID", "MIB_GITHUB_CLIENT_SECRET", "MIB_PUBLIC_URL", "MIB_MASTER_KEY"}},
		{"dev needs nothing", "dev",
			[]string{"MIB_GITHUB_CLIENT_ID", "MIB_GITHUB_CLIENT_SECRET", "MIB_PUBLIC_URL", "MIB_MASTER_KEY"}, nil},
		{"test env needs nothing", "test",
			[]string{"MIB_GITHUB_CLIENT_ID", "MIB_GITHUB_CLIENT_SECRET", "MIB_PUBLIC_URL", "MIB_MASTER_KEY"}, nil},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("MIB_ENV", tt.env)
			for name, value := range full {
				t.Setenv(name, value)
			}
			for _, name := range tt.unset {
				t.Setenv(name, "")
			}

			err := Load().Validate()
			if len(tt.wantMissing) == 0 {
				if err != nil {
					t.Fatalf("Validate() = %v, want nil", err)
				}
				return
			}
			if err == nil {
				t.Fatal("Validate() = nil, want an error")
			}
			for _, name := range tt.wantMissing {
				if !strings.Contains(err.Error(), name) {
					t.Errorf("error %q does not name missing %s", err, name)
				}
			}
		})
	}
}

// The public-URL default is dev-only: production must configure it explicitly.
func TestPublicURLDefaultIsDevOnly(t *testing.T) {
	t.Setenv("MIB_PUBLIC_URL", "")

	t.Setenv("MIB_ENV", "dev")
	if got := Load().PublicURL; got != "http://localhost:5173" {
		t.Errorf("dev PublicURL default = %q, want the Vite origin", got)
	}

	t.Setenv("MIB_ENV", "production")
	if got := Load().PublicURL; got != "" {
		t.Errorf("production PublicURL defaulted to %q, want empty (Validate catches it)", got)
	}
}

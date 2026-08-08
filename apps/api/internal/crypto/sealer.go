// Package crypto seals connector credentials at rest (architecture.md §9.1).
// Self-host tier: AES-256-GCM under a master key from MIB_MASTER_KEY; the
// scale tier swaps in KMS-managed envelope keys behind the same interface.
// Dev without a key runs unsealed (PlainSealer) with a loud startup warning;
// production with auth configured requires the key (fatal at boot).
package crypto

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
)

// Sealer encrypts small secrets (connector credentials) for storage at rest.
type Sealer interface {
	// Seal encrypts plaintext. The result is self-contained: Open needs no
	// other state than the sealer's key.
	Seal(plaintext []byte) ([]byte, error)
	// Open decrypts a Seal result. Any tampering or key mismatch is an error,
	// never silently wrong plaintext.
	Open(sealed []byte) ([]byte, error)
}

// ---- AES-256-GCM ---------------------------------------------------------

// AESSealer seals with AES-256-GCM: a fresh random nonce per Seal, prepended
// to the ciphertext (nonce ‖ ciphertext ‖ tag). GCM authenticates, so Open
// detects tampering and wrong keys.
type AESSealer struct {
	aead cipher.AEAD
}

// NewAESSealer builds an AESSealer from a base64-encoded master key
// (MIB_MASTER_KEY) that must decode to exactly 32 bytes.
func NewAESSealer(masterKeyB64 string) (*AESSealer, error) {
	key, err := base64.StdEncoding.DecodeString(masterKeyB64)
	if err != nil {
		// Tolerate unpadded encodings; the requirement is the decoded length.
		key, err = base64.RawStdEncoding.DecodeString(masterKeyB64)
	}
	if err != nil {
		return nil, fmt.Errorf("crypto: MIB_MASTER_KEY is not valid base64: %w", err)
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("crypto: MIB_MASTER_KEY must decode to exactly 32 bytes, got %d", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("crypto: building AES cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("crypto: building GCM: %w", err)
	}
	return &AESSealer{aead: aead}, nil
}

// Seal implements Sealer.
func (s *AESSealer) Seal(plaintext []byte) ([]byte, error) {
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("crypto: generating nonce: %w", err)
	}
	// Seal appends ciphertext+tag to the nonce slice: nonce ‖ ciphertext ‖ tag.
	return s.aead.Seal(nonce, nonce, plaintext, nil), nil
}

// Open implements Sealer.
func (s *AESSealer) Open(sealed []byte) ([]byte, error) {
	n := s.aead.NonceSize()
	if len(sealed) < n+s.aead.Overhead() {
		return nil, errors.New("crypto: sealed record is too short")
	}
	plaintext, err := s.aead.Open(nil, sealed[:n], sealed[n:], nil)
	if err != nil {
		return nil, errors.New("crypto: sealed record failed authentication (tampered, or wrong master key)")
	}
	return plaintext, nil
}

// ---- dev passthrough -----------------------------------------------------

// plainPrefix marks records written by PlainSealer so unsealed dev records
// can never be confused with AES ciphertext: PlainSealer.Open rejects
// anything without the prefix, and AESSealer.Open rejects prefixed records
// via GCM authentication.
var plainPrefix = []byte("mib-unsealed-v0:")

// PlainSealer is the dev-without-key fallback: a passthrough that stores
// plaintext with a distinguishing prefix. Selecting it must be accompanied by
// a loud startup warning; it is never valid in production (architecture.md
// §9.1).
type PlainSealer struct{}

// Seal implements Sealer.
func (PlainSealer) Seal(plaintext []byte) ([]byte, error) {
	out := make([]byte, 0, len(plainPrefix)+len(plaintext))
	out = append(out, plainPrefix...)
	return append(out, plaintext...), nil
}

// Open implements Sealer.
func (PlainSealer) Open(sealed []byte) ([]byte, error) {
	rest, ok := bytes.CutPrefix(sealed, plainPrefix)
	if !ok {
		return nil, errors.New("crypto: record was not sealed by PlainSealer (sealed under a master key? set MIB_MASTER_KEY)")
	}
	return rest, nil
}

package crypto

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"strings"
	"testing"
)

func testKey(t *testing.T) string {
	t.Helper()
	var key [32]byte
	if _, err := rand.Read(key[:]); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(key[:])
}

func TestAESSealerRoundTrip(t *testing.T) {
	s, err := NewAESSealer(testKey(t))
	if err != nil {
		t.Fatal(err)
	}

	for _, plaintext := range [][]byte{
		[]byte(`{"accessToken":"ghu_secret","refreshToken":"ghr_secret"}`),
		{},
		[]byte("x"),
	} {
		sealed, err := s.Seal(plaintext)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(sealed, []byte("ghu_secret")) {
			t.Fatal("sealed record contains the plaintext")
		}
		opened, err := s.Open(sealed)
		if err != nil {
			t.Fatalf("Open failed: %v", err)
		}
		if !bytes.Equal(opened, plaintext) {
			t.Errorf("round trip = %q, want %q", opened, plaintext)
		}
	}
}

// Two seals of the same plaintext must differ (random nonce), and both open.
func TestAESSealerNonceIsRandom(t *testing.T) {
	s, err := NewAESSealer(testKey(t))
	if err != nil {
		t.Fatal(err)
	}
	a, _ := s.Seal([]byte("same"))
	b, _ := s.Seal([]byte("same"))
	if bytes.Equal(a, b) {
		t.Error("two seals of the same plaintext are identical — nonce is not random")
	}
	for _, sealed := range [][]byte{a, b} {
		if _, err := s.Open(sealed); err != nil {
			t.Errorf("Open failed: %v", err)
		}
	}
}

func TestAESSealerTamperDetection(t *testing.T) {
	s, err := NewAESSealer(testKey(t))
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := s.Seal([]byte("credentials"))
	if err != nil {
		t.Fatal(err)
	}

	// Flipping any single byte (nonce, ciphertext, or tag) must fail Open.
	for i := range sealed {
		tampered := bytes.Clone(sealed)
		tampered[i] ^= 0x01
		if _, err := s.Open(tampered); err == nil {
			t.Fatalf("Open accepted a record with byte %d flipped", i)
		}
	}

	// Truncation must fail too, not panic.
	for _, cut := range [][]byte{nil, sealed[:1], sealed[:len(sealed)-1]} {
		if _, err := s.Open(cut); err == nil {
			t.Error("Open accepted a truncated record")
		}
	}
}

func TestAESSealerWrongKey(t *testing.T) {
	sealerA, err := NewAESSealer(testKey(t))
	if err != nil {
		t.Fatal(err)
	}
	sealerB, err := NewAESSealer(testKey(t))
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := sealerA.Seal([]byte("credentials"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sealerB.Open(sealed); err == nil {
		t.Error("Open under a different master key succeeded")
	}
}

func TestNewAESSealerKeyValidation(t *testing.T) {
	tests := []struct {
		name    string
		key     string
		wantErr bool
	}{
		{"valid padded", base64.StdEncoding.EncodeToString(make([]byte, 32)), false},
		{"valid unpadded", base64.RawStdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)), false},
		{"empty", "", true},
		{"not base64", "!!!not-base64!!!", true},
		{"too short", base64.StdEncoding.EncodeToString(make([]byte, 16)), true},
		{"too long", base64.StdEncoding.EncodeToString(make([]byte, 33)), true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := NewAESSealer(tt.key)
			if (err != nil) != tt.wantErr {
				t.Errorf("NewAESSealer(%q) error = %v, wantErr %v", tt.key, err, tt.wantErr)
			}
		})
	}
}

func TestPlainSealerRoundTrip(t *testing.T) {
	s := PlainSealer{}
	plaintext := []byte(`{"accessToken":"tok"}`)
	sealed, err := s.Seal(plaintext)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(sealed, plainPrefix) {
		t.Error("plain-sealed record lacks the distinguishing prefix")
	}
	opened, err := s.Open(sealed)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(opened, plaintext) {
		t.Errorf("round trip = %q, want %q", opened, plaintext)
	}
}

// Sealed and unsealed records must never be confused: each sealer rejects the
// other's output with a clear error instead of returning garbage.
func TestSealersRejectEachOthersRecords(t *testing.T) {
	aes, err := NewAESSealer(testKey(t))
	if err != nil {
		t.Fatal(err)
	}
	plain := PlainSealer{}

	aesSealed, _ := aes.Seal([]byte("credentials"))
	if _, err := plain.Open(aesSealed); err == nil {
		t.Error("PlainSealer opened an AES-sealed record")
	}

	plainSealed, _ := plain.Seal([]byte("credentials"))
	if _, err := aes.Open(plainSealed); err == nil {
		t.Error("AESSealer opened a plain record")
	}
	// Raw plaintext (e.g. hand-edited JSON) is rejected by PlainSealer too.
	if _, err := plain.Open([]byte("credentials")); err == nil {
		t.Error("PlainSealer opened an unprefixed record")
	} else if !strings.Contains(err.Error(), "MIB_MASTER_KEY") {
		t.Errorf("error should hint at the master key: %v", err)
	}
}

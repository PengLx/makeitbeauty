package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

// Fonts store contract, run against both implementations: CRUD, the
// one-face-per-(family,weight) uniqueness rule, and file-store durability.

func testFont(id, userID, family string, weight int) *Font {
	return &Font{
		ID: id, UserID: userID, Family: family, Weight: weight,
		Format: "ttf", Size: 1234, Hash: "abc123",
		CreatedAt: time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC),
	}
}

func TestFontsStoreContract(t *testing.T) {
	fileStores, dir := newFileStores(t)
	impls := map[string]Stores{
		"memory": NewMemory(),
		"file":   fileStores,
	}
	for name, stores := range impls {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			fonts := stores.Fonts

			if err := fonts.Create(ctx, testFont("font-1", "u1", "My Font", 400)); err != nil {
				t.Fatal(err)
			}
			// Same family, different weight: fine. Different user, same face: fine.
			if err := fonts.Create(ctx, testFont("font-2", "u1", "My Font", 700)); err != nil {
				t.Fatal(err)
			}
			if err := fonts.Create(ctx, testFont("font-3", "u2", "My Font", 400)); err != nil {
				t.Fatal(err)
			}
			// Duplicate (user, family, weight): ErrExists.
			if err := fonts.Create(ctx, testFont("font-4", "u1", "My Font", 400)); !errors.Is(err, ErrExists) {
				t.Errorf("duplicate face Create err = %v, want ErrExists", err)
			}

			got, err := fonts.Get(ctx, "font-1")
			if err != nil {
				t.Fatal(err)
			}
			if got.Family != "My Font" || got.Weight != 400 || got.Format != "ttf" || got.Hash != "abc123" || got.Size != 1234 {
				t.Errorf("Get = %+v", got)
			}
			if _, err := fonts.Get(ctx, "ghost"); !errors.Is(err, ErrNotFound) {
				t.Errorf("Get ghost err = %v, want ErrNotFound", err)
			}

			mine, err := fonts.ListByUser(ctx, "u1")
			if err != nil || len(mine) != 2 {
				t.Errorf("ListByUser u1 = %d fonts, %v, want 2", len(mine), err)
			}
			none, err := fonts.ListByUser(ctx, "nobody")
			if err != nil || len(none) != 0 {
				t.Errorf("ListByUser nobody = %d fonts, %v, want 0", len(none), err)
			}

			if err := fonts.Delete(ctx, "font-2"); err != nil {
				t.Fatal(err)
			}
			if _, err := fonts.Get(ctx, "font-2"); !errors.Is(err, ErrNotFound) {
				t.Error("font-2 still present after Delete")
			}
			if err := fonts.Delete(ctx, "font-2"); !errors.Is(err, ErrNotFound) {
				t.Errorf("second Delete err = %v, want ErrNotFound", err)
			}
			// The face is free again after deletion.
			if err := fonts.Create(ctx, testFont("font-5", "u1", "My Font", 700)); err != nil {
				t.Errorf("re-creating a deleted face: %v", err)
			}
		})
	}

	// File store: fonts survive a restart (fonts.json reload).
	reopened := reopen(t, dir)
	got, err := reopened.Fonts.Get(context.Background(), "font-1")
	if err != nil {
		t.Fatalf("font-1 lost across reopen: %v", err)
	}
	if got.UserID != "u1" || got.Family != "My Font" || got.Weight != 400 ||
		got.Format != "ttf" || got.Size != 1234 || got.Hash != "abc123" ||
		!got.CreatedAt.Equal(time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC)) {
		t.Errorf("reloaded font = %+v", got)
	}
	if err := reopened.Fonts.Create(context.Background(), testFont("font-6", "u1", "My Font", 400)); !errors.Is(err, ErrExists) {
		t.Errorf("uniqueness not enforced after reopen: %v", err)
	}
}

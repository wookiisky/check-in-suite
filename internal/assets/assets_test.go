package assets

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// TestInstallPreservesImmutableAssets checks first install, repeat install and conflicts on disk.
func TestInstallPreservesImmutableAssets(t *testing.T) {
	service := New(t.TempDir())
	if err := service.Install(); err != nil {
		t.Fatal(err)
	}
	items, err := service.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) < 15 {
		t.Fatalf("expected usable controlled catalog, got %d", len(items))
	}
	if err := service.Install(); err != nil {
		t.Fatalf("repeat install: %v", err)
	}
	file, err := service.Open(DefaultAvatar)
	if err != nil {
		t.Fatal(err)
	}
	original, err := io.ReadAll(file)
	file.Close()
	if err != nil || !bytes.Contains(original, []byte("<svg")) {
		t.Fatalf("invalid persisted SVG: %v", err)
	}
	path := filepath.Join(service.Directory, DefaultAvatar, "asset.svg")
	if err := os.WriteFile(path, []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := service.Install(); err == nil {
		t.Fatal("changed bytes under an existing identity were accepted")
	}
	actual, err := os.ReadFile(path)
	if err != nil || string(actual) != "changed" {
		t.Fatal("conflicting file was overwritten")
	}
}

// TestHistoricalAssetsRemainReadable proves a persisted resource survives removal from built-in catalog.
func TestHistoricalAssetsRemainReadable(t *testing.T) {
	directory := t.TempDir()
	service := New(directory)
	if err := service.Install(); err != nil {
		t.Fatal(err)
	}
	legacy := Asset{Key: "retired-fox-v1", Name: "历史素材", Kind: KindAvatar, URL: "/api/v1/assets/retired-fox-v1"}
	path := filepath.Join(directory, legacy.Key)
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	metadata, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "metadata.json"), metadata, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "asset.svg"), []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`), 0600); err != nil {
		t.Fatal(err)
	}
	// A new process has only the persistent directory; the old source is absent from the binary catalog.
	restarted := New(directory)
	if _, exists := Get(legacy.Key); exists {
		t.Fatal("test resource unexpectedly exists in built-in source")
	}
	if err := restarted.Install(); err != nil {
		t.Fatal(err)
	}
	choices, err := restarted.List()
	if err != nil {
		t.Fatal(err)
	}
	for _, choice := range choices {
		if choice.Key == legacy.Key || !Valid(choice.Key, choice.Kind) {
			t.Fatalf("selection catalog contains a retired or invalid choice: %#v", choice)
		}
	}
	item, err := restarted.Lookup(legacy.Key)
	if err != nil || item != legacy {
		t.Fatalf("historical metadata lost: %#v %v", item, err)
	}
	file, err := restarted.Open(legacy.Key)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if body, err := io.ReadAll(file); err != nil || !bytes.Contains(body, []byte("<svg")) {
		t.Fatalf("historical bytes lost: %v", err)
	}
}

// TestCatalogKindsAndInvalidKeys verifies controlled choices and lexical path boundaries.
func TestCatalogKindsAndInvalidKeys(t *testing.T) {
	service := New(t.TempDir())
	if err := service.Install(); err != nil {
		t.Fatal(err)
	}
	if !Valid("book-v1", KindIcon) || Valid("book-v1", KindAvatar) || Valid("unknown-v1", KindIcon) {
		t.Fatal("kind validation failed")
	}
	accessories := 0
	items, err := service.List()
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range items {
		if item.Kind == KindAccessory {
			accessories++
		}
		if item.URL != "/api/v1/assets/"+item.Key {
			t.Fatalf("invalid public URL: %q", item.URL)
		}
	}
	if accessories < 10 {
		t.Fatalf("need ten visible distinct accessories, have %d", accessories)
	}
	for _, key := range []string{"", "..", "../fox-v1", "fox-v1/asset.svg", "unknown-v1", "/etc/passwd"} {
		if file, err := service.Open(key); err == nil {
			file.Close()
			t.Fatalf("invalid key accepted: %q", key)
		}
	}
}

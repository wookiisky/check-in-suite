package assets

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// TestExplorerBadgeUpgrade preserves the published v1 files while installing the renamed badge.
func TestExplorerBadgeUpgrade(t *testing.T) {
	service := New(t.TempDir())
	legacyDirectory := filepath.Join(service.Directory, "badge-explorer-v1")
	if err := os.Mkdir(legacyDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	original := make(map[string][]byte)
	for _, name := range []string{"metadata.json", "asset.svg"} {
		data, err := os.ReadFile(filepath.Join("testdata", "explorer-v1", name))
		if err != nil {
			t.Fatal(err)
		}
		original[name] = data
		if err := os.WriteFile(filepath.Join(legacyDirectory, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		if err := service.Install(); err != nil {
			t.Fatalf("install over historical badge: %v", err)
		}
	}
	for name, want := range original {
		got, err := os.ReadFile(filepath.Join(legacyDirectory, name))
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("historical %s changed: %v", name, err)
		}
	}
	var legacy Asset
	if err := json.Unmarshal(original["metadata.json"], &legacy); err != nil {
		t.Fatal(err)
	}
	stored, err := service.Lookup(legacy.Key)
	if err != nil || stored != legacy {
		t.Fatalf("historical metadata unavailable: %+v %v", stored, err)
	}
	for _, key := range []string{legacy.Key, "badge-explorer-v2"} {
		file, err := service.Open(key)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(file)
		file.Close()
		if err != nil || !bytes.Equal(body, original["asset.svg"]) {
			t.Fatalf("badge artwork changed for %s: %v", key, err)
		}
	}
	if _, exists := Get(legacy.Key); exists {
		t.Fatal("retired badge is still a current choice")
	}
	items, err := service.List()
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range items {
		if item.Key == legacy.Key {
			t.Fatal("historical badge is still selectable")
		}
		if item.Key == "badge-explorer-v2" {
			found = true
		}
	}
	if !found {
		t.Fatal("renamed badge is not selectable")
	}
}

// TestInstallRejectsChangedAssetMetadata keeps display names within the immutable identity contract.
func TestInstallRejectsChangedAssetMetadata(t *testing.T) {
	service := New(t.TempDir())
	if err := service.Install(); err != nil {
		t.Fatal(err)
	}
	item, ok := Get(DefaultAvatar)
	if !ok {
		t.Fatal("default avatar missing")
	}
	item.Name += " changed"
	metadata, err := json.Marshal(item)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(service.Directory, item.Key, "metadata.json")
	if err := os.WriteFile(path, metadata, 0600); err != nil {
		t.Fatal(err)
	}
	if err := service.Install(); err == nil {
		t.Fatal("changed metadata under an existing identity was accepted")
	}
	actual, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(actual, metadata) {
		t.Fatalf("conflicting metadata was overwritten: %v", err)
	}
}

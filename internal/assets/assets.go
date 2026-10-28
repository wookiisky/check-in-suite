// Package assets installs controlled versioned artwork and preserves historical resources.
package assets

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"

	"github.com/wookiisky/check-in-suite/internal/core"
)

// Kind identifies the business use allowed for a controlled asset.
type Kind string

const (
	KindIcon      Kind = "icon"      // Task icon rendered in current and historical records.
	KindAvatar    Kind = "avatar"    // Full character illustration.
	KindAccessory Kind = "accessory" // Decoration rendered around the current character.
	KindTitle     Kind = "title"     // Emblem shown with the equipped title.
	KindReward    Kind = "reward"    // Illustration for a household reward.
	DefaultAvatar      = "fox-v1"    // Stable default character identity retained across releases.
)

// Asset is public metadata for an immutable controlled SVG.
type Asset struct {
	Key  string `json:"key"`  // Versioned identity also used by historical snapshots.
	Name string `json:"name"` // Display name loaded from the catalog resource.
	Kind Kind   `json:"kind"` // Allowed business use.
	URL  string `json:"url"`  // Same-origin authenticated content endpoint.
}

// Service owns only the persistent controlled-artwork directory, never uploaded media.
type Service struct {
	Directory string // Private persistent root that survives application releases.
}

//go:embed builtin/*
var builtin embed.FS

var keyPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,95}$`)

// New binds the immutable asset store to a persistent directory without changing files.
func New(directory string) *Service { return &Service{Directory: directory} }

// catalog reads names and controlled identities from the embedded resource.
func catalog() ([]Asset, error) {
	data, err := builtin.ReadFile("builtin/catalog.json")
	if err != nil {
		return nil, err
	}
	var items []Asset
	if err := json.Unmarshal(data, &items); err != nil {
		return nil, err
	}
	return items, nil
}

// Get returns a current built-in choice; persisted historical lookups use Service.Lookup.
func Get(key string) (Asset, bool) {
	items, err := catalog()
	if err != nil {
		return Asset{}, false
	}
	for _, item := range items {
		if item.Key == key {
			return item, true
		}
	}
	return Asset{}, false
}

// Valid checks the allowed business kind of a current built-in choice.
func Valid(key string, kind Kind) bool { item, ok := Get(key); return ok && item.Kind == kind }

// Install adds versioned directories atomically and refuses different bytes under existing keys.
func (service *Service) Install() error {
	if err := os.MkdirAll(service.Directory, 0700); err != nil {
		return err
	}
	items, err := catalog()
	if err != nil {
		return err
	}
	for _, item := range items {
		if !keyPattern.MatchString(item.Key) {
			return fmt.Errorf("invalid controlled asset key %q", item.Key)
		}
		drawing, err := builtin.ReadFile("builtin/" + item.Key + ".svg")
		if err != nil {
			return err
		}
		if err := service.install(item, drawing); err != nil {
			return err
		}
	}
	return nil
}

// install publishes one complete resource; an interrupted temporary directory is never readable.
func (service *Service) install(item Asset, drawing []byte) error {
	destination := filepath.Join(service.Directory, item.Key)
	if _, err := os.Stat(destination); err == nil {
		return service.compare(item, drawing)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	temporary, err := os.MkdirTemp(service.Directory, ".install-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temporary)
	metadata, err := json.Marshal(item)
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(temporary, "metadata.json"), metadata, 0600); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(temporary, "asset.svg"), drawing, 0600); err != nil {
		return err
	}
	if err := os.Rename(temporary, destination); err != nil {
		// A concurrent installer may have published the exact same immutable resource.
		if _, statErr := os.Stat(destination); statErr == nil {
			return service.compare(item, drawing)
		}
		return err
	}
	return nil
}

// compare rejects accidental reuse of a published identity for changed artwork or metadata.
func (service *Service) compare(item Asset, drawing []byte) error {
	stored, err := service.Lookup(item.Key)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(filepath.Join(service.Directory, item.Key, "asset.svg"))
	if err != nil {
		return err
	}
	if stored != item || !bytes.Equal(data, drawing) {
		return fmt.Errorf("asset identity %q already contains different content", item.Key)
	}
	return nil
}

// Lookup reads persisted metadata so snapshots do not depend on the current release catalog.
func (service *Service) Lookup(key string) (Asset, error) {
	if !keyPattern.MatchString(key) {
		return Asset{}, core.Fail(404, "NOT_FOUND")
	}
	data, err := os.ReadFile(filepath.Join(service.Directory, key, "metadata.json"))
	if errors.Is(err, fs.ErrNotExist) {
		return Asset{}, core.Fail(404, "NOT_FOUND")
	}
	if err != nil {
		return Asset{}, err
	}
	var item Asset
	if err := json.Unmarshal(data, &item); err != nil {
		return Asset{}, err
	}
	if item.Key != key || item.URL != "/api/v1/assets/"+key {
		return Asset{}, fmt.Errorf("asset metadata does not match %q", key)
	}
	return item, nil
}

// List offers installed current choices; historical versions remain accessible through Lookup and Open.
func (service *Service) List() ([]Asset, error) {
	entries, err := os.ReadDir(service.Directory)
	if err != nil {
		return nil, err
	}
	items := make([]Asset, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || !keyPattern.MatchString(entry.Name()) {
			continue
		}
		if _, selectable := Get(entry.Name()); !selectable {
			continue
		}
		item, err := service.Lookup(entry.Name())
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Key < items[j].Key })
	return items, nil
}

// Open exposes a controlled resource only after validating its persisted identity.
func (service *Service) Open(key string) (*os.File, error) {
	if _, err := service.Lookup(key); err != nil {
		return nil, err
	}
	return os.Open(filepath.Join(service.Directory, key, "asset.svg"))
}

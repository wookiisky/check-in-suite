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
	"sync"

	"github.com/wookiisky/check-in-suite/internal/core"
)

// Kind identifies the business use allowed for a controlled asset.
type Kind string

const (
	KindModel     Kind = "model"     // Versioned GLB geometry, not an image choice.
	KindAnimation Kind = "animation" // Offline prepared GLB animation clips.
	KindWearable  Kind = "wearable"  // Rendered thumbnail for a 3D wearable definition.
	KindCharacter Kind = "character" // Rendered thumbnail for a complete standardized character.
	KindIsland    Kind = "island"    // Controlled island construction thumbnail.
	KindIcon      Kind = "icon"      // Task icon rendered in current and historical records.
	KindTitle     Kind = "title"     // Emblem shown with the equipped title.
	KindReward    Kind = "reward"    // Illustration for a household reward.
	KindBadge     Kind = "badge"     // Permanent achievement emblem displayed below the character.
)

// Asset is public metadata for immutable controlled artwork.
type Asset struct {
	Free      bool   `json:"free,omitempty"`       // Explicit free camp thumbnails cannot be sold.
	Key       string `json:"key"`                  // Versioned identity also used by historical snapshots.
	Name      string `json:"name"`                 // Display name loaded from the catalog resource.
	Kind      Kind   `json:"kind"`                 // Allowed business use.
	URL       string `json:"url"`                  // Same-origin authenticated content endpoint.
	Format    string `json:"format,omitempty"`     // SVG by default; explicit PNG and WebP retain transparency.
	SourceURL string `json:"source_url,omitempty"` // Official source or recorded derivative provenance.
	License   string `json:"license,omitempty"`    // Resource-specific license; animation rights are separate.
	Provider  string `json:"provider,omitempty"`   // Official provider used by catalog filters.
	PackKey   string `json:"pack_key,omitempty"`   // Stable source-pack identity, separate from asset versions.
	PackName  string `json:"pack_name,omitempty"`  // Official pack display name for catalog browsing.
	Category  string `json:"category,omitempty"`   // Reviewed category of a complete independently usable item.
}

// extension keeps historical SVG metadata and filenames compatible.
func (item Asset) extension() string {
	if item.Format == "" {
		return "svg"
	}
	return item.Format
}

// ContentType returns only supported artwork media types; empty means invalid metadata.
func (item Asset) ContentType() string {
	switch item.extension() {
	case "svg":
		return "image/svg+xml"
	case "png":
		return "image/png"
	case "webp":
		return "image/webp"
	case "glb":
		return "model/gltf-binary"
	default:
		return ""
	}
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

// builtinCatalog 同时保存不可变列表和按身份读取的索引。
type builtinCatalog struct {
	items []Asset          // 安装时使用的目录顺序。
	byKey map[string]Asset // 常数时间的受控身份查找。
}

// loadBuiltinCatalog 只解析一次不可变目录，查找与遍历共用同一版本。
var loadBuiltinCatalog = sync.OnceValues(func() (builtinCatalog, error) {
	data, err := builtin.ReadFile("builtin/catalog.json")
	if err != nil {
		return builtinCatalog{}, err
	}
	var items []Asset
	if err := json.Unmarshal(data, &items); err != nil {
		return builtinCatalog{}, err
	}
	byKey := make(map[string]Asset, len(items))
	for _, item := range items {
		byKey[item.Key] = item
	}
	return builtinCatalog{items: items, byKey: byKey}, nil
})

// catalog 返回独立列表，调用者不能改变进程内的目录索引。
func catalog() ([]Asset, error) {
	catalog, err := loadBuiltinCatalog()
	return append([]Asset(nil), catalog.items...), err
}

// Get returns a current built-in choice; persisted historical lookups use Service.Lookup.
func Get(key string) (Asset, bool) {
	catalog, err := loadBuiltinCatalog()
	if err != nil {
		return Asset{}, false
	}
	item, ok := catalog.byKey[key]
	return item, ok
}

// Valid checks the allowed business kind of a current built-in choice.
func Valid(key string, kind Kind) bool { item, ok := Get(key); return ok && item.Kind == kind }

// validateBuiltinMetadata keeps format and explicit free capabilities consistent.
func (item Asset) validateBuiltinMetadata() error {
	if !keyPattern.MatchString(item.Key) || item.ContentType() == "" || (item.Free && item.Kind != KindIsland) {
		return fmt.Errorf("invalid controlled asset key %q", item.Key)
	}
	model := item.Kind == KindModel || item.Kind == KindAnimation
	if model != (item.extension() == "glb") || ((item.Kind == KindWearable || item.Kind == KindCharacter) && item.extension() != "png") {
		return fmt.Errorf("controlled asset format does not match kind %q", item.Key)
	}
	return nil
}

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
		if err := item.validateBuiltinMetadata(); err != nil {
			return err
		}
		drawing, err := builtin.ReadFile("builtin/" + item.Key + "." + item.extension())
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
	if err := os.WriteFile(filepath.Join(temporary, "asset."+item.extension()), drawing, 0600); err != nil {
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
	data, err := os.ReadFile(filepath.Join(service.Directory, item.Key, "asset."+item.extension()))
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
	if item.Key != key || item.URL != "/api/v1/assets/"+key || item.ContentType() == "" {
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
		if choice, selectable := Get(entry.Name()); !selectable || choice.Kind == KindModel || choice.Kind == KindAnimation {
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
	item, err := service.Lookup(key)
	if err != nil {
		return nil, err
	}
	name := "asset." + item.extension()
	return os.Open(filepath.Join(service.Directory, key, name))
}

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
	KindCharacterPart Kind = "character-part" // Internal layer installed for composition, never sold.
	KindIsland        Kind = "island"         // Controlled island construction thumbnail.
	KindIcon          Kind = "icon"           // Task icon rendered in current and historical records.
	KindAvatar        Kind = "avatar"         // Full character illustration.
	KindAccessory     Kind = "accessory"      // Decoration rendered around the current character.
	KindBackground    Kind = "background"     // Fixed artwork behind the character canvas.
	KindEffect        Kind = "effect"         // Fixed animated overlay with an immutable still alternative.
	KindTitle         Kind = "title"          // Emblem shown with the equipped title.
	KindReward        Kind = "reward"         // Illustration for a household reward.
	KindBadge         Kind = "badge"          // Permanent achievement emblem displayed below the character.
	DefaultAvatar          = "avatar-boy-v2"  // Free default human character selected for a new account.
)

// WearableSlot identifies a fixed body attachment shared by human characters.
type WearableSlot string

const (
	SlotHair   WearableSlot = "hair"   // One hairstyle including optional rear hair.
	SlotTop    WearableSlot = "top"    // Upper garment.
	SlotBottom WearableSlot = "bottom" // Lower garment.
	SlotShoes  WearableSlot = "shoes"  // Footwear.
)

// Valid reports whether a fixed attachment exists in the character model.
func (slot WearableSlot) Valid() bool {
	switch slot {
	case SlotHair, SlotTop, SlotBottom, SlotShoes:
		return true
	default:
		return false
	}
}

// Asset is public metadata for immutable controlled artwork.
type Asset struct {
	Free         bool         `json:"free,omitempty"`           // Base characters can be selected without a purchase.
	WearableSlot WearableSlot `json:"wearable_slot,omitempty"`  // Fixed attachment; empty means ordinary artwork.
	BackAssetKey string       `json:"back_asset_key,omitempty"` // Internal rear layer belonging to this same wearable.
	Key          string       `json:"key"`                      // Versioned identity also used by historical snapshots.
	Name         string       `json:"name"`                     // Display name loaded from the catalog resource.
	Kind         Kind         `json:"kind"`                     // Allowed business use.
	URL          string       `json:"url"`                      // Same-origin authenticated content endpoint.
	Format       string       `json:"format,omitempty"`         // SVG by default; explicit PNG and WebP retain transparency.
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
		if !keyPattern.MatchString(item.Key) || item.ContentType() == "" || (item.WearableSlot != "" && (!item.WearableSlot.Valid() || item.Kind != KindAccessory)) || (item.Free && item.Kind != KindAvatar) {
			return fmt.Errorf("invalid controlled asset key %q", item.Key)
		}
		drawing, err := builtin.ReadFile("builtin/" + item.Key + "." + item.extension())
		if err != nil {
			return err
		}
		var still []byte
		if item.Kind == KindEffect {
			still, err = builtin.ReadFile("builtin/" + item.Key + "-static.svg")
			if err != nil {
				return err
			}
		}
		if err := service.install(item, drawing, still); err != nil {
			return err
		}
	}
	return nil
}

// install publishes one complete resource; an interrupted temporary directory is never readable.
func (service *Service) install(item Asset, drawing, still []byte) error {
	destination := filepath.Join(service.Directory, item.Key)
	if _, err := os.Stat(destination); err == nil {
		return service.compare(item, drawing, still)
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
	if item.Kind == KindEffect {
		if err := os.WriteFile(filepath.Join(temporary, "asset-static.svg"), still, 0600); err != nil {
			return err
		}
	}
	if err := os.Rename(temporary, destination); err != nil {
		// A concurrent installer may have published the exact same immutable resource.
		if _, statErr := os.Stat(destination); statErr == nil {
			return service.compare(item, drawing, still)
		}
		return err
	}
	return nil
}

// compare rejects accidental reuse of a published identity for changed artwork or metadata.
func (service *Service) compare(item Asset, drawing, still []byte) error {
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
	if item.Kind == KindEffect {
		data, err := os.ReadFile(filepath.Join(service.Directory, item.Key, "asset-static.svg"))
		if err != nil {
			return err
		}
		if !bytes.Equal(data, still) {
			return fmt.Errorf("asset identity %q already contains different static content", item.Key)
		}
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
		if choice, selectable := Get(entry.Name()); !selectable || choice.Kind == KindCharacterPart {
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
	return service.OpenVariant(key, false)
}

// OpenVariant keeps both effect variants under the same immutable asset identity.
func (service *Service) OpenVariant(key string, still bool) (*os.File, error) {
	item, err := service.Lookup(key)
	if err != nil {
		return nil, err
	}
	name := "asset." + item.extension()
	if still && item.Kind == KindEffect {
		name = "asset-static.svg"
	}
	return os.Open(filepath.Join(service.Directory, key, name))
}

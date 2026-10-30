// Package island owns controlled item capabilities and persistent island placement.
package island

import (
	_ "embed"
	"encoding/json"
)

// Definition describes current optional presentation and activity capabilities of a stable item.
type Definition struct {
	Key              string  `json:"key"`                          // Stable identity; never reused for another item.
	Name             string  `json:"name"`                         // Localized name loaded from the resource catalog.
	Category         string  `json:"category"`                     // Scene role, independent of portrait usage.
	Model            string  `json:"model"`                        // Controlled SVG renderer identity.
	Width            float64 `json:"width"`                        // Ground footprint width.
	Depth            float64 `json:"depth"`                        // Ground footprint depth.
	Movable          bool    `json:"movable"`                      // Whether user placement may change the position.
	Repeatable       bool    `json:"repeatable"`                   // Whether each additional purchase grants another instance.
	CatalogOnly      bool    `json:"catalog_only,omitempty"`       // Artwork requires a managed offer; initialization does not price it.
	SeedExisting     bool    `json:"seed_existing,omitempty"`      // New offer may be introduced to existing households without replacing managed rows.
	IndoorOnly       bool    `json:"indoor_only,omitempty"`        // Household furniture uses the home's local placement space.
	Animation        string  `json:"animation,omitempty"`          // Optional ambient animation, independent from interaction.
	Activity         string  `json:"activity,omitempty"`           // Optional activity available at this item.
	PortraitAssetKey string  `json:"portrait_asset_key,omitempty"` // Optional existing portrait artwork.
	AssetKey         string  `json:"asset_key,omitempty"`          // Controlled thumbnail and purchase lookup identity.
	CoinPrice        int64   `json:"coin_price"`                   // Default initial offer price, never reapplied to managed offers.
	DiamondPrice     int64   `json:"diamond_price"`                // Default initial offer diamond price.
}

//go:embed catalog.json
var catalogJSON []byte

// Catalog returns a fresh resource definition list; callers cannot mutate shared definitions.
func Catalog() []Definition {
	var definitions []Definition
	if err := json.Unmarshal(catalogJSON, &definitions); err != nil {
		panic(err)
	}
	return definitions
}

// ForAsset resolves current capabilities for historical purchased artwork.
func ForAsset(key string) (Definition, bool) {
	for _, item := range Catalog() {
		if (item.AssetKey == key || item.PortraitAssetKey == key) && key != "" {
			return item, true
		}
	}
	return Definition{}, false
}

// Find returns a stable item definition, including free base objects.
func Find(key string) (Definition, bool) {
	for _, item := range Catalog() {
		if item.Key == key {
			return item, true
		}
	}
	return Definition{}, false
}

package shop

import (
	"github.com/wookiisky/check-in-suite/internal/assets"
	"github.com/wookiisky/check-in-suite/internal/island"
)

// portraitCapability resolves optional equipment uses from the current controlled definition.
func portraitCapability(item island.Definition) (string, string) {
	if asset, ok := assets.Get(item.PortraitAssetKey); ok {
		switch asset.Kind {
		case assets.KindAccessory, assets.KindAvatar, assets.KindBackground, assets.KindEffect, assets.KindTitle:
			return string(asset.Kind), asset.Key
		}
	}
	return "", ""
}

// equipmentType preserves original roles while allowing island items to gain portrait uses.
func equipmentType(item Purchase) string {
	if item.PortraitType != "" {
		return item.PortraitType
	}
	return item.TypeSnapshot
}

// portraitSourceKeys lets filtered inventory include capabilities added after purchase.
func portraitSourceKeys(kind string) ([]string, []string) {
	keys := []string{}
	items := []string{}
	for _, item := range island.Catalog() {
		role, _ := portraitCapability(item)
		if role == kind {
			items = append(items, item.Key)
			keys = append(keys, item.AssetKey)
			if item.PortraitAssetKey != item.AssetKey {
				keys = append(keys, item.PortraitAssetKey)
			}
		}
	}
	return keys, items
}

package shop_test

import (
	"github.com/wookiisky/check-in-suite/internal/character"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// 测试服装使用真实目录身份，不用二维饰品来模拟三维所有权。
func appearanceProduct(slot, style string) shop.ProductInput {
	key := slot + "-" + style + "-v1"
	if slot == "head" {
		key = "hair-" + style + "-v1"
	}
	if item, ok := character.GetWearable(key); ok {
		return shop.ProductInput{Type: shop.TypeWearable, Name: item.Name, AssetKey: item.ThumbnailAssetKey, WearableKey: item.Key, Enabled: true}
	}
	return shop.ProductInput{Type: shop.TypeWearable, Name: "三维服装", AssetKey: "wearable-" + key, WearableKey: key, Enabled: true}
}

package shop_test

import "github.com/wookiisky/check-in-suite/internal/shop"

// 测试服装使用真实目录身份，不用二维饰品来模拟三维所有权。
func appearanceProduct(slot, style string) shop.ProductInput {
	key := slot + "-" + style + "-v1"
	return shop.ProductInput{Type: shop.TypeWearable, Name: "三维服装", AssetKey: "wearable-" + key, WearableKey: key, Enabled: true}
}

package shop

import (
	"context"
	"database/sql"

	"github.com/wookiisky/check-in-suite/internal/assets"
	"github.com/wookiisky/check-in-suite/internal/island"
)

// purchaseFacets supplies all owned source options without loading order descriptions or model bytes.
func purchaseFacets(ctx context.Context, tx *sql.Tx, accountID int64) (*ProductFacets, error) {
	rows, err := tx.QueryContext(ctx, `SELECT DISTINCT asset_key_snapshot,character_key_snapshot,wearable_key_snapshot,item_key_snapshot FROM purchases WHERE account_id=?`, accountID)
	if err != nil {
		return nil, err
	}
	items := []Product{}
	for rows.Next() {
		var assetKey, bodyKey, wearableKey, itemKey string
		if err := rows.Scan(&assetKey, &bodyKey, &wearableKey, &itemKey); err != nil {
			rows.Close()
			return nil, err
		}
		item := Product{}
		item.Provider, item.PackKey, item.PackName = purchaseSourceMetadata(assetKey, bodyKey, wearableKey, itemKey)
		items = append(items, item)
	}
	readErr := rows.Err()
	rows.Close()
	if readErr != nil {
		return nil, readErr
	}
	return productFacets(items), nil
}

// purchaseSourceMetadata 优先保留素材来源，只用已购稳定身份补齐退役图片缺失的来源。
func purchaseSourceMetadata(assetKey, bodyKey, wearableKey, itemKey string) (provider, packKey, packName string) {
	source, _ := assets.Get(assetKey)
	fallback := Product{CharacterKey: bodyKey, WearableKey: wearableKey}
	switch {
	case bodyKey != "":
		fallback.Type = TypeCharacter
	case wearableKey != "":
		fallback.Type = TypeWearable
	}
	applyProductCatalog(&fallback)
	if itemKey != "" {
		if item, found := island.SpatialFind(itemKey); found {
			fallback.Provider, fallback.PackKey, fallback.PackName = item.Provider, item.PackKey, item.PackName
		}
	}
	if source.Provider == "" {
		source.Provider = fallback.Provider
	}
	if source.PackKey == "" {
		source.PackKey = fallback.PackKey
	}
	if source.PackName == "" {
		source.PackName = fallback.PackName
	}
	return source.Provider, source.PackKey, source.PackName
}

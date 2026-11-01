package shop

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"fmt"

	"github.com/wookiisky/check-in-suite/internal/island"
)

// sceneOffer 声明场景初始报价，正式名称和缩略图由场景目录提供。
type sceneOffer struct {
	Key      string `json:"scene_key"`     // 永久空间身份。
	Coins    int64  `json:"coin_price"`    // 初始金币报价。
	Diamonds int64  `json:"diamond_price"` // 初始钻石报价。
}

//go:embed scene-products.json
var sceneOffersJSON []byte

// SeedSceneProducts 补入场景报价，重试不覆盖管理值或恢复已删除商品。
func SeedSceneProducts(ctx context.Context, db *sql.DB, now int64) error {
	var offers []sceneOffer
	if err := json.Unmarshal(sceneOffersJSON, &offers); err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, offer := range offers {
		scene, found := island.SpatialSceneFind(offer.Key)
		if !found || scene.Free {
			return fmt.Errorf("invalid paid scene offer %q", offer.Key)
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO products(id,type,name,asset_key,scene_key,description,coin_price,diamond_price,enabled,created_at,updated_at) VALUES(?,?,?,?,?,'',?,?,1,?,?) ON CONFLICT(id) DO NOTHING`, "scene-offer-"+scene.Key, TypeScene, scene.Name, scene.ThumbnailAssetKey, scene.Key, offer.Coins, offer.Diamonds, now, now)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE products SET asset_key=?,version=version+1,updated_at=? WHERE type=? AND scene_key=? AND asset_key!=?`, scene.ThumbnailAssetKey, now, TypeScene, scene.Key, scene.ThumbnailAssetKey); err != nil {
			return err
		}
	}
	return tx.Commit()
}

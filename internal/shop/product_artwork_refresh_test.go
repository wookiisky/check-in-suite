package shop_test

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/character"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/island"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// 插入旧报价的管理事实，模拟更新前已经存在而不是经过当前素材校验创建。
func historicalOffer(t *testing.T, f shopFixture, id, kind, identity, artwork string, enabled int, deleted any) {
	t.Helper()
	characterKey, sceneKey := "", ""
	if kind == shop.TypeCharacter {
		characterKey = identity
	} else if kind == shop.TypeScene {
		sceneKey = identity
	}
	_, err := f.DB.Exec(`INSERT INTO products(id,type,name,asset_key,character_key,scene_key,description,coin_price,diamond_price,stock,enabled,deleted_at,version,created_at,updated_at) VALUES(?,?,?, ?,?,?,?,7,0,3,?,?,5,11,12)`, id, kind, "管理名称", artwork, characterKey, sceneKey, "管理说明", enabled, deleted)
	if err != nil {
		t.Fatal(err)
	}
}

// 刷新只改变资源引用和确认版本，所有报价管理事实都保持原样。
func requireRefreshedOffer(t *testing.T, f shopFixture, id, artwork string, enabled int, deleted bool) {
	t.Helper()
	var key, name, description string
	var coins, diamonds, stock, actualEnabled, version, created, updated int64
	var hasDeleted bool
	err := f.DB.QueryRow(`SELECT asset_key,name,description,coin_price,diamond_price,stock,enabled,deleted_at IS NOT NULL,version,created_at,updated_at FROM products WHERE id=?`, id).Scan(&key, &name, &description, &coins, &diamonds, &stock, &actualEnabled, &hasDeleted, &version, &created, &updated)
	if err != nil {
		t.Fatal(err)
	}
	if key != artwork || name != "管理名称" || description != "管理说明" || coins != 7 || diamonds != 0 || stock != 3 || int(actualEnabled) != enabled || hasDeleted != deleted || version != 6 || created != 11 || updated != 100 {
		t.Fatalf("refresh changed managed facts: key=%s name=%s description=%s coins=%d diamonds=%d stock=%d enabled=%d deleted=%v version=%d created=%d updated=%d", key, name, description, coins, diamonds, stock, actualEnabled, hasDeleted, version, created, updated)
	}
}

// 角色及场景按稳定身份刷新全部报价，旧订单的图片快照不被更改。
func TestCharacterAndSceneSeedsRefreshOnlyVersionedArtwork(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	body, ok := character.Get("kaykit-skeleton-v1")
	if !ok {
		t.Fatal("missing basic skeleton")
	}
	scene, _ := island.SpatialSceneFind("forest-courtyard-v1")
	oldBody := "kaykit-adventurers-barbarian-m-a608430851cc-thumbnail"
	oldScene := "camp-sports-area-v1-thumbnail"
	historicalOffer(t, f, "old-character", shop.TypeCharacter, body.Key, oldBody, 1, nil)
	historicalOffer(t, f, "deleted-character", shop.TypeCharacter, body.Key, oldBody, 0, 13)
	historicalOffer(t, f, "old-scene", shop.TypeScene, scene.Key, oldScene, 1, nil)
	historicalOffer(t, f, "deleted-scene", shop.TypeScene, scene.Key, oldScene, 0, 13)
	_, err := f.DB.Exec(`INSERT INTO purchases(id,product_id,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,character_key_snapshot,coin_price,diamond_price,status,created_at) VALUES('historic-character-order','deleted-character','character','成交名称','成交说明',?,?,7,0,'owned',10)`, oldBody, body.Key)
	if err != nil {
		t.Fatal(err)
	}
	if err := shop.SeedCharacterProducts(ctx, f.DB, 100); err != nil {
		t.Fatal(err)
	}
	if err := shop.SeedSceneProducts(ctx, f.DB, 100); err != nil {
		t.Fatal(err)
	}
	for _, offer := range []struct {
		id, artwork string
		enabled     int
		deleted     bool
	}{{"old-character", body.ThumbnailAssetKey, 1, false}, {"deleted-character", body.ThumbnailAssetKey, 0, true}, {"old-scene", scene.ThumbnailAssetKey, 1, false}, {"deleted-scene", scene.ThumbnailAssetKey, 0, true}} {
		requireRefreshedOffer(t, f, offer.id, offer.artwork, offer.enabled, offer.deleted)
	}
	if err := shop.SeedCharacterProducts(ctx, f.DB, 101); err != nil {
		t.Fatal(err)
	}
	if err := shop.SeedSceneProducts(ctx, f.DB, 101); err != nil {
		t.Fatal(err)
	}
	requireRefreshedOffer(t, f, "old-character", body.ThumbnailAssetKey, 1, false)
	requireRefreshedOffer(t, f, "old-scene", scene.ThumbnailAssetKey, 1, false)
	var retained string
	if err := f.DB.QueryRow(`SELECT asset_key_snapshot FROM purchases WHERE id='historic-character-order'`).Scan(&retained); err != nil || retained != oldBody {
		t.Fatalf("historical artwork=%s err=%v", retained, err)
	}
	balance := creditFixture(t, f, 20, 0)
	_, err = f.Service.Buy(ctx, f.Principal, core.ID(), shop.BuyInput{ProductID: "old-scene", ExpectedProductVersion: 5, ExpectedWalletVersion: balance.Version})
	requireShopCode(t, err, "PRODUCT_CHANGED")
	order, err := f.Service.Buy(ctx, f.Principal, core.ID(), shop.BuyInput{ProductID: "old-scene", ExpectedProductVersion: 6, ExpectedWalletVersion: balance.Version})
	if err != nil || order.Purchase.SceneKey != scene.Key || order.Purchase.AssetKeySnapshot != scene.ThumbnailAssetKey {
		t.Fatalf("refreshed scene purchase=%+v err=%v", order, err)
	}
}

// 旧角色报价刷新后仍按同一人物成交，购买资格与身体权益没有依赖旧图片。
func TestCharacterSeedRefreshAllowsBuyingHistoricalOffer(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	body, ok := character.Get("kaykit-skeleton-v1")
	if !ok {
		t.Fatal("missing basic skeleton")
	}
	historicalOffer(t, f, "old-character", shop.TypeCharacter, body.Key, "kaykit-adventurers-barbarian-m-a608430851cc-thumbnail", 1, nil)
	if err := shop.SeedCharacterProducts(ctx, f.DB, 100); err != nil {
		t.Fatal(err)
	}
	balance := creditFixture(t, f, 20, 0)
	order, err := f.Service.Buy(ctx, f.Principal, core.ID(), shop.BuyInput{ProductID: "old-character", ExpectedProductVersion: 6, ExpectedWalletVersion: balance.Version})
	if err != nil || order.Purchase.CharacterKey != body.Key || order.Purchase.AssetKeySnapshot != body.ThumbnailAssetKey {
		t.Fatalf("historical character purchase=%+v err=%v", order, err)
	}
	saved, err := f.Service.SaveAppearance(ctx, f.Principal, shop.SaveAppearanceInput{ExpectedVersion: 1, CharacterKey: body.Key})
	if err != nil || saved.CharacterKey != body.Key || len(saved.Inventory) != 0 {
		t.Fatalf("historical offer lost character capability: %+v err=%v", saved, err)
	}
}

// 全部历史物件缩略图按明确别名恢复能力，自建旧报价刷新后购买仍产生同一物件实例。
func TestSpatialSeedRefreshesHistoricalOffersByStableIdentity(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	data, err := os.ReadFile("../island/spatial-thumbnail-aliases.json")
	if err != nil {
		t.Fatal(err)
	}
	var history struct {
		Aliases map[string]string `json:"aliases"`
	}
	if err := json.Unmarshal(data, &history); err != nil {
		t.Fatal(err)
	}
	if len(history.Aliases) < 91 {
		t.Fatalf("missing historical source mapping: %d", len(history.Aliases))
	}
	firstID, firstKey, firstArtwork := "", "", ""
	index := 0
	for old, key := range history.Aliases {
		definition, found := island.SpatialFind(key)
		if !found || definition.Free {
			t.Fatalf("alias target unavailable: %s -> %s", old, key)
		}
		resolved, found := island.SpatialForThumbnail(old)
		if !found || resolved.Key != key {
			t.Fatalf("historical thumbnail lost capability: %s -> %+v", old, resolved)
		}
		id := core.ID()
		var deleted any
		enabled := 1
		if index%2 == 1 {
			deleted, enabled = 13, 0
		}
		historicalOffer(t, f, id, shop.TypeIsland, key, old, enabled, deleted)
		if firstID == "" {
			firstID, firstKey, firstArtwork = id, key, definition.ThumbnailAssetKey
			_, err := f.DB.Exec(`INSERT INTO purchases(id,product_id,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,item_key_snapshot,repeatable,coin_price,diamond_price,status,created_at) VALUES('historic-island-order',?,'island','成交名称','成交说明',?,?,1,7,0,'owned',10)`, id, old, key)
			if err != nil {
				t.Fatal(err)
			}
		}
		index++
	}
	if err := shop.SeedSpatialProducts(ctx, f.DB, 100); err != nil {
		t.Fatal(err)
	}
	var changed int
	if err := f.DB.QueryRow(`SELECT count(*) FROM products WHERE name='管理名称' AND version=6 AND coin_price=7 AND diamond_price=0 AND stock=3 AND description='管理说明' AND created_at=11 AND updated_at=100`).Scan(&changed); err != nil || changed != len(history.Aliases) {
		t.Fatalf("managed spatial updates=%d want=%d err=%v", changed, len(history.Aliases), err)
	}
	if err := shop.SeedSpatialProducts(ctx, f.DB, 101); err != nil {
		t.Fatal(err)
	}
	requireRefreshedOffer(t, f, firstID, firstArtwork, 1, false)
	balance := creditFixture(t, f, 20, 0)
	order, err := f.Service.Buy(ctx, f.Principal, core.ID(), shop.BuyInput{ProductID: firstID, ExpectedProductVersion: 6, ExpectedWalletVersion: balance.Version})
	if err != nil || order.Purchase.ItemKeySnapshot != firstKey || order.Purchase.AssetKeySnapshot != firstArtwork {
		t.Fatalf("historical offer lost instance identity: %+v err=%v", order, err)
	}
	var oldArtwork string
	if err := f.DB.QueryRow(`SELECT asset_key_snapshot FROM purchases WHERE id='historic-island-order'`).Scan(&oldArtwork); err != nil || history.Aliases[oldArtwork] != firstKey {
		t.Fatalf("old order rewritten: key=%s err=%v", oldArtwork, err)
	}
}

// 刷新失败必须回滚同次补入的报价，修复数据库故障后可以重试。
func TestSpatialArtworkRefreshFailureRollsBackSeed(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	const old = "kaykit-furniture-bits-cactus-medium-a-fe0b9b-8c461dde-thumb"
	definition, found := island.SpatialForThumbnail(old)
	if !found {
		t.Fatal("missing original published thumbnail identity")
	}
	historicalOffer(t, f, "historical-cactus", shop.TypeIsland, definition.Key, old, 1, nil)
	if _, err := f.DB.Exec(`CREATE TRIGGER reject_artwork_refresh BEFORE UPDATE OF asset_key ON products WHEN OLD.id='historical-cactus' BEGIN SELECT RAISE(ABORT,'artwork refresh failure'); END;`); err != nil {
		t.Fatal(err)
	}
	if err := shop.SeedSpatialProducts(ctx, f.DB, 100); err == nil {
		t.Fatal("failed artwork refresh was reported successful")
	}
	var count, version int
	var retained string
	if err := f.DB.QueryRow(`SELECT count(*) FROM products`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("failed refresh left seed products: %d err=%v", count, err)
	}
	if err := f.DB.QueryRow(`SELECT asset_key,version FROM products WHERE id='historical-cactus'`).Scan(&retained, &version); err != nil || retained != old || version != 5 {
		t.Fatalf("failed refresh changed legacy quote: %s version=%d err=%v", retained, version, err)
	}
	if _, err := f.DB.Exec(`DROP TRIGGER reject_artwork_refresh`); err != nil {
		t.Fatal(err)
	}
	if err := shop.SeedSpatialProducts(ctx, f.DB, 100); err != nil {
		t.Fatal(err)
	}
	requireRefreshedOffer(t, f, "historical-cactus", definition.ThumbnailAssetKey, 1, false)
}

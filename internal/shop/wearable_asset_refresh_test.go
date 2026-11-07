package shop_test

import (
	"context"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/character"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// 新图片按穿戴身份刷新已有报价，包括自建的形象报价，管理事实及订单不变。
func TestWearableSeedRefreshesExistingArtworkAndFaceQuotes(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	if err := f.Accounts.Initialize(ctx, "artwork-other", "其他账户", "artwork-login-password", "artwork-management-password"); err != nil {
		t.Fatal(err)
	}
	var secondID int64
	if err := f.DB.QueryRow("SELECT id FROM accounts WHERE username='artwork-other'").Scan(&secondID); err != nil {
		t.Fatal(err)
	}
	head, ok := character.GetWearable("kaykit-adventurers-knight-head")
	if !ok {
		t.Fatal("missing alternate headwear")
	}
	face, ok := character.GetWearable("face-kaykit-legacy-skeleton-minion")
	if !ok {
		t.Fatal("missing alternate face definition")
	}
	const oldArtwork = "historical-wearable-thumbnail"
	for _, quote := range []struct {
		id        string // 报价可以由用户自建，不依赖初始化 ID。
		key       string // 报价引用的稳定穿戴身份。
		accountID int64  // 刷新必须受初始化账户限制。
		enabled   int    // 原上下架事实。
		deleted   any    // 原软删除事实。
	}{
		{"wearable-offer-" + head.Key, head.Key, f.Principal.AccountID, 1, nil},
		{"custom-wearable", head.Key, f.Principal.AccountID, 0, nil},
		{"managed-face", face.Key, f.Principal.AccountID, 0, 13},
		{"other-wearable", head.Key, secondID, 1, nil},
	} {
		_, err := f.DB.Exec(`INSERT INTO products(id,account_id,type,name,asset_key,wearable_key,description,coin_price,diamond_price,stock,enabled,deleted_at,version,created_at,updated_at) VALUES(?,?,'wearable','管理名称',?,?,'管理说明',7,0,3,?,?,5,11,12)`, quote.id, quote.accountID, oldArtwork, quote.key, quote.enabled, quote.deleted)
		if err != nil {
			t.Fatal(err)
		}
	}
	_, err := f.DB.Exec(`INSERT INTO purchases(id,account_id,product_id,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,wearable_key_snapshot,coin_price,diamond_price,status,created_at) VALUES('historic-wearable-order',?,'managed-face','wearable','成交名称','成交说明',?,?,7,0,'owned',10)`, f.Principal.AccountID, oldArtwork, face.Key)
	if err != nil {
		t.Fatal(err)
	}
	if err := shop.SeedCatalogForAccount(ctx, f.DB, f.Principal.AccountID, 100); err != nil {
		t.Fatal(err)
	}
	requireRefreshedOffer(t, f, "wearable-offer-"+head.Key, head.ThumbnailAssetKey, 1, false)
	requireRefreshedOffer(t, f, "custom-wearable", head.ThumbnailAssetKey, 0, false)
	requireRefreshedOffer(t, f, "managed-face", face.ThumbnailAssetKey, 0, true)
	var otherArtwork string
	var otherVersion, otherUpdated int64
	if err := f.DB.QueryRow("SELECT asset_key,version,updated_at FROM products WHERE id='other-wearable'").Scan(&otherArtwork, &otherVersion, &otherUpdated); err != nil || otherArtwork != oldArtwork || otherVersion != 5 || otherUpdated != 12 {
		t.Fatalf("other account changed: artwork=%s version=%d updated=%d err=%v", otherArtwork, otherVersion, otherUpdated, err)
	}
	if err := shop.SeedCatalogForAccount(ctx, f.DB, f.Principal.AccountID, 101); err != nil {
		t.Fatal(err)
	}
	requireRefreshedOffer(t, f, "wearable-offer-"+head.Key, head.ThumbnailAssetKey, 1, false)
	requireRefreshedOffer(t, f, "managed-face", face.ThumbnailAssetKey, 0, true)
	var snapshotArtwork, snapshotName, snapshotDescription, snapshotKey string
	if err := f.DB.QueryRow("SELECT asset_key_snapshot,name_snapshot,description_snapshot,wearable_key_snapshot FROM purchases WHERE id='historic-wearable-order'").Scan(&snapshotArtwork, &snapshotName, &snapshotDescription, &snapshotKey); err != nil || snapshotArtwork != oldArtwork || snapshotName != "成交名称" || snapshotDescription != "成交说明" || snapshotKey != face.Key {
		t.Fatalf("historical snapshot changed: artwork=%s name=%s description=%s key=%s err=%v", snapshotArtwork, snapshotName, snapshotDescription, snapshotKey, err)
	}
	balance := creditFixture(t, f, 20, 0)
	_, err = f.Service.Buy(ctx, f.Principal, core.ID(), shop.BuyInput{ProductID: "wearable-offer-" + head.Key, ExpectedProductVersion: 5, ExpectedWalletVersion: balance.Version})
	requireShopCode(t, err, "PRODUCT_CHANGED")
	order, err := f.Service.Buy(ctx, f.Principal, core.ID(), shop.BuyInput{ProductID: "wearable-offer-" + head.Key, ExpectedProductVersion: 6, ExpectedWalletVersion: balance.Version})
	if err != nil || order.Purchase.WearableKey != head.Key || order.Purchase.AssetKeySnapshot != head.ThumbnailAssetKey {
		t.Fatalf("refreshed wearable purchase=%+v err=%v", order, err)
	}
}

// 素材刷新失败时同次新增报价一起回滚，移除数据库故障后可重试。
func TestWearableArtworkRefreshFailureRollsBackSeed(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	item, ok := character.GetWearable("face-kaykit-legacy-skeleton-minion")
	if !ok {
		t.Fatal("missing alternate face definition")
	}
	_, err := f.DB.Exec(`INSERT INTO products(id,type,name,asset_key,wearable_key,description,coin_price,diamond_price,enabled,version,created_at,updated_at) VALUES('broken-artwork','wearable','原报价','historical-wearable-thumbnail',?,'',7,0,1,5,11,12)`, item.Key)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.DB.Exec(`CREATE TRIGGER reject_wearable_artwork BEFORE UPDATE OF asset_key ON products WHEN OLD.id='broken-artwork' BEGIN SELECT RAISE(ABORT,'wearable artwork refresh failure'); END;`); err != nil {
		t.Fatal(err)
	}
	if err := shop.SeedWearableProducts(ctx, f.DB, 100); err == nil {
		t.Fatal("expected artwork refresh failure")
	}
	var count int
	var artwork string
	var version int64
	if err := f.DB.QueryRow("SELECT count(*) FROM products").Scan(&count); err != nil || count != 1 {
		t.Fatalf("failed seed left new offers: count=%d err=%v", count, err)
	}
	if err := f.DB.QueryRow("SELECT asset_key,version FROM products WHERE id='broken-artwork'").Scan(&artwork, &version); err != nil || artwork != "historical-wearable-thumbnail" || version != 5 {
		t.Fatalf("failed refresh changed existing offer: artwork=%s version=%d err=%v", artwork, version, err)
	}
	if _, err := f.DB.Exec("DROP TRIGGER reject_wearable_artwork"); err != nil {
		t.Fatal(err)
	}
	if err := shop.SeedWearableProducts(ctx, f.DB, 100); err != nil {
		t.Fatal(err)
	}
	if err := f.DB.QueryRow("SELECT asset_key,version FROM products WHERE id='broken-artwork'").Scan(&artwork, &version); err != nil || artwork != item.ThumbnailAssetKey || version != 6 {
		t.Fatalf("retry did not refresh alternate face quote: artwork=%s version=%d err=%v", artwork, version, err)
	}
}

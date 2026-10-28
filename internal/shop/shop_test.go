package shop_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// TestPurchaseReplayAndOwnership proves atomic dual-currency payment and stable permanent ownership.
func TestPurchaseReplayAndOwnership(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	balance := creditFixture(t, f, 20, 5)
	input := productInput("avatar")
	input.CoinPrice = 8
	input.DiamondPrice = 3
	stock := int64(1)
	input.Stock = &stock
	p := createProduct(t, f, input)
	command := shop.BuyInput{ProductID: p.ID, ExpectedProductVersion: p.Version, ExpectedWalletVersion: balance.Version}
	first, err := f.Service.Buy(ctx, f.Principal, "purchase-once", command)
	if err != nil {
		t.Fatal(err)
	}
	if first.Wallet.Coins != 12 || first.Wallet.Diamonds != 2 || first.Purchase.Status != "owned" {
		t.Fatalf("%+v", first)
	}
	if _, err = f.Service.SetSlot(ctx, f.Principal, "avatar", &first.Purchase.ID); err != nil {
		t.Fatal(err)
	}
	if err = f.Service.DeleteProduct(ctx, f.Principal, p.ID, 2); err != nil {
		t.Fatal(err)
	}
	replay, err := f.Service.Buy(ctx, f.Principal, "purchase-once", command)
	if err != nil {
		t.Fatal(err)
	}
	if replay.Purchase.ID != first.Purchase.ID || replay.Wallet != first.Wallet {
		t.Fatalf("replay=%+v", replay)
	}
	equipment, err := f.Service.Equipment(ctx, f.Principal)
	if err != nil || equipment.Avatar == nil || equipment.Avatar.ID != first.Purchase.ID {
		t.Fatalf("%+v %v", equipment, err)
	}
	command.ExpectedWalletVersion++
	_, err = f.Service.Buy(ctx, f.Principal, "purchase-once", command)
	requireShopCode(t, err, "IDEMPOTENCY_CONFLICT")
	if err = f.Accounts.Logout(ctx, f.Principal); err != nil {
		t.Fatal(err)
	}
	command.ExpectedWalletVersion--
	_, err = f.Service.Buy(ctx, f.Principal, "purchase-once", command)
	requireShopCode(t, err, "SESSION_REQUIRED")
	if got := readBalance(t, f); got.Coins != 12 || got.Diamonds != 2 {
		t.Fatal(got)
	}
}

// TestPurchaseFailuresAndRollback refuses stale confirmations, insufficient currencies and partial commits.
func TestPurchaseFailuresAndRollback(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	balance := creditFixture(t, f, 10, 1)
	input := productInput("reward")
	input.CoinPrice = 2
	input.DiamondPrice = 2
	stock := int64(2)
	input.Stock = &stock
	p := createProduct(t, f, input)
	command := shop.BuyInput{ProductID: p.ID, ExpectedProductVersion: p.Version, ExpectedWalletVersion: balance.Version}
	_, err := f.Service.Buy(ctx, f.Principal, "insufficient", command)
	requireShopCode(t, err, "INSUFFICIENT_BALANCE")
	input.DiamondPrice = 1
	p, err = f.Service.UpdateProduct(ctx, f.Principal, p.ID, shop.ProductUpdate{ProductInput: input, ExpectedVersion: p.Version})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.Service.Buy(ctx, f.Principal, "stale-product", command)
	requireShopCode(t, err, "PRODUCT_CHANGED")
	command.ExpectedProductVersion = p.Version
	command.ExpectedWalletVersion = 0
	_, err = f.Service.Buy(ctx, f.Principal, "stale-wallet", command)
	requireShopCode(t, err, "WALLET_CHANGED")
	command.ExpectedWalletVersion = balance.Version
	if _, err = f.DB.Exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON idempotency_requests WHEN NEW.operation='purchase.create' BEGIN SELECT RAISE(ABORT,'test receipt failure'); END"); err != nil {
		t.Fatal(err)
	}
	if _, err = f.Service.Buy(ctx, f.Principal, "rollback", command); err == nil {
		t.Fatal("expected injected receipt failure")
	}
	if got := readBalance(t, f); got != balance {
		t.Fatalf("partial wallet update: %+v", got)
	}
	var count int
	if err = f.DB.QueryRow("SELECT count(*) FROM purchases").Scan(&count); err != nil || count != 0 {
		t.Fatalf("purchases=%d %v", count, err)
	}
	if err = f.DB.QueryRow("SELECT stock FROM products WHERE id=?", p.ID).Scan(&stock); err != nil || stock != 2 {
		t.Fatalf("stock was partially decremented: %d %v", stock, err)
	}
}

// TestProductsAndRewards preserves snapshots and requires a fresh password for each redemption.
func TestProductsAndRewards(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	input := productInput("reward")
	p := createProduct(t, f, input)
	first := buyProduct(t, f, p)
	second := buyProduct(t, f, p)
	if first.Purchase.ID == second.Purchase.ID {
		t.Fatal("repeatable reward reused ownership")
	}
	input.Name = "新的商品名称"
	input.Description = "仅影响后续购买"
	input.CoinPrice = 10
	p, err := f.Service.UpdateProduct(ctx, f.Principal, p.ID, shop.ProductUpdate{ProductInput: input, ExpectedVersion: p.Version})
	if err != nil {
		t.Fatal(err)
	}
	prior, err := f.Service.ListPurchases(ctx, f.Principal, shop.PurchaseQuery{Type: "reward"})
	if err != nil || len(prior.Items) != 2 || prior.Items[0].NameSnapshot != first.Purchase.NameSnapshot || prior.Items[0].CoinPrice != 0 {
		t.Fatalf("purchase snapshot was rewritten: %+v %v", prior, err)
	}
	input.Type = "avatar"
	input.AssetKey = "fox-v1"
	_, err = f.Service.UpdateProduct(ctx, f.Principal, p.ID, shop.ProductUpdate{ProductInput: input, ExpectedVersion: p.Version})
	requireShopCode(t, err, "PRODUCT_TYPE_LOCKED")
	_, err = f.Service.Redeem(ctx, f.Principal, first.Purchase.ID, "wrong-password")
	requireShopCode(t, err, "INVALID_CREDENTIALS")
	if err = f.Accounts.Lock(ctx, f.Principal); err != nil {
		t.Fatal(err)
	}
	redeemed, err := f.Service.Redeem(ctx, f.Principal, first.Purchase.ID, "shop-management-password")
	if err != nil || redeemed.Status != "redeemed" || redeemed.RedeemedAt == nil {
		t.Fatalf("%+v %v", redeemed, err)
	}
	again, err := f.Service.Redeem(ctx, f.Principal, first.Purchase.ID, "shop-management-password")
	if err != nil || again.Version != redeemed.Version {
		t.Fatalf("%+v %v", again, err)
	}
	state, err := f.Accounts.Session(ctx, f.Principal)
	if err != nil || state.ManagementExpiresAt != nil {
		t.Fatalf("redemption unlocked management: %+v %v", state, err)
	}
	page, err := f.Service.ListPurchases(ctx, f.Principal, shop.PurchaseQuery{Type: "reward", Limit: 1})
	if err != nil || len(page.Items) != 1 || page.NextCursor == nil {
		t.Fatalf("%+v %v", page, err)
	}
	page2, err := f.Service.ListPurchases(ctx, f.Principal, shop.PurchaseQuery{Type: "reward", Limit: 1, Cursor: *page.NextCursor})
	if err != nil || len(page2.Items) != 1 || page2.Items[0].ID == page.Items[0].ID || page2.NextCursor != nil {
		t.Fatalf("%+v %v", page2, err)
	}
	if got := readBalance(t, f); got.Coins != 0 || got.Diamonds != 0 || got.Version != 3 {
		t.Fatal(got)
	}
}

// TestManagementCreationReplayRequiresFreshUnlock cannot use an old receipt to bypass a locked session.
func TestManagementCreationReplayRequiresFreshUnlock(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	input := productInput("title")
	first, err := f.Service.CreateProduct(ctx, f.Principal, "managed-create", input)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.Accounts.Lock(ctx, f.Principal); err != nil {
		t.Fatal(err)
	}
	_, err = f.Service.CreateProduct(ctx, f.Principal, "managed-create", input)
	requireShopCode(t, err, "MANAGEMENT_REQUIRED")
	_, err = f.Service.ListProducts(ctx, f.Principal, true)
	requireShopCode(t, err, "MANAGEMENT_REQUIRED")
	if _, err = f.Accounts.Unlock(ctx, f.Principal, "shop-management-password"); err != nil {
		t.Fatal(err)
	}
	again, err := f.Service.CreateProduct(ctx, f.Principal, "managed-create", input)
	if err != nil || first.ID != again.ID {
		t.Fatalf("%+v %v", again, err)
	}
}

// TestEquipmentLimitAndIndependentSlots preserves all other slots and profile versions.
func TestEquipmentLimitAndIndependentSlots(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	avatar := buyProduct(t, f, createProduct(t, f, productInput("avatar")))
	title := buyProduct(t, f, createProduct(t, f, productInput("title")))
	equipment, err := f.Service.Equipment(ctx, f.Principal)
	if err != nil || equipment.Avatar != nil || equipment.Title != nil || len(equipment.Accessories) != 0 {
		t.Fatalf("purchase auto-equipped: %+v %v", equipment, err)
	}
	if _, err = f.Service.SetSlot(ctx, f.Principal, "avatar", &avatar.Purchase.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.Service.SetSlot(ctx, f.Principal, "title", &title.Purchase.ID); err != nil {
		t.Fatal(err)
	}
	var accessories []shop.Purchase
	for i := 0; i < 11; i++ {
		p := buyProduct(t, f, createProduct(t, f, productInput("accessory"))).Purchase
		accessories = append(accessories, p)
		if i < 10 {
			if _, err = f.Service.SetAccessory(ctx, f.Principal, p.ID, true); err != nil {
				t.Fatal(err)
			}
		}
	}
	_, err = f.Service.SetAccessory(ctx, f.Principal, accessories[10].ID, true)
	requireShopCode(t, err, "ACCESSORY_LIMIT")
	if _, err = f.Service.SetAccessory(ctx, f.Principal, accessories[0].ID, true); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err = f.Service.SetAccessory(ctx, f.Principal, accessories[0].ID, false); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = f.Service.SetAccessory(ctx, f.Principal, accessories[10].ID, true); err != nil {
		t.Fatal(err)
	}
	_, err = f.Service.SetSlot(ctx, f.Principal, "avatar", &title.Purchase.ID)
	requireShopCode(t, err, "INVALID_EQUIPMENT")
	equipment, err = f.Service.SetSlot(ctx, f.Principal, "title", nil)
	if err != nil || equipment.Title != nil || equipment.Avatar == nil || len(equipment.Accessories) != 10 {
		t.Fatalf("%+v %v", equipment, err)
	}
	state, err := f.Accounts.Session(ctx, f.Principal)
	if err != nil || state.Account.Version != 1 {
		t.Fatalf("profile version changed: %+v %v", state, err)
	}
}

// TestProductValidationAndNullStock verifies actual JSON null and controlled asset constraints.
func TestProductValidationAndNullStock(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	input := productInput("reward")
	input.Name = "   "
	_, err := f.Service.CreateProduct(ctx, f.Principal, core.ID(), input)
	requireShopCode(t, err, "INVALID_REQUEST")
	input = productInput("reward")
	input.AssetKey = "../../private"
	_, err = f.Service.CreateProduct(ctx, f.Principal, core.ID(), input)
	requireShopCode(t, err, "INVALID_REQUEST")
	input = productInput("reward")
	negative := int64(-1)
	input.Stock = &negative
	_, err = f.Service.CreateProduct(ctx, f.Principal, core.ID(), input)
	requireShopCode(t, err, "INVALID_REQUEST")
	p := createProduct(t, f, productInput("reward"))
	data, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err = json.Unmarshal(data, &wire); err != nil {
		t.Fatal(err)
	}
	if value, exists := wire["stock"]; !exists || value != nil {
		t.Fatalf("stock must serialize as null: %s", data)
	}
}

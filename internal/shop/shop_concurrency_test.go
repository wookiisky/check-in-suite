package shop_test

import (
	"context"
	"sync"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/checkin"
	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/shop"
)

// compete releases two actual services together; the fixture assigns independent SQLite pools.
func compete(first, second func() error) [2]error {
	var results [2]error
	start := make(chan struct{})
	var ready, done sync.WaitGroup
	ready.Add(2)
	done.Add(2)
	for index, operation := range []func() error{first, second} {
		go func() { defer done.Done(); ready.Done(); <-start; results[index] = operation() }()
	}
	ready.Wait()
	close(start)
	done.Wait()
	return results
}

// requireOneSuccess checks the serializable winner without depending on scheduler ordering.
func requireOneSuccess(t *testing.T, results [2]error) {
	t.Helper()
	successes := 0
	for _, err := range results {
		if err == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("expected one committed operation: %v", results)
	}
}

// TestConcurrentLastStockAndPermanentOrder uses independent connections to compete for one economic fact.
func TestConcurrentLastStockAndPermanentOrder(t *testing.T) {
	for _, kind := range []string{"reward", "avatar"} {
		t.Run(kind, func(t *testing.T) {
			f := newShopFixture(t)
			ctx := context.Background()
			input := productInput(kind)
			if kind == "reward" {
				stock := int64(1)
				input.Stock = &stock
			}
			p := createProduct(t, f, input)
			command := shop.BuyInput{ProductID: p.ID, ExpectedProductVersion: 1, ExpectedWalletVersion: 1}
			results := compete(func() error { _, err := f.Service.Buy(ctx, f.Principal, "race-one", command); return err }, func() error { _, err := f.Contender.Buy(ctx, f.Principal, "race-two", command); return err })
			requireOneSuccess(t, results)
			var orders, debits int
			if err := f.DB.QueryRow("SELECT count(*) FROM purchases").Scan(&orders); err != nil {
				t.Fatal(err)
			}
			if err := f.DB.QueryRow("SELECT count(*) FROM wallet_entries WHERE event_type='purchase_debit'").Scan(&debits); err != nil {
				t.Fatal(err)
			}
			if orders != 1 || debits != 1 {
				t.Fatalf("orders=%d debits=%d", orders, debits)
			}
			balance := readBalance(t, f)
			if balance.Version != 2 || balance.Coins != 0 || balance.Diamonds != 0 {
				t.Fatal(balance)
			}
			if kind == "reward" {
				var stock int64
				if err := f.DB.QueryRow("SELECT stock FROM products WHERE id=?", p.ID).Scan(&stock); err != nil || stock != 0 {
					t.Fatalf("stock=%d %v", stock, err)
				}
			} else {
				command.ExpectedWalletVersion = balance.Version
				_, err := f.Service.Buy(ctx, f.Principal, "owned-retry", command)
				requireShopCode(t, err, "ALREADY_OWNED")
			}
		})
	}
}

// TestConcurrentSamePurchaseKey replays one committed order even when both calls start together.
func TestConcurrentSamePurchaseKey(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	p := createProduct(t, f, productInput("reward"))
	command := shop.BuyInput{ProductID: p.ID, ExpectedProductVersion: 1, ExpectedWalletVersion: 1}
	var a, b shop.PurchaseResult
	results := compete(func() error { var err error; a, err = f.Service.Buy(ctx, f.Principal, "same-key", command); return err }, func() error {
		var err error
		b, err = f.Contender.Buy(ctx, f.Principal, "same-key", command)
		return err
	})
	if results[0] != nil || results[1] != nil || a.Purchase.ID != b.Purchase.ID || a.Wallet != b.Wallet {
		t.Fatalf("%v first=%+v second=%+v", results, a, b)
	}
	if balance := readBalance(t, f); balance.Version != 2 {
		t.Fatal(balance)
	}
}

// TestConcurrentTenthAccessory serializes checking the bound and inserting a new decoration.
func TestConcurrentTenthAccessory(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	var items []shop.Purchase
	for i := 0; i < 11; i++ {
		purchase := buyProduct(t, f, createProduct(t, f, productInput("accessory"))).Purchase
		items = append(items, purchase)
		if i < 9 {
			if _, err := f.Service.SetAccessory(ctx, f.Principal, purchase.ID, true); err != nil {
				t.Fatal(err)
			}
		}
	}
	results := compete(func() error { _, err := f.Service.SetAccessory(ctx, f.Principal, items[9].ID, true); return err }, func() error { _, err := f.Contender.SetAccessory(ctx, f.Principal, items[10].ID, true); return err })
	requireOneSuccess(t, results)
	equipment, err := f.Service.Equipment(ctx, f.Principal)
	if err != nil || len(equipment.Accessories) != 10 {
		t.Fatalf("%+v %v", equipment, err)
	}
	for _, item := range items[:9] {
		found := false
		for _, equipped := range equipment.Accessories {
			found = found || equipped.ID == item.ID
		}
		if !found {
			t.Fatalf("preexisting accessory lost: %s", item.ID)
		}
	}
}

// TestDeletionAfterSpendingRetainsOutfit rejects a free purchase when either spendable currency is negative.
func TestDeletionAfterSpendingRetainsOutfit(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	creditFixture(t, f, 10, 2)
	input := productInput("avatar")
	input.CoinPrice = 8
	input.DiamondPrice = 1
	purchase := buyProduct(t, f, createProduct(t, f, input)).Purchase
	if _, err := f.Service.SetSlot(ctx, f.Principal, "avatar", &purchase.ID); err != nil {
		t.Fatal(err)
	}
	var recordID string
	if err := f.DB.QueryRow("SELECT id FROM checkins LIMIT 1").Scan(&recordID); err != nil {
		t.Fatal(err)
	}
	checkins := checkin.New(f.DB, f.Accounts, config.Defaults())
	checkins.Now = f.Service.Now
	deleted, err := checkins.Delete(ctx, f.Principal, false, recordID, 1)
	if err != nil || deleted.Wallet.Coins != -8 || deleted.Wallet.Diamonds != -1 {
		t.Fatalf("%+v %v", deleted, err)
	}
	free := createProduct(t, f, productInput("reward"))
	balance := readBalance(t, f)
	_, err = f.Service.Buy(ctx, f.Principal, "free-with-negative", shop.BuyInput{ProductID: free.ID, ExpectedProductVersion: free.Version, ExpectedWalletVersion: balance.Version})
	requireShopCode(t, err, "INSUFFICIENT_BALANCE")
	equipment, err := f.Service.Equipment(ctx, f.Principal)
	if err != nil || equipment.Avatar == nil || equipment.Avatar.ID != purchase.ID {
		t.Fatalf("outfit revoked: %+v %v", equipment, err)
	}
}

// TestDeleteCompetesWithPurchase verifies both services share a serializable wallet and immutable ledger.
func TestDeleteCompetesWithPurchase(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	balance := creditFixture(t, f, 10, 0)
	var recordID string
	if err := f.DB.QueryRow("SELECT id FROM checkins LIMIT 1").Scan(&recordID); err != nil {
		t.Fatal(err)
	}
	input := productInput("reward")
	input.CoinPrice = 8
	p := createProduct(t, f, input)
	checkins := checkin.New(f.Other, f.Accounts, config.Defaults())
	checkins.Now = f.Service.Now
	results := compete(func() error {
		_, err := f.Service.Buy(ctx, f.Principal, "spend-before-revoke", shop.BuyInput{ProductID: p.ID, ExpectedProductVersion: p.Version, ExpectedWalletVersion: balance.Version})
		return err
	}, func() error { _, err := checkins.Delete(ctx, f.Principal, false, recordID, 1); return err })
	if results[1] != nil {
		t.Fatalf("revocation must always succeed: %v", results)
	}
	got := readBalance(t, f)
	expected := int64(0)
	if results[0] == nil {
		expected = -8
	} else {
		requireShopCode(t, results[0], "WALLET_CHANGED")
	}
	if got.Coins != expected || got.Diamonds != 0 {
		t.Fatalf("%+v results=%v", got, results)
	}
}

// TestConcurrentRedemption changes one reward state without another currency event.
func TestConcurrentRedemption(t *testing.T) {
	f := newShopFixture(t)
	ctx := context.Background()
	purchase := buyProduct(t, f, createProduct(t, f, productInput("reward"))).Purchase
	var first, second shop.Purchase
	results := compete(func() error {
		var err error
		first, err = f.Service.Redeem(ctx, f.Principal, purchase.ID, "shop-management-password")
		return err
	}, func() error {
		var err error
		second, err = f.Contender.Redeem(ctx, f.Principal, purchase.ID, "shop-management-password")
		return err
	})
	if results[0] != nil || results[1] != nil || first.Version != 2 || second.Version != 2 || first.Status != "redeemed" || second.Status != "redeemed" {
		t.Fatalf("%v %+v %+v", results, first, second)
	}
	if b := readBalance(t, f); b.Version != 2 {
		t.Fatal(b)
	}
}

package shop

import (
	"context"
	"log/slog"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/wallet"
)

// DevelopmentBuyAll grants one of each unowned shop item without consuming stock or currency.
func (s *Service) DevelopmentBuyAll(ctx context.Context, principal account.Principal) (wallet.Balance, error) {
	var balance wallet.Balance
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return balance, err
	}
	defer tx.Rollback()

	now := s.Now()
	if err := account.Authorize(ctx, tx, principal, false, now); err != nil {
		return balance, err
	}
	accountID := principal.AccountID
	rows, err := tx.QueryContext(ctx, activeShopOffers+" AND p.type IN (?,?,?,?) ORDER BY p.created_at,p.id",
		accountID, TypeCharacter, TypeWearable, TypeIsland, TypeScene)
	if err != nil {
		return balance, err
	}
	var products []Product
	for rows.Next() {
		product, err := scanProduct(rows)
		if err != nil {
			rows.Close()
			return balance, err
		}
		products = append(products, product)
	}
	readErr := rows.Err()
	rows.Close()
	if readErr != nil {
		return balance, readErr
	}
	if err := applyProductOwnership(ctx, tx, accountID, products, true); err != nil {
		return balance, err
	}
	balance, err = wallet.Get(ctx, tx, accountID)
	if err != nil {
		return balance, err
	}

	granted := map[ownershipIdentity]bool{}
	count := 0
	for _, product := range products {
		if product.Owned {
			continue
		}
		identity := stableOwnershipIdentity(product, true)
		if identity == (ownershipIdentity{}) {
			identity.Product = product.ID
		}
		if granted[identity] {
			continue
		}

		// Preserve normal order and ledger records while leaving the offered price and stock intact.
		product.CoinPrice, product.DiamondPrice = 0, 0
		id, err := insertPurchase(ctx, tx, accountID, product, now)
		if err != nil {
			return wallet.Balance{}, err
		}
		balance, err = wallet.Apply(ctx, tx, accountID, wallet.Event{Type: wallet.PurchaseDebit, ResourceID: id, At: now})
		if err != nil {
			return wallet.Balance{}, err
		}
		granted[identity] = true
		count++
	}
	if err := tx.Commit(); err != nil {
		return wallet.Balance{}, err
	}
	slog.InfoContext(ctx, "开发环境一键购买成功", "request_id", core.RequestID(ctx), "account_id", accountID, "purchase_count", count)
	return balance, nil
}

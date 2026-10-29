package shop

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/idempotency"
	"github.com/wookiisky/check-in-suite/internal/island"
	"github.com/wookiisky/check-in-suite/internal/wallet"
)

const purchaseColumns = `p.id,p.product_id,p.type_snapshot,p.name_snapshot,p.asset_key_snapshot,p.description_snapshot,p.coin_price,p.diamond_price,p.status,p.redeemed_at,p.version,p.created_at,p.item_key_snapshot`

// scanPurchase formats actual instants while preserving nullable redemption time.
func scanPurchase(row rowScanner) (Purchase, error) {
	var p Purchase
	var redeemed sql.NullInt64
	var created int64
	err := row.Scan(&p.ID, &p.ProductID, &p.TypeSnapshot, &p.NameSnapshot, &p.AssetKeySnapshot, &p.DescriptionSnapshot, &p.CoinPrice, &p.DiamondPrice, &p.Status, &redeemed, &p.Version, &created, &p.ItemKeySnapshot)
	p.CreatedAt = core.Timestamp(created)
	item, ok := island.Find(p.ItemKeySnapshot)
	if p.ItemKeySnapshot == "" {
		item, ok = island.ForAsset(p.AssetKeySnapshot)
	}
	if ok {
		p.IslandItemKey = item.Key
		p.PortraitType, p.PortraitAssetKey = portraitCapability(item)
	}
	if redeemed.Valid {
		value := core.Timestamp(redeemed.Int64)
		p.RedeemedAt = &value
	}
	return p, err
}

// readPurchase does not join live products, allowing deleted offers to retain their ownership.
func readPurchase(ctx context.Context, tx *sql.Tx, id string) (Purchase, error) {
	p, err := scanPurchase(tx.QueryRowContext(ctx, "SELECT "+purchaseColumns+" FROM purchases p WHERE p.id=?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return Purchase{}, core.Fail(404, "NOT_FOUND")
	}
	return p, err
}

// purchaseReceipt deliberately omits product descriptions and all credentials.
type purchaseReceipt struct {
	Wallet wallet.Balance `json:"wallet"` // Original confirmed post-purchase balance.
}

// Buy commits ownership, both currency debits, stock and the replay receipt atomically.
func (s *Service) Buy(ctx context.Context, p account.Principal, key string, input BuyInput) (PurchaseResult, error) {
	var result PurchaseResult
	hash, err := idempotency.Hash(purchaseOperation, input)
	if err != nil {
		return result, err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	now := s.Now()
	if err = account.Authorize(ctx, tx, p, false, now); err != nil {
		return result, err
	}
	saved, err := idempotency.Lookup(ctx, tx, purchaseOperation, key, hash)
	if err != nil {
		return result, err
	}
	if saved != nil {
		var receipt purchaseReceipt
		if err = json.Unmarshal(saved.JSON, &receipt); err != nil {
			return result, err
		}
		purchase, err := readPurchase(ctx, tx, saved.ResourceID)
		if err != nil {
			return result, err
		}
		return PurchaseResult{Purchase: purchase, Wallet: receipt.Wallet}, tx.Commit()
	}
	product, err := readProduct(ctx, tx, input.ProductID, false)
	if err != nil {
		return result, err
	}
	if !product.Enabled {
		return result, core.Fail(409, "PRODUCT_UNAVAILABLE")
	}
	if product.Version != input.ExpectedProductVersion {
		return result, core.Fail(409, "PRODUCT_CHANGED")
	}
	balance, err := wallet.Get(ctx, tx)
	if err != nil {
		return result, err
	}
	if balance.Version != input.ExpectedWalletVersion {
		return result, core.Fail(409, "WALLET_CHANGED")
	}
	if balance.Coins < product.CoinPrice || balance.Diamonds < product.DiamondPrice {
		return result, core.Fail(409, "INSUFFICIENT_BALANCE")
	}
	if product.Stock != nil && *product.Stock == 0 {
		return result, core.Fail(409, "OUT_OF_STOCK")
	}
	if product.Owned && !product.Repeatable {
		return result, core.Fail(409, "ALREADY_OWNED")
	}
	id, status := core.ID(), StatusOwned
	if product.Type == TypeReward {
		status = StatusPending
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO purchases(id,product_id,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,coin_price,diamond_price,status,created_at,repeatable,item_key_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", id, product.ID, product.Type, product.Name, product.Description, product.AssetKey, product.CoinPrice, product.DiamondPrice, status, now.UnixMilli(), product.Repeatable, product.IslandItemKey)
	if err != nil {
		return result, err
	}
	if product.Stock != nil {
		if _, err = tx.ExecContext(ctx, "UPDATE products SET stock=stock-1,version=version+1,updated_at=? WHERE id=?", now.UnixMilli(), product.ID); err != nil {
			return result, err
		}
	}
	balance, err = wallet.Apply(ctx, tx, wallet.Event{Type: wallet.PurchaseDebit, ResourceID: id, Coins: -product.CoinPrice, Diamonds: -product.DiamondPrice, At: now})
	if err != nil {
		return result, err
	}
	if err = idempotency.Save(ctx, tx, purchaseOperation, key, hash, id, 201, purchaseReceipt{Wallet: balance}, now); err != nil {
		return result, err
	}
	purchase, err := readPurchase(ctx, tx, id)
	if err != nil {
		return result, err
	}
	if err = tx.Commit(); err != nil {
		return result, err
	}
	slog.InfoContext(ctx, "商品购买成功", "request_id", core.RequestID(ctx), "purchase_id", id, "product_id", product.ID)
	return PurchaseResult{Purchase: purchase, Wallet: balance}, nil
}

// purchaseCursor binds a stable keyset boundary to the requested filter combination.
type purchaseCursor struct {
	CreatedAt int64  `json:"created_at"` // Exact stored milliseconds, not a rounded browser time.
	ID        string `json:"id"`         // Tie breaker for orders created in the same millisecond.
	Type      string `json:"type"`       // Filter that produced this boundary.
	Status    string `json:"status"`     // Status filter that produced this boundary.
}

// ListPurchases preserves ownership across product deletion and reports further pages explicitly.
func (s *Service) ListPurchases(ctx context.Context, p account.Principal, input PurchaseQuery) (PurchaseList, error) {
	result := PurchaseList{Items: []Purchase{}}
	if input.Type != "" && !validType(input.Type) {
		return result, core.Invalid("type", "INVALID_VALUE")
	}
	if input.Status != "" && input.Status != StatusOwned && input.Status != StatusPending && input.Status != StatusRedeemed {
		return result, core.Invalid("status", "INVALID_VALUE")
	}
	if input.Limit == 0 {
		input.Limit = 50
	}
	if input.Limit < 1 || input.Limit > 100 {
		return result, core.Invalid("limit", "INVALID_VALUE")
	}
	query := "SELECT " + purchaseColumns + " FROM purchases p WHERE 1=1"
	args := []any{}
	if input.Type != "" {
		keys, itemKeys := portraitSourceKeys(input.Type)
		if len(keys) == 0 {
			query += " AND p.type_snapshot=?"
		} else {
			query += " AND (p.type_snapshot=? OR p.asset_key_snapshot IN (" + strings.TrimSuffix(strings.Repeat("?,", len(keys)), ",") + ") OR p.item_key_snapshot IN (" + strings.TrimSuffix(strings.Repeat("?,", len(itemKeys)), ",") + "))"
		}
		args = append(args, input.Type)
		for _, key := range append(keys, itemKeys...) {
			args = append(args, key)
		}
	}
	if input.Status != "" {
		query += " AND p.status=?"
		args = append(args, input.Status)
	}
	if input.Cursor != "" {
		var cursor purchaseCursor
		data, err := base64.RawURLEncoding.DecodeString(input.Cursor)
		if err != nil || len(data) > 1024 || json.Unmarshal(data, &cursor) != nil || cursor.ID == "" || cursor.Type != input.Type || cursor.Status != input.Status {
			return result, core.Invalid("cursor", "INVALID_CURSOR")
		}
		query += " AND (p.created_at<? OR (p.created_at=? AND p.id<?))"
		args = append(args, cursor.CreatedAt, cursor.CreatedAt, cursor.ID)
	}
	query += " ORDER BY p.created_at DESC,p.id DESC LIMIT ?"
	args = append(args, input.Limit+1)
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if err = account.Authorize(ctx, tx, p, false, s.Now()); err != nil {
		return result, err
	}
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		item, scanErr := scanPurchase(rows)
		if scanErr != nil {
			rows.Close()
			return result, scanErr
		}
		result.Items = append(result.Items, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	if len(result.Items) > input.Limit {
		result.Items = result.Items[:input.Limit]
		last := result.Items[len(result.Items)-1]
		created, err := time.Parse(time.RFC3339Nano, last.CreatedAt)
		if err != nil {
			return result, err
		}
		data, err := json.Marshal(purchaseCursor{CreatedAt: created.UnixMilli(), ID: last.ID, Type: input.Type, Status: input.Status})
		if err != nil {
			return result, err
		}
		cursor := base64.RawURLEncoding.EncodeToString(data)
		result.NextCursor = &cursor
	}
	return result, tx.Commit()
}

// Redeem verifies this request's password outside the write transaction and then rechecks revocation.
func (s *Service) Redeem(ctx context.Context, p account.Principal, id, password string) (Purchase, error) {
	credentialVersion, err := s.verifyManagement(ctx, password)
	if err != nil {
		return Purchase{}, err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Purchase{}, err
	}
	defer tx.Rollback()
	now := s.Now()
	if err = account.Authorize(ctx, tx, p, false, now); err != nil {
		return Purchase{}, err
	}
	if credentialVersion != p.CredentialVersion {
		return Purchase{}, core.Fail(401, "SESSION_REQUIRED")
	}
	purchase, err := readPurchase(ctx, tx, id)
	if err != nil {
		return Purchase{}, err
	}
	if purchase.TypeSnapshot != TypeReward {
		return Purchase{}, core.Fail(422, "INVALID_REWARD")
	}
	if purchase.Status == StatusRedeemed {
		return purchase, tx.Commit()
	}
	if _, err = tx.ExecContext(ctx, "UPDATE purchases SET status='redeemed',redeemed_at=?,version=version+1 WHERE id=? AND status='pending'", now.UnixMilli(), id); err != nil {
		return Purchase{}, err
	}
	purchase, err = readPurchase(ctx, tx, id)
	if err != nil {
		return Purchase{}, err
	}
	if err = tx.Commit(); err != nil {
		return Purchase{}, err
	}
	slog.InfoContext(ctx, "奖励兑现成功", "request_id", core.RequestID(ctx), "purchase_id", id)
	return purchase, nil
}

package shop

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/assets"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/idempotency"
)

const productColumns = `p.id,p.type,p.name,p.asset_key,p.description,p.coin_price,p.diamond_price,p.stock,p.enabled,p.version,p.deleted_at,EXISTS(SELECT 1 FROM purchases x WHERE x.product_id=p.id AND x.type_snapshot!='reward')`

// rowScanner is the common Scan boundary shared by database rows and one-row queries.
type rowScanner interface{ Scan(...any) error }

// scanProduct converts nullable SQLite stock without substituting a magic sentinel.
func scanProduct(row rowScanner) (Product, error) {
	var p Product
	var stock, deleted sql.NullInt64
	err := row.Scan(&p.ID, &p.Type, &p.Name, &p.AssetKey, &p.Description, &p.CoinPrice, &p.DiamondPrice, &stock, &p.Enabled, &p.Version, &deleted, &p.Owned)
	if stock.Valid {
		p.Stock = &stock.Int64
	}
	p.Deleted = deleted.Valid
	return p, err
}

// readProduct keeps deleted source rows available only for successful creation replay.
func readProduct(ctx context.Context, tx *sql.Tx, id string, includeDeleted bool) (Product, error) {
	p, err := scanProduct(tx.QueryRowContext(ctx, "SELECT "+productColumns+" FROM products p WHERE p.id=?", id))
	if errors.Is(err, sql.ErrNoRows) || (err == nil && p.Deleted && !includeDeleted) {
		return Product{}, core.Fail(404, "NOT_FOUND")
	}
	return p, err
}

// validType uses the four stable product behaviors, never inferred display text.
func validType(kind string) bool {
	return kind == TypeTitle || kind == TypeAvatar || kind == TypeAccessory || kind == TypeReward
}

// validateProduct applies configured numeric and Unicode bounds before any product write.
func (s *Service) validateProduct(input ProductInput) error {
	if !validType(input.Type) {
		return core.Invalid("type", "INVALID_VALUE")
	}
	if err := core.Text("name", input.Name, 1, s.Config.Limits.NameMax); err != nil {
		return err
	}
	if err := core.Text("description", input.Description, 0, s.Config.Limits.TextMax); err != nil {
		return err
	}
	if !assets.Valid(input.AssetKey, assets.Kind(input.Type)) {
		return core.Invalid("asset_key", "INVALID_ASSET")
	}
	if input.CoinPrice < 0 || input.CoinPrice > s.Config.Limits.PriceMax {
		return core.Invalid("coin_price", "INVALID_VALUE")
	}
	if input.DiamondPrice < 0 || input.DiamondPrice > s.Config.Limits.PriceMax {
		return core.Invalid("diamond_price", "INVALID_VALUE")
	}
	if input.Stock != nil && (*input.Stock < 0 || *input.Stock > s.Config.Limits.StockMax) {
		return core.Invalid("stock", "INVALID_VALUE")
	}
	return nil
}

// ListProducts authorizes inactive configuration inside the same read snapshot.
func (s *Service) ListProducts(ctx context.Context, p account.Principal, includeInactive bool) (ProductList, error) {
	result := ProductList{Items: []Product{}}
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if err = account.Authorize(ctx, tx, p, includeInactive, s.Now()); err != nil {
		return result, err
	}
	query := "SELECT " + productColumns + " FROM products p WHERE p.deleted_at IS NULL"
	if !includeInactive {
		query += " AND p.enabled=1"
	}
	query += " ORDER BY p.created_at,p.id"
	rows, err := tx.QueryContext(ctx, query)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		item, scanErr := scanProduct(rows)
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
	return result, tx.Commit()
}

// CreateProduct uses identity-only replay so product descriptions are not copied into receipts.
func (s *Service) CreateProduct(ctx context.Context, p account.Principal, key string, input ProductInput) (Product, error) {
	input.Name = strings.TrimSpace(input.Name)
	hash, err := idempotency.Hash("product.create", input)
	if err != nil {
		return Product{}, err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Product{}, err
	}
	defer tx.Rollback()
	now := s.Now()
	if err = account.Authorize(ctx, tx, p, true, now); err != nil {
		return Product{}, err
	}
	saved, err := idempotency.Lookup(ctx, tx, "product.create", key, hash)
	if err != nil {
		return Product{}, err
	}
	if saved != nil {
		item, err := readProduct(ctx, tx, saved.ResourceID, true)
		if err != nil {
			return Product{}, err
		}
		return item, tx.Commit()
	}
	if err = s.validateProduct(input); err != nil {
		return Product{}, err
	}
	id := core.ID()
	_, err = tx.ExecContext(ctx, "INSERT INTO products(id,type,name,asset_key,description,coin_price,diamond_price,stock,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", id, input.Type, input.Name, input.AssetKey, input.Description, input.CoinPrice, input.DiamondPrice, input.Stock, input.Enabled, now.UnixMilli(), now.UnixMilli())
	if err != nil {
		return Product{}, err
	}
	item, err := readProduct(ctx, tx, id, false)
	if err != nil {
		return Product{}, err
	}
	if err = idempotency.Save(ctx, tx, "product.create", key, hash, id, 201, json.RawMessage(`{}`), now); err != nil {
		return Product{}, err
	}
	return item, tx.Commit()
}

// UpdateProduct replaces only current configuration and prevents changing sold product behavior.
func (s *Service) UpdateProduct(ctx context.Context, p account.Principal, id string, input ProductUpdate) (Product, error) {
	input.Name = strings.TrimSpace(input.Name)
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Product{}, err
	}
	defer tx.Rollback()
	now := s.Now()
	if err = account.Authorize(ctx, tx, p, true, now); err != nil {
		return Product{}, err
	}
	current, err := readProduct(ctx, tx, id, false)
	if err != nil {
		return Product{}, err
	}
	if current.Version != input.ExpectedVersion {
		return Product{}, core.VersionConflict(current.Version)
	}
	if err = s.validateProduct(input.ProductInput); err != nil {
		return Product{}, err
	}
	if input.Type != current.Type {
		var sold bool
		if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM purchases WHERE product_id=?)", id).Scan(&sold); err != nil {
			return Product{}, err
		}
		if sold {
			return Product{}, core.Fail(409, "PRODUCT_TYPE_LOCKED")
		}
	}
	_, err = tx.ExecContext(ctx, "UPDATE products SET type=?,name=?,asset_key=?,description=?,coin_price=?,diamond_price=?,stock=?,enabled=?,version=version+1,updated_at=? WHERE id=?", input.Type, input.Name, input.AssetKey, input.Description, input.CoinPrice, input.DiamondPrice, input.Stock, input.Enabled, now.UnixMilli(), id)
	if err != nil {
		return Product{}, err
	}
	item, err := readProduct(ctx, tx, id, false)
	if err != nil {
		return Product{}, err
	}
	return item, tx.Commit()
}

// DeleteProduct removes an offer while preserving all ownership and transaction snapshots.
func (s *Service) DeleteProduct(ctx context.Context, p account.Principal, id string, version int64) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := s.Now()
	if err = account.Authorize(ctx, tx, p, true, now); err != nil {
		return err
	}
	current, err := readProduct(ctx, tx, id, true)
	if err != nil {
		return err
	}
	if current.Deleted {
		return tx.Commit()
	}
	if current.Version != version {
		return core.VersionConflict(current.Version)
	}
	if _, err = tx.ExecContext(ctx, "UPDATE products SET deleted_at=?,enabled=0,version=version+1,updated_at=? WHERE id=?", now.UnixMilli(), now.UnixMilli(), id); err != nil {
		return err
	}
	return tx.Commit()
}

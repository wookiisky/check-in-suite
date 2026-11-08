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
	"github.com/wookiisky/check-in-suite/internal/island"
)

// catalogOfferFilter hides entries retired by the published catalog, without changing commercial terms.
const catalogOfferFilter = " AND (p.type NOT IN ('character','wearable') OR p.catalog_revision IS NOT NULL)"

const manageableOffers = " AND p.type IN ('character','wearable','island','scene')"

const productColumns = "p.id,p.type,p.name,p.asset_key,p.wearable_key,p.character_key,p.scene_key,p.description,p.coin_price,p.diamond_price,p.stock,p.enabled,p.version,p.deleted_at,p.created_at"

// rowScanner is the common Scan boundary shared by database rows and one-row queries.
type rowScanner interface{ Scan(...any) error }

// scanProduct converts nullable SQLite stock without substituting a magic sentinel.
func scanProduct(row rowScanner) (Product, error) {
	var p Product
	var stock, deleted sql.NullInt64
	err := row.Scan(&p.ID, &p.Type, &p.Name, &p.AssetKey, &p.WearableKey, &p.CharacterKey, &p.SceneKey, &p.Description, &p.CoinPrice, &p.DiamondPrice, &stock, &p.Enabled, &p.Version, &deleted, &p.CreatedAt)
	if stock.Valid {
		p.Stock = &stock.Int64
	}
	p.Deleted = deleted.Valid
	if err == nil {
		applyProductCatalog(&p)
	}
	return p, err
}

// applyProductCatalog supplies live artwork and source metadata for an offer.
func applyProductCatalog(p *Product) {
	var display dressUpDisplay
	switch p.Type {
	case TypeCharacter:
		display = dressUpDisplays()[TypeCharacter][p.CharacterKey]
		p.AssetKey = display.Thumbnail
	case TypeWearable:
		display = dressUpDisplays()[TypeWearable][p.WearableKey]
		p.AssetKey = display.Thumbnail
	case TypeIsland:
		if item, ok := island.SpatialForThumbnail(p.AssetKey); ok {
			p.IslandItemKey, p.Repeatable = item.Key, item.Repeatable
		}
	}
	if asset, ok := assets.Get(p.AssetKey); ok {
		p.Provider, p.PackKey, p.PackName = asset.Provider, asset.PackKey, asset.PackName
	}
	if display.Provider != "" {
		p.Provider = display.Provider
	}
	if display.PackKey != "" {
		p.PackKey = display.PackKey
	}
}

// readProduct keeps deleted source rows available only for successful creation replay.
func readProduct(ctx context.Context, tx *sql.Tx, accountID int64, id string, includeDeleted bool) (Product, error) {
	p, err := scanProduct(tx.QueryRowContext(ctx, "SELECT "+productColumns+" FROM products p WHERE p.account_id=? AND p.id=?"+catalogOfferFilter, accountID, id))
	if errors.Is(err, sql.ErrNoRows) || (err == nil && p.Deleted && !includeDeleted) {
		return Product{}, core.Fail(404, "NOT_FOUND")
	}
	if err == nil {
		items := []Product{p}
		err = applyProductOwnership(ctx, tx, accountID, items)
		p = items[0]
	}
	return p, err
}

// validType uses the declared product behaviors, never inferred display text.
func validType(kind string) bool {
	return manageableProductType(kind) || kind == TypeTitle || kind == TypeReward
}

// manageableProductType restricts management to current shop behaviors.
func manageableProductType(kind string) bool {
	return kind == TypeScene || kind == TypeCharacter || kind == TypeWearable || kind == TypeIsland
}

// validateProductTerms applies configured numeric and Unicode bounds before writing.
func (s *Service) validateProductTerms(input ProductTerms) error {
	if err := core.Text("name", input.Name, 1, s.Config.Limits.NameMax); err != nil {
		return err
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
	accountID := p.AccountID
	result := ProductList{Items: []Product{}}
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if err = account.Authorize(ctx, tx, p, includeInactive, s.Now()); err != nil {
		return result, err
	}
	query := "SELECT " + productColumns + " FROM products p WHERE p.account_id=? AND p.deleted_at IS NULL" + catalogOfferFilter
	if includeInactive {
		query += manageableOffers
	} else {
		query += " AND p.enabled=1"
	}
	query += " ORDER BY p.created_at,p.id"
	rows, err := tx.QueryContext(ctx, query, accountID)
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
	if err = applyProductOwnership(ctx, tx, accountID, result.Items); err != nil {
		return result, err
	}
	return result, tx.Commit()
}

// CreateProduct uses identity-only replay so product descriptions are not copied into receipts.
func (s *Service) CreateProduct(ctx context.Context, p account.Principal, key string, input ProductCreate) (Product, error) {
	accountID := p.AccountID
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
	saved, err := idempotency.Lookup(ctx, tx, accountID, "product.create", key, hash)
	if err != nil {
		return Product{}, err
	}
	if saved != nil {
		item, err := readProduct(ctx, tx, accountID, saved.ResourceID, true)
		if err != nil {
			return Product{}, err
		}
		return item, tx.Commit()
	}
	if err = s.validateProductTerms(input.ProductTerms); err != nil {
		return Product{}, err
	}
	binding, ok := materialCatalog().byAsset[input.AssetKey]
	if !ok {
		return Product{}, core.Invalid("asset_key", "INVALID_ASSET")
	}
	var sceneKey string
	if binding.productType == TypeScene {
		sceneKey = binding.definitionKey
	}
	id := core.ID()
	_, err = tx.ExecContext(ctx, "INSERT INTO products(id,account_id,type,name,asset_key,scene_key,description,coin_price,diamond_price,stock,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", id, accountID, binding.productType, input.Name, input.AssetKey, sceneKey, "", input.CoinPrice, input.DiamondPrice, input.Stock, input.Enabled, now.UnixMilli(), now.UnixMilli())
	if err != nil {
		return Product{}, err
	}
	item, err := readProduct(ctx, tx, accountID, id, false)
	if err != nil {
		return Product{}, err
	}
	if err = idempotency.Save(ctx, tx, accountID, "product.create", key, hash, id, 201, json.RawMessage(`{}`), now); err != nil {
		return Product{}, err
	}
	return item, tx.Commit()
}

// UpdateProduct changes the commercial terms without replacing the material or its type.
func (s *Service) UpdateProduct(ctx context.Context, p account.Principal, id string, input ProductUpdate) (Product, error) {
	accountID := p.AccountID
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
	current, err := readProduct(ctx, tx, accountID, id, false)
	if err != nil {
		return Product{}, err
	}
	if !manageableProductType(current.Type) {
		return Product{}, core.Fail(404, "NOT_FOUND")
	}
	if current.Version != input.ExpectedVersion {
		return Product{}, core.VersionConflict(current.Version)
	}
	if err = s.validateProductTerms(input.ProductTerms); err != nil {
		return Product{}, err
	}
	_, err = tx.ExecContext(ctx, "UPDATE products SET name=?,coin_price=?,diamond_price=?,stock=?,enabled=?,version=version+1,updated_at=? WHERE account_id=? AND id=?", input.Name, input.CoinPrice, input.DiamondPrice, input.Stock, input.Enabled, now.UnixMilli(), accountID, id)
	if err != nil {
		return Product{}, err
	}
	item, err := readProduct(ctx, tx, accountID, id, false)
	if err != nil {
		return Product{}, err
	}
	return item, tx.Commit()
}

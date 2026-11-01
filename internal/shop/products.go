package shop

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/assets"
	"github.com/wookiisky/check-in-suite/internal/character"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/idempotency"
	"github.com/wookiisky/check-in-suite/internal/island"
)

// productIslandItemKey resolves the controlled three-dimensional placement identity.
func productIslandItemKey(assetKey string) string {
	if item, ok := island.SpatialForThumbnail(assetKey); ok {
		return item.Key
	}
	return ""
}

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
	if item, ok := island.SpatialForThumbnail(p.AssetKey); ok && p.Type == TypeIsland {
		p.IslandItemKey, p.Repeatable = item.Key, item.Repeatable
	}
	if asset, ok := assets.Get(p.AssetKey); ok {
		p.Provider, p.PackKey, p.PackName = asset.Provider, asset.PackKey, asset.PackName
	}
	if definition, ok := character.Get(p.CharacterKey); ok {
		p.Provider, p.PackKey = definition.Provider, definition.PackKey
	}
	return p, err
}

// readProduct keeps deleted source rows available only for successful creation replay.
func readProduct(ctx context.Context, tx *sql.Tx, id string, includeDeleted bool) (Product, error) {
	p, err := scanProduct(tx.QueryRowContext(ctx, "SELECT "+productColumns+" FROM products p WHERE p.id=?", id))
	if errors.Is(err, sql.ErrNoRows) || (err == nil && p.Deleted && !includeDeleted) {
		return Product{}, core.Fail(404, "NOT_FOUND")
	}
	if err == nil {
		items := []Product{p}
		err = applyProductOwnership(ctx, tx, items)
		p = items[0]
	}
	return p, err
}

// validType uses the declared product behaviors, never inferred display text.
func validType(kind string) bool {
	return kind == TypeScene || kind == TypeCharacter || kind == TypeWearable || kind == TypeIsland || kind == TypeTitle || kind == TypeReward
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
	if input.Type == TypeScene {
		scene, found := island.SpatialSceneFind(input.SceneKey)
		if !found || scene.Free {
			return core.Invalid("scene_key", "INVALID_VALUE")
		}
		artwork, found := assets.Get(input.AssetKey)
		if !found || scene.ThumbnailAssetKey != input.AssetKey || (artwork.Kind != assets.Kind(TypeScene) && artwork.Kind != assets.KindIsland) {
			return core.Invalid("asset_key", "INVALID_ASSET")
		}
	} else {
		if input.SceneKey != "" {
			return core.Invalid("scene_key", "INVALID_VALUE")
		}
		if artwork, ok := assets.Get(input.AssetKey); !ok || artwork.Kind != assets.Kind(input.Type) || artwork.Free {
			return core.Invalid("asset_key", "INVALID_ASSET")
		}
	}
	if item, ok := island.SpatialForThumbnail(input.AssetKey); ok && input.Type != TypeScene && (input.Type != TypeIsland || item.Free) {
		return core.Invalid("asset_key", "INVALID_ASSET")
	}
	if input.Type == TypeWearable {
		wearable, ok := character.GetWearable(input.WearableKey)
		if !ok || wearable.ThumbnailAssetKey != input.AssetKey || isDefaultWearable(wearable) {
			return core.Invalid("wearable_key", "INVALID_VALUE")
		}
	} else if input.WearableKey != "" {
		return core.Invalid("wearable_key", "INVALID_VALUE")
	}
	if input.Type == TypeCharacter {
		body, ok := character.Get(input.CharacterKey)
		if !ok || body.Key == character.DefaultCharacterKey || body.ThumbnailAssetKey != input.AssetKey {
			return core.Invalid("character_key", "INVALID_VALUE")
		}
	} else if input.CharacterKey != "" {
		return core.Invalid("character_key", "INVALID_VALUE")
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
	if err = applyProductOwnership(ctx, tx, result.Items); err != nil {
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
	_, err = tx.ExecContext(ctx, "INSERT INTO products(id,type,name,asset_key,wearable_key,character_key,scene_key,description,coin_price,diamond_price,stock,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", id, input.Type, input.Name, input.AssetKey, input.WearableKey, input.CharacterKey, input.SceneKey, input.Description, input.CoinPrice, input.DiamondPrice, input.Stock, input.Enabled, now.UnixMilli(), now.UnixMilli())
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
	oldItemKey, newItemKey := "", ""
	if current.Type == TypeIsland {
		oldItemKey = productIslandItemKey(current.AssetKey)
	}
	if input.Type == TypeIsland {
		newItemKey = productIslandItemKey(input.AssetKey)
	}
	identityChanged := ((oldItemKey != "" || newItemKey != "") && oldItemKey != newItemKey) ||
		(current.Type == TypeWearable && input.Type == TypeWearable && current.WearableKey != input.WearableKey) ||
		(current.Type == TypeCharacter && input.Type == TypeCharacter && current.CharacterKey != input.CharacterKey) ||
		(current.Type == TypeScene && input.Type == TypeScene && current.SceneKey != input.SceneKey)
	if identityChanged {
		var sold bool
		if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM purchases WHERE product_id=?)", id).Scan(&sold); err != nil {
			return Product{}, err
		}
		if sold {
			return Product{}, core.Fail(409, "PRODUCT_ITEM_LOCKED")
		}
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
	_, err = tx.ExecContext(ctx, "UPDATE products SET type=?,name=?,asset_key=?,wearable_key=?,character_key=?,scene_key=?,description=?,coin_price=?,diamond_price=?,stock=?,enabled=?,version=version+1,updated_at=? WHERE id=?", input.Type, input.Name, input.AssetKey, input.WearableKey, input.CharacterKey, input.SceneKey, input.Description, input.CoinPrice, input.DiamondPrice, input.Stock, input.Enabled, now.UnixMilli(), id)
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

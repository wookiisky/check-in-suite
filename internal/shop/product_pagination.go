package shop

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"github.com/wookiisky/check-in-suite/internal/assets"
	"sort"
	"strings"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/character"
	"github.com/wookiisky/check-in-suite/internal/core"
)

// productCursor retains an immutable order boundary and the filters that produced it.
type productCursor struct {
	CreatedAt       int64  `json:"at"`       // Original immutable creation instant.
	ID              string `json:"id"`       // Tie-breaker for products created in the same millisecond.
	Type            string `json:"type"`     // Exact product behavior filter.
	Group           string `json:"group"`    // Broader appearance filter.
	Slot            string `json:"slot"`     // Wearable attachment filter.
	Search          string `json:"search"`   // Normalized name filter.
	Provider        string `json:"provider"` // Source filter.
	PackKey         string `json:"pack"`     // Source pack filter.
	IncludeInactive bool   `json:"inactive"` // Managed authority cannot leak through a cursor.
}

// productMatches applies explicit metadata filters without deriving capability from display names.
func productMatches(item Product, input ProductQuery) bool {
	if input.Type != "" && item.Type != input.Type {
		return false
	}
	if input.Group == "appearance" && item.Type != TypeCharacter && item.Type != TypeWearable && item.Type != TypeTitle {
		return false
	}
	if input.Provider != "" && item.Provider != input.Provider {
		return false
	}
	if input.PackKey != "" && item.PackKey != input.PackKey {
		return false
	}
	if input.Search != "" && !strings.Contains(strings.ToLower(item.Name), input.Search) {
		return false
	}
	if input.Slot != "" {
		wearable, ok := character.GetWearable(item.WearableKey)
		if !ok || string(wearable.Slot) != input.Slot {
			return false
		}
	}
	return true
}

// productFacets resolves every visible source option before the page is limited.
func productFacets(items []Product) *ProductFacets {
	result := &ProductFacets{Providers: []string{}, Packs: []ProductPack{}}
	providers, packs := map[string]bool{}, map[ProductPack]string{}
	for _, item := range items {
		if item.Provider != "" {
			providers[item.Provider] = true
		}
		if item.PackKey != "" {
			identity := ProductPack{Key: item.PackKey, Provider: item.Provider}
			if packs[identity] == "" {
				packs[identity] = item.PackName
			}
		}
	}
	for value := range providers {
		result.Providers = append(result.Providers, value)
	}
	for value, name := range packs {
		value.Name = name
		result.Packs = append(result.Packs, value)
	}
	sort.Strings(result.Providers)
	sort.Slice(result.Packs, func(i, j int) bool {
		if result.Packs[i].Provider != result.Packs[j].Provider {
			return result.Packs[i].Provider < result.Packs[j].Provider
		}
		return result.Packs[i].Key < result.Packs[j].Key
	})
	return result
}

// ListProductsPage limits browser payloads while preserving the full separate appearance inventory.
func (s *Service) ListProductsPage(ctx context.Context, principal account.Principal, includeInactive bool, input ProductQuery) (ProductList, error) {
	accountID := principal.AccountID
	result := ProductList{Items: []Product{}}
	input.Search = strings.ToLower(strings.TrimSpace(input.Search))
	input.Provider = strings.ToLower(input.Provider)
	if input.Limit < 1 || input.Limit > 100 {
		return result, core.Invalid("limit", "INVALID_VALUE")
	}
	if input.Type != "" && !validType(input.Type) {
		return result, core.Invalid("type", "INVALID_VALUE")
	}
	if input.Group != "" && input.Group != "appearance" {
		return result, core.Invalid("group", "INVALID_VALUE")
	}
	if input.Slot != "" && input.Slot != "face" && input.Slot != "back" && input.Slot != "head" && input.Slot != "upper" && input.Slot != "lower" && input.Slot != "shoes" {
		return result, core.Invalid("slot", "INVALID_VALUE")
	}
	expected := productCursor{Type: input.Type, Group: input.Group, Slot: input.Slot, Search: input.Search, Provider: input.Provider, PackKey: input.PackKey, IncludeInactive: includeInactive}
	boundary := expected
	if input.Cursor != "" {
		data, err := base64.RawURLEncoding.DecodeString(input.Cursor)
		if err != nil || len(data) > 2048 || json.Unmarshal(data, &boundary) != nil || boundary.ID == "" {
			return result, core.Invalid("cursor", "INVALID_CURSOR")
		}
		match := boundary
		match.ID = ""
		match.CreatedAt = 0
		if match != expected {
			return result, core.Invalid("cursor", "INVALID_CURSOR")
		}
	}
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if err := account.Authorize(ctx, tx, principal, includeInactive, s.Now()); err != nil {
		return result, err
	}
	query := "SELECT " + productColumns + " FROM products p WHERE p.account_id=? AND p.deleted_at IS NULL"
	args := []any{accountID}
	if !includeInactive {
		query += " AND p.enabled=1"
	}
	if input.Type != "" {
		query += " AND p.type=?"
		args = append(args, input.Type)
	}
	if input.Group == "appearance" {
		query += " AND p.type IN ('character','wearable','title')"
	}
	if input.Cursor != "" {
		query += " AND (p.created_at>? OR (p.created_at=? AND p.id>?))"
		args = append(args, boundary.CreatedAt, boundary.CreatedAt, boundary.ID)
	}
	query += " ORDER BY p.created_at,p.id"
	if input.Provider == "" && input.PackKey == "" && input.Slot == "" && input.Search == "" {
		query += " LIMIT ?"
		args = append(args, input.Limit+1)
	}
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		item, err := scanProduct(rows)
		if err != nil {
			rows.Close()
			return result, err
		}
		if !productMatches(item, input) {
			continue
		}
		if len(result.Items) == input.Limit {
			last := result.Items[len(result.Items)-1]
			expected.CreatedAt, expected.ID = last.CreatedAt, last.ID
			data, err := json.Marshal(expected)
			if err != nil {
				rows.Close()
				return result, err
			}
			cursor := base64.RawURLEncoding.EncodeToString(data)
			result.NextCursor = &cursor
			break
		}
		result.Items = append(result.Items, item)
	}
	readErr := rows.Err()
	rows.Close()
	if readErr != nil {
		return result, readErr
	}
	if err := applyProductOwnership(ctx, tx, accountID, result.Items); err != nil {
		return result, err
	}
	result.Facets, err = visibleProductFacets(ctx, tx, accountID, includeInactive)
	if err != nil {
		return result, err
	}
	if err := tx.Commit(); err != nil {
		return result, err
	}
	return result, nil
}

// visibleProductFacets reads only distinct source identities instead of every product description.
func visibleProductFacets(ctx context.Context, tx *sql.Tx, accountID int64, includeInactive bool) (*ProductFacets, error) {
	query := "SELECT DISTINCT asset_key,character_key FROM products WHERE account_id=? AND deleted_at IS NULL"
	if !includeInactive {
		query += " AND enabled=1"
	}
	rows, err := tx.QueryContext(ctx, query, accountID)
	if err != nil {
		return nil, err
	}
	items := []Product{}
	for rows.Next() {
		var assetKey, bodyKey string
		if err := rows.Scan(&assetKey, &bodyKey); err != nil {
			rows.Close()
			return nil, err
		}
		item := Product{}
		if asset, ok := assets.Get(assetKey); ok {
			item.Provider, item.PackKey, item.PackName = asset.Provider, asset.PackKey, asset.PackName
		}
		if body, ok := character.Get(bodyKey); ok {
			item.Provider, item.PackKey = body.Provider, body.PackKey
		}
		items = append(items, item)
	}
	readErr := rows.Err()
	rows.Close()
	if readErr != nil {
		return nil, readErr
	}
	return productFacets(items), nil
}

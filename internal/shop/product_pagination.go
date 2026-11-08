package shop

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"sort"
	"strings"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/assets"
	"github.com/wookiisky/check-in-suite/internal/character"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/island"
)

// productCursor retains an immutable order boundary and the filters that produced it.
type productCursor struct {
	CreatedAt       int64  `json:"at"`       // Original immutable creation instant.
	ID              string `json:"id"`       // Tie-breaker for products created in the same millisecond.
	Type            string `json:"type"`     // Exact product behavior filter.
	Group           string `json:"group"`    // Stable appearance or camp group.
	Category        string `json:"category"` // Stable detail category within the group.
	Slot            string `json:"slot"`     // Wearable attachment filter.
	Search          string `json:"search"`   // Normalized name filter.
	Provider        string `json:"provider"` // Source filter.
	PackKey         string `json:"pack"`     // Source pack filter.
	IncludeInactive bool   `json:"inactive"` // Managed authority cannot leak through a cursor.
}

// productMatches applies explicit metadata filters without deriving capability from display names.
func productMatches(item Product, input ProductQuery, slots map[string]character.Slot) bool {
	if input.Type != "" && item.Type != input.Type {
		return false
	}
	if input.Category != "" && shopProductCategory(item, slots) != input.Category {
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
	if input.Group != "" && input.Group != shopAppearance && input.Group != shopCamp {
		return result, core.Invalid("group", "INVALID_VALUE")
	}
	if input.Category != "" && input.Group == "" {
		return result, core.Invalid("category", "INVALID_VALUE")
	}
	if err := core.Text("category", input.Category, 0, 64); err != nil {
		return result, err
	}
	if input.Slot != "" && input.Slot != "face" && input.Slot != "back" && input.Slot != "head" && input.Slot != "upper" && input.Slot != "lower" && input.Slot != "shoes" {
		return result, core.Invalid("slot", "INVALID_VALUE")
	}
	expected := productCursor{Type: input.Type, Group: input.Group, Category: input.Category, Slot: input.Slot, Search: input.Search, Provider: input.Provider, PackKey: input.PackKey, IncludeInactive: includeInactive}
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
	query += productGroupFilter(input.Group, includeInactive)
	if input.Cursor != "" {
		query += " AND (p.created_at>? OR (p.created_at=? AND p.id>?))"
		args = append(args, boundary.CreatedAt, boundary.CreatedAt, boundary.ID)
	}
	query += " ORDER BY p.created_at,p.id"
	if input.Provider == "" && input.PackKey == "" && input.Slot == "" && input.Search == "" && input.Category == "" {
		query += " LIMIT ?"
		args = append(args, input.Limit+1)
	}
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return result, err
	}
	slots := map[string]character.Slot{}
	if input.Group == shopAppearance && input.Category != "" {
		for _, wearable := range character.Wearables() {
			slots[wearable.Key] = wearable.Slot
		}
	}
	for rows.Next() {
		item, err := scanProduct(rows)
		if err != nil {
			rows.Close()
			return result, err
		}
		if !productMatches(item, input, slots) {
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
	if err := applyProductOwnership(ctx, tx, accountID, result.Items, includeInactive); err != nil {
		return result, err
	}
	result.Facets, result.CampCategories, err = visibleProductMetadata(ctx, tx, accountID, includeInactive, input.Group)
	if err != nil {
		return result, err
	}
	if err := tx.Commit(); err != nil {
		return result, err
	}
	return result, nil
}

// productGroupFilter keeps public historical title reads while management uses current shop groups.
func productGroupFilter(group string, includeInactive bool) string {
	switch group {
	case shopAppearance:
		if includeInactive {
			return " AND p.type IN ('character','wearable')"
		}
		return " AND p.type IN ('character','wearable','title')"
	case shopCamp:
		return " AND p.type IN ('island','scene')"
	default:
		if includeInactive {
			return manageableOffers
		}
		return ""
	}
}

// visibleProductMetadata reads distinct source identities and camp categories independently of the page.
func visibleProductMetadata(ctx context.Context, tx *sql.Tx, accountID int64, includeInactive bool, group string) (*ProductFacets, []string, error) {
	query := "SELECT DISTINCT p.type,p.asset_key,p.character_key FROM products p WHERE p.account_id=? AND p.deleted_at IS NULL"
	if !includeInactive {
		query += " AND p.enabled=1"
	}
	if includeInactive || group == shopCamp {
		query += productGroupFilter(group, includeInactive)
	}
	rows, err := tx.QueryContext(ctx, query, accountID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	items := []Product{}
	categories := map[string]bool{TypeScene: true}
	for rows.Next() {
		var kind, assetKey, bodyKey string
		if err := rows.Scan(&kind, &assetKey, &bodyKey); err != nil {
			return nil, nil, err
		}
		item := Product{Type: kind}
		if asset, ok := assets.Get(assetKey); ok {
			item.Provider, item.PackKey, item.PackName = asset.Provider, asset.PackKey, asset.PackName
		}
		if bodyKey != "" {
			if body, ok := character.Get(bodyKey); ok {
				item.Provider, item.PackKey = body.Provider, body.PackKey
			}
		}
		if group == shopCamp {
			if definition, ok := island.SpatialForThumbnail(assetKey); ok {
				item.IslandItemKey = definition.Key
			}
			categories[shopProductCategory(item, nil)] = true
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	var campCategories []string
	if group == shopCamp {
		for category := range categories {
			campCategories = append(campCategories, category)
		}
		sort.Strings(campCategories)
	}
	return productFacets(items), campCategories, nil
}

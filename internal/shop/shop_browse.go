package shop

import (
	"context"
	"database/sql"
	"sort"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/island"
	"github.com/wookiisky/check-in-suite/internal/wallet"
)

const (
	shopAppearance = "appearance"
	shopCamp       = "camp"
	otherCampItems = "other"
)

// activeShopOffers is shared by browsing and the development ownership grant.
const activeShopOffers = "SELECT " + productColumns + " FROM products p WHERE p.account_id=? AND p.deleted_at IS NULL AND p.enabled=1" + catalogOfferFilter

// ShopQuery specifies a numbered page of the public shop for the current account.
type ShopQuery struct {
	Group    string // Appearance or camp.
	Category string // Empty selects all products in the group.
	Page     int    // One-based requested page.
	Limit    int    // Number of offers per page.
}

// ShopPage holds the unowned offers and wallet from one read snapshot.
type ShopPage struct {
	Items             []Product      `json:"items"`                         // Offers in stable display order.
	CampCategories    []string       `json:"camp_categories"`               // Stable categories from all active camp offers.
	Page              int            `json:"page"`                          // Effective page after clamping to the current count.
	Total             int            `json:"total"`                         // Count after category and ownership filtering.
	Wallet            wallet.Balance `json:"wallet"`                        // Version used when confirming a purchase.
	DevelopmentBuyAll bool           `json:"development_buy_all,omitempty"` // The server enables the development action.
}

// shopProductCategory uses stable catalog metadata shared with appearance and camp.
func shopProductCategory(item Product) string {
	switch item.Type {
	case TypeScene, TypeCharacter:
		return item.Type
	case TypeWearable:
		return dressUpDisplays()[TypeWearable][item.WearableKey].Slot
	case TypeIsland:
		if definition, ok := island.SpatialFind(item.IslandItemKey); ok && definition.Category != "" {
			return definition.Category
		}
		return otherCampItems
	}
	return ""
}

// BrowseShop filters stable ownership before counting and slicing the requested page.
func (s *Service) BrowseShop(ctx context.Context, principal account.Principal, input ShopQuery) (ShopPage, error) {
	result := ShopPage{Items: []Product{}, CampCategories: []string{}}
	if input.Group != shopAppearance && input.Group != shopCamp {
		return result, core.Invalid("group", "INVALID_VALUE")
	}
	if input.Page < 1 {
		return result, core.Invalid("page", "INVALID_VALUE")
	}
	if input.Limit < 1 || input.Limit > 100 {
		return result, core.Invalid("limit", "INVALID_VALUE")
	}
	if err := core.Text("category", input.Category, 0, 64); err != nil {
		return result, err
	}

	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if err := account.Authorize(ctx, tx, principal, false, s.Now()); err != nil {
		return result, err
	}
	var kinds [2]string
	if input.Group == shopCamp {
		kinds = [2]string{TypeIsland, TypeScene}
	} else {
		kinds = [2]string{TypeCharacter, TypeWearable}
	}
	rows, err := tx.QueryContext(ctx, activeShopOffers+" AND p.type IN (?,?) ORDER BY p.created_at,p.id", principal.AccountID, kinds[0], kinds[1])
	if err != nil {
		return result, err
	}
	items := []Product{}
	categories := map[string]bool{TypeScene: true}

	for rows.Next() {
		item, err := scanProduct(rows)
		if err != nil {
			rows.Close()
			return result, err
		}
		category := shopProductCategory(item)
		if input.Group == shopCamp {
			categories[category] = true
		}
		if input.Category == "" || category == input.Category {
			items = append(items, item)
		}
	}
	readErr := rows.Err()
	rows.Close()
	if readErr != nil {
		return result, readErr
	}
	if input.Group == shopCamp {
		for category := range categories {
			result.CampCategories = append(result.CampCategories, category)
		}
		sort.Strings(result.CampCategories)
	}
	if err := applyProductOwnership(ctx, tx, principal.AccountID, items); err != nil {
		return result, err
	}
	unowned := items[:0]
	for _, item := range items {
		if !item.Owned {
			unowned = append(unowned, item)
		}
	}
	result.Total = len(unowned)
	totalPages := max(1, (result.Total+input.Limit-1)/input.Limit)
	result.Page = min(input.Page, totalPages)
	start := (result.Page - 1) * input.Limit
	result.Items = unowned[start:min(start+input.Limit, result.Total)]
	result.Wallet, err = wallet.Get(ctx, tx, principal.AccountID)
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}

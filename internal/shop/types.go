// Package shop owns merchandise, immutable purchases and persistent equipment.
package shop

import (
	"context"
	"database/sql"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/wallet"
)

const (
	TypeCharacter     = "character"       // Purchased identity for a complete shared-body character.
	TypeWearable      = "wearable"        // Three-dimensional clothing with a stable definition identity.
	TypeScene         = "scene"           // Permanent access to an independent household scene.
	TypeIsland        = "island"          // Controlled island construction item.
	TypeTitle         = "title"           // One equipped title, permanently owned after purchase.
	TypeReward        = "reward"          // A repeatable household reward requiring redemption.
	StatusOwned       = "owned"           // Permanent ownership has no redemption step.
	StatusPending     = "pending"         // A purchased household reward awaiting confirmation.
	StatusRedeemed    = "redeemed"        // The reward has been confirmed exactly once.
	purchaseOperation = "purchase.create" // Stable namespace for economic idempotency.
)

// Service uses the shared database and credential authority without owning their lifecycle.
type Service struct {
	DB               *sql.DB                                      // Application's one connection pool.
	Config           config.Config                                // Confirmed input limits.
	Accounts         *account.Service                             // Password verification and session authority.
	Now              func() time.Time                             // Fixed once after acquiring a write transaction.
	verifyManagement func(context.Context, string) (int64, error) // Slow credential boundary, replaceable by same-package tests.
}

// New builds the shop without creating sample products or modifying schema.
func New(db *sql.DB, cfg config.Config, accounts *account.Service) *Service {
	return &Service{DB: db, Config: cfg, Accounts: accounts, Now: time.Now, verifyManagement: accounts.VerifyManagement}
}

// Product describes the current offer; its fields never rewrite existing purchase snapshots.
type Product struct {
	SceneKey      string `json:"scene_key,omitempty"`       // Permanent scene identity independent of its artwork.
	PackName      string `json:"pack_name,omitempty"`       // Human-readable official source pack name.
	CharacterKey  string `json:"character_key,omitempty"`   // Permanent character identity independent of model versions.
	Provider      string `json:"provider,omitempty"`        // Controlled source provider.
	PackKey       string `json:"pack_key,omitempty"`        // Controlled source pack.
	CreatedAt     int64  `json:"-"`                         // Stable product pagination boundary.
	WearableKey   string `json:"wearable_key,omitempty"`    // Stable three-dimensional clothing definition.
	IslandItemKey string `json:"island_item_key,omitempty"` // Optional current island capability identity.
	Repeatable    bool   `json:"repeatable"`                // Additional purchases create independent instances.
	OwnedCount    int64  `json:"owned_count"`               // Total instances of this controlled item.
	ID            string `json:"id"`                        // Stable merchandise identity.
	Type          string `json:"type"`                      // One of the declared product behaviors.
	Name          string `json:"name"`                      // Current display name.
	AssetKey      string `json:"asset_key"`                 // Controlled immutable artwork identity.
	Description   string `json:"description"`               // Plain product description.
	CoinPrice     int64  `json:"coin_price"`                // Current nonnegative coin price.
	DiamondPrice  int64  `json:"diamond_price"`             // Current nonnegative diamond price.
	Stock         *int64 `json:"stock"`                     // Nil means unlimited; zero means sold out.
	Enabled       bool   `json:"enabled"`                   // Whether new purchases are offered.
	Version       int64  `json:"version"`                   // Confirmation version, including finite stock changes.
	Owned         bool   `json:"owned"`                     // Whether the sole account already owns this permanent product.
	Deleted       bool   `json:"-"`                         // Internal soft-deletion marker, never a client authorization flag.
}

// ProductInput is the complete mutable merchandise configuration.
type ProductInput struct {
	SceneKey     string `json:"scene_key,omitempty"`     // Required for scene products, empty for other types.
	CharacterKey string `json:"character_key,omitempty"` // Required for character products; empty for other behaviors.
	WearableKey  string `json:"wearable_key,omitempty"`  // Required for three-dimensional clothing, empty for other types.
	Type         string `json:"type"`                    // Selected product type.
	Name         string `json:"name"`                    // Required name, trimmed before storage.
	AssetKey     string `json:"asset_key"`               // Artwork of the matching controlled kind.
	Description  string `json:"description"`             // Optional plain text.
	CoinPrice    int64  `json:"coin_price"`              // Coins required for a new purchase.
	DiamondPrice int64  `json:"diamond_price"`           // Diamonds required at the same time.
	Stock        *int64 `json:"stock"`                   // Unlimited or nonnegative finite stock.
	Enabled      bool   `json:"enabled"`                 // Whether the product is currently purchasable.
}

// ProductUpdate carries the version the household reviewed before editing.
type ProductUpdate struct {
	ProductInput          // All mutable product fields.
	ExpectedVersion int64 `json:"expected_version"` // Rejects a stale configuration form.
}

// ProductList always emits an array, including for an empty shop.
type ProductList struct {
	Items      []Product      `json:"items"`            // Current undeleted offers or managed configuration.
	NextCursor *string        `json:"next_cursor"`      // Null when the selected product query is exhausted.
	Facets     *ProductFacets `json:"facets,omitempty"` // Complete visible source choices independent of this page.
}

// ProductPack identifies a visible source pack without deriving it from current page contents.
type ProductPack struct {
	Name     string `json:"name,omitempty"` // Official display name, when known.
	Key      string `json:"key"`            // Controlled pack identity.
	Provider string `json:"provider"`       // Source provider identity.
}

// ProductFacets contains complete source choices for the current authority.
type ProductFacets struct {
	Providers []string      `json:"providers"` // Sorted provider identities.
	Packs     []ProductPack `json:"packs"`     // Sorted source pack identities.
}

// ProductQuery binds pagination to explicit catalog filters.
type ProductQuery struct {
	Type     string // Optional exact behavior.
	Group    string // Optional appearance group.
	Slot     string // Optional wearable slot.
	Search   string // Case-insensitive display name search.
	Provider string // Optional controlled provider identity.
	PackKey  string // Optional controlled source pack identity.
	Cursor   string // Previous stable boundary for these same filters.
	Limit    int    // Requested page size, from one through one hundred.
}

// Purchase is a permanent transaction snapshot plus the independent redemption state.
type Purchase struct {
	SceneKey            string  `json:"scene_key,omitempty"`       // Scene identity copied at purchase time.
	PackName            string  `json:"pack_name,omitempty"`       // Human-readable official source pack name.
	Provider            string  `json:"provider,omitempty"`        // Current catalog source of the purchased resource.
	PackKey             string  `json:"pack_key,omitempty"`        // Current catalog source pack.
	CharacterKey        string  `json:"character_key,omitempty"`   // Character identity copied at purchase time.
	WearableKey         string  `json:"wearable_key,omitempty"`    // Clothing identity copied at purchase time, independent of the live offer.
	ItemKeySnapshot     string  `json:"-"`                         // Stable item identity retained independently from versioned sale artwork.
	IslandItemKey       string  `json:"island_item_key,omitempty"` // Current capability identity resolved independently of sale facts.
	ID                  string  `json:"id"`                        // Stable order and ownership identity.
	ProductID           string  `json:"product_id"`                // Source product, retained after soft deletion.
	TypeSnapshot        string  `json:"type_snapshot"`             // Purchased behavior cannot change later.
	NameSnapshot        string  `json:"name_snapshot"`             // Name at purchase time.
	AssetKeySnapshot    string  `json:"asset_key_snapshot"`        // Persistent versioned artwork.
	DescriptionSnapshot string  `json:"description_snapshot"`      // Description at purchase time.
	CoinPrice           int64   `json:"coin_price"`                // Coins actually paid.
	DiamondPrice        int64   `json:"diamond_price"`             // Diamonds actually paid.
	Status              string  `json:"status"`                    // owned, pending or redeemed.
	RedeemedAt          *string `json:"redeemed_at"`               // Actual confirmation instant, or null.
	Version             int64   `json:"version"`                   // Increases only when redemption changes status.
	CreatedAt           string  `json:"created_at"`                // Actual UTC purchase instant.
}

// BuyInput binds the final confirmation to the displayed merchandise and balance versions.
type BuyInput struct {
	ProductID              string `json:"product_id"`               // Confirmed product.
	ExpectedProductVersion int64  `json:"expected_product_version"` // Confirmed price and stock version.
	ExpectedWalletVersion  int64  `json:"expected_wallet_version"`  // Confirmed balance version.
}

// PurchaseResult combines current order state with the original economic receipt on replay.
type PurchaseResult struct {
	Purchase Purchase       `json:"purchase"` // Stable purchase; redemption state may since have changed.
	Wallet   wallet.Balance `json:"wallet"`   // Balance immediately after the original purchase.
}

// PurchaseQuery filters immutable orders using stable keyset pagination.
type PurchaseQuery struct {
	Group    string // Optional appearance group.
	Slot     string // Optional wearable attachment slot.
	Search   string // Display name substring across all matching orders.
	Provider string // Optional current controlled source.
	PackKey  string // Optional current controlled source pack.
	Type     string // Empty means all declared product types.
	Status   string // Empty means all valid order statuses.
	Cursor   string // Opaque previous page boundary bound to these filters.
	Limit    int    // Zero uses fifty; valid explicit range is one through one hundred.
}

// PurchaseList exposes whether further orders remain instead of implying page one is complete.
type PurchaseList struct {
	Facets     *ProductFacets `json:"facets,omitempty"` // Complete sources in owned orders, independent of current page.
	Items      []Purchase     `json:"items"`            // Orders in newest-first stable order.
	NextCursor *string        `json:"next_cursor"`      // Null only when this query is fully loaded.
}

// Equipment keeps the title separate from the versioned three-dimensional appearance.
type Equipment struct {
	Title *Purchase `json:"title"` // Owned title or nil when none is selected.
}

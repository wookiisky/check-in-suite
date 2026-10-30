// Package shop owns merchandise, immutable purchases and persistent equipment.
package shop

import (
	"context"
	"database/sql"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/assets"
	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/wallet"
)

const (
	TypeIsland        = "island"          // Controlled island construction item.
	TypeTitle         = "title"           // One equipped title, permanently owned after purchase.
	TypeAvatar        = "avatar"          // One equipped character; nil restores the default.
	TypeBackground    = "background"      // One equipped scene behind the character and accessories.
	TypeEffect        = "effect"          // Independently equipped fixed animation overlays.
	TypeAccessory     = "accessory"       // Up to ten distinct equipped permanent decorations.
	TypeReward        = "reward"          // A repeatable household reward requiring redemption.
	StatusOwned       = "owned"           // Permanent ownership has no redemption step.
	StatusPending     = "pending"         // A purchased household reward awaiting confirmation.
	StatusRedeemed    = "redeemed"        // The reward has been confirmed exactly once.
	AccessoryLimit    = 10                // Limit applies to equipment, never total ownership.
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
	WearableSlot     assets.WearableSlot `json:"wearable_slot,omitempty"`      // Fixed attachment resolved from controlled artwork.
	BackAssetKey     string              `json:"back_asset_key,omitempty"`     // Optional rear hair layer.
	PortraitType     string              `json:"portrait_type,omitempty"`      // Current optional portrait equipment role.
	PortraitAssetKey string              `json:"portrait_asset_key,omitempty"` // Current optional portrait artwork, independent from sale thumbnail.
	IslandItemKey    string              `json:"island_item_key,omitempty"`    // Optional current island capability identity.
	Repeatable       bool                `json:"repeatable"`                   // Additional purchases create independent instances.
	OwnedCount       int64               `json:"owned_count"`                  // Total instances of this controlled item.
	ID               string              `json:"id"`                           // Stable merchandise identity.
	Type             string              `json:"type"`                         // One of the declared product behaviors.
	Name             string              `json:"name"`                         // Current display name.
	AssetKey         string              `json:"asset_key"`                    // Controlled immutable artwork identity.
	Description      string              `json:"description"`                  // Plain product description.
	CoinPrice        int64               `json:"coin_price"`                   // Current nonnegative coin price.
	DiamondPrice     int64               `json:"diamond_price"`                // Current nonnegative diamond price.
	Stock            *int64              `json:"stock"`                        // Nil means unlimited; zero means sold out.
	Enabled          bool                `json:"enabled"`                      // Whether new purchases are offered.
	Version          int64               `json:"version"`                      // Confirmation version, including finite stock changes.
	Owned            bool                `json:"owned"`                        // Whether the sole account already owns this permanent product.
	Deleted          bool                `json:"-"`                            // Internal soft-deletion marker, never a client authorization flag.
}

// ProductInput is the complete mutable merchandise configuration.
type ProductInput struct {
	Type         string `json:"type"`          // Selected product type.
	Name         string `json:"name"`          // Required name, trimmed before storage.
	AssetKey     string `json:"asset_key"`     // Artwork of the matching controlled kind.
	Description  string `json:"description"`   // Optional plain text.
	CoinPrice    int64  `json:"coin_price"`    // Coins required for a new purchase.
	DiamondPrice int64  `json:"diamond_price"` // Diamonds required at the same time.
	Stock        *int64 `json:"stock"`         // Unlimited or nonnegative finite stock.
	Enabled      bool   `json:"enabled"`       // Whether the product is currently purchasable.
}

// ProductUpdate carries the version the household reviewed before editing.
type ProductUpdate struct {
	ProductInput          // All mutable product fields.
	ExpectedVersion int64 `json:"expected_version"` // Rejects a stale configuration form.
}

// ProductList always emits an array, including for an empty shop.
type ProductList struct {
	Items []Product `json:"items"` // Current undeleted offers or managed configuration.
}

// Purchase is a permanent transaction snapshot plus the independent redemption state.
type Purchase struct {
	WearableSlot        assets.WearableSlot `json:"wearable_slot,omitempty"`      // Fixed attachment from the purchased controlled artwork.
	BackAssetKey        string              `json:"back_asset_key,omitempty"`     // Optional rear hair layer.
	ItemKeySnapshot     string              `json:"-"`                            // Stable item identity retained independently from versioned sale artwork.
	PortraitType        string              `json:"portrait_type,omitempty"`      // Current optional portrait equipment role.
	PortraitAssetKey    string              `json:"portrait_asset_key,omitempty"` // Current optional portrait artwork, independent from sale thumbnail.
	IslandItemKey       string              `json:"island_item_key,omitempty"`    // Current capability identity resolved independently of sale facts.
	ID                  string              `json:"id"`                           // Stable order and ownership identity.
	ProductID           string              `json:"product_id"`                   // Source product, retained after soft deletion.
	TypeSnapshot        string              `json:"type_snapshot"`                // Purchased behavior cannot change later.
	NameSnapshot        string              `json:"name_snapshot"`                // Name at purchase time.
	AssetKeySnapshot    string              `json:"asset_key_snapshot"`           // Persistent versioned artwork.
	DescriptionSnapshot string              `json:"description_snapshot"`         // Description at purchase time.
	CoinPrice           int64               `json:"coin_price"`                   // Coins actually paid.
	DiamondPrice        int64               `json:"diamond_price"`                // Diamonds actually paid.
	Status              string              `json:"status"`                       // owned, pending or redeemed.
	RedeemedAt          *string             `json:"redeemed_at"`                  // Actual confirmation instant, or null.
	Version             int64               `json:"version"`                      // Increases only when redemption changes status.
	CreatedAt           string              `json:"created_at"`                   // Actual UTC purchase instant.
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
	Type   string // Empty means all declared product types.
	Status string // Empty means all valid order statuses.
	Cursor string // Opaque previous page boundary bound to these filters.
	Limit  int    // Zero uses fifty; valid explicit range is one through one hundred.
}

// PurchaseList exposes whether further orders remain instead of implying page one is complete.
type PurchaseList struct {
	Items      []Purchase `json:"items"`       // Orders in newest-first stable order.
	NextCursor *string    `json:"next_cursor"` // Null only when this query is fully loaded.
}

// Equipment contains snapshot identities so removing a product never erases an outfit.
type Equipment struct {
	BaseAvatarKey    string                     `json:"base_avatar_key"`   // Selected free character, retained while using an animal.
	Wearables        Wearables                  `json:"wearables"`         // Independent fixed attachments that never use accessory layouts.
	Title            *Purchase                  `json:"title"`             // Nil leaves the title slot empty.
	Avatar           *Purchase                  `json:"avatar"`            // Nil selects the built-in default character.
	Background       *Purchase                  `json:"background"`        // Nil selects the built-in default scene.
	Accessories      []Purchase                 `json:"accessories"`       // Stable equipment-time order, zero through ten.
	Effects          []Purchase                 `json:"effects"`           // Fixed overlays in stable equipment-time order.
	AccessoryLayouts map[string]AccessoryLayout `json:"accessory_layouts"` // Geometry and order for equipped accessories only.
}

// Wearables contains one independently replaceable purchase per attachment.
type Wearables struct {
	Hair   *Purchase `json:"hair"`   // Nil restores the base character's default hairstyle.
	Top    *Purchase `json:"top"`    // Nil restores the default upper garment.
	Bottom *Purchase `json:"bottom"` // Nil restores the default lower garment.
	Shoes  *Purchase `json:"shoes"`  // Nil restores default footwear.
}

// AccessoryLayout uses a square normalized canvas and a square image-contain box.
type AccessoryLayout struct {
	X        float64 `json:"x"`        // Horizontal center, with the image box entirely inside the canvas.
	Y        float64 `json:"y"`        // Vertical center, with the image box entirely inside the canvas.
	Size     float64 `json:"size"`     // Box side as a fraction of the canvas side, from .05 through 1.
	Rotation float64 `json:"rotation"` // Clockwise angle in degrees, from zero up to but excluding 360.
	Layer    int     `json:"layer"`    // Negative behind the character; positive in front; character is zero.
}

// AccessoryLayoutInput saves one accessory and its absolute ordering intent together.
type AccessoryLayoutInput struct {
	X        float64 `json:"x"`         // Desired normalized horizontal center.
	Y        float64 `json:"y"`         // Desired normalized vertical center.
	Size     float64 `json:"size"`      // Desired normalized square image-contain box side.
	Rotation float64 `json:"rotation"`  // Desired clockwise angle in degrees, in [0, 360).
	BeforeID *string `json:"before_id"` // Another equipped purchase or "avatar"; null places it on top.
}

// AccessoryResult describes only the selected decoration's idempotent desired state.
type AccessoryResult struct {
	PurchaseID string `json:"purchase_id"` // The affected permanent accessory order.
	Equipped   bool   `json:"equipped"`    // Confirmed final desired state.
}

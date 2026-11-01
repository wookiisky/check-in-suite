package shop

import "github.com/wookiisky/check-in-suite/internal/character"

// SaveAppearanceInput replaces all four slots under one appearance version.
type SaveAppearanceInput struct {
	HairFreeWearableKey  *string `json:"hair_free_wearable_key"`  // Optional initial free garment shared across controlled bodies.
	UpperFreeWearableKey *string `json:"upper_free_wearable_key"` // Optional initial free garment shared across controlled bodies.
	LowerFreeWearableKey *string `json:"lower_free_wearable_key"` // Optional initial free garment shared across controlled bodies.
	ShoesFreeWearableKey *string `json:"shoes_free_wearable_key"` // Optional initial free garment shared across controlled bodies.

	ExpectedVersion int64   `json:"expected_version"`  // Version reviewed before saving.
	CharacterKey    string  `json:"character_key"`     // Controlled body and compatibility identity.
	HairPurchaseID  *string `json:"hair_purchase_id"`  // Nil restores the default hairstyle.
	UpperPurchaseID *string `json:"upper_purchase_id"` // Nil restores the default upper garment.
	LowerPurchaseID *string `json:"lower_purchase_id"` // Nil restores the default lower garment.
	ShoesPurchaseID *string `json:"shoes_purchase_id"` // Nil restores default footwear.
}

// AppearanceOwnedItem links an owned instance to its immutable clothing definition.
type AppearanceOwnedItem struct {
	PurchaseID  string `json:"purchase_id"`  // Permanent owned purchase identity.
	WearableKey string `json:"wearable_key"` // Definition copied when the item was bought.
}

// AppearanceOwnedCharacter preserves each permanently acquired character identity.
type AppearanceOwnedCharacter struct {
	PurchaseID   string `json:"purchase_id"`   // Original owned order identity.
	CharacterKey string `json:"character_key"` // Stable character identity copied in the order.
}

// AppearanceState is one snapshot of saved choices, definitions and complete ownership.
type AppearanceState struct {
	HairFreeWearableKey  *string `json:"hair_free_wearable_key"`  // Optional initial free garment shared across controlled bodies.
	UpperFreeWearableKey *string `json:"upper_free_wearable_key"` // Optional initial free garment shared across controlled bodies.
	LowerFreeWearableKey *string `json:"lower_free_wearable_key"` // Optional initial free garment shared across controlled bodies.
	ShoesFreeWearableKey *string `json:"shoes_free_wearable_key"` // Optional initial free garment shared across controlled bodies.

	DefaultCharacterKey string                     `json:"default_character_key"` // Explicit free initial character identity.
	CharacterInventory  []AppearanceOwnedCharacter `json:"character_inventory"`   // All acquired characters, independent of order pagination.
	Version             int64                      `json:"version"`               // Independent optimistic appearance version.
	CharacterKey        string                     `json:"character_key"`         // Selected controlled body.
	HairPurchaseID      *string                    `json:"hair_purchase_id"`      // Saved hairstyle instance or default.
	UpperPurchaseID     *string                    `json:"upper_purchase_id"`     // Saved upper garment instance or default.
	LowerPurchaseID     *string                    `json:"lower_purchase_id"`     // Saved lower garment instance or default.
	ShoesPurchaseID     *string                    `json:"shoes_purchase_id"`     // Saved footwear instance or default.
	Characters          []character.Definition     `json:"characters"`            // Versioned body definitions.
	Wearables           []character.Wearable       `json:"wearables"`             // Versioned clothing definitions and geometry references.
	Inventory           []AppearanceOwnedItem      `json:"inventory"`             // Entire owned 3D wardrobe, independent of order pagination.
}

package shop

import "github.com/wookiisky/check-in-suite/internal/character"

// SaveAppearanceInput replaces all six slots under one appearance version.
type SaveAppearanceInput struct {
	FaceFreeWearableKey  *string `json:"face_free_wearable_key"`  // Optional default part of an acquired body, shared across compatible bodies.
	HeadFreeWearableKey  *string `json:"head_free_wearable_key"`  // Optional default part of an acquired body, shared across compatible bodies.
	UpperFreeWearableKey *string `json:"upper_free_wearable_key"` // Optional default part of an acquired body, shared across compatible bodies.
	LowerFreeWearableKey *string `json:"lower_free_wearable_key"` // Optional default part of an acquired body, shared across compatible bodies.
	BackFreeWearableKey  *string `json:"back_free_wearable_key"`  // Optional default part of an acquired body, shared across compatible bodies.
	ShoesFreeWearableKey *string `json:"shoes_free_wearable_key"` // Optional default part of an acquired body, shared across compatible bodies.

	ExpectedVersion int64   `json:"expected_version"`  // Version reviewed before saving.
	CharacterKey    string  `json:"character_key"`     // Controlled body and compatibility identity.
	FacePurchaseID  *string `json:"face_purchase_id"`  // Nil restores the default face.
	HeadPurchaseID  *string `json:"head_purchase_id"`  // Nil restores the default head item.
	UpperPurchaseID *string `json:"upper_purchase_id"` // Nil restores the default upper garment.
	LowerPurchaseID *string `json:"lower_purchase_id"` // Nil restores the default lower garment.
	BackPurchaseID  *string `json:"back_purchase_id"`  // Nil restores the default back item.
	ShoesPurchaseID *string `json:"shoes_purchase_id"` // Nil restores default footwear.
}

// AppearanceOwnedItem links an owned instance to its immutable wearable definition.
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
	PreviewAnimations []character.Animation `json:"preview_animations"` // 标准身体共用的检查动作目录，不随人物数量重复。

	FaceFreeWearableKey  *string `json:"face_free_wearable_key"`  // Optional default part of an acquired body, shared across compatible bodies.
	HeadFreeWearableKey  *string `json:"head_free_wearable_key"`  // Optional default part of an acquired body, shared across compatible bodies.
	UpperFreeWearableKey *string `json:"upper_free_wearable_key"` // Optional default part of an acquired body, shared across compatible bodies.
	LowerFreeWearableKey *string `json:"lower_free_wearable_key"` // Optional default part of an acquired body, shared across compatible bodies.
	BackFreeWearableKey  *string `json:"back_free_wearable_key"`  // Optional default part of an acquired body, shared across compatible bodies.
	ShoesFreeWearableKey *string `json:"shoes_free_wearable_key"` // Optional default part of an acquired body, shared across compatible bodies.

	DefaultCharacterKey string                     `json:"default_character_key"` // Explicit free initial character identity.
	CharacterInventory  []AppearanceOwnedCharacter `json:"character_inventory"`   // All acquired characters, independent of order pagination.
	Version             int64                      `json:"version"`               // Independent optimistic appearance version.
	CharacterKey        string                     `json:"character_key"`         // Selected controlled body.
	FacePurchaseID      *string                    `json:"face_purchase_id"`      // Nil restores the default face.
	HeadPurchaseID      *string                    `json:"head_purchase_id"`      // Saved head item instance or default.
	UpperPurchaseID     *string                    `json:"upper_purchase_id"`     // Saved upper garment instance or default.
	LowerPurchaseID     *string                    `json:"lower_purchase_id"`     // Saved lower garment instance or default.
	BackPurchaseID      *string                    `json:"back_purchase_id"`      // Nil restores the default back item.
	ShoesPurchaseID     *string                    `json:"shoes_purchase_id"`     // Saved footwear instance or default.
	Characters          []character.Definition     `json:"characters"`            // Versioned body definitions.
	Wearables           []character.Wearable       `json:"wearables"`             // Versioned wearable definitions and geometry references.
	Inventory           []AppearanceOwnedItem      `json:"inventory"`             // Entire owned six-slot wardrobe, independent of order pagination.
}

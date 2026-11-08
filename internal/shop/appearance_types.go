package shop

import "github.com/wookiisky/check-in-suite/internal/character"

// SaveAppearanceInput replaces all six slots under one appearance version.
type SaveAppearanceInput struct {
	HeadColorKey  *string `json:"head_color_key"`  // 省略或空值使用头部素材底色。
	UpperColorKey *string `json:"upper_color_key"` // 省略或空值使用上衣素材底色。
	LowerColorKey *string `json:"lower_color_key"` // 省略或空值使用下装素材底色。
	ShoesColorKey *string `json:"shoes_color_key"` // 省略或空值使用鞋子素材底色。
	BackColorKey  *string `json:"back_color_key"`  // 省略或空值使用背部素材底色。

	ExpectedVersion  int64   `json:"expected_version"`   // Version reviewed before saving.
	CharacterKey     string  `json:"character_key"`      // Controlled body and compatibility identity.
	FaceWearableKey  *string `json:"face_wearable_key"`  // 空值使用当前身体的默认件。
	HeadWearableKey  *string `json:"head_wearable_key"`  // 空值使用当前身体的默认件。
	UpperWearableKey *string `json:"upper_wearable_key"` // 空值使用当前身体的默认件。
	LowerWearableKey *string `json:"lower_wearable_key"` // 空值使用当前身体的默认件。
	BackWearableKey  *string `json:"back_wearable_key"`  // 空值使用当前身体的默认件。
	ShoesWearableKey *string `json:"shoes_wearable_key"` // 空值使用当前身体的默认件。
}

// AppearanceOwnedItem 是订单授予的稳定穿戴身份。
type AppearanceOwnedItem struct {
	WearableKey string `json:"wearable_key"` // 购买时记录的穿戴定义。
}

// AppearanceOwnedCharacter preserves each permanently acquired character identity.
type AppearanceOwnedCharacter struct {
	CharacterKey string `json:"character_key"` // Stable character identity copied in the order.
}

// AppearanceState is one snapshot of saved choices, definitions and complete ownership.
type AppearanceState struct {
	PreviewAnimations []character.Animation     `json:"preview_animations"` // 标准身体共用的检查动作目录，不随人物数量重复。
	WearableColors    []character.WearableColor `json:"wearable_colors"`    // 支持换色的部件共用的预设色。
	HeadColorKey      *string                   `json:"head_color_key"`     // 空值使用头部素材底色。
	UpperColorKey     *string                   `json:"upper_color_key"`    // 空值使用上衣素材底色。
	LowerColorKey     *string                   `json:"lower_color_key"`    // 空值使用下装素材底色。
	ShoesColorKey     *string                   `json:"shoes_color_key"`    // 空值使用鞋子素材底色。
	BackColorKey      *string                   `json:"back_color_key"`     // 空值使用背部素材底色。

	DefaultCharacterKey string                     `json:"default_character_key"` // Explicit free initial character identity.
	CharacterInventory  []AppearanceOwnedCharacter `json:"character_inventory"`   // All acquired characters, independent of order pagination.
	Version             int64                      `json:"version"`               // Independent optimistic appearance version.
	CharacterKey        string                     `json:"character_key"`         // Selected controlled body.
	FaceWearableKey     *string                    `json:"face_wearable_key"`     // 空值使用当前身体的默认件。
	HeadWearableKey     *string                    `json:"head_wearable_key"`     // 空值使用当前身体的默认件。
	UpperWearableKey    *string                    `json:"upper_wearable_key"`    // 空值使用当前身体的默认件。
	LowerWearableKey    *string                    `json:"lower_wearable_key"`    // 空值使用当前身体的默认件。
	BackWearableKey     *string                    `json:"back_wearable_key"`     // 空值使用当前身体的默认件。
	ShoesWearableKey    *string                    `json:"shoes_wearable_key"`    // 空值使用当前身体的默认件。
	Characters          []character.Definition     `json:"characters"`            // Versioned body definitions.
	Wearables           []character.Wearable       `json:"wearables"`             // Versioned wearable definitions and geometry references.
	Inventory           []AppearanceOwnedItem      `json:"inventory"`             // Entire owned six-slot wardrobe, independent of order pagination.
}

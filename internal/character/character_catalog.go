package character

import (
	_ "embed"
	"encoding/json"
)

// catalogJSON is the reviewed body, wearable and rig animation catalog.
//
//go:embed character-catalog.json
var catalogJSON []byte

// catalogContent groups the immutable definitions and their shared rig actions.
type catalogContent struct {
	Characters    []Definition                        `json:"characters"`     // 身体定义。
	Wearables     []Wearable                          `json:"wearables"`      // 六槽部件定义。
	AnimationSets map[string]map[string]actionBinding `json:"animation_sets"` // 按骨架身份绑定语义动作。
}

// readCatalog returns fresh data so callers cannot change another request's definitions.
func readCatalog() catalogContent {
	var result catalogContent
	if err := json.Unmarshal(catalogJSON, &result); err != nil {
		panic(err)
	}
	return result
}

// Definitions returns the current reviewed body catalog.
func Definitions() []Definition {
	catalog := readCatalog()
	for index := range catalog.Characters {
		body := &catalog.Characters[index]
		bindings := catalog.AnimationSets[body.RigKey]
		body.Animations = make(map[string]Animation, len(bindings))
		for key, binding := range bindings {
			body.Animations[key] = Animation{Clip: binding.Clip, AssetKey: binding.AssetKey, URL: assetURL(binding.AssetKey)}
		}
	}
	return catalog.Characters
}

// Wearables returns definitions without making any ownership claim.
func Wearables() []Wearable { return readCatalog().Wearables }

// Get looks up a stable character identity.
func Get(key string) (Definition, bool) {
	for _, item := range Definitions() {
		if item.Key == key {
			return item, true
		}
	}
	return Definition{}, false
}

// GetWearable looks up a stable garment identity.
func GetWearable(key string) (Wearable, bool) {
	for _, item := range Wearables() {
		if item.Key == key {
			return item, true
		}
	}
	return Wearable{}, false
}

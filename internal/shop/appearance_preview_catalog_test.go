package shop_test

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/character"
)

// 实际服务响应只序列化一份共享动作，人物增加不会把整份目录按人数复制。
func TestAppearanceSerializesSharedPreviewAnimationsOnce(t *testing.T) {
	fixture := newShopFixture(t)
	state, err := fixture.Service.Appearance(context.Background(), fixture.Principal)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.PreviewAnimations) == 0 {
		t.Fatal("appearance omitted shared preview animations")
	}
	legacy := map[string]bool{}
	for _, definition := range state.Characters {
		for _, animation := range definition.PreviewAnimations {
			legacy[animation.AssetKey] = true
		}
	}
	var sharedOnly character.Animation
	for _, animation := range state.PreviewAnimations {
		if !legacy[animation.AssetKey] {
			sharedOnly = animation
			break
		}
	}
	if sharedOnly.AssetKey == "" {
		t.Fatal("new preview catalog was copied into every character")
	}
	payload, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	key, _ := json.Marshal(sharedOnly.AssetKey)
	needle := append([]byte(`"asset_key":`), key...)
	if count := bytes.Count(payload, needle); count != 1 {
		t.Fatalf("shared animation serialized %d times", count)
	}
	duplicated := state
	duplicated.Characters = append([]character.Definition(nil), state.Characters...)
	for index := range duplicated.Characters {
		duplicated.Characters[index].PreviewAnimations = state.PreviewAnimations
	}
	duplicatedPayload, err := json.Marshal(duplicated)
	if err != nil {
		t.Fatal(err)
	}
	if len(payload) >= len(duplicatedPayload) {
		t.Fatalf("shared catalog did not reduce response: shared=%d repeated=%d", len(payload), len(duplicatedPayload))
	}
	t.Logf("actual JSON: characters=%d shared=%d bytes repeated=%d bytes", len(state.Characters), len(payload), len(duplicatedPayload))
}

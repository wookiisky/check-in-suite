package assets

import (
	"encoding/json"
	"testing"
)

// TestCharacterArtworkMetadata 验证角色缩略图保留来源并遵守受控图片格式。
func TestCharacterArtworkMetadata(t *testing.T) {
	item := Asset{Key: "test-character-v1", Name: "测试角色", Kind: KindCharacter, Format: "png", URL: "/api/v1/assets/test-character-v1", Provider: "kaykit", PackKey: "adventurers", License: "CC0-1.0"}
	if err := item.validateBuiltinMetadata(); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(item)
	if err != nil {
		t.Fatal(err)
	}
	var decoded Asset
	if err := json.Unmarshal(data, &decoded); err != nil || decoded != item {
		t.Fatalf("来源元数据未保留: %#v %v", decoded, err)
	}
	item.Format = "svg"
	if err := item.validateBuiltinMetadata(); err == nil {
		t.Fatal("角色缩略图必须来自实际模型渲染的PNG")
	}
}

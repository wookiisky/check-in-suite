package assets

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"image/png"
	"os"
	"testing"
)

// providerImportReport 保存逐模型交付身份，用真实容器验证报告与嵌入资源一致。
type providerImportReport struct {
	Items []struct {
		Selected                   bool   `json:"selected"`                      // 本次发布选择，完整本地库不要求在CI存在。
		PublishedModelAssetKey     string `json:"published_model_asset_key"`     // 本次正式模型身份。
		PublishedThumbnailAssetKey string `json:"published_thumbnail_asset_key"` // 本次正式缩略图身份。
		Status                     string `json:"status"`                        // 转换、排除或失败状态。
		ModelAssetKey              string `json:"model_asset_key"`               // 正式 GLB 身份。
		ThumbnailAssetKey          string `json:"thumbnail_asset_key"`           // 实际模型缩略图身份。
		ModelSHA256                string `json:"model_sha256"`                  // 交付模型的字节校验值。
		ThumbnailSHA256            string `json:"thumbnail_sha256"`              // 交付缩略图的字节校验值。
	} `json:"items"` // 全部源模型的结果，不只包含成功项。
}

// 全量解码交付 PNG 并检查实际 GLB 字节，登记或文件存在不能代替可用资源。
func TestProviderImportedResourcesAreSelfContained(t *testing.T) {
	data, err := os.ReadFile("provider-asset-manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var report providerImportReport
	if err := json.Unmarshal(data, &report); err != nil {
		t.Fatal(err)
	}
	prepared := 0
	for _, item := range report.Items {
		if !item.Selected {
			continue
		}
		item.ModelAssetKey = item.PublishedModelAssetKey
		item.ThumbnailAssetKey = item.PublishedThumbnailAssetKey
		if item.Status != "prepared" {
			t.Errorf("provider model is not resolved: %s %s", item.ModelAssetKey, item.Status)
			continue
		}
		prepared++
		model, modelOK := Get(item.ModelAssetKey)
		thumbnail, thumbnailOK := Get(item.ThumbnailAssetKey)
		if !modelOK || model.Kind != KindModel || !thumbnailOK || thumbnail.Kind != KindIsland {
			t.Errorf("provider resource absent from controlled catalog: %s", item.ModelAssetKey)
			continue
		}
		glb, err := builtin.ReadFile("builtin/" + item.ModelAssetKey + ".glb")
		if err != nil {
			t.Error(err)
			continue
		}
		image, err := builtin.ReadFile("builtin/" + item.ThumbnailAssetKey + ".png")
		if err != nil {
			t.Error(err)
			continue
		}
		modelHash, imageHash := sha256.Sum256(glb), sha256.Sum256(image)
		if hex.EncodeToString(modelHash[:]) != item.ModelSHA256 || hex.EncodeToString(imageHash[:]) != item.ThumbnailSHA256 {
			t.Errorf("provider byte checksum changed: %s", item.ModelAssetKey)
		}
		if len(glb) < 20 || binary.LittleEndian.Uint32(glb[:4]) != 0x46546c67 || binary.LittleEndian.Uint32(glb[4:8]) != 2 || int(binary.LittleEndian.Uint32(glb[8:12])) != len(glb) {
			t.Errorf("provider GLB header invalid: %s", item.ModelAssetKey)
			continue
		}
		length := int(binary.LittleEndian.Uint32(glb[12:16]))
		if length > len(glb)-20 {
			t.Errorf("provider GLB JSON truncated: %s", item.ModelAssetKey)
			continue
		}
		var document struct {
			Nodes []struct {
				Children []int `json:"children"`
			} `json:"nodes"` // 交付节点必须保持单一父级。
			Buffers []map[string]json.RawMessage `json:"buffers"` // 运行时不能再读取源缓冲。
			Images  []map[string]json.RawMessage `json:"images"`  // 运行时不能再读取源贴图。
		}
		if err := json.Unmarshal(glb[20:20+length], &document); err != nil {
			t.Error(err)
			continue
		}
		parents := make(map[int]int)
		for _, node := range document.Nodes {
			for _, child := range node.Children {
				parents[child]++
				if child < 0 || child >= len(document.Nodes) || parents[child] > 1 {
					t.Errorf("provider GLB has invalid child or duplicate parent: %s", item.ModelAssetKey)
				}
			}
		}
		for _, buffer := range document.Buffers {
			if _, external := buffer["uri"]; external {
				t.Errorf("external buffer in %s", item.ModelAssetKey)
			}
		}
		for _, image := range document.Images {
			if _, external := image["uri"]; external {
				t.Errorf("external image in %s", item.ModelAssetKey)
			}
		}
		decoded, err := png.Decode(bytes.NewReader(image))
		if err != nil {
			t.Errorf("provider PNG cannot decode: %s: %v", item.ThumbnailAssetKey, err)
			continue
		}
		visible := false
		for y := decoded.Bounds().Min.Y; y < decoded.Bounds().Max.Y && !visible; y++ {
			for x := decoded.Bounds().Min.X; x < decoded.Bounds().Max.X; x++ {
				_, _, _, alpha := decoded.At(x, y).RGBA()
				if alpha > 0 {
					visible = true
					break
				}
			}
		}
		if !visible {
			t.Errorf("provider PNG has no visible model: %s", item.ThumbnailAssetKey)
		}
	}
	if prepared == 0 {
		t.Fatal("no provider model has been delivered")
	}
}

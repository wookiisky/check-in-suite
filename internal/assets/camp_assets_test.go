package assets

import (
	"bytes"
	"image/png"
	"io"
	"testing"
)

// 免费身份只允许明确的基础形象和内置营地图片，不能绕过其他商品类型限制。
func TestFreeCampAssetMetadata(t *testing.T) {
	for _, sample := range []struct {
		kind     Kind
		format   string
		accepted bool
	}{{KindIsland, "png", true}, {KindAvatar, "svg", true}, {KindWearable, "png", false}, {KindAccessory, "svg", false}, {KindModel, "glb", false}, {KindAnimation, "glb", false}} {
		item := Asset{Key: "free-metadata-v1", Kind: sample.kind, Format: sample.format, Free: true}
		if (item.validateBuiltinMetadata() == nil) != sample.accepted {
			t.Fatalf("unexpected free metadata acceptance: %#v", item)
		}
	}
}

// 正式陈设、活动道具和免费房屋图均通过受控目录安装，不依赖Vite公开目录。
func TestCampAssetsInstallWithRealModels(t *testing.T) {
	service := New(t.TempDir())
	if err := service.Install(); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"camp-bed-v1", "camp-dining-table-v1", "camp-dining-chair-v1", "camp-sofa-v1", "camp-coffee-table-v1", "camp-television-v1", "camp-cabinet-v1", "camp-refrigerator-v1", "camp-kitchen-counter-v1", "camp-toilet-v1", "camp-washbasin-v1", "camp-shower-v1", "camp-reading-desk-v1", "camp-tree-v1", "camp-rocks-v1", "camp-flowers-v1", "camp-bench-v1", "camp-tent-v1", "camp-fence-v1", "camp-lamp-v1", "camp-sports-area-v1", "camp-ball-v1", "activity-reading-book-v1", "character-living-v1"} {
		item, ok := Get(key)
		if !ok || (item.Kind != KindModel && item.Kind != KindAnimation) {
			t.Fatalf("missing delivered model: %s", key)
		}
		file, err := service.Open(key)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(file)
		file.Close()
		if err != nil {
			t.Fatal(err)
		}
		document := readGraphicsGLB(t, data)
		for _, image := range document.Images {
			if image.URI != "" {
				t.Fatalf("external image in %s", key)
			}
		}
		for _, buffer := range document.Buffers {
			if buffer.URI != "" {
				t.Fatalf("external buffer in %s", key)
			}
		}
	}
	for _, key := range []string{"camp-house-v1-thumbnail", "camp-reading-desk-v1-thumbnail", "camp-sports-area-v1-thumbnail", "camp-ball-v1-thumbnail"} {
		item, ok := Get(key)
		if !ok || item.Kind != KindIsland {
			t.Fatalf("missing camp image: %s", key)
		}
		if item.Free != (key != "camp-ball-v1-thumbnail") {
			t.Fatalf("incorrect free capability: %s", key)
		}
		file, err := service.Open(key)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(file)
		file.Close()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := png.Decode(bytes.NewReader(data)); err != nil {
			t.Fatal(err)
		}
	}
}

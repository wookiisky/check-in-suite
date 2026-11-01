package assets

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"image/color"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/character"
)

// glbDocument exposes only the actual container fields needed by resource integration checks.
type glbDocument struct {
	Buffers []struct {
		URI string `json:"uri"`
	} `json:"buffers"` // GLB应内嵌数据。
	Images []struct {
		URI string `json:"uri"`
	} `json:"images"` // 纹理不得依赖相对外链。
	Nodes []struct {
		Name string `json:"name"`
		Mesh *int   `json:"mesh"`
		Skin *int   `json:"skin"`
	} `json:"nodes"` // 实际节点。
	Animations []struct {
		Name string `json:"name"`
	} `json:"animations"` // 可播放片段。
}

// readGraphicsGLB reads the actual embedded JSON chunk, not a separate description.
func readGraphicsGLB(t *testing.T, data []byte) glbDocument {
	t.Helper()
	if len(data) < 20 || string(data[:4]) != "glTF" || binary.LittleEndian.Uint32(data[4:8]) != 2 || int(binary.LittleEndian.Uint32(data[8:12])) != len(data) {
		t.Fatal("invalid GLB container")
	}
	length := int(binary.LittleEndian.Uint32(data[12:16]))
	if string(data[16:20]) != "JSON" || 20+length > len(data) {
		t.Fatal("missing actual GLB JSON")
	}
	var document glbDocument
	if err := json.Unmarshal(data[20:20+length], &document); err != nil {
		t.Fatal(err)
	}
	return document
}

// 实际GLB和缩略图经原有安装流程持久化，图片选择不能混入模型。
func TestGraphicsAssetsInstallAndPersist(t *testing.T) {
	directory := t.TempDir()
	service := New(directory)
	if err := service.Install(); err != nil {
		t.Fatal(err)
	}
	items, err := catalog()
	if err != nil {
		t.Fatal(err)
	}
	models, thumbnails := 0, 0
	for _, item := range items {
		if item.Kind != KindModel && item.Kind != KindAnimation && item.Kind != KindWearable {
			continue
		}
		if item.SourceURL == "" || item.License == "" {
			t.Fatalf("missing provenance: %s", item.Key)
		}
		file, err := New(directory).Open(item.Key)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(file)
		file.Close()
		if err != nil {
			t.Fatal(err)
		}
		expected, err := builtin.ReadFile("builtin/" + item.Key + "." + item.extension())
		if err != nil || !bytes.Equal(data, expected) {
			t.Fatalf("persisted bytes mismatch: %s %v", item.Key, err)
		}
		if item.Kind == KindWearable {
			thumbnails++
			picture, err := png.Decode(bytes.NewReader(data))
			if err != nil {
				t.Fatal(err)
			}
			transparent, visible := 0, 0
			for y := picture.Bounds().Min.Y; y < picture.Bounds().Max.Y; y++ {
				for x := picture.Bounds().Min.X; x < picture.Bounds().Max.X; x++ {
					pixel := color.NRGBAModel.Convert(picture.At(x, y)).(color.NRGBA)
					if pixel.A == 0 {
						transparent++
					} else {
						visible++
					}
				}
			}
			if transparent == 0 || visible == 0 {
				t.Fatalf("thumbnail must contain rendered geometry and transparency: %s", item.Key)
			}
			continue
		}
		models++
		if item.ContentType() != "model/gltf-binary" {
			t.Fatalf("wrong model media type: %#v", item)
		}
		document := readGraphicsGLB(t, data)
		for _, buffer := range document.Buffers {
			if buffer.URI != "" {
				t.Fatalf("GLB depends on external buffer: %s", item.Key)
			}
		}
		for _, image := range document.Images {
			if image.URI != "" {
				t.Fatalf("GLB depends on external texture: %s", item.Key)
			}
		}
	}
	if models == 0 || thumbnails == 0 {
		t.Fatal("3D resources were not installed")
	}
	choices, err := service.List()
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range choices {
		if item.Kind == KindModel || item.Kind == KindAnimation {
			t.Fatalf("non-image in selectable catalog: %s", item.Key)
		}
	}
	path := filepath.Join(directory, "character-medium-v1", "asset.glb")
	if err := os.WriteFile(path, []byte("different"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := service.Install(); err == nil {
		t.Fatal("existing GLB identity was overwritten")
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "different" {
		t.Fatal("conflicting file changed")
	}
}

// 人物与服装必须引用已交付的同源资源和实际模型节点。
func TestCharacterCatalogReferencesDeliveredGeometry(t *testing.T) {
	for _, definition := range character.Definitions() {
		asset, ok := Get(definition.ModelAssetKey)
		if !ok || asset.Kind != KindModel || definition.ModelURL != asset.URL {
			t.Fatalf("invalid character model: %#v", definition)
		}
		data, err := builtin.ReadFile("builtin/" + asset.Key + ".glb")
		if err != nil {
			t.Fatal(err)
		}
		document := readGraphicsGLB(t, data)
		nodes := map[string]bool{}
		for _, node := range document.Nodes {
			if node.Mesh != nil {
				nodes[node.Name] = node.Skin != nil
			}
		}
		for _, name := range definition.FixedNodes {
			if !nodes[name] {
				t.Fatalf("missing fixed skinned node: %s", name)
			}
		}
		for _, names := range definition.BodyRegions {
			for _, name := range names {
				if !nodes[name] {
					t.Fatalf("missing body region: %s", name)
				}
			}
		}
		for _, animation := range definition.Animations {
			asset, ok := Get(animation.AssetKey)
			if !ok || animation.URL != asset.URL {
				t.Fatalf("invalid animation resource: %#v", animation)
			}
			data, err := builtin.ReadFile("builtin/" + asset.Key + ".glb")
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, clip := range readGraphicsGLB(t, data).Animations {
				if clip.Name == animation.Clip {
					found = true
				}
			}
			if !found {
				t.Fatalf("missing actual animation clip: %#v", animation)
			}
		}
		for _, wearable := range character.Wearables() {
			if wearable.CharacterKey != definition.Key {
				continue
			}
			if wearable.RigKey != definition.RigKey || wearable.ModelAssetKey != asset.Key || wearable.ModelURL != asset.URL {
				t.Fatalf("incompatible wearable: %#v", wearable)
			}
			thumbnail, ok := Get(wearable.ThumbnailAssetKey)
			if !ok || thumbnail.Kind != KindWearable || thumbnail.URL != wearable.ThumbnailURL {
				t.Fatalf("missing wearable thumbnail: %#v", wearable)
			}
			for _, name := range wearable.Nodes {
				if !nodes[name] {
					t.Fatalf("missing wearable skinned node: %s", name)
				}
			}
			for _, region := range wearable.Covers {
				if _, ok := definition.BodyRegions[region]; !ok {
					t.Fatalf("unknown body coverage: %s", region)
				}
			}
		}
	}
}

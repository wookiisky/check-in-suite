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
		Name     string `json:"name"`
		Mesh     *int   `json:"mesh"`
		Skin     *int   `json:"skin"`
		Children []int  `json:"children"`
	} `json:"nodes"` // 实际节点。
	Animations []struct {
		Name string `json:"name"`
	} `json:"animations"` // 可播放片段。
	Skins []json.RawMessage `json:"skins"` // 蒙皮角色不能作为静态摆设留在发行包。
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
	body, ok := character.Get(character.DefaultCharacterKey)
	if !ok {
		t.Fatal("default body is missing")
	}
	path := filepath.Join(directory, body.ModelAssetKey, "asset.glb")
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
	documents := map[string]glbDocument{}
	readModel := func(key, url string) glbDocument {
		t.Helper()
		asset, ok := Get(key)
		if !ok || asset.Kind != KindModel || url != asset.URL {
			t.Fatalf("invalid character or wearable model: %s %s", key, url)
		}
		if document, ok := documents[key]; ok {
			return document
		}
		data, err := builtin.ReadFile("builtin/" + asset.Key + ".glb")
		if err != nil {
			t.Fatal(err)
		}
		document := readGraphicsGLB(t, data)
		documents[key] = document
		return document
	}
	for _, definition := range character.Definitions() {
		document := readModel(definition.ModelAssetKey, definition.ModelURL)
		nodes := graphicsSkinnedNodes(document)
		for _, name := range definition.FixedNodes {
			if !nodes[name] {
				t.Fatalf("missing fixed skinned node: %s %s", definition.Key, name)
			}
		}
		for _, names := range definition.BodyRegions {
			for _, name := range names {
				if !nodes[name] {
					t.Fatalf("missing body region: %s %s", definition.Key, name)
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
	}
	wearables := character.Wearables()
	for _, wearable := range wearables {
		body, ok := character.Get(wearable.CharacterKey)
		if !ok || wearable.RigKey != body.RigKey || wearable.BodyKey != body.BodyKey {
			t.Fatalf("incompatible wearable: %#v", wearable)
		}
		nodes := graphicsSkinnedNodes(readModel(wearable.ModelAssetKey, wearable.ModelURL))
		thumbnail, ok := Get(wearable.ThumbnailAssetKey)
		// 空默认项没有独立衣物，可以复用实际身体缩略图，但不能成为衣物商品。
		validThumbnailKind := thumbnail.Kind == KindWearable || (wearable.Empty && thumbnail.Kind == KindCharacter)
		if !ok || !validThumbnailKind || thumbnail.URL != wearable.ThumbnailURL {
			t.Fatalf("missing wearable thumbnail: %#v", wearable)
		}
		selected := map[string]bool{}
		for _, name := range wearable.Nodes {
			if !nodes[name] {
				t.Fatalf("missing wearable skinned node: %s %s", wearable.Key, name)
			}
			selected[name] = true
		}
		// 覆盖既可隐藏身体，也可隐藏另一槽穿戴的局部网格。
		knownRegions := map[string]bool{}
		for region := range body.BodyRegions {
			knownRegions[region] = true
		}
		for _, other := range wearables {
			if other.Slot == wearable.Slot || other.BodyKey != wearable.BodyKey || other.RigKey != wearable.RigKey {
				continue
			}
			for region := range other.Regions {
				knownRegions[region] = true
			}
		}
		for _, region := range wearable.Covers {
			if !knownRegions[region] {
				t.Fatalf("unknown coverage region: %s %s", wearable.Key, region)
			}
		}
		for region, names := range wearable.Regions {
			if region == "" || len(names) == 0 {
				t.Fatalf("empty wearable subregion: %s %s", wearable.Key, region)
			}
			for _, name := range names {
				if !selected[name] {
					t.Fatalf("wearable subregion selects an unrelated node: %s %s", wearable.Key, name)
				}
			}
		}
	}
}

// 多材质节点可以是容器，其实际网格必须全部绑定到交付骨架。
func graphicsSkinnedNodes(document glbDocument) map[string]bool {
	var inspect func(int) (int, bool)
	inspect = func(index int) (int, bool) {
		node := document.Nodes[index]
		count, valid := 0, true
		if node.Mesh != nil {
			count = 1
			valid = node.Skin != nil && *node.Skin >= 0 && *node.Skin < len(document.Skins)
		}
		for _, child := range node.Children {
			meshes, skinned := inspect(child)
			count += meshes
			valid = valid && skinned
		}
		return count, valid
	}
	nodes := map[string]bool{}
	for index, node := range document.Nodes {
		count, valid := inspect(index)
		nodes[node.Name] = count > 0 && valid
	}
	return nodes
}

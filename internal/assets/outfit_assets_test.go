package assets

import (
	"bytes"
	"encoding/xml"
	"image"
	"image/color"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"testing"

	_ "golang.org/x/image/webp"
)

// TestOutfitAssetsInstall checks each new business kind and every effect's immutable still image.
func TestOutfitAssetsInstall(t *testing.T) {
	service := New(t.TempDir())
	if err := service.Install(); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"background-meadow-v1", "background-night-v1", "effect-snow-v1", "effect-sparkle-v1"} {
		item, err := service.Lookup(key)
		if err != nil {
			t.Fatal(err)
		}
		if item.Kind != KindBackground && item.Kind != KindEffect {
			t.Fatalf("unexpected outfit kind: %s", item.Kind)
		}
		for _, still := range []bool{false, true} {
			file, err := service.OpenVariant(key, still)
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(file)
			file.Close()
			if err != nil {
				t.Fatal(err)
			}
			var svg struct {
				XMLName xml.Name
				ViewBox string `xml:"viewBox,attr"`
			}
			if err := xml.Unmarshal(body, &svg); err != nil || svg.XMLName.Local != "svg" || svg.ViewBox == "" {
				t.Fatalf("invalid scalable artwork %s: %v", key, err)
			}
			if item.Kind == KindEffect && still && (bytes.Contains(body, []byte("<animate")) || bytes.Contains(body, []byte("@keyframes"))) {
				t.Fatalf("still effect animates: %s", key)
			}
		}
	}
	stillPath := filepath.Join(service.Directory, "effect-snow-v1", "asset-static.svg")
	if err := os.WriteFile(stillPath, []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := service.Install(); err == nil {
		t.Fatal("existing effect still image was overwritten")
	}
}

// TestControlledRasterAssets checks persisted formats and transparent pixel decoding without uploads.
func TestControlledRasterAssets(t *testing.T) {
	service := New(t.TempDir())
	drawing := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	drawing.SetNRGBA(0, 0, color.NRGBA{R: 70, G: 150, B: 90, A: 255})
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, drawing); err != nil {
		t.Fatal(err)
	}
	webp, err := os.ReadFile("testdata/transparent.webp")
	if err != nil {
		t.Fatal(err)
	}
	for _, sample := range []struct {
		format string
		body   []byte
		mime   string
	}{
		{"png", encoded.Bytes(), "image/png"}, {"webp", webp, "image/webp"},
	} {
		item := Asset{Key: "sample-" + sample.format + "-v1", Name: "格式测试", Kind: KindAccessory, Format: sample.format}
		item.URL = "/api/v1/assets/" + item.Key
		if err := service.install(item, sample.body, nil); err != nil {
			t.Fatal(err)
		}
		if err := service.install(item, sample.body, nil); err != nil {
			t.Fatalf("repeat raster install: %v", err)
		}
		file, err := service.Open(item.Key)
		if err != nil {
			t.Fatal(err)
		}
		decoded, format, err := image.Decode(file)
		file.Close()
		if err != nil || format != sample.format {
			t.Fatalf("raster decode: %s %v", format, err)
		}
		_, _, _, alpha := decoded.At(1, 1).RGBA()
		if alpha != 0 || item.ContentType() != sample.mime {
			t.Fatalf("format or alpha lost: %s %d", item.ContentType(), alpha)
		}
	}
}

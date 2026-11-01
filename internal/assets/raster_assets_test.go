package assets

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"os"
	"testing"

	_ "golang.org/x/image/webp"
)

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
		item := Asset{Key: "sample-" + sample.format + "-v1", Name: "格式测试", Kind: KindIcon, Format: sample.format}
		item.URL = "/api/v1/assets/" + item.Key
		if err := service.install(item, sample.body); err != nil {
			t.Fatal(err)
		}
		if err := service.install(item, sample.body); err != nil {
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

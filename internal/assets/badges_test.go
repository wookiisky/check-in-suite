package assets

import (
	"encoding/xml"
	"io"
	"testing"
)

// TestBadgeCatalogInstallsDistinctArtwork checks badge selection and readable persisted SVGs.
func TestBadgeCatalogInstallsDistinctArtwork(t *testing.T) {
	service := New(t.TempDir())
	if err := service.Install(); err != nil {
		t.Fatal(err)
	}
	items, err := service.List()
	if err != nil {
		t.Fatal(err)
	}
	badges := 0
	drawings := map[string]bool{}
	for _, item := range items {
		if item.Kind != KindBadge {
			continue
		}
		badges++
		if !Valid(item.Key, KindBadge) || Valid(item.Key, KindIcon) || Valid(item.Key, KindAccessory) {
			t.Fatalf("badge accepted for another business use: %s", item.Key)
		}
		file, err := service.Open(item.Key)
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
			t.Fatalf("badge is not scalable SVG: %s, %v", item.Key, err)
		}
		if drawings[string(body)] {
			t.Fatalf("badge artwork is duplicated: %s", item.Key)
		}
		drawings[string(body)] = true
	}
	if badges < 6 {
		t.Fatalf("expected at least six badge choices, got %d", badges)
	}
}

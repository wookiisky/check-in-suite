package assets

import (
	"encoding/xml"
	"io"
	"testing"
)

// TestMaterialCatalogInstallsEveryChoice checks complete, distinct, scalable artwork through the persistent store.
func TestMaterialCatalogInstallsEveryChoice(t *testing.T) {
	service := New(t.TempDir())
	if err := service.Install(); err != nil {
		t.Fatal(err)
	}
	items, err := service.List()
	if err != nil {
		t.Fatal(err)
	}
	counts := map[Kind]int{}
	keys := map[string]bool{}
	drawings := map[string]string{}
	for _, item := range items {
		if keys[item.Key] || item.URL != "/api/v1/assets/"+item.Key || !Valid(item.Key, item.Kind) {
			t.Fatalf("invalid or duplicate selectable asset: %#v", item)
		}
		keys[item.Key] = true
		counts[item.Kind]++
		file, err := service.Open(item.Key)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(file)
		file.Close()
		if err != nil {
			t.Fatal(err)
		}
		if item.ContentType() != "image/svg+xml" {
			continue
		}
		var svg struct {
			XMLName xml.Name
			ViewBox string `xml:"viewBox,attr"`
		}
		if err := xml.Unmarshal(body, &svg); err != nil || svg.XMLName.Local != "svg" || svg.ViewBox == "" {
			t.Fatalf("unreadable scalable choice %s: %v", item.Key, err)
		}
		// 导航图标可复用任务图标的图案，但保留各自稳定的素材身份。
		if item.Kind == KindIcon {
			continue
		}
		identity := string(item.Kind) + string(body)
		if previous := drawings[identity]; previous != "" {
			t.Fatalf("choices %s and %s use identical drawings", previous, item.Key)
		}
		drawings[identity] = item.Key
	}
	for kind, minimum := range map[Kind]int{KindIsland: 1, KindBadge: 12, KindIcon: 1, KindWearable: 1} {
		if counts[kind] < minimum {
			t.Errorf("incomplete %s choices: got %d, need at least %d", kind, counts[kind], minimum)
		}
	}
}

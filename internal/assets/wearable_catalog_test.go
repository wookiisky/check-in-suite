package assets

import "testing"

// TestWearableCatalogHidesInternalLayers keeps layer images readable without offering them as merchandise.
func TestWearableCatalogHidesInternalLayers(t *testing.T) {
	service := New(t.TempDir())
	if err := service.Install(); err != nil {
		t.Fatal(err)
	}
	choices, err := service.List()
	if err != nil {
		t.Fatal(err)
	}
	bases, fixed := 0, 0
	for _, item := range choices {
		if item.Kind == KindCharacterPart {
			t.Fatalf("internal composition layer offered as a choice: %s", item.Key)
		}
		if item.Free {
			bases++
		}
		if item.WearableSlot.Valid() {
			fixed++
		}
	}
	if bases != 2 || fixed != 14 {
		t.Fatalf("incomplete character choices: bases=%d wearables=%d", bases, fixed)
	}
	for _, key := range []string{"default-top-v1", "default-bottom-v1", "default-shoes-v1"} {
		layer, err := service.Lookup(key)
		if err != nil || layer.Kind != KindCharacterPart {
			t.Fatalf("missing internal layer %s: %+v %v", key, layer, err)
		}
		file, err := service.Open(key)
		if err != nil {
			t.Fatal(err)
		}
		file.Close()
	}
}

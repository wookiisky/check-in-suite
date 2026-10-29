package assets

import (
	"encoding/json"
	"encoding/xml"
	"io"
	"strings"
	"testing"
)

// TestHumanArtworkSeparatesFixedWearables verifies the installed composition used by all character views.
func TestHumanArtworkSeparatesFixedWearables(t *testing.T) {
	catalogBytes, err := builtin.ReadFile("builtin/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	var entries []struct {
		Key          string `json:"key"`
		Kind         string `json:"kind"`
		Free         bool   `json:"free"`
		WearableSlot string `json:"wearable_slot"`
		BackAssetKey string `json:"back_asset_key"`
	}
	if err := json.Unmarshal(catalogBytes, &entries); err != nil {
		t.Fatal(err)
	}
	service := New(t.TempDir())
	if err := service.Install(); err != nil {
		t.Fatal(err)
	}
	byKey := make(map[string]int)
	counts := make(map[string]int)
	for index, entry := range entries {
		byKey[entry.Key] = index
		if entry.Free && entry.Kind == "avatar" {
			counts["body"]++
		}
		if entry.WearableSlot != "" {
			counts[entry.WearableSlot]++
			if entry.Kind != "accessory" {
				t.Errorf("wearable has a non-purchasable kind: %s", entry.Key)
			}
		}
	}
	for slot, expected := range map[string]int{"body": 2, "hair": 11, "top": 1, "bottom": 1, "shoes": 1} {
		if counts[slot] != expected {
			t.Fatalf("%s choices: got %d, want %d", slot, counts[slot], expected)
		}
	}
	for _, key := range []string{"avatar-boy-v2", "avatar-girl-v2", "default-boy-hair-v1", "default-girl-hair-v1", "default-top-v1", "default-bottom-v1", "default-shoes-v1"} {
		if _, ok := byKey[key]; !ok {
			t.Fatalf("missing character composition layer: %s", key)
		}
	}
	for _, key := range []string{"default-boy-hair-v1", "default-girl-hair-v1", "default-top-v1", "default-bottom-v1", "default-shoes-v1"} {
		entry := entries[byKey[key]]
		if entry.Kind != "character-part" || entry.WearableSlot != "" {
			t.Fatalf("default character layer must not be sold as a wearable: %s", key)
		}
	}
	for _, entry := range entries {
		if !entry.Free && entry.WearableSlot == "" && entry.Kind != "character-part" {
			continue
		}
		t.Run(entry.Key, func(t *testing.T) {
			file, err := service.Open(entry.Key)
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			body, err := io.ReadAll(file)
			if err != nil {
				t.Fatal(err)
			}
			var svg struct {
				XMLName xml.Name
				ViewBox string `xml:"viewBox,attr"`
				Groups  []struct {
					ID string `xml:"id,attr"`
				} `xml:"g"`
			}
			if err := xml.Unmarshal(body, &svg); err != nil || svg.XMLName.Local != "svg" || svg.ViewBox != "0 0 320 320" {
				t.Fatalf("fixed wearable has no shared character canvas: %v", err)
			}
			if strings.Contains(string(body), "<image") || strings.Contains(string(body), "<script") {
				t.Fatal("character artwork must be self-contained vectors")
			}
			if entry.Free {
				groups := make(map[string]bool)
				for _, group := range svg.Groups {
					groups[group.ID] = true
				}
				if !groups["character-body"] || !groups["character-head"] || groups["character-ground"] || groups["hair-front"] {
					t.Fatal("base character must separate body/head from clothing, hair and scene ground")
				}
			}
			if entry.BackAssetKey != "" {
				index, ok := byKey[entry.BackAssetKey]
				if !ok || entries[index].Kind != "character-part" || entry.WearableSlot != "hair" {
					t.Fatal("hair back layer must reference a controlled character part")
				}
			}
		})
	}
}

package assets

import (
	"encoding/xml"
	"io"
	"testing"
)

// TestHumanHairstylesPreserveCharacter verifies each person's identity stays fixed across hairstyles.
func TestHumanHairstylesPreserveCharacter(t *testing.T) {
	service := New(t.TempDir())
	if err := service.Install(); err != nil {
		t.Fatal(err)
	}
	for _, person := range []struct {
		name string
		keys []string
	}{
		{"boy", []string{"avatar-boy-short-v1", "avatar-boy-curly-v1", "avatar-boy-sidepart-v1"}},
		{"girl", []string{"avatar-girl-long-v1", "avatar-girl-braids-v1", "avatar-girl-short-v1"}},
	} {
		t.Run(person.name, func(t *testing.T) {
			var base string
			drawings := map[string]bool{}
			for _, key := range person.keys {
				if !Valid(key, KindAvatar) || Valid(key, KindAccessory) {
					t.Fatalf("missing controlled human avatar: %s", key)
				}
				file, err := service.Open(key)
				if err != nil {
					t.Fatal(err)
				}
				body, err := io.ReadAll(file)
				file.Close()
				if err != nil {
					t.Fatal(err)
				}
				var svg struct {
					ViewBox string `xml:"viewBox,attr"`
					Groups  []struct {
						ID    string `xml:"id,attr"`
						Inner string `xml:",innerxml"`
					} `xml:"g"`
				}
				if err := xml.Unmarshal(body, &svg); err != nil || svg.ViewBox != "0 0 320 320" {
					t.Fatalf("invalid human avatar canvas %s: %v", key, err)
				}
				var current string
				for _, group := range svg.Groups {
					if group.ID == "character-base" {
						current = group.Inner
					}
				}
				if current == "" || base != "" && current != base {
					t.Fatalf("face, clothing or pose changed with hairstyle: %s", key)
				}
				base = current
				if drawings[string(body)] {
					t.Fatalf("hairstyle is indistinguishable: %s", key)
				}
				drawings[string(body)] = true
			}
		})
	}
}

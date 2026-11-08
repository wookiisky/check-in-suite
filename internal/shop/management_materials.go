package shop

import (
	"context"
	"database/sql"
	"maps"
	"slices"
	"strings"
	"sync"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/assets"
	"github.com/wookiisky/check-in-suite/internal/character"
	"github.com/wookiisky/check-in-suite/internal/island"
)

// ManagementMaterial presents a controlled thumbnail and its catalog classification.
type ManagementMaterial struct {
	Asset    assets.Asset `json:"asset"`    // Controlled thumbnail with source metadata.
	Group    string       `json:"group"`    // Shared appearance or camp shop group.
	Category string       `json:"category"` // Body, wearable slot, camp object category, or scene.
	Saleable bool         `json:"saleable"` // Whether the material can be bound to a new offer.
}

// ManagementActivityMaterial shows the same action clip used in the current camp.
type ManagementActivityMaterial struct {
	SceneKey           string `json:"scene_key"`                      // Stable scene identity.
	SceneName          string `json:"scene_name"`                     // Scene name from the live catalog.
	Activity           string `json:"activity"`                       // Business activity key.
	CharacterKey       string `json:"character_key"`                  // Body whose rig supplies the clip.
	CharacterName      string `json:"character_name"`                 // Body name from the live catalog.
	AssetKey           string `json:"asset_key"`                      // Controlled GLB containing the animation.
	Clip               string `json:"clip"`                           // Animation name inside the GLB.
	AttachmentAssetKey string `json:"attachment_asset_key,omitempty"` // Optional prop model.
}

// ManagementMaterials collects the existing material library and read-only activity bindings.
type ManagementMaterials struct {
	Items      []ManagementMaterial         `json:"items"`      // Character, wearable, camp, and scene thumbnails.
	Activities []ManagementActivityMaterial `json:"activities"` // Current bindings from the runtime catalogs.
}

// materialBinding resolves stable product identity from an exact, current thumbnail.
type materialBinding struct {
	productType   string // Product type derived from its owning definition.
	definitionKey string // Character, wearable, scene, or camp item identity.
}

// managementMaterialCatalog is initialized once from immutable embedded catalogs.
type managementMaterialCatalog struct {
	view    ManagementMaterials        // Read-only management projection.
	byAsset map[string]materialBinding // Exact current thumbnail lookup for product creation.
}

var materialCatalog = sync.OnceValue(buildManagementMaterialCatalog)

// buildManagementMaterialCatalog uses the same authoritative definitions as the renderer and shop.
func buildManagementMaterialCatalog() managementMaterialCatalog {
	result := managementMaterialCatalog{
		view:    ManagementMaterials{Items: []ManagementMaterial{}, Activities: []ManagementActivityMaterial{}},
		byAsset: map[string]materialBinding{},
	}
	add := func(key, group, category, kind, definition string, available bool) {
		asset, ok := assets.Get(key)
		if !ok || asset.Format == "glb" {
			return
		}
		// Camp scenes can use a camp-item thumbnail. Empty or default wearables can share body artwork.
		matchingKind := string(asset.Kind) == kind || kind == TypeScene && asset.Kind == assets.KindIsland
		if !matchingKind {
			return
		}
		material := ManagementMaterial{Asset: asset, Group: group, Category: category, Saleable: available && !asset.Free}
		if material.Saleable {
			result.byAsset[key] = materialBinding{productType: kind, definitionKey: definition}
		}
		result.view.Items = append(result.view.Items, material)
	}
	bodies := character.Definitions()
	for _, body := range bodies {
		add(body.ThumbnailAssetKey, shopAppearance, TypeCharacter, TypeCharacter, body.Key, body.Key != character.DefaultCharacterKey)
	}
	for _, wearable := range character.Wearables() {
		isDefault := slices.ContainsFunc(bodies, func(body character.Definition) bool {
			return body.Defaults.ForSlot(wearable.Slot) == wearable.Key
		})
		add(wearable.ThumbnailAssetKey, shopAppearance, string(wearable.Slot), TypeWearable, wearable.Key, !wearable.Empty && !isDefault)
	}
	for _, item := range island.SpatialCatalog() {
		category := shopProductCategory(Product{Type: TypeIsland, IslandItemKey: item.Key}, nil)
		add(item.ThumbnailAssetKey, shopCamp, category, TypeIsland, item.Key, !item.Free)
	}
	for _, scene := range island.SpatialSceneDefinitions() {
		add(scene.ThumbnailAssetKey, shopCamp, TypeScene, TypeScene, scene.Key, !scene.Free)
		for _, activity := range slices.Sorted(maps.Keys(scene.Scene.ActivityPresentations)) {
			presentation := scene.Scene.ActivityPresentations[activity]
			attachment := ""
			if presentation.Attachment != nil {
				attachment = strings.TrimPrefix(presentation.Attachment.ModelURL, "/api/v1/assets/")
			}
			for _, body := range bodies {
				animation, exists := body.Animations[presentation.Action]
				if exists {
					result.view.Activities = append(result.view.Activities, ManagementActivityMaterial{
						SceneKey: scene.Key, SceneName: scene.Name, Activity: activity, CharacterKey: body.Key, CharacterName: body.Name,
						AssetKey: animation.AssetKey, Clip: animation.Clip, AttachmentAssetKey: attachment,
					})
				}
			}
		}
	}
	return result
}

// ListManagementMaterials reads the catalog only with a valid management session.
func (s *Service) ListManagementMaterials(ctx context.Context, principal account.Principal) (ManagementMaterials, error) {
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return ManagementMaterials{}, err
	}
	defer tx.Rollback()
	if err := account.Authorize(ctx, tx, principal, true, s.Now()); err != nil {
		return ManagementMaterials{}, err
	}
	view := materialCatalog().view
	return ManagementMaterials{Items: slices.Clone(view.Items), Activities: slices.Clone(view.Activities)}, tx.Commit()
}

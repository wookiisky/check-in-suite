package shop

import (
	"context"
	"database/sql"
)

// ownershipCount aggregates order facts without making SQL grow with the asset catalog.
type ownershipCount struct {
	Owned bool  // Whether a permanent order exists.
	Count int64 // Number of currently owned instances.
}

// ownershipIdentity separates product quotes from the stable capability bought through them.
type ownershipIdentity struct {
	Product   string // Quote identity, empty for aggregate stable identities.
	Item      string // Stable island item identity.
	Character string // Stable character identity.
	Scene     string // Stable scene identity.
}

// addOwnership combines disjoint order groups while retaining permanent ownership.
func addOwnership(first, second ownershipCount) ownershipCount {
	return ownershipCount{Owned: first.Owned || second.Owned, Count: first.Count + second.Count}
}

// applyProductOwnership resolves all visible quotes with one grouped order query.
func applyProductOwnership(ctx context.Context, tx *sql.Tx, items []Product) error {
	counts := map[ownershipIdentity]ownershipCount{}
	rows, err := tx.QueryContext(ctx, `SELECT product_id,item_key_snapshot,character_key_snapshot,scene_key_snapshot,type_snapshot,status,count(*) FROM purchases GROUP BY product_id,item_key_snapshot,character_key_snapshot,scene_key_snapshot,type_snapshot,status`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var product, item, body, scene, kind, status string
		var count int64
		if err := rows.Scan(&product, &item, &body, &scene, &kind, &status, &count); err != nil {
			rows.Close()
			return err
		}
		value := ownershipCount{Owned: kind != TypeReward}
		if status == StatusOwned {
			value.Count = count
		}
		keys := []ownershipIdentity{{Product: product}}
		if item != "" {
			keys = append(keys, ownershipIdentity{Item: item}, ownershipIdentity{Product: product, Item: item})
		}
		if body != "" {
			keys = append(keys, ownershipIdentity{Character: body}, ownershipIdentity{Product: product, Character: body})
		}
		if scene != "" {
			keys = append(keys, ownershipIdentity{Scene: scene}, ownershipIdentity{Product: product, Scene: scene})
		}
		for _, key := range keys {
			counts[key] = addOwnership(counts[key], value)
		}
	}
	readErr := rows.Err()
	rows.Close()
	if readErr != nil {
		return readErr
	}
	for index := range items {
		item := &items[index]
		value := counts[ownershipIdentity{Product: item.ID}]
		var stable, intersection ownershipIdentity
		if item.Type == TypeScene {
			stable.Scene = item.SceneKey
			intersection = ownershipIdentity{Product: item.ID, Scene: item.SceneKey}
		} else if item.Type == TypeCharacter {
			stable.Character = item.CharacterKey
			intersection = ownershipIdentity{Product: item.ID, Character: item.CharacterKey}
		} else if item.IslandItemKey != "" {
			stable.Item = item.IslandItemKey
			intersection = ownershipIdentity{Product: item.ID, Item: item.IslandItemKey}
		}
		if stable.Item != "" || stable.Character != "" || stable.Scene != "" {
			other := counts[stable]
			value.Count += other.Count - counts[intersection].Count
			value.Owned = value.Owned || other.Owned
		}
		item.Owned, item.OwnedCount = value.Owned, value.Count
	}
	return nil
}

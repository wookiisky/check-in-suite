package island

import (
	"context"
	"testing"
)

// TestAccountsSaveIndependentScenes proves free instance IDs and versions are local to each account.
func TestAccountsSaveIndependentScenes(t *testing.T) {
	f := newSpatialFixture(t)
	ctx := context.Background()
	if err := f.accounts.Initialize(ctx, "second-spatial", "另一位", "second-login-password", "second-management-password"); err != nil {
		t.Fatal(err)
	}
	token, _, err := f.accounts.Login(ctx, "second-spatial", "second-login-password")
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.accounts.Authenticate(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	for _, scene := range SpatialSceneDefinitions() {
		if scene.Free {
			continue
		}
		grantSpatialScenes(t, f, scene.Key)
		if _, err := f.service.ReadSpatialScene(ctx, second, scene.Key); err == nil {
			t.Fatal("second account inherited a purchased scene")
		}
		break
	}
	if _, err := f.db.ExecContext(ctx, `INSERT INTO products(id,account_id,type,name,asset_key,coin_price,diamond_price,enabled,created_at,updated_at) VALUES('private-spatial-quote',?,'island','私人房屋','island-tree-v1',0,0,1,1,1)`, f.principal.AccountID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.ExecContext(ctx, `INSERT INTO purchases(id,account_id,product_id,repeatable,item_key_snapshot,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,coin_price,diamond_price,status,created_at) VALUES('private-spatial-instance',?,'private-spatial-quote',1,'camp-house-v1','island','私人房屋','','island-tree-v1',0,0,'owned',1)`, f.principal.AccountID); err != nil {
		t.Fatal(err)
	}
	firstState, err := f.service.ReadSpatial(ctx, f.principal)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.SaveSpatial(ctx, f.principal, spatialInput(firstState)); err != nil {
		t.Fatal(err)
	}
	secondState, err := f.service.ReadSpatial(ctx, second)
	if err != nil {
		t.Fatal(err)
	}
	if secondState.Version != 1 {
		t.Fatalf("second account inherited version: %d", secondState.Version)
	}
	for _, item := range secondState.Inventory {
		if item.InstanceID == "private-spatial-instance" {
			t.Fatal("second account sees another user's owned instance")
		}
	}
	foreign := spatialInput(secondState)
	foreign.Placements[0].InstanceID = "private-spatial-instance"
	foreign.Placements[0].ItemKey = "camp-house-v1"
	if _, err := f.service.SaveSpatial(ctx, second, foreign); err == nil {
		t.Fatal("second account placed another user's instance")
	}
	if _, err := f.service.SaveSpatial(ctx, second, spatialInput(secondState)); err != nil {
		t.Fatalf("free instances collide across accounts: %v", err)
	}
	empty := spatialInput(secondState)
	empty.ExpectedVersion = 2
	empty.Placements = []SpatialPlacement{}
	if _, err := f.service.SaveSpatial(ctx, second, empty); err != nil {
		t.Fatal(err)
	}
	retained, err := f.service.ReadSpatial(ctx, f.principal)
	if err != nil {
		t.Fatal(err)
	}
	if retained.Version != 2 || len(retained.Placements) != len(firstState.Placements) {
		t.Fatalf("another account changed first scene: %+v", retained)
	}
	var states int
	if err := f.db.QueryRowContext(ctx, "SELECT count(*) FROM island_scene_states WHERE scene_key=?", firstState.SceneKey).Scan(&states); err != nil || states != 2 {
		t.Fatalf("scene count=%d error=%v", states, err)
	}
}

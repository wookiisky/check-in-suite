package storage

import (
	"context"
	"database/sql"
	"io/fs"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"github.com/wookiisky/check-in-suite/migrations"
)

// 场景迁移保留成交、外观、流水与已保存布局，并允许重复运行。
func TestSpatialScenesMigrationPreservesExistingFacts(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "scenes-upgrade.db"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	previous := fstest.MapFS{}
	names, err := fs.Glob(migrations.Files, "*.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		if name >= "007_" {
			continue
		}
		data, err := fs.ReadFile(migrations.Files, name)
		if err != nil {
			t.Fatal(err)
		}
		previous[name] = &fstest.MapFile{Data: data}
	}
	if err := Migrate(ctx, db, previous); err != nil {
		t.Fatal(err)
	}
	_, err = db.ExecContext(ctx, `
INSERT INTO accounts(id,username,display_name,login_password_hash,management_password_hash,created_at,updated_at) VALUES(1,'kept','保留账户','hash','hash',1,1);
INSERT INTO wallets(account_id,coins,diamonds,version) VALUES(1,93,4,3);
INSERT INTO products(id,type,name,asset_key,character_key,coin_price,diamond_price,enabled,created_at,updated_at) VALUES('kept-offer','character','保留角色','old-art','kept-character',7,0,1,1,1);
INSERT INTO purchases(id,product_id,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,coin_price,diamond_price,status,created_at,character_key_snapshot) VALUES('kept-purchase','kept-offer','character','旧名字','旧说明','old-art',7,0,'owned',1,'kept-character');
INSERT INTO appearance_state(id,version,character_key,hair_purchase_id,upper_free_wearable_key) VALUES(1,4,'kept-character','kept-purchase','upper-free');
INSERT INTO wallet_entries(id,account_id,event_type,purchase_id,coin_delta,diamond_delta,created_at) VALUES('kept-ledger',1,'purchase_debit','kept-purchase',-7,0,1);
INSERT INTO island_spatial_state(id,version,scene_key,environment_key,placements) VALUES(1,8,'seaside-v1','dusk','[{"instance_id":"base:house3d","item_key":"camp-house-v1","space":"outdoor","x_cm":100,"z_cm":-200,"rotation":0},{"instance_id":"a-chair","item_key":"chair-v1","space":"indoor","x_cm":25,"z_cm":75,"rotation":1}]');
`)
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := Migrate(ctx, db, migrations.Files); err != nil {
			t.Fatal(err)
		}
	}
	var name, character, hair, free, ledger, scene, environment, instance, item, space string
	var appearanceVersion, coins, diamonds, walletVersion, sceneVersion, x, z, rotation int
	err = db.QueryRowContext(ctx, `SELECT p.name_snapshot,p.character_key_snapshot,a.hair_purchase_id,a.upper_free_wearable_key,a.version,w.purchase_id FROM purchases p JOIN appearance_state a ON a.hair_purchase_id=p.id JOIN wallet_entries w ON w.purchase_id=p.id`).Scan(&name, &character, &hair, &free, &appearanceVersion, &ledger)
	if err != nil || name != "旧名字" || character != "kept-character" || hair != "kept-purchase" || free != "upper-free" || appearanceVersion != 4 || ledger != hair {
		t.Fatalf("成交或外观改变: %q %q %q %q %d %q err=%v", name, character, hair, free, appearanceVersion, ledger, err)
	}
	err = db.QueryRowContext(ctx, "SELECT coins,diamonds,version FROM wallets WHERE account_id=1").Scan(&coins, &diamonds, &walletVersion)
	if err != nil || coins != 93 || diamonds != 4 || walletVersion != 3 {
		t.Fatalf("钱包改变: %d %d %d err=%v", coins, diamonds, walletVersion, err)
	}
	err = db.QueryRowContext(ctx, `SELECT s.scene_key,s.version,s.environment_key,p.instance_id,p.item_key,p.space,p.x_cm,p.z_cm,p.rotation FROM island_scene_states s JOIN island_scene_placements p USING(scene_key) WHERE p.instance_id='base:house3d'`).Scan(&scene, &sceneVersion, &environment, &instance, &item, &space, &x, &z, &rotation)
	if err != nil || scene != "seaside-v1" || sceneVersion != 8 || environment != "dusk" || instance != "base:house3d" || item != "camp-house-v1" || space != "outdoor" || x != 100 || z != -200 || rotation != 0 {
		t.Fatalf("布局改变: %q %d %q %q %q %q %d %d %d err=%v", scene, sceneVersion, environment, instance, item, space, x, z, rotation, err)
	}
	var order string
	err = db.QueryRowContext(ctx, `SELECT group_concat(instance_id,',') FROM (SELECT instance_id FROM island_scene_placements ORDER BY position_index,instance_id)`).Scan(&order)
	if err != nil || order != "base:house3d,a-chair" {
		t.Fatalf("布局顺序改变: %q err=%v", order, err)
	}
	assertSceneMigrationForeignKeys(t, db)
}

// 场景权益按稳定身份唯一，跨场景实例和布局引用由真实数据库约束。
func TestSpatialScenesMigrationEnforcesSceneOwnershipAndPlacement(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "scenes-constraints.db"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Migrate(ctx, db, migrations.Files); err != nil {
		t.Fatal(err)
	}
	_, err = db.ExecContext(ctx, `
INSERT INTO products(id,type,name,asset_key,scene_key,coin_price,diamond_price,enabled,created_at,updated_at) VALUES('forest-a','scene','树林','forest-art','forest-v1',80,0,1,1,1),('forest-b','scene','树林另一报价','forest-art','forest-v1',90,0,1,1,1);
INSERT INTO purchases(id,product_id,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,scene_key_snapshot,coin_price,diamond_price,status,created_at) VALUES('forest-order','forest-a','scene','树林','','forest-art','forest-v1',80,0,'owned',1);
INSERT INTO island_scene_states(scene_key,version,environment_key) VALUES('forest-v1',1,'day'),('lake-v1',1,'day');
INSERT INTO island_scene_placements(instance_id,scene_key,item_key,space,x_cm,z_cm,rotation) VALUES('shared-chair','forest-v1','chair-v1','outdoor',0,0,0);
`)
	if err != nil {
		t.Fatal(err)
	}
	invalidStatements := []string{
		`INSERT INTO purchases(id,product_id,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,scene_key_snapshot,coin_price,diamond_price,status,created_at) VALUES('duplicate','forest-b','scene','树林','','forest-art','forest-v1',90,0,'owned',1)`,
		`INSERT INTO products(id,type,name,asset_key,scene_key,coin_price,diamond_price,enabled,created_at,updated_at) VALUES('empty-scene','scene','缺少身份','art','',0,0,1,1,1)`,
		`INSERT INTO products(id,type,name,asset_key,scene_key,coin_price,diamond_price,enabled,created_at,updated_at) VALUES('wrong-scene','title','错误类型','art','forest-v1',0,0,1,1,1)`,
		`INSERT INTO purchases(id,product_id,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,scene_key_snapshot,coin_price,diamond_price,status,created_at) VALUES('empty-order','forest-b','scene','树林','','forest-art','',90,0,'owned',1)`,
		`INSERT INTO purchases(id,product_id,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,scene_key_snapshot,coin_price,diamond_price,status,created_at) VALUES('wrong-order','forest-b','title','树林','','forest-art','forest-v1',90,0,'owned',1)`,
		`INSERT INTO island_scene_placements(instance_id,scene_key,item_key,space,x_cm,z_cm,rotation) VALUES('shared-chair','lake-v1','chair-v1','outdoor',0,0,0)`,
		`INSERT INTO island_scene_placements(instance_id,scene_key,item_key,space,x_cm,z_cm,rotation) VALUES('missing-scene','missing-v1','chair-v1','outdoor',0,0,0)`,
		`INSERT INTO island_scene_placements(instance_id,scene_key,item_key,space,x_cm,z_cm,rotation) VALUES('invalid-rotation','lake-v1','chair-v1','outdoor',0,0,4)`,
	}
	for _, statement := range invalidStatements {
		if _, err := db.ExecContext(ctx, statement); err == nil {
			t.Fatalf("无效事实被接受: %s", statement)
		}
	}
	var count int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM island_scene_states").Scan(&count); err != nil || count != 2 {
		t.Fatalf("默认场景被迁移凭空创建: count=%d err=%v", count, err)
	}
	assertSceneMigrationForeignKeys(t, db)
}

// 每次表重建后检查真实外键关系，避免只检查列值而漏掉断裂引用。
func assertSceneMigrationForeignKeys(t *testing.T, db *sql.DB) {
	t.Helper()
	rows, err := db.Query("PRAGMA foreign_key_check")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if rows.Next() || rows.Err() != nil {
		t.Fatalf("迁移留下断裂引用: %v", rows.Err())
	}
}

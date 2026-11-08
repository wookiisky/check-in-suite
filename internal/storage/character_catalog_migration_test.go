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

// 角色商品迁移必须保留真实旧订单、装备和不可变钱包流水的外键关系。
func TestCharacterCatalogMigrationPreservesPurchasesAndReferences(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "character-upgrade.db"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	previous := fstest.MapFS{}
	beforeExtraColors := fstest.MapFS{}
	throughExtraColors := fstest.MapFS{}
	names, _ := fs.Glob(migrations.Files, "*.sql")
	for _, name := range names {
		if name >= "011_" {
			continue
		}
		data, err := fs.ReadFile(migrations.Files, name)
		if err != nil {
			t.Fatal(err)
		}
		file := &fstest.MapFile{Data: data}
		throughExtraColors[name] = file
		if name < "010_" {
			beforeExtraColors[name] = file
		}
		if name < "006_" {
			previous[name] = file
		}
	}
	if err := Migrate(ctx, db, previous); err != nil {
		t.Fatal(err)
	}
	_, err = db.ExecContext(ctx, `
        INSERT INTO accounts(id,username,display_name,login_password_hash,management_password_hash,created_at,updated_at) VALUES(1,'kept','保留账户','hash','hash',1,1);
        INSERT INTO products(id,type,name,asset_key,coin_price,diamond_price,enabled,created_at,updated_at) VALUES('kept-offer','wearable','保留衣物','old-art',7,0,1,1,1);
        INSERT INTO products(id,type,name,asset_key,coin_price,diamond_price,enabled,created_at,updated_at) VALUES('face-offer','wearable','形象','face-art',0,0,1,1,1),('back-offer','wearable','披风','back-art',0,0,1,1,1);
        INSERT INTO purchases(id,product_id,type_snapshot,name_snapshot,description_snapshot,asset_key_snapshot,coin_price,diamond_price,status,created_at,wearable_key_snapshot) VALUES('kept-purchase','kept-offer','wearable','旧名字','旧说明','old-art',7,0,'owned',1,'head-kept'),('face-purchase','face-offer','wearable','形象','','face-art',0,0,'owned',1,'face-kept'),('back-purchase','back-offer','wearable','披风','','back-art',0,0,'owned',1,'back-kept');
        INSERT INTO appearance_state(id,version,character_key,face_purchase_id,head_purchase_id,back_purchase_id) VALUES(1,4,'kaykit-medium-v1','face-purchase','kept-purchase','back-purchase');
        INSERT INTO wallet_entries(id,account_id,event_type,purchase_id,coin_delta,diamond_delta,created_at) VALUES('kept-ledger',1,'purchase_debit','kept-purchase',-7,0,1);
    `)
	if err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, db, beforeExtraColors); err != nil {
		t.Fatal(err)
	}
	var name, head, face, back, ledger string
	if err := db.QueryRowContext(ctx, `SELECT p.name_snapshot,a.head_purchase_id,a.face_purchase_id,a.back_purchase_id,w.purchase_id FROM purchases p JOIN appearance_state a ON a.head_purchase_id=p.id JOIN wallet_entries w ON w.purchase_id=p.id`).Scan(&name, &head, &face, &back, &ledger); err != nil {
		t.Fatal(err)
	}
	if name != "旧名字" || head != "kept-purchase" || ledger != head || face != "face-purchase" || back != "back-purchase" {
		t.Fatalf("lost snapshot: %s %s %s %s %s", name, head, face, back, ledger)
	}
	var upperColor, backColor sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT upper_color_key,back_color_key FROM appearance_state WHERE id=1`).Scan(&upperColor, &backColor); err != nil || upperColor.Valid || backColor.Valid {
		t.Fatalf("old appearance must use the baked colors: %v %v %v", upperColor, backColor, err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE appearance_state SET upper_color_key='blue',back_color_key='red' WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, db, throughExtraColors); err != nil {
		t.Fatal(err)
	}
	var headColor, lowerColor, shoesColor sql.NullString
	var version int64
	err = db.QueryRowContext(ctx, `SELECT version,upper_color_key,back_color_key,head_color_key,lower_color_key,shoes_color_key FROM appearance_state WHERE id=1`).
		Scan(&version, &upperColor, &backColor, &headColor, &lowerColor, &shoesColor)
	if err != nil || version != 4 || upperColor.String != "blue" || backColor.String != "red" || headColor.Valid || lowerColor.Valid || shoesColor.Valid {
		t.Fatalf("color migration changed appearance: version=%d upper=%v back=%v head=%v lower=%v shoes=%v err=%v", version, upperColor, backColor, headColor, lowerColor, shoesColor, err)
	}
	_, err = db.ExecContext(ctx, `INSERT INTO products(id,type,name,asset_key,character_key,coin_price,diamond_price,enabled,created_at,updated_at) VALUES('new-character','character','新角色','new-art','new-character',95,0,1,2,2)`)
	if err != nil {
		t.Fatalf("character offer rejected: %v", err)
	}
	rows, err := db.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if rows.Next() {
		t.Fatal("migration left foreign key violations")
	}
	rows.Close()
	if err := Migrate(ctx, db, throughExtraColors); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, db, migrations.Files); err == nil {
		t.Fatal("existing outfit must require an explicit rebuild")
	}
	if err := db.QueryRowContext(ctx, `SELECT version,upper_color_key FROM appearance_state WHERE id=1`).Scan(&version, &upperColor); err != nil || version != 4 || upperColor.String != "blue" {
		t.Fatalf("failed migration lost outfit: version=%d color=%v err=%v", version, upperColor, err)
	}
}

// 表重建后的引用检查失败时整笔迁移回滚，并恢复该连接的业务外键约束。
func TestMigrationForeignKeyFailureRollsBackAndRestoresChecks(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "foreign-key-rollback.db"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	files := fstest.MapFS{
		"001_start.sql": &fstest.MapFile{Data: []byte(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,checksum TEXT NOT NULL,applied_at INTEGER NOT NULL) STRICT; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parent(id));`)},
	}
	if err := Migrate(ctx, db, files); err != nil {
		t.Fatal(err)
	}
	files["002_broken.sql"] = &fstest.MapFile{Data: []byte(`INSERT INTO child(id,parent_id) VALUES(1,999);`)}
	if err := Migrate(ctx, db, files); err == nil {
		t.Fatal("broken reference migration committed")
	}
	var count, enabled int
	if err := db.QueryRow("SELECT count(*) FROM child").Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial count=%d err=%v", count, err)
	}
	if err := db.QueryRow("PRAGMA foreign_keys").Scan(&enabled); err != nil || enabled != 1 {
		t.Fatalf("foreign keys=%d err=%v", enabled, err)
	}
	if _, err := db.Exec("INSERT INTO child(id,parent_id) VALUES(2,999)"); err == nil {
		t.Fatal("business foreign key check not restored")
	}
}

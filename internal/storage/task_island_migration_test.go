package storage

import (
	"context"
	"io/fs"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"github.com/wookiisky/check-in-suite/migrations"
)

// TestTaskIslandMigrationPreservesData upgrades an existing file without replacing its existing task data.
func TestTaskIslandMigrationPreservesData(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "upgrade.db"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	files, err := fs.Glob(migrations.Files, "*.sql")
	if err != nil {
		t.Fatal(err)
	}
	previous := fstest.MapFS{}
	for _, name := range files {
		if name == "005_task_island_activities.sql" {
			continue
		}
		source, err := fs.ReadFile(migrations.Files, name)
		if err != nil {
			t.Fatal(err)
		}
		previous[name] = &fstest.MapFile{Data: source}
	}
	if err := Migrate(ctx, db, previous); err != nil {
		t.Fatal(err)
	}
	_, err = db.ExecContext(ctx, `INSERT INTO tasks(id,name,icon_key,coin_reward,diamond_reward,daily_limit,weekday_mask,enabled,version,created_at,updated_at) VALUES('kept-task','保留任务','book-v1',3,1,2,127,1,4,10,20)`)
	if err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, db, migrations.Files); err != nil {
		t.Fatal(err)
	}
	var name string
	var version, reward int
	if err := db.QueryRowContext(ctx, "SELECT name,version,coin_reward FROM tasks WHERE id='kept-task'").Scan(&name, &version, &reward); err != nil {
		t.Fatal(err)
	}
	if name != "保留任务" || version != 4 || reward != 3 {
		t.Fatalf("task changed: %s %d %d", name, version, reward)
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO task_island_activities(task_id,activity) VALUES('kept-task','read')"); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, db, migrations.Files); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM task_island_activities").Scan(&count); err != nil || count != 1 {
		t.Fatalf("links=%d err=%v", count, err)
	}
}

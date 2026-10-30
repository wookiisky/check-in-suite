package island

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io/fs"
	"path/filepath"
	"reflect"
	"testing"
	"testing/fstest"
	"time"

	"github.com/wookiisky/check-in-suite/internal/storage"
	"github.com/wookiisky/check-in-suite/migrations"
)

// housingDatabase isolates persistent upgrade transactions from the user's application data.
func housingDatabase(t *testing.T) *sql.DB {
	t.Helper()
	db, err := storage.Open(context.Background(), filepath.Join(t.TempDir(), "housing.db"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := storage.Migrate(context.Background(), db, migrations.Files); err != nil {
		t.Fatal(err)
	}
	return db
}

// writeLegacyHousing stores a genuine pre-upgrade placement payload without rewriting purchase identity.
func writeLegacyHousing(t *testing.T, db *sql.DB, placements []Placement) {
	t.Helper()
	raw, err := json.Marshal(placements)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO island_state(id,version,placements) VALUES(1,7,?)", string(raw)); err != nil {
		t.Fatal(err)
	}
}

// readHousingLayout reads committed bytes to distinguish rollback from an in-memory correction.
func readHousingLayout(t *testing.T, db *sql.DB) (int64, []Placement) {
	t.Helper()
	var version int64
	var raw string
	if err := db.QueryRow("SELECT version,placements FROM island_state WHERE id=1").Scan(&version, &raw); err != nil {
		t.Fatal(err)
	}
	var placements []Placement
	if err := json.Unmarshal([]byte(raw), &placements); err != nil {
		t.Fatal(err)
	}
	return version, placements
}

// TestHousingUpgrade moves only newly conflicting placements and never repeats a completed adjustment.
func TestHousingUpgrade(t *testing.T) {
	for _, houseKey := range []string{"house", "cottage"} {
		t.Run(houseKey, func(t *testing.T) {
			db := housingDatabase(t)
			placements := defaultPlacements()
			placements[0].ItemKey = houseKey
			placements[0].X, placements[0].Y = -4, -4.5
			placements = append(placements, Placement{ID: "owned:tree", ItemKey: "tree", X: .75, Y: -4.5, Zone: "outdoor"})
			writeLegacyHousing(t, db, placements)
			if err := UpgradeHousing(context.Background(), db); err != nil {
				t.Fatal(err)
			}
			version, after := readHousingLayout(t, db)
			if version != 8 {
				t.Fatalf("version=%d", version)
			}
			if after[0].X != -1.5 || after[0].Y != -3.5 {
				t.Fatalf("house=%+v", after[0])
			}
			if after[1] != placements[1] || after[2] != placements[2] {
				t.Fatalf("unaffected objects changed: %+v", after)
			}
			if after[4].ID != placements[4].ID || after[4] == placements[4] {
				t.Fatalf("new house conflict not relocated: %+v", after[4])
			}
			var moved, stored int
			if err := db.QueryRow("SELECT moved,stored FROM island_housing_upgrade WHERE id=1").Scan(&moved, &stored); err != nil || moved != 2 || stored != 0 {
				t.Fatalf("notice=%d/%d err=%v", moved, stored, err)
			}
			if err := UpgradeHousing(context.Background(), db); err != nil {
				t.Fatal(err)
			}
			secondVersion, second := readHousingLayout(t, db)
			if secondVersion != version || !reflect.DeepEqual(after, second) {
				t.Fatalf("repeated upgrade changed layout")
			}
		})
	}
}

// TestHousingUpgradeRollback keeps layout and completion marker atomic when persistence fails.
func TestHousingUpgradeRollback(t *testing.T) {
	db := housingDatabase(t)
	placements := defaultPlacements()
	placements[0].X = -4
	writeLegacyHousing(t, db, placements)
	if _, err := db.Exec("CREATE TRIGGER fail_housing_marker BEFORE INSERT ON island_housing_upgrade BEGIN SELECT RAISE(ABORT, 'test interruption'); END"); err != nil {
		t.Fatal(err)
	}
	if err := UpgradeHousing(context.Background(), db); err == nil {
		t.Fatal("expected interrupted upgrade")
	}
	version, after := readHousingLayout(t, db)
	if version != 7 || !reflect.DeepEqual(after, placements) {
		t.Fatalf("interrupted upgrade committed layout")
	}
	var count int
	if err := db.QueryRow("SELECT count(*) FROM island_housing_upgrade").Scan(&count); err != nil || count != 0 {
		t.Fatalf("count=%d err=%v", count, err)
	}
}

// TestHousingUpgradeNoSavedLayout leaves the new-account default scene virtual.
func TestHousingUpgradeNoSavedLayout(t *testing.T) {
	db := housingDatabase(t)
	if err := UpgradeHousing(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRow("SELECT count(*) FROM island_state").Scan(&count); err != nil || count != 0 {
		t.Fatalf("count=%d err=%v", count, err)
	}
}

// TestHousingUpgradeStoresWhenFull returns only the newly conflicting instance to inventory.
func TestHousingUpgradeStoresWhenFull(t *testing.T) {
	placements := defaultPlacements()
	house := placements[0]
	houseDefinition, _ := Find(house.ItemKey)
	treeDefinition, _ := Find("tree")
	placements = append(placements, Placement{ID: "owned:displaced", ItemKey: "tree", X: 3.25, Y: -3, Zone: "outdoor"})
	for x := -7.5; x <= 7.5; x++ {
		for y := -7.5; y <= 7.5; y++ {
			p := Placement{ID: fmt.Sprintf("occupied:%g:%g", x, y), ItemKey: "tree", X: x, Y: y, Zone: "outdoor"}
			if !placementsOverlap(house, houseDefinition, p, treeDefinition) {
				placements = append(placements, p)
			}
		}
	}
	after, adjustment, err := expandedPlacements(placements, 0)
	if err != nil {
		t.Fatal(err)
	}
	if adjustment.Stored < 1 {
		t.Fatalf("expected inventory return: %+v", adjustment)
	}
	for _, p := range after {
		if p.ID == "owned:displaced" {
			t.Fatal("full layout retained newly colliding instance")
		}
	}
	if after[1] != placements[1] {
		t.Fatal("existing indoor furniture changed")
	}
}

// TestHousingUpgradePreservesHistoricalOverlap avoids silently repairing unrelated old placements.
func TestHousingUpgradePreservesHistoricalOverlap(t *testing.T) {
	placements := defaultPlacements()
	placements = append(placements, Placement{ID: "old:overlap", ItemKey: "tree", X: -3, Y: -2, Zone: "outdoor"})
	after, adjustment, err := expandedPlacements(placements, 0)
	if err != nil || !reflect.DeepEqual(after, placements) || adjustment != (HousingAdjustment{}) {
		t.Fatalf("unrelated old layout changed: %+v %+v %v", after, adjustment, err)
	}
}

// TestHousingUpgradeConcurrentStarts uses independent SQLite connections to prove single application.
func TestHousingUpgradeConcurrentStarts(t *testing.T) {
	for _, revision := range []int{0, 1} {
		t.Run(fmt.Sprintf("revision-%d", revision), func(t *testing.T) {
			ctx := context.Background()
			path := filepath.Join(t.TempDir(), "concurrent.db")
			first, err := storage.Open(ctx, path, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer first.Close()
			if err := storage.Migrate(ctx, first, migrations.Files); err != nil {
				t.Fatal(err)
			}
			second, err := storage.Open(ctx, path, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer second.Close()
			placements := defaultPlacements()
			placements[0].X = -3
			writeLegacyHousing(t, first, placements)
			if revision == 1 {
				if _, err := first.Exec("INSERT INTO island_housing_upgrade(id,moved,stored) VALUES(1,2,1)"); err != nil {
					t.Fatal(err)
				}
			}
			start := make(chan struct{})
			results := make(chan error, 2)
			for _, db := range []*sql.DB{first, second} {
				go func(db *sql.DB) { <-start; results <- UpgradeHousing(ctx, db) }(db)
			}
			close(start)
			for range 2 {
				if err := <-results; err != nil {
					t.Fatal(err)
				}
			}
			version, after := readHousingLayout(t, first)
			if version != 8 || after[0].X != -1.5 {
				t.Fatalf("upgrade duplicated: version=%d house=%+v", version, after[0])
			}
		})
	}
}

// TestHousingSecondExpansion upgrades an already expanded home without clearing its unread notice.
func TestHousingSecondExpansion(t *testing.T) {
	db := housingDatabase(t)
	placements := defaultPlacements()
	placements[0].X, placements[0].Y = -3, -2
	placements[2].X, placements[2].Y = 3.25, 2
	placements = append(placements,
		Placement{ID: "old:overlap", ItemKey: "tree", X: 1.75, Y: -2, Zone: "outdoor"},
		Placement{ID: "new:conflict", ItemKey: "tree", X: 2.75, Y: -2, Zone: "outdoor"},
	)
	writeLegacyHousing(t, db, placements)
	if _, err := db.Exec("INSERT INTO island_housing_upgrade(id,moved,stored) VALUES(1,2,1)"); err != nil {
		t.Fatal(err)
	}
	if err := UpgradeHousing(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	version, after := readHousingLayout(t, db)
	if version != 8 || after[0].X != -1.5 || after[4] != placements[4] || after[5] == placements[5] {
		t.Fatalf("second expansion: version=%d placements=%+v", version, after)
	}
	var moved, stored, revision int
	if err := db.QueryRow("SELECT moved,stored,revision FROM island_housing_upgrade WHERE id=1").Scan(&moved, &stored, &revision); err != nil || moved != 5 || stored != 1 || revision != 2 {
		t.Fatalf("notice=%d/%d revision=%d error=%v", moved, stored, revision, err)
	}
	if err := UpgradeHousing(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	secondVersion, second := readHousingLayout(t, db)
	if secondVersion != version || !reflect.DeepEqual(after, second) {
		t.Fatal("latest expansion repeated")
	}
}

// TestHousingSecondExpansionRollback keeps the previous revision and notice when the next stage fails.
func TestHousingSecondExpansionRollback(t *testing.T) {
	db := housingDatabase(t)
	placements := defaultPlacements()
	placements[0].X = -3
	writeLegacyHousing(t, db, placements)
	if _, err := db.Exec("INSERT INTO island_housing_upgrade(id,moved,stored) VALUES(1,2,1)"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE TRIGGER fail_next_housing BEFORE UPDATE ON island_housing_upgrade BEGIN SELECT RAISE(ABORT, 'test interruption'); END"); err != nil {
		t.Fatal(err)
	}
	if err := UpgradeHousing(context.Background(), db); err == nil {
		t.Fatal("expected interrupted second expansion")
	}
	version, after := readHousingLayout(t, db)
	if version != 7 || !reflect.DeepEqual(after, placements) {
		t.Fatal("second expansion partly committed")
	}
	var moved, stored, revision int
	if err := db.QueryRow("SELECT moved,stored,revision FROM island_housing_upgrade WHERE id=1").Scan(&moved, &stored, &revision); err != nil || moved != 2 || stored != 1 || revision != 1 {
		t.Fatalf("previous marker changed: %d/%d revision=%d %v", moved, stored, revision, err)
	}
}

// TestHousingRevisionMigrationPreservesNotice upgrades the actual revision-free schema without changing its notice.
func TestHousingRevisionMigrationPreservesNotice(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "revision.db"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	names, err := fs.Glob(migrations.Files, "*.sql")
	if err != nil {
		t.Fatal(err)
	}
	previous := fstest.MapFS{}
	for _, name := range names {
		if name >= "007_housing_expansion_revision.sql" {
			continue
		}
		data, err := fs.ReadFile(migrations.Files, name)
		if err != nil {
			t.Fatal(err)
		}
		previous[name] = &fstest.MapFile{Data: data}
	}
	if err := storage.Migrate(ctx, db, previous); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO island_housing_upgrade(id,moved,stored) VALUES(1,3,2)"); err != nil {
		t.Fatal(err)
	}
	if err := storage.Migrate(ctx, db, migrations.Files); err != nil {
		t.Fatal(err)
	}
	var revision, moved, stored int
	if err := db.QueryRow("SELECT revision,moved,stored FROM island_housing_upgrade WHERE id=1").Scan(&revision, &moved, &stored); err != nil || revision != 1 || moved != 3 || stored != 2 {
		t.Fatalf("migration changed existing notice: %d/%d/%d %v", revision, moved, stored, err)
	}
}

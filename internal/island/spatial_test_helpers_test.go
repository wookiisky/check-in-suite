package island

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/storage"
	"github.com/wookiisky/check-in-suite/migrations"
)

// spatialFixture 使用同一真实文件的两条独立连接验证版本竞争。
type spatialFixture struct {
	db        *sql.DB           // 主连接。
	other     *sql.DB           // 独立竞争连接。
	accounts  *account.Service  // 实际会话授权。
	service   *Service          // 主布局服务。
	contender *Service          // 竞争布局服务。
	principal account.Principal // 已认证会话。
}

// newSpatialFixture 只初始化临时数据库，不使用日常开发数据库。
func newSpatialFixture(t *testing.T) spatialFixture {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "spatial.db")
	db, err := storage.Open(ctx, path, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err = storage.Migrate(ctx, db, migrations.Files); err != nil {
		t.Fatal(err)
	}
	other, err := storage.Open(ctx, path, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { other.Close() })
	now := time.Date(2026, 11, 1, 4, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	accounts := account.New(db, config.Defaults())
	accounts.Now = clock
	if err = accounts.Initialize(ctx, "spatial-test", "布局测试", "spatial-login-password", "spatial-management-password"); err != nil {
		t.Fatal(err)
	}
	token, _, err := accounts.Login(ctx, "spatial-test", "spatial-login-password")
	if err != nil {
		t.Fatal(err)
	}
	principal, err := accounts.Authenticate(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	return spatialFixture{db, other, accounts, New(db, clock), New(other, clock), principal}
}

// spatialInput 从真实快照建立独立草稿，避免测试意外改写原切片。
func spatialInput(state SpatialState) SpatialSaveInput {
	return SpatialSaveInput{ExpectedVersion: state.Version, SceneKey: state.SceneKey, EnvironmentKey: state.EnvironmentKey, Placements: append([]SpatialPlacement{}, state.Placements...)}
}

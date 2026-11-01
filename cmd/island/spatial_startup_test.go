package main

import (
	"bytes"
	"context"
	"database/sql"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/island"
	"github.com/wookiisky/check-in-suite/internal/storage"
)

// assertSpatialCLIOffers 通过真实数据库验证 CLI 已创建全部付费三维商品。
func assertSpatialCLIOffers(t *testing.T, db *sql.DB) {
	t.Helper()
	want := 0
	for _, item := range island.SpatialCatalog() {
		if item.Free {
			continue
		}
		want++
		var asset string
		if err := db.QueryRow("SELECT asset_key FROM products WHERE id=? AND type='island' AND enabled=1", "spatial-offer-"+item.Key).Scan(&asset); err != nil || asset != item.ThumbnailAssetKey {
			t.Fatalf("missing offer %s: asset=%s err=%v", item.Key, asset, err)
		}
	}
	var count int
	if err := db.QueryRow("SELECT count(*) FROM products WHERE id LIKE 'spatial-offer-%'").Scan(&count); err != nil || count != want {
		t.Fatalf("offers count=%d want=%d err=%v", count, want, err)
	}
}

// TestSpatialCLIInitSeedFailureIsRetryable 新商品写失败时不初始化账户，重试补齐全部商品。
func TestSpatialCLIInitSeedFailureIsRetryable(t *testing.T) {
	configuration, database := deploymentConfig(t)
	ctx := context.Background()
	if err := runWithIO(ctx, []string{"migrate", "-config", configuration}, strings.NewReader(""), io.Discard); err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(ctx, database, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(`CREATE TRIGGER fail_spatial_seed BEFORE INSERT ON products WHEN NEW.id LIKE 'spatial-offer-%' BEGIN SELECT RAISE(ABORT,'spatial-seed-write-failed'); END`); err != nil {
		t.Fatal(err)
	}
	input := "spatial-cli\nCLI测试\nlogin-password\nlogin-password\nmanage-password\nmanage-password\n"
	if err = runWithIO(ctx, []string{"init", "-config", configuration}, strings.NewReader(input), io.Discard); err == nil {
		t.Fatal("initialization accepted failed spatial seed")
	}
	var count int
	if err = db.QueryRow("SELECT count(*) FROM accounts").Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed seed initialized account: count=%d err=%v", count, err)
	}
	if _, err = db.Exec("DROP TRIGGER fail_spatial_seed"); err != nil {
		t.Fatal(err)
	}
	if err = runWithIO(ctx, []string{"init", "-config", configuration}, strings.NewReader(input), io.Discard); err != nil {
		t.Fatal(err)
	}
	assertSpatialCLIOffers(t, db)
}

// TestSpatialCLIServeSeedsBeforeListening 新商品失败阻止服务启动，恢复后真实 HTTP 就绪且商品齐全。
func TestSpatialCLIServeSeedsBeforeListening(t *testing.T) {
	configuration, database := deploymentConfig(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	source, err := os.ReadFile(configuration)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(configuration, bytes.ReplaceAll(source, []byte("0.0.0.0:8080"), []byte(address)), 0600); err != nil {
		t.Fatal(err)
	}
	if err = runWithIO(context.Background(), []string{"migrate", "-config", configuration}, strings.NewReader(""), io.Discard); err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(context.Background(), database, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(`CREATE TRIGGER fail_spatial_seed BEFORE INSERT ON products WHEN NEW.id LIKE 'spatial-offer-%' BEGIN SELECT RAISE(ABORT,'spatial-seed-write-failed'); END`); err != nil {
		t.Fatal(err)
	}
	failing, cancelFailure := context.WithTimeout(context.Background(), 2*time.Second)
	err = runWithIO(failing, []string{"serve", "-config", configuration}, strings.NewReader(""), io.Discard)
	cancelFailure()
	if err == nil || !strings.Contains(err.Error(), "spatial-seed-write-failed") {
		t.Fatalf("serve did not reject spatial seed: %v", err)
	}
	if _, err = db.Exec("DROP TRIGGER fail_spatial_seed"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- runWithIO(ctx, []string{"serve", "-config", configuration}, strings.NewReader(""), io.Discard)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("serve shutdown: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Error("serve did not stop")
		}
	})
	client := &http.Client{Timeout: 200 * time.Millisecond}
	deadline := time.Now().Add(10 * time.Second)
	ready := false
	for time.Now().Before(deadline) {
		response, requestErr := client.Get("http://" + address + "/health/ready")
		if requestErr == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				ready = true
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !ready {
		t.Fatal("CLI server did not become ready")
	}
	assertSpatialCLIOffers(t, db)
}

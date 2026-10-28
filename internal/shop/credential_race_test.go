package shop

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/core"
	"github.com/wookiisky/check-in-suite/internal/storage"
	"github.com/wookiisky/check-in-suite/migrations"
)

// TestPasswordResetWinsAgainstVerifiedRedemption places reset between real password verification and the write.
func TestPasswordResetWinsAgainstVerifiedRedemption(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "redemption.db")
	db, err := storage.Open(ctx, path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err = storage.Migrate(ctx, db, migrations.Files); err != nil {
		t.Fatal(err)
	}
	other, err := storage.Open(ctx, path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	cfg := config.Defaults()
	accounts := account.New(db, cfg)
	resetter := account.New(other, cfg)
	if err = accounts.Initialize(ctx, "race", "名字", "login-password", "management-password"); err != nil {
		t.Fatal(err)
	}
	token, _, err := accounts.Login(ctx, "race", "login-password")
	if err != nil {
		t.Fatal(err)
	}
	principal, err := accounts.Authenticate(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = accounts.Unlock(ctx, principal, "management-password"); err != nil {
		t.Fatal(err)
	}
	service := New(db, cfg, accounts)
	product, err := service.CreateProduct(ctx, principal, "product", ProductInput{Type: TypeReward, Name: "奖励", AssetKey: "reward-gift-v1", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	order, err := service.Buy(ctx, principal, "purchase", BuyInput{ProductID: product.ID, ExpectedProductVersion: 1, ExpectedWalletVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	verified, release := make(chan struct{}), make(chan struct{})
	service.verifyManagement = func(ctx context.Context, password string) (int64, error) {
		version, err := accounts.VerifyManagement(ctx, password)
		close(verified)
		<-release
		return version, err
	}
	finished := make(chan error, 1)
	go func() {
		_, err := service.Redeem(ctx, principal, order.Purchase.ID, "management-password")
		finished <- err
	}()
	<-verified
	err = resetter.ResetPassword(ctx, "management", "new-management-password")
	close(release)
	if err != nil {
		t.Fatal(err)
	}
	var domainError *core.Error
	if err = <-finished; !errors.As(err, &domainError) || domainError.Code != "SESSION_REQUIRED" {
		t.Fatalf("stale verified password redeemed: %v", err)
	}
	var status string
	var version int64
	if err = db.QueryRow("SELECT status,version FROM purchases WHERE id=?", order.Purchase.ID).Scan(&status, &version); err != nil || status != StatusPending || version != 1 {
		t.Fatalf("status=%s version=%d err=%v", status, version, err)
	}
}

package account

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/wookiisky/check-in-suite/internal/core"
)

// Initialize creates the sole account and empty wallet without demo records.
func (s *Service) Initialize(ctx context.Context, username, displayName, loginPassword, managementPassword string) error {
	return s.InitializeWith(ctx, username, displayName, loginPassword, managementPassword, nil)
}

// InitializeWith creates the household and optional initial business data atomically.
// Password derivation finishes before the write transaction; populate must use the supplied transaction.
func (s *Service) InitializeWith(ctx context.Context, username, displayName, loginPassword, managementPassword string, populate func(*sql.Tx) error) error {
	username = strings.TrimSpace(username)
	displayName = strings.TrimSpace(displayName)
	for field, value := range map[string]string{"username": username, "display_name": displayName} {
		if err := core.Text(field, value, 1, s.Config.Limits.NameMax); err != nil {
			return err
		}
	}
	for field, value := range map[string]string{"login_password": loginPassword, "management_password": managementPassword} {
		if err := core.Text(field, value, s.Config.Limits.PasswordMin, s.Config.Limits.PasswordMax); err != nil {
			return err
		}
	}
	var loginHash, managementHash string
	err := s.passwordWork(ctx, "", func() error {
		var err error
		loginHash, err = s.hash(loginPassword)
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		managementHash, err = s.hash(managementPassword)
		return err
	})
	if err != nil {
		return err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var count int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM accounts").Scan(&count); err != nil {
		return err
	}
	if count != 0 {
		return core.Fail(409, "ACCOUNT_EXISTS")
	}
	now := s.Now().UnixMilli()
	if _, err = tx.ExecContext(ctx, "INSERT INTO accounts(id,username,display_name,login_password_hash,management_password_hash,created_at,updated_at) VALUES(1,?,?,?,?,?,?)", username, displayName, loginHash, managementHash, now, now); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO wallets(account_id) VALUES(1)"); err != nil {
		return err
	}
	if populate != nil {
		if err := populate(tx); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// credential loads a stored hash and its version before slow verification starts.
func (s *Service) credential(ctx context.Context, kind string) (string, int64, error) {
	column, err := passwordColumn(kind)
	if err != nil {
		return "", 0, err
	}
	var hash string
	var version int64
	err = s.DB.QueryRowContext(ctx, "SELECT "+column+",credential_version FROM accounts WHERE id=1").Scan(&hash, &version)
	if errors.Is(err, sql.ErrNoRows) {
		return "", 0, core.Fail(401, "INVALID_CREDENTIALS")
	}
	return hash, version, err
}

// passwordColumn chooses a SQL identifier exclusively from trusted service constants.
func passwordColumn(kind string) (string, error) {
	switch kind {
	case "login":
		return "login_password_hash", nil
	case "management":
		return "management_password_hash", nil
	default:
		return "", core.Invalid("kind", "INVALID_VALUE")
	}
}

// ResetPassword replaces one credential through the local maintenance interface and revokes all sessions.
func (s *Service) ResetPassword(ctx context.Context, kind, password string) error {
	column, err := passwordColumn(kind)
	if err != nil {
		return err
	}
	if err = core.Text("new_password", password, s.Config.Limits.PasswordMin, s.Config.Limits.PasswordMax); err != nil {
		return err
	}
	var hash string
	err = s.passwordWork(ctx, "", func() error {
		var err error
		hash, err = s.hash(password)
		return err
	})
	if err != nil {
		return err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, "UPDATE accounts SET "+column+"=?,credential_version=credential_version+1,updated_at=? WHERE id=1", hash, s.Now().UnixMilli())
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return core.Fail(404, "ACCOUNT_NOT_INITIALIZED")
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM sessions"); err != nil {
		return err
	}
	return tx.Commit()
}

// ChangePassword verifies the matching old password before rechecking authorization inside its transaction.
func (s *Service) ChangePassword(ctx context.Context, p Principal, kind, oldPassword, newPassword, confirmation string) error {
	column, err := passwordColumn(kind)
	if err != nil {
		return err
	}
	// Check access before expensive password work, then recheck in the write transaction.
	access, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	err = Authorize(ctx, access, p, true, s.Now())
	access.Rollback()
	if err != nil {
		return err
	}
	if err = s.checkAttempts(kind); err != nil {
		return err
	}
	if newPassword != confirmation {
		return core.Invalid("confirm_password", "PASSWORD_MISMATCH")
	}
	if err = core.Text("new_password", newPassword, s.Config.Limits.PasswordMin, s.Config.Limits.PasswordMax); err != nil {
		return err
	}
	if err = core.Text("old_password", oldPassword, 1, s.Config.Limits.PasswordMax); err != nil {
		return err
	}
	var version int64
	var replacement string
	err = s.passwordWork(ctx, kind, func() error {
		hash, current, err := s.credential(ctx, kind)
		if err != nil {
			return err
		}
		version = current
		if !s.verify(hash, oldPassword) {
			s.failedAttempt(kind)
			return core.Fail(422, "INVALID_CREDENTIALS")
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		replacement, err = s.hash(newPassword)
		return err
	})
	if err != nil {
		return err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := s.Now()
	if err = Authorize(ctx, tx, p, true, now); err != nil {
		return err
	}
	var current int64
	if err = tx.QueryRowContext(ctx, "SELECT credential_version FROM accounts WHERE id=1").Scan(&current); err != nil {
		return err
	}
	if current != version {
		return core.Fail(401, "SESSION_REQUIRED")
	}
	if _, err = tx.ExecContext(ctx, "UPDATE accounts SET "+column+"=?,credential_version=credential_version+1,updated_at=? WHERE id=1", replacement, now.UnixMilli()); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM sessions"); err != nil {
		return err
	}
	return tx.Commit()
}

// VerifyManagement returns the credential version that must be rechecked by a later business transaction.
func (s *Service) VerifyManagement(ctx context.Context, password string) (int64, error) {
	if err := s.checkAttempts("management"); err != nil {
		return 0, err
	}
	if err := core.Text("password", password, 1, s.Config.Limits.PasswordMax); err != nil {
		return 0, err
	}
	var version int64
	err := s.passwordWork(ctx, "management", func() error {
		hash, current, err := s.credential(ctx, "management")
		if err != nil {
			return err
		}
		version = current
		if !s.verify(hash, password) {
			s.failedAttempt("management")
			return core.Fail(422, "INVALID_CREDENTIALS")
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return version, nil
}

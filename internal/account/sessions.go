package account

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"time"

	"github.com/wookiisky/check-in-suite/internal/core"
)

// tokenHash keeps bearer credentials out of the database.
func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// randomToken creates independently random cookie and CSRF credentials.
func randomToken() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

// Login verifies outside the write transaction then refuses a concurrently replaced credential.
func (s *Service) Login(ctx context.Context, username, password string) (string, Session, error) {
	if err := s.checkAttempts("login"); err != nil {
		return "", Session{}, err
	}
	if err := core.Text("username", username, 1, s.Config.Limits.NameMax); err != nil {
		return "", Session{}, err
	}
	if err := core.Text("password", password, 1, s.Config.Limits.PasswordMax); err != nil {
		return "", Session{}, err
	}
	var hash, expectedUsername string
	var version int64
	err := s.passwordWork(ctx, "login", func() error {
		err := s.DB.QueryRowContext(ctx, "SELECT username,login_password_hash,credential_version FROM accounts WHERE id=1").Scan(&expectedUsername, &hash, &version)
		if errors.Is(err, sql.ErrNoRows) {
			s.failedAttempt("login")
			return core.Fail(401, "INVALID_CREDENTIALS")
		}
		if err != nil {
			return err
		}
		valid := s.verify(hash, password)
		if !valid || username != expectedUsername {
			s.failedAttempt("login")
			return core.Fail(401, "INVALID_CREDENTIALS")
		}
		return nil
	})
	if err != nil {
		return "", Session{}, err
	}
	token, err := randomToken()
	if err != nil {
		return "", Session{}, err
	}
	csrf, err := randomToken()
	if err != nil {
		return "", Session{}, err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return "", Session{}, err
	}
	defer tx.Rollback()
	var current int64
	if err = tx.QueryRowContext(ctx, "SELECT credential_version FROM accounts WHERE id=1").Scan(&current); err != nil {
		return "", Session{}, err
	}
	if current != version {
		return "", Session{}, core.Fail(401, "INVALID_CREDENTIALS")
	}
	now := s.Now()
	p := Principal{SessionID: core.ID(), CredentialVersion: version, CSRFToken: csrf}
	if _, err = tx.ExecContext(ctx, "DELETE FROM sessions WHERE expires_at<=?", now.UnixMilli()); err != nil {
		return "", Session{}, err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO sessions(id,account_id,token_hash,csrf_token,expires_at,credential_version,created_at) VALUES(?,1,?,?,?,?,?)", p.SessionID, tokenHash(token), csrf, now.Add(s.Config.SessionTTL).UnixMilli(), version, now.UnixMilli()); err != nil {
		return "", Session{}, err
	}
	session, err := s.sessionInTx(ctx, tx, p, now)
	if err != nil {
		return "", Session{}, err
	}
	if err = tx.Commit(); err != nil {
		return "", Session{}, err
	}
	return token, session, nil
}

// Authenticate resolves the cookie while treating expiry and credential revocation identically.
func (s *Service) Authenticate(ctx context.Context, token string) (Principal, error) {
	if token == "" || len(token) > 128 {
		return Principal{}, core.Fail(401, "SESSION_REQUIRED")
	}
	var p Principal
	err := s.DB.QueryRowContext(ctx, "SELECT s.id,s.credential_version,s.csrf_token FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.expires_at>? AND s.credential_version=a.credential_version", tokenHash(token), s.Now().UnixMilli()).Scan(&p.SessionID, &p.CredentialVersion, &p.CSRFToken)
	if errors.Is(err, sql.ErrNoRows) {
		return Principal{}, core.Fail(401, "SESSION_REQUIRED")
	}
	return p, err
}

// Authorize rechecks a previously authenticated session inside the business transaction.
func Authorize(ctx context.Context, tx *sql.Tx, p Principal, management bool, now time.Time) error {
	var credential int64
	var expiry, managementExpiry sql.NullInt64
	err := tx.QueryRowContext(ctx, "SELECT s.credential_version,s.expires_at,s.management_expires_at FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.id=? AND s.credential_version=a.credential_version", p.SessionID).Scan(&credential, &expiry, &managementExpiry)
	if errors.Is(err, sql.ErrNoRows) {
		return core.Fail(401, "SESSION_REQUIRED")
	}
	if err != nil {
		return err
	}
	if credential != p.CredentialVersion || !expiry.Valid || expiry.Int64 <= now.UnixMilli() {
		return core.Fail(401, "SESSION_REQUIRED")
	}
	if management && (!managementExpiry.Valid || managementExpiry.Int64 <= now.UnixMilli()) {
		return core.Fail(403, "MANAGEMENT_REQUIRED")
	}
	return nil
}

// Session returns profile and authorization from one read snapshot.
func (s *Service) Session(ctx context.Context, p Principal) (Session, error) {
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return Session{}, err
	}
	defer tx.Rollback()
	now := s.Now()
	if err = Authorize(ctx, tx, p, false, now); err != nil {
		return Session{}, err
	}
	result, err := s.sessionInTx(ctx, tx, p, now)
	if err != nil {
		return Session{}, err
	}
	if err = tx.Commit(); err != nil {
		return Session{}, err
	}
	return result, nil
}

// sessionInTx builds one session view without borrowing the database's only connection.
func (s *Service) sessionInTx(ctx context.Context, tx *sql.Tx, p Principal, now time.Time) (Session, error) {
	profile, err := readAccount(ctx, tx)
	if err != nil {
		return Session{}, err
	}
	var expires sql.NullInt64
	if err = tx.QueryRowContext(ctx, "SELECT management_expires_at FROM sessions WHERE id=?", p.SessionID).Scan(&expires); err != nil {
		return Session{}, err
	}
	result := Session{Account: profile, CSRFToken: p.CSRFToken, ServerNow: now.UTC().Format(time.RFC3339Nano), Today: core.Today(now), Timezone: "Asia/Taipei", Limits: s.Config.Limits}
	if expires.Valid && expires.Int64 > now.UnixMilli() {
		value := core.Timestamp(expires.Int64)
		result.ManagementExpiresAt = &value
	}
	return result, nil
}

// Logout deletes the authorization record so in-flight business writes must recheck it.
func (s *Service) Logout(ctx context.Context, p Principal) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "DELETE FROM sessions WHERE id=?", p.SessionID); err != nil {
		return err
	}
	return tx.Commit()
}

// Unlock refuses an earlier password verification if lock or logout happened while it ran.
func (s *Service) Unlock(ctx context.Context, p Principal, password string) (time.Time, error) {
	var managementVersion int64
	err := s.DB.QueryRowContext(ctx, "SELECT management_version FROM sessions WHERE id=?", p.SessionID).Scan(&managementVersion)
	if errors.Is(err, sql.ErrNoRows) {
		return time.Time{}, core.Fail(401, "SESSION_REQUIRED")
	}
	if err != nil {
		return time.Time{}, err
	}
	credentialVersion, err := s.VerifyManagement(ctx, password)
	if err != nil {
		return time.Time{}, err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return time.Time{}, err
	}
	defer tx.Rollback()
	now := s.Now()
	if err = Authorize(ctx, tx, p, false, now); err != nil {
		return time.Time{}, err
	}
	if credentialVersion != p.CredentialVersion {
		return time.Time{}, core.Fail(401, "SESSION_REQUIRED")
	}
	var current int64
	if err = tx.QueryRowContext(ctx, "SELECT management_version FROM sessions WHERE id=?", p.SessionID).Scan(&current); err != nil {
		return time.Time{}, err
	}
	if current != managementVersion {
		return time.Time{}, core.Fail(409, "MANAGEMENT_CHANGED")
	}
	expires := now.Add(s.Config.ManagementTTL)
	if _, err = tx.ExecContext(ctx, "UPDATE sessions SET management_expires_at=?,management_version=management_version+1 WHERE id=?", expires.UnixMilli(), p.SessionID); err != nil {
		return time.Time{}, err
	}
	return expires, tx.Commit()
}

// Lock immediately revokes current management authorization and invalidates delayed unlocks.
func (s *Service) Lock(ctx context.Context, p Principal) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = Authorize(ctx, tx, p, false, s.Now()); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE sessions SET management_expires_at=NULL,management_version=management_version+1 WHERE id=?", p.SessionID); err != nil {
		return err
	}
	return tx.Commit()
}

// checkAttempts keeps failed authentication retryable after a bounded cooldown.
func (s *Service) checkAttempts(kind string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	window := s.attempts[kind]
	if s.Now().Before(window.Until) && window.Count >= 10 {
		return core.Fail(429, "TOO_MANY_ATTEMPTS")
	}
	return nil
}

// failedAttempt updates only a fixed login or management bucket, without retaining personal inputs.
func (s *Service) failedAttempt(kind string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.Now()
	window := s.attempts[kind]
	if !now.Before(window.Until) {
		window = attemptWindow{Until: now.Add(time.Minute)}
	}
	window.Count++
	s.attempts[kind] = window
}

package account

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/wookiisky/check-in-suite/internal/core"
)

// Group is an existing named space for mutual read access.
type Group struct {
	ID   int64  `json:"id"`   // Stable group identity.
	Name string `json:"name"` // Group name displayed during selection.
}

// Member exposes the minimum profile needed to choose a group member.
type Member struct {
	ID          int64  `json:"id"`           // Account whose records may be read.
	DisplayName string `json:"display_name"` // Member's current display name.
}

// GroupState combines group choices and current membership from one snapshot.
type GroupState struct {
	Groups       []Group  `json:"groups"`        // All existing group choices.
	CurrentGroup *Group   `json:"current_group"` // Nil for an independent account.
	Members      []Member `json:"members"`       // Current group members, including oneself.
}

// AuthorizeRead accepts one's own account or a current member of the same nonempty group.
func AuthorizeRead(ctx context.Context, tx *sql.Tx, p Principal, targetAccountID int64, now time.Time) error {
	if err := Authorize(ctx, tx, p, false, now); err != nil {
		return err
	}
	if targetAccountID == p.AccountID {
		return nil
	}
	var ownGroup, targetGroup sql.NullInt64
	err := tx.QueryRowContext(ctx, "SELECT own.group_id,target.group_id FROM accounts own JOIN accounts target ON target.id=? WHERE own.id=?", targetAccountID, p.AccountID).Scan(&ownGroup, &targetGroup)
	if errors.Is(err, sql.ErrNoRows) {
		return core.Fail(404, "NOT_FOUND")
	}
	if err != nil {
		return err
	}
	if !ownGroup.Valid || !targetGroup.Valid || ownGroup.Int64 != targetGroup.Int64 {
		return core.Fail(403, "GROUP_ACCESS_DENIED")
	}
	return nil
}

// CreateGroup creates a named existing group through the local maintenance entry point.
func (s *Service) CreateGroup(ctx context.Context, name string) (Group, error) {
	name = strings.TrimSpace(name)
	if err := core.Text("name", name, 1, s.Config.Limits.NameMax); err != nil {
		return Group{}, err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Group{}, err
	}
	defer tx.Rollback()
	var count int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM groups WHERE name=?", name).Scan(&count); err != nil {
		return Group{}, err
	}
	if count > 0 {
		return Group{}, core.Fail(409, "GROUP_EXISTS")
	}
	created, err := tx.ExecContext(ctx, "INSERT INTO groups(name) VALUES(?)", name)
	if err != nil {
		return Group{}, err
	}
	id, err := created.LastInsertId()
	if err != nil {
		return Group{}, err
	}
	if err = tx.Commit(); err != nil {
		return Group{}, err
	}
	return Group{ID: id, Name: name}, nil
}

// Groups returns membership without turning group access into management authority.
func (s *Service) Groups(ctx context.Context, p Principal) (GroupState, error) {
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return GroupState{}, err
	}
	defer tx.Rollback()
	if err = Authorize(ctx, tx, p, false, s.Now()); err != nil {
		return GroupState{}, err
	}
	return readGroups(ctx, tx, p.AccountID)
}

// readGroups reads all choices and only the current group's members.
func readGroups(ctx context.Context, tx *sql.Tx, accountID int64) (GroupState, error) {
	out := GroupState{Groups: []Group{}, Members: []Member{}}
	var current sql.NullInt64
	if err := tx.QueryRowContext(ctx, "SELECT group_id FROM accounts WHERE id=?", accountID).Scan(&current); err != nil {
		return out, err
	}
	rows, err := tx.QueryContext(ctx, "SELECT id,name FROM groups ORDER BY name,id")
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var item Group
		if err = rows.Scan(&item.ID, &item.Name); err != nil {
			rows.Close()
			return out, err
		}
		out.Groups = append(out.Groups, item)
		if current.Valid && item.ID == current.Int64 {
			copy := item
			out.CurrentGroup = &copy
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	if !current.Valid {
		return out, nil
	}
	rows, err = tx.QueryContext(ctx, "SELECT id,display_name FROM accounts WHERE group_id=? ORDER BY display_name,id", current.Int64)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var member Member
		if err = rows.Scan(&member.ID, &member.DisplayName); err != nil {
			return out, err
		}
		out.Members = append(out.Members, member)
	}
	return out, rows.Err()
}

// JoinGroup authorizes joining an existing group using this account's fresh management password.
func (s *Service) JoinGroup(ctx context.Context, p Principal, groupID int64, password string) (GroupState, error) {
	if groupID <= 0 {
		return GroupState{}, core.Invalid("group_id", "INVALID_NUMBER")
	}
	return s.changeGroup(ctx, p, &groupID, password)
}

// LeaveGroup revokes mutual read access without changing either account's business data.
func (s *Service) LeaveGroup(ctx context.Context, p Principal, password string) (GroupState, error) {
	return s.changeGroup(ctx, p, nil, password)
}

// changeGroup checks intent before password work and refuses a delayed mutation after membership changes.
func (s *Service) changeGroup(ctx context.Context, p Principal, groupID *int64, password string) (GroupState, error) {
	access, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return GroupState{}, err
	}
	if err = Authorize(ctx, access, p, false, s.Now()); err != nil {
		access.Rollback()
		return GroupState{}, err
	}
	var expected int64
	err = access.QueryRowContext(ctx, "SELECT group_version FROM accounts WHERE id=?", p.AccountID).Scan(&expected)
	access.Rollback()
	if err != nil {
		return GroupState{}, err
	}
	credential, err := s.VerifyManagement(ctx, p.AccountID, password)
	if err != nil {
		return GroupState{}, err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return GroupState{}, err
	}
	defer tx.Rollback()
	now := s.Now()
	if err = Authorize(ctx, tx, p, false, now); err != nil {
		return GroupState{}, err
	}
	if credential != p.CredentialVersion {
		return GroupState{}, core.Fail(401, "SESSION_REQUIRED")
	}
	var current sql.NullInt64
	var version int64
	if err = tx.QueryRowContext(ctx, "SELECT group_id,group_version FROM accounts WHERE id=?", p.AccountID).Scan(&current, &version); err != nil {
		return GroupState{}, err
	}
	if version != expected {
		return GroupState{}, core.Fail(409, "GROUP_CHANGED")
	}
	if groupID != nil {
		if current.Valid && current.Int64 != *groupID {
			return GroupState{}, core.Fail(409, "GROUP_ALREADY_JOINED")
		}
		var exists int
		if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM groups WHERE id=?", *groupID).Scan(&exists); err != nil {
			return GroupState{}, err
		}
		if exists == 0 {
			return GroupState{}, core.Fail(404, "NOT_FOUND")
		}
	}
	if (groupID == nil && current.Valid) || (groupID != nil && (!current.Valid || current.Int64 != *groupID)) {
		if _, err = tx.ExecContext(ctx, "UPDATE accounts SET group_id=?,group_version=group_version+1,updated_at=? WHERE id=?", groupID, now.UnixMilli(), p.AccountID); err != nil {
			return GroupState{}, err
		}
	}
	state, err := readGroups(ctx, tx, p.AccountID)
	if err != nil {
		return GroupState{}, err
	}
	if err = tx.Commit(); err != nil {
		return GroupState{}, err
	}
	return state, nil
}

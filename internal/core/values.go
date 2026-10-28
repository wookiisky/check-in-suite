// Package core contains the small shared protocol and business-value rules.
package core

import (
	"strings"
	"time"
	_ "time/tzdata"
	"unicode/utf8"

	"github.com/google/uuid"
)

// MaxInteger is the greatest exact integer representable by JSON consumers in JavaScript.
const MaxInteger int64 = 9007199254740991

// Error is a stable machine-readable business failure; clients localize its codes.
type Error struct {
	Status         int               `json:"-"`                         // HTTP status appropriate to the failure.
	Code           string            `json:"code"`                      // Stable protocol error code.
	FieldErrors    map[string]string `json:"field_errors"`              // Field-specific machine codes.
	CurrentVersion *int64            `json:"current_version,omitempty"` // Latest version for stale edits.
}

// Error satisfies error without exposing user content.
func (e *Error) Error() string { return e.Code }

// Fail creates a protocol failure without embedding translated copy.
func Fail(status int, code string) *Error {
	return &Error{Status: status, Code: code, FieldErrors: map[string]string{}}
}

// Invalid points a validation failure at its input field.
func Invalid(field, code string) *Error {
	return &Error{Status: 400, Code: "INVALID_REQUEST", FieldErrors: map[string]string{field: code}}
}

// ID creates a fresh opaque identifier for a persisted resource.
func ID() string { return uuid.NewString() }

// Today interprets an instant in the fixed business timezone.
func Today(now time.Time) string {
	zone, err := time.LoadLocation("Asia/Taipei")
	if err != nil {
		panic(err)
	}
	return now.In(zone).Format(time.DateOnly)
}

// ParseDate accepts only a complete valid calendar date.
func ParseDate(value string) (time.Time, error) {
	d, err := time.Parse(time.DateOnly, value)
	if err != nil || d.Format(time.DateOnly) != value {
		return time.Time{}, Fail(422, "INVALID_DATE_RANGE")
	}
	return d, nil
}

// Add checks both operands and the result before integer arithmetic reaches persistence.
func Add(a, b int64) (int64, error) {
	if a < -MaxInteger || a > MaxInteger || b < -MaxInteger || b > MaxInteger || (b > 0 && a > MaxInteger-b) || (b < 0 && a < -MaxInteger-b) {
		return 0, Fail(422, "INTEGER_OVERFLOW")
	}
	return a + b, nil
}

// Text validates Unicode code points after callers choose their own whitespace policy.
func Text(field, value string, min, max int) error {
	if !utf8.ValidString(value) {
		return Invalid(field, "INVALID_TEXT")
	}
	n := utf8.RuneCountInString(value)
	if n < min || n > max {
		return Invalid(field, "INVALID_LENGTH")
	}
	if min > 0 && strings.TrimSpace(value) == "" {
		return Invalid(field, "REQUIRED")
	}
	return nil
}

// VersionConflict describes a stale optimistic edit.
func VersionConflict(current int64) *Error {
	e := Fail(409, "VERSION_CONFLICT")
	e.CurrentVersion = &current
	return e
}

// Timestamp converts persisted UTC milliseconds to the public RFC3339 format.
func Timestamp(milliseconds int64) string {
	return time.UnixMilli(milliseconds).UTC().Format(time.RFC3339Nano)
}

package core

import (
	"testing"
	"time"
)

// TestBusinessDateAndIntegerBounds exercises calendar and JSON-safe arithmetic boundaries.
func TestBusinessDateAndIntegerBounds(t *testing.T) {
	if got := Today(time.Date(2026, 12, 31, 16, 0, 0, 0, time.UTC)); got != "2027-01-01" {
		t.Fatal(got)
	}
	if got := Today(time.Date(2026, 12, 31, 15, 59, 59, 0, time.UTC)); got != "2026-12-31" {
		t.Fatal(got)
	}
	if got := Today(time.Date(2026, 2, 28, 16, 0, 0, 0, time.UTC)); got != "2026-03-01" {
		t.Fatal(got)
	}
	if got := Today(time.Date(2028, 2, 28, 16, 0, 0, 0, time.UTC)); got != "2028-02-29" {
		t.Fatal(got)
	}
	if _, err := Add(MaxInteger, 1); err == nil {
		t.Fatal("overflow accepted")
	}
	if _, err := Add(-MaxInteger, -1); err == nil {
		t.Fatal("underflow accepted")
	}
	if got, err := Add(2, -10); err != nil || got != -8 {
		t.Fatalf("%d %v", got, err)
	}
	if _, err := ParseDate("2026-02-29"); err == nil {
		t.Fatal("invalid date accepted")
	}
	if err := Text("姓名", "😀😀", 2, 2); err != nil {
		t.Fatal(err)
	}
}

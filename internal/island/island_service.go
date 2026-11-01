package island

import (
	"database/sql"
	"time"
)

// Service owns centimeter layouts and task qualifications over the shared database.
type Service struct {
	DB  *sql.DB          // Shared application database.
	Now func() time.Time // Authorization clock, injectable in tests.
}

// New uses the existing database without seeding products or mutating schema.
func New(db *sql.DB, now func() time.Time) *Service { return &Service{DB: db, Now: now} }

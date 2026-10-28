// Package migrations embeds ordered SQL into the executable for repeatable startup checks.
package migrations

import "embed"

// Files contains immutable, sequential SQL migrations shipped with this application.
//
//go:embed *.sql
var Files embed.FS

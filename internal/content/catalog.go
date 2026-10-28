// Package content embeds the command-line messages shipped with the application.
package content

import (
	_ "embed"
	"encoding/json"
)

// catalogJSON contains localized user-facing messages without runtime file dependencies.
//
//go:embed zh-CN.json
var catalogJSON []byte

// catalog is immutable after startup and safe for concurrent reads.
var catalog = load()

// load treats a malformed built-in resource as a build defect.
func load() map[string]string {
	var result map[string]string
	if err := json.Unmarshal(catalogJSON, &result); err != nil {
		panic(err)
	}
	return result
}

// Text resolves stable message keys while keeping internal failures out of the UI.
func Text(key string) string {
	if value, ok := catalog[key]; ok {
		return value
	}
	return catalog["INTERNAL_ERROR"]
}

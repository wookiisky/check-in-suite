package main

import (
	"encoding/json"
	"io"
	"runtime"
)

// buildVersion is replaced by the release build with its full Git revision and dirty marker.
var buildVersion = "development"

// buildTime is the UTC timestamp supplied by the release build.
var buildTime string

// printVersion reports artifact identity without requiring installation or database access.
func printVersion(output io.Writer) error {
	return json.NewEncoder(output).Encode(struct {
		Version   string `json:"version"`            // Full revision or development label.
		BuiltAt   string `json:"built_at,omitempty"` // Timestamp of the release build.
		GOOS      string `json:"goos"`               // Compiled target operating system.
		GOARCH    string `json:"goarch"`             // Compiled target CPU architecture.
		GoVersion string `json:"go_version"`         // Compiler/runtime version.
	}{buildVersion, buildTime, runtime.GOOS, runtime.GOARCH, runtime.Version()})
}

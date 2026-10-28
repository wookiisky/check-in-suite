package main

import (
	"bytes"
	"context"
	"encoding/json"
	"runtime"
	"strings"
	"testing"
)

// TestVersionCommand verifies build identity without opening configuration or a database.
func TestVersionCommand(t *testing.T) {
	var output bytes.Buffer
	if err := runWithIO(context.Background(), []string{"version"}, strings.NewReader(""), &output); err != nil {
		t.Fatal(err)
	}
	var info struct {
		Version   string `json:"version"`    // Compiled application revision.
		GOOS      string `json:"goos"`       // Compiled target operating system.
		GOARCH    string `json:"goarch"`     // Compiled target architecture.
		GoVersion string `json:"go_version"` // Compiler runtime identity.
	}
	if err := json.Unmarshal(output.Bytes(), &info); err != nil {
		t.Fatal(err)
	}
	if info.Version == "" || info.GOOS != runtime.GOOS || info.GOARCH != runtime.GOARCH || info.GoVersion != runtime.Version() {
		t.Fatalf("invalid build identity: %+v", info)
	}
	output.Reset()
	if err := runWithIO(context.Background(), []string{"version", "extra"}, strings.NewReader(""), &output); err == nil || output.Len() != 0 {
		t.Fatalf("extra version argument accepted: output=%q error=%v", output.String(), err)
	}
}

package httpapi

import (
	"os"
	"testing"
	"time"
)

// TestMain provides a separate subprocess fixture for success, failure, and probe deadlines.
func TestMain(m *testing.M) {
	if len(os.Args) == 2 && os.Args[1] == "-version" {
		switch os.Getenv("ISLAND_TEST_PROBE_MODE") {
		case "success":
			os.Exit(0)
		case "timeout":
			time.Sleep(time.Second)
			os.Exit(0)
		default:
			os.Exit(1)
		}
	}
	os.Exit(m.Run())
}

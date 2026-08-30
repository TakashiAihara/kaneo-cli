package session

import (
	"os"
	"strings"
	"testing"
)

// TestWriteMarkersForCompatCheck dumps what this package writes so the Python
// implementation can be run over the same bytes. Enabled by an env var so it
// only runs when the cross-language check is being performed.
func TestWriteMarkersForCompatCheck(t *testing.T) {
	dest := os.Getenv("KANEO_COMPAT_DUMP")
	if dest == "" {
		t.Skip("set KANEO_COMPAT_DUMP to a path to dump markers")
	}
	markers := []Marker{
		{SessionID: "abc-123", Host: "d1", Cwd: "/root/.ccx/x/01ABC", Branch: "feat/go-cli-foundation", State: StateRunning, NextStep: "CI を待つ"},
		{SessionID: "abc-123", Host: "d1", Cwd: "/root/.ccx/x/01ABC", Branch: "feat/go-cli-foundation", State: StateClosed},
	}
	var b strings.Builder
	for _, m := range markers {
		b.WriteString(m.Format())
		b.WriteString("\n===SPLIT===\n")
	}
	if err := os.WriteFile(dest, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
}

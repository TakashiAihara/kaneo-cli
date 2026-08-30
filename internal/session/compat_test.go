package session

import (
	"encoding/json"
	"os"
	"testing"
)

// testdata/real_markers.json holds comments captured from a live board that
// the Python implementation wrote. Parsing them here is the half of the
// compatibility guarantee that a hand-written fixture cannot give: it pins the
// byte layout that actually exists, not the layout this package believes it
// emits.
//
// Session ids, hostnames and paths were replaced with placeholders — the file
// ships in a public repository. Only the values changed: field order, spacing,
// the 次の一手 label and the non-ASCII content are byte-for-byte as captured,
// and those are what the compatibility claim rests on.
func TestParsesMarkersCapturedFromALiveBoard(t *testing.T) {
	raw, err := os.ReadFile("testdata/real_markers.json")
	if err != nil {
		t.Fatal(err)
	}
	var comments []struct {
		Content   string `json:"content"`
		CreatedAt string `json:"createdAt"`
	}
	if err := json.Unmarshal(raw, &comments); err != nil {
		t.Fatal(err)
	}
	if len(comments) == 0 {
		t.Fatal("no captured markers; the fixture would pin nothing")
	}

	var markers []Marker
	for _, c := range comments {
		m, ok := Parse(c.Content, c.CreatedAt)
		if !ok {
			t.Fatalf("a marker written by the Python implementation was not recognised:\n%s", c.Content)
		}
		if m.SessionID == "" {
			t.Errorf("session id empty for:\n%s", c.Content)
		}
		if m.State != StateRunning && m.State != StateClosed {
			t.Errorf("state = %q, want running or closed, for:\n%s", m.State, c.Content)
		}
		if m.Host == "" {
			t.Errorf("host empty for:\n%s", c.Content)
		}
		if m.Cwd == "" {
			t.Errorf("cwd empty for:\n%s", c.Content)
		}
		markers = append(markers, m)
	}

	// The label the Python implementation writes must not survive into the
	// next step, or the board would render it twice.
	for _, m := range markers {
		if len(m.NextStep) >= len("次の一手") && m.NextStep[:len("次の一手")] == "次の一手" {
			t.Errorf("next step kept its label: %q", m.NextStep)
		}
	}

	if got := LatestPerSession(markers); len(got) == 0 || len(got) > len(markers) {
		t.Errorf("LatestPerSession returned %d entries from %d markers", len(got), len(markers))
	}
}

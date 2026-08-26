package session

import "testing"

// The exact bytes the Python `kn` writes. Both implementations read the same
// board while one replaces the other, so this must keep parsing.
const pythonMarker = "<!-- kn:session id=abc-123 host=d1 cwd=/root/.ccx/x/01ABC branch=main state=running -->\n" +
	"次の一手: CI を待つ"

func TestParsesTheMarkerWrittenByPython(t *testing.T) {
	m, ok := Parse(pythonMarker, "2026-08-26T00:00:00Z")
	if !ok {
		t.Fatal("marker not recognised")
	}
	if m.SessionID != "abc-123" {
		t.Errorf("id = %q, want abc-123", m.SessionID)
	}
	if m.Host != "d1" {
		t.Errorf("host = %q, want d1", m.Host)
	}
	if m.Cwd != "/root/.ccx/x/01ABC" {
		t.Errorf("cwd = %q", m.Cwd)
	}
	if m.Branch != "main" {
		t.Errorf("branch = %q, want main", m.Branch)
	}
	if m.State != StateRunning {
		t.Errorf("state = %q, want running", m.State)
	}
	if m.NextStep != "CI を待つ" {
		t.Errorf("next step = %q, want the label stripped", m.NextStep)
	}
}

// The other direction: what this package writes has to survive the Python
// reader, which splits the marker body on whitespace and strips an optional
// 次の一手 prefix from the line below.
func TestFormatIsReadableByThePythonParser(t *testing.T) {
	m := Marker{
		SessionID: "abc-123", Host: "d1", Cwd: "/root/repo", Branch: "main",
		State: StateRunning, NextStep: "CI を待つ",
	}
	got := m.Format()

	want := "<!-- kn:session id=abc-123 host=d1 cwd=/root/repo branch=main state=running -->\nCI を待つ"
	if got != want {
		t.Errorf("Format() =\n%q\nwant\n%q", got, want)
	}
}

func TestRoundTrip(t *testing.T) {
	in := Marker{
		SessionID: "s1", Host: "pi", Cwd: "/home/x/repo", Branch: "feat/thing",
		State: StateClosed, NextStep: "done",
	}
	out, ok := Parse(in.Format(), "t0")
	if !ok {
		t.Fatal("own output did not parse")
	}
	if out.SessionID != in.SessionID || out.Host != in.Host || out.Cwd != in.Cwd ||
		out.Branch != in.Branch || out.State != in.State || out.NextStep != in.NextStep {
		t.Errorf("round trip lost data:\n got %+v\nwant %+v", out, in)
	}
}

func TestEmptyFieldsRoundTripAsAbsent(t *testing.T) {
	m := Marker{SessionID: "s1", State: StateRunning}
	out, ok := Parse(m.Format(), "t0")
	if !ok {
		t.Fatal("did not parse")
	}
	if out.Host != "" || out.Cwd != "" || out.Branch != "" {
		t.Errorf("placeholder leaked into a field: %+v", out)
	}
}

func TestPlainCommentIsNotAMarker(t *testing.T) {
	if _, ok := Parse("just a human comment mentioning kn:session in passing", "t0"); ok {
		t.Error("plain text was parsed as a marker")
	}
	if _, ok := Parse("", "t0"); ok {
		t.Error("empty comment was parsed as a marker")
	}
}

func TestMarkerWithoutNextStep(t *testing.T) {
	m, ok := Parse("<!-- kn:session id=s1 host=d1 cwd=/x branch=main state=closed -->", "t0")
	if !ok {
		t.Fatal("did not parse")
	}
	if m.NextStep != "" {
		t.Errorf("next step = %q, want empty", m.NextStep)
	}
}

// attach, next and close each append a comment, so a session leaves a trail.
// Only the newest entry describes the session's actual state.
func TestLatestPerSessionCollapsesTheTrail(t *testing.T) {
	markers := []Marker{
		{SessionID: "s1", State: StateRunning, CreatedAt: "2026-08-26T01:00:00Z", NextStep: "start"},
		{SessionID: "s2", State: StateRunning, CreatedAt: "2026-08-26T02:00:00Z"},
		{SessionID: "s1", State: StateRunning, CreatedAt: "2026-08-26T03:00:00Z", NextStep: "middle"},
		{SessionID: "s1", State: StateClosed, CreatedAt: "2026-08-26T04:00:00Z"},
	}

	latest := LatestPerSession(markers)
	if len(latest) != 2 {
		t.Fatalf("sessions = %d, want 2 (one per id)", len(latest))
	}

	byID := map[string]Marker{}
	for _, m := range latest {
		byID[m.SessionID] = m
	}
	if byID["s1"].State != StateClosed {
		t.Errorf("s1 state = %q, want closed; an older running marker won", byID["s1"].State)
	}

	running := Running(latest)
	if len(running) != 1 || running[0].SessionID != "s2" {
		t.Errorf("running = %+v, want only s2", running)
	}
}

func TestFormatKeepsTheMarkerOnOneLine(t *testing.T) {
	m := Marker{SessionID: "s1", Cwd: "/tmp/a\nb", Branch: "main", State: StateRunning}
	out, ok := Parse(m.Format(), "t0")
	if !ok {
		t.Fatal("a newline in a field broke the marker")
	}
	if out.Branch != "main" {
		t.Errorf("branch = %q; a newline in an earlier field corrupted the parse", out.Branch)
	}
}

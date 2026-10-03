package session

import (
	"strings"
	"testing"
)

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

	want := "<!-- kn:session id=abc-123 host=d1 cwd=/root/repo branch=main state=running enc=1 -->\nCI を待つ"
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

// A value containing a space followed by something shaped like a key would
// otherwise end the field early, and the round trip would silently lose the
// rest of the path.
func TestValueContainingAFieldSeparatorSurvives(t *testing.T) {
	for _, cwd := range []string{
		"/work/client foo=bar",
		"/work/my client",
		"/work/100% sure",
		"/work/a\tb",
		"/work/trailing branch=notreal",
	} {
		in := Marker{SessionID: "s1", Host: "h", Cwd: cwd, Branch: "main", State: StateRunning}
		out, ok := Parse(in.Format(), "t0")
		if !ok {
			t.Fatalf("cwd %q: did not parse:\n%s", cwd, in.Format())
		}
		if out.Cwd != cwd {
			t.Errorf("cwd = %q, want %q (marker: %s)", out.Cwd, cwd, in.Format())
		}
		if out.Branch != "main" {
			t.Errorf("cwd %q: branch = %q, want main; the field boundary moved", cwd, out.Branch)
		}
	}
}

// The encoded form must stay on one whitespace-separated token, because the
// Python implementation splits the marker body on whitespace.
func TestEncodedValueHasNoWhitespace(t *testing.T) {
	m := Marker{SessionID: "s1", Cwd: "/work/my client", Branch: "main", State: StateRunning}
	body := m.Format()
	body = body[strings.Index(body, "kn:session ")+len("kn:session ") : strings.Index(body, "-->")]

	for _, field := range strings.Fields(body) {
		if !strings.Contains(field, "=") {
			t.Errorf("field %q has no key; a value was split across tokens: %q", field, body)
		}
	}
}

// Markers written by the Python implementation carry raw values and no
// escapes, so decoding must leave them untouched.
func TestRawValuesFromTheOtherImplementationAreUnchanged(t *testing.T) {
	m, ok := Parse("<!-- kn:session id=abc host=d1 cwd=/root/x branch=main state=running -->", "t0")
	if !ok {
		t.Fatal("did not parse")
	}
	if m.Cwd != "/root/x" {
		t.Errorf("cwd = %q, want /root/x", m.Cwd)
	}
}

// A marker written by the older implementation stores values raw, so a path
// that legitimately contains a percent sequence must come back unchanged.
// Decoding it would turn /repo/100%20done into /repo/100 done.
func TestLegacyMarkerValuesAreNotDecoded(t *testing.T) {
	raw := "<!-- kn:session id=s1 host=d1 cwd=/repo/100%20done branch=feature%2Fx state=running -->"
	m, ok := Parse(raw, "t0")
	if !ok {
		t.Fatal("did not parse")
	}
	if m.Cwd != "/repo/100%20done" {
		t.Errorf("cwd = %q, want the raw value unchanged", m.Cwd)
	}
	if m.Branch != "feature%2Fx" {
		t.Errorf("branch = %q, want the raw value unchanged", m.Branch)
	}
}

// The same bytes, declared as encoded, must decode.
func TestDeclaredEncodedMarkerIsDecoded(t *testing.T) {
	raw := "<!-- kn:session id=s1 host=d1 cwd=/repo/100%20done branch=main state=running enc=1 -->"
	m, ok := Parse(raw, "t0")
	if !ok {
		t.Fatal("did not parse")
	}
	if m.Cwd != "/repo/100 done" {
		t.Errorf("cwd = %q, want the decoded value", m.Cwd)
	}
}

// A value containing the comment terminator has to survive rather than be
// mangled into "--".
func TestValueContainingCommentTerminatorRoundTrips(t *testing.T) {
	for _, cwd := range []string{"/work/a-->b", "/work/a>b", "/work/<x>"} {
		in := Marker{SessionID: "s1", Cwd: cwd, Branch: "main", State: StateRunning}
		formatted := in.Format()
		if strings.Count(formatted, "-->") != 1 {
			t.Errorf("cwd %q produced a marker with a stray terminator: %s", cwd, formatted)
		}
		out, ok := Parse(formatted, "t0")
		if !ok {
			t.Fatalf("cwd %q: did not parse: %s", cwd, formatted)
		}
		if out.Cwd != cwd {
			t.Errorf("cwd = %q, want %q", out.Cwd, cwd)
		}
	}
}

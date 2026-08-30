// Package session tracks which agent session is working on which task.
//
// Kaneo tasks carry no custom fields, so the association is stored in a task
// comment as a machine-readable marker. The marker's wire format is fixed by
// the Python `kn` that came first: both implementations read the same board
// while one is being replaced by the other, so the format cannot drift.
package session

import (
	"regexp"
	"sort"
	"strings"
)

// markerPattern matches the HTML comment carrying the session fields. The
// prefix is `kn:` rather than `kaneo:` because that is what is already written
// on the board; changing it would make existing markers invisible.
var markerPattern = regexp.MustCompile(`(?s)<!--\s*kn:session\s+(.*?)-->`)

// keyPattern locates where each key=value pair starts inside the marker body.
//
// Values are then taken as the text between one key and the next, so a value
// containing spaces survives. Matching the value with a regexp instead would
// need a lookahead to avoid swallowing the following key, and RE2 has none.
var keyPattern = regexp.MustCompile(`(?:^|\s)([a-zA-Z_][a-zA-Z0-9_]*)=`)

// parseFields splits a marker body into its key=value pairs.
func parseFields(body string) map[string]string {
	positions := keyPattern.FindAllStringSubmatchIndex(body, -1)
	out := make(map[string]string, len(positions))
	for i, pos := range positions {
		key := body[pos[2]:pos[3]]
		valueStart := pos[1]
		valueEnd := len(body)
		if i+1 < len(positions) {
			valueEnd = positions[i+1][0]
		}
		out[key] = strings.TrimSpace(body[valueStart:valueEnd])
	}
	return out
}

// State is what a session is doing with a task.
type State string

const (
	StateRunning State = "running"
	StateClosed  State = "closed"
)

// nextStepLabels are prefixes stripped from the free-text line under a marker.
// The Japanese one is what the Python implementation writes.
var nextStepLabels = []string{"次の一手:", "次の一手：", "next:"}

// Marker is one session's record on a task.
type Marker struct {
	SessionID string
	Host      string
	Cwd       string
	Branch    string
	State     State

	// NextStep is the free-text line following the marker.
	NextStep string

	// CreatedAt is the comment's timestamp, used to pick the newest marker
	// for a session. It is not part of the marker itself.
	CreatedAt string
}

// Format renders the marker plus its optional next-step line.
//
// The next step is written as a bare line with no label. The Python reader
// strips an optional `次の一手:` prefix and otherwise takes the line as-is, so
// an unlabelled line reads correctly there while staying language-neutral here.
func (m Marker) Format() string {
	fields := []string{
		"id=" + encodeValue(m.SessionID),
		"host=" + encodeValue(m.Host),
		"cwd=" + encodeValue(m.Cwd),
		"branch=" + encodeValue(m.Branch),
		"state=" + string(m.State),
	}
	out := "<!-- kn:session " + strings.Join(fields, " ") + " -->"
	if step := strings.TrimSpace(m.NextStep); step != "" {
		out += "\n" + step
	}
	return out
}

// encodeValue makes a value safe to sit between two space-separated fields.
//
// Whitespace is percent-encoded rather than kept. A value containing a space
// is otherwise indistinguishable from the start of the next field: a path like
// "/work/client foo=bar" would be read back as "/work/client". The Python
// implementation splits the marker body on whitespace, so encoding keeps the
// value in one piece for that reader too — it renders the escapes literally
// where it displays the value, which is cosmetic, rather than truncating it.
//
// The percent sign itself is encoded first so decoding is unambiguous.
func encodeValue(s string) string {
	s = strings.ReplaceAll(s, "-->", "--")
	s = strings.TrimSpace(s)
	if s == "" {
		return "-"
	}

	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '%':
			b.WriteString("%25")
		case r == ' ':
			b.WriteString("%20")
		case r == '\t':
			b.WriteString("%09")
		case r == '\n' || r == '\r':
			b.WriteString("%0A")
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// decodeValue reverses encodeValue. An unrecognised escape is left alone: a
// marker written by the Python implementation carries raw values, and mangling
// a literal percent sign would be worse than leaving it.
func decodeValue(s string) string {
	replacements := []struct{ from, to string }{
		{"%20", " "}, {"%09", "\t"}, {"%0A", "\n"},
	}
	for _, r := range replacements {
		s = strings.ReplaceAll(s, r.from, r.to)
	}
	return strings.ReplaceAll(s, "%25", "%")
}

// Parse extracts a marker from a comment body. The second result is false when
// the comment carries no marker, which is the normal case for a human comment.
func Parse(content, createdAt string) (Marker, bool) {
	loc := markerPattern.FindStringSubmatchIndex(content)
	if loc == nil {
		return Marker{}, false
	}
	body := content[loc[2]:loc[3]]

	m := Marker{CreatedAt: createdAt}
	for key, value := range parseFields(body) {
		if value == "-" {
			value = ""
		}
		value = decodeValue(value)
		switch key {
		case "id":
			m.SessionID = value
		case "host":
			m.Host = value
		case "cwd":
			m.Cwd = value
		case "branch":
			m.Branch = value
		case "state":
			m.State = State(value)
		}
	}

	trailing := strings.TrimSpace(content[loc[1]:])
	for _, label := range nextStepLabels {
		if strings.HasPrefix(trailing, label) {
			trailing = strings.TrimSpace(strings.TrimPrefix(trailing, label))
			break
		}
	}
	m.NextStep = trailing

	return m, true
}

// LatestPerSession keeps only the newest marker for each session id.
//
// attach, next and close each append their own comment, so a session leaves a
// trail behind it. Without this, a closed session keeps showing as running and
// appears several times over.
func LatestPerSession(markers []Marker) []Marker {
	latest := map[string]Marker{}
	for _, m := range markers {
		prev, seen := latest[m.SessionID]
		if !seen || m.CreatedAt >= prev.CreatedAt {
			latest[m.SessionID] = m
		}
	}

	out := make([]Marker, 0, len(latest))
	for _, m := range latest {
		out = append(out, m)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].CreatedAt != out[j].CreatedAt {
			return out[i].CreatedAt < out[j].CreatedAt
		}
		return out[i].SessionID < out[j].SessionID
	})
	return out
}

// Running filters to the sessions still holding a task.
func Running(markers []Marker) []Marker {
	out := make([]Marker, 0, len(markers))
	for _, m := range markers {
		if m.State == StateRunning {
			out = append(out, m)
		}
	}
	return out
}

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
		"id=" + oneLine(m.SessionID),
		"host=" + oneLine(m.Host),
		"cwd=" + oneLine(m.Cwd),
		"branch=" + oneLine(m.Branch),
		"state=" + string(m.State),
	}
	out := "<!-- kn:session " + strings.Join(fields, " ") + " -->"
	if step := strings.TrimSpace(m.NextStep); step != "" {
		out += "\n" + step
	}
	return out
}

// oneLine keeps a field on a single line and free of the marker terminator.
// Spaces are preserved: the reader here handles them, and a value containing
// one is rare enough that degrading it for the older reader is the better
// trade than silently rewriting the user's path.
func oneLine(s string) string {
	s = strings.NewReplacer("\n", " ", "\r", " ", "-->", "--").Replace(s)
	s = strings.TrimSpace(s)
	if s == "" {
		return "-"
	}
	return s
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

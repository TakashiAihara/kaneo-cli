package output

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestResolveMode(t *testing.T) {
	tests := []struct {
		name                                string
		jsonFlag, humanFlag, isTTY, noColor bool
		wantJSON, wantColor                 bool
	}{
		{name: "tty default is human", isTTY: true, wantJSON: false, wantColor: true},
		{name: "pipe default is json", isTTY: false, wantJSON: true, wantColor: false},
		{name: "json flag on tty", jsonFlag: true, isTTY: true, wantJSON: true, wantColor: true},
		{name: "human flag beats pipe", humanFlag: true, isTTY: false, wantJSON: false, wantColor: false},
		{name: "human flag beats json flag", jsonFlag: true, humanFlag: true, isTTY: true, wantJSON: false, wantColor: true},
		{name: "no color on tty", isTTY: true, noColor: true, wantJSON: false, wantColor: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ResolveMode(tt.jsonFlag, tt.humanFlag, tt.isTTY, tt.noColor)
			if got.JSON != tt.wantJSON {
				t.Errorf("JSON = %v, want %v", got.JSON, tt.wantJSON)
			}
			if got.Color != tt.wantColor {
				t.Errorf("Color = %v, want %v", got.Color, tt.wantColor)
			}
		})
	}
}

func newTestWriter(jsonMode bool) (*Writer, *bytes.Buffer, *bytes.Buffer) {
	out, errBuf := &bytes.Buffer{}, &bytes.Buffer{}
	return &Writer{Mode: Mode{JSON: jsonMode}, Out: out, Err: errBuf}, out, errBuf
}

// Data is the only stdout producer in JSON mode; that is what makes `| jq` safe.
func TestJSONModeKeepsStdoutClean(t *testing.T) {
	w, out, errBuf := newTestWriter(true)
	w.Status("fetching tasks")
	w.Human("this must not appear")
	if err := w.Data(map[string]int{"count": 2}); err != nil {
		t.Fatal(err)
	}

	var got map[string]int
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("stdout is not a single JSON document: %v (stdout=%q)", err, out.String())
	}
	if got["count"] != 2 {
		t.Errorf("count = %d, want 2", got["count"])
	}
	if errBuf.Len() != 0 {
		t.Errorf("status leaked in JSON mode: %q", errBuf.String())
	}
}

func TestHumanModeSuppressesData(t *testing.T) {
	w, out, errBuf := newTestWriter(false)
	w.Status("fetching tasks")
	w.Human("#1 first task")
	if err := w.Data(map[string]int{"count": 2}); err != nil {
		t.Fatal(err)
	}

	if strings.Contains(out.String(), "count") {
		t.Errorf("Data leaked into human stdout: %q", out.String())
	}
	if !strings.Contains(out.String(), "#1 first task") {
		t.Errorf("Human output missing: %q", out.String())
	}
	if !strings.Contains(errBuf.String(), "fetching tasks") {
		t.Errorf("status did not reach stderr: %q", errBuf.String())
	}
}

func TestErrorReachesStderrInBothModes(t *testing.T) {
	for _, jsonMode := range []bool{false, true} {
		w, out, errBuf := newTestWriter(jsonMode)
		w.Error(errors.New("boom"))

		if !strings.Contains(errBuf.String(), "boom") {
			t.Errorf("jsonMode=%v: stderr missing error: %q", jsonMode, errBuf.String())
		}
		if jsonMode {
			var got map[string]string
			if err := json.Unmarshal(out.Bytes(), &got); err != nil {
				t.Fatalf("jsonMode: stdout is not JSON: %v (%q)", err, out.String())
			}
			if got["error"] != "boom" {
				t.Errorf("error payload = %q, want boom", got["error"])
			}
		} else if out.Len() != 0 {
			t.Errorf("human mode wrote to stdout: %q", out.String())
		}
	}
}

// Task titles, branch names and session notes come from the server. An escape
// sequence in one of them would otherwise reach the terminal, where it can
// repaint the screen or rewrite what the reader believes they are looking at.
func TestHumanOutputStripsControlCharacters(t *testing.T) {
	w, out, _ := newTestWriter(false)
	w.Human("#%d %s", 7, "innocent\x1b[2K\x1b[1Ghijacked")

	got := out.String()
	if strings.ContainsRune(got, 0x1b) {
		t.Errorf("an escape sequence reached stdout: %q", got)
	}
	if !strings.Contains(got, "innocent") || !strings.Contains(got, "hijacked") {
		t.Errorf("the visible text was lost: %q", got)
	}
}

func TestSanitizeControl(t *testing.T) {
	const repl = "\uFFFD"
	tests := []struct{ in, want string }{
		{"plain", "plain"},
		{"tab\there", "tab\there"},
		{"line\nbreak", "line\nbreak"},
		{"esc\x1b[31m", "esc" + repl + "[31m"},
		{"bell\x07", "bell" + repl},
		{"del\x7f", "del" + repl},
		{"c1\u0090", "c1" + repl},
		{"carriage\rreturn", "carriage" + repl + "return"},
		{"日本語はそのまま", "日本語はそのまま"},
	}
	for _, tc := range tests {
		if got := SanitizeControl(tc.in); got != tc.want {
			t.Errorf("SanitizeControl(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// The JSON path must not be touched: the encoder escapes control characters
// itself, and rewriting them would corrupt the value a script reads.
func TestJSONOutputKeepsValuesIntact(t *testing.T) {
	w, out, _ := newTestWriter(true)
	original := "with\x1bescape"
	if err := w.Data(map[string]string{"title": original}); err != nil {
		t.Fatal(err)
	}
	var got map[string]string
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["title"] != original {
		t.Errorf("title = %q, want the value unchanged", got["title"])
	}
}

func TestErrorOutputStripsControlCharacters(t *testing.T) {
	w, _, errBuf := newTestWriter(false)
	w.Error(errors.New("boom\x1b[2Jcleared"))
	if strings.ContainsRune(errBuf.String(), 0x1b) {
		t.Errorf("an escape sequence reached stderr: %q", errBuf.String())
	}
}

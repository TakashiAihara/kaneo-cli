// Package output decides how command results reach the user.
//
// Two rules drive everything here:
//   - Data goes to stdout, decoration goes to stderr. `kaneo task ls | jq` has to
//     work without the caller passing a flag.
//   - Non-TTY stdout means the caller is a script, so JSON is the better default.
package output

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
)

// Mode is the resolved rendering decision for one invocation.
type Mode struct {
	JSON  bool
	Color bool
}

// ResolveMode picks between JSON and human rendering.
//
// human wins over json so that a caller can force readable output through a pipe.
// stdoutIsTTY is passed in rather than probed so the decision is testable.
func ResolveMode(jsonFlag, humanFlag, stdoutIsTTY, noColor bool) Mode {
	return Mode{
		JSON:  !humanFlag && (jsonFlag || !stdoutIsTTY),
		Color: stdoutIsTTY && !noColor,
	}
}

// IsTTY reports whether f is attached to a terminal.
func IsTTY(f *os.File) bool {
	info, err := f.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}

// Writer renders results according to a Mode.
type Writer struct {
	Mode Mode
	Out  io.Writer
	Err  io.Writer
}

// New builds a Writer over the process stdio.
func New(mode Mode) *Writer {
	return &Writer{Mode: mode, Out: os.Stdout, Err: os.Stderr}
}

// Data emits the payload of a command. In JSON mode it is the only thing on stdout.
func (w *Writer) Data(v any) error {
	if !w.Mode.JSON {
		return nil
	}
	enc := json.NewEncoder(w.Out)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

// Human writes human-readable payload to stdout. Suppressed in JSON mode so that
// Data stays the sole stdout producer.
func (w *Writer) Human(format string, args ...any) {
	if w.Mode.JSON {
		return
	}
	fmt.Fprintf(w.Out, format+"\n", args...)
}

// Status writes progress and headings to stderr. Suppressed in JSON mode.
func (w *Writer) Status(format string, args ...any) {
	if w.Mode.JSON {
		return
	}
	fmt.Fprintf(w.Err, format+"\n", args...)
}

// Error reports a failure. stderr always gets the readable form; JSON mode
// additionally puts a machine-readable object on stdout so a script sees it.
func (w *Writer) Error(err error) {
	if err == nil {
		return
	}
	fmt.Fprintf(w.Err, "Error: %v\n", err)
	if w.Mode.JSON {
		enc := json.NewEncoder(w.Out)
		enc.SetIndent("", "  ")
		_ = enc.Encode(map[string]string{"error": err.Error()})
	}
}

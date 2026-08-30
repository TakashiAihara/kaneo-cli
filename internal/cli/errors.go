package cli

import (
	"os"

	"github.com/TakashiAihara/kaneo-cli/internal/output"
)

// ReportError prints a failure in whatever form the caller asked for.
//
// It lives in the CLI package rather than inside a command so that a failure
// during flag parsing — before any App has been built — is still reported.
// In that case the mode is recovered from the raw arguments: a script running
// with --json has to be able to parse the error too, and cannot if the one
// path that skips the writer prints prose.
func ReportError(app *App, args []string, err error) {
	if err == nil {
		return
	}
	w := app.writer()
	if w == nil {
		w = output.New(output.ResolveMode(
			hasFlag(args, "--json"),
			hasFlag(args, "--human"),
			output.IsTTY(os.Stdout),
			os.Getenv("NO_COLOR") != "",
		))
	}
	w.Error(err)
}

// writer returns the App's output writer, or nil when it was never built.
func (a *App) writer() *output.Writer {
	if a == nil {
		return nil
	}
	return a.Out
}

func hasFlag(args []string, name string) bool {
	for _, a := range args {
		if a == name {
			return true
		}
		if a == "--" {
			return false
		}
	}
	return false
}

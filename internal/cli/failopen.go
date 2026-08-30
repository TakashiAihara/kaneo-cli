package cli

import (
	"errors"
	"fmt"

	"github.com/spf13/cobra"
)

// hardError marks a failure that must be reported even by a fail-open command.
//
// Fail-open exists so an unreachable server cannot break a session. It is not
// a licence to hide a failure that leaves things inconsistent — a comment
// written to the server with no local record of it, for instance.
type hardError struct{ err error }

func (e hardError) Error() string { return e.err.Error() }
func (e hardError) Unwrap() error { return e.err }

// hard wraps an error so fail-open will not swallow it.
func hard(format string, args ...any) error {
	return hardError{err: fmt.Errorf(format, args...)}
}

// failOpen wraps a command so that a failure produces no output and exit 0.
//
// board and the session commands run from a session-start hook, where a
// missing board is a smaller harm than a broken session. Every other command
// reports failures normally: hiding an error from someone typing at a prompt
// would be the larger harm.
//
// --strict turns this off, and KANEO_DEBUG=1 prints the swallowed reason.
func failOpen(app *App, strict *bool, run func(*cobra.Command, []string) error) func(*cobra.Command, []string) error {
	return func(cmd *cobra.Command, args []string) error {
		err := run(cmd, args)
		if err == nil {
			return nil
		}
		if *strict {
			return err
		}
		// A failure that already changed something elsewhere has to surface:
		// staying quiet would leave the caller believing a half-done operation
		// succeeded.
		var hardErr hardError
		if errors.As(err, &hardErr) {
			return err
		}
		debugf("%v", err)
		return nil
	}
}

// addStrictFlag registers --strict on a fail-open command.
func addStrictFlag(cmd *cobra.Command, strict *bool) {
	cmd.Flags().BoolVar(strict, "strict", false,
		"report failures instead of exiting quietly; this command is otherwise silent on error so it is safe to call from a hook")
}

package cli

import "github.com/spf13/cobra"

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
		debugf("%v", err)
		return nil
	}
}

// addStrictFlag registers --strict on a fail-open command.
func addStrictFlag(cmd *cobra.Command, strict *bool) {
	cmd.Flags().BoolVar(strict, "strict", false,
		"report failures instead of exiting quietly; this command is otherwise silent on error so it is safe to call from a hook")
}

package cli

import (
	"fmt"

	"github.com/TakashiAihara/kaneo-cli/internal/api"
	"github.com/spf13/cobra"
)

// newAPICheckCommand compares what this client calls against what the server
// offers.
//
// It exits non-zero when an operation this client uses is missing from the
// server, so it can gate a release. Reporting a mismatch and exiting 0 would
// make the check unusable in CI, which is the whole reason to have it.
func newAPICheckCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "api-check",
		Short: "Check this client's operations against the server's OpenAPI document",
		Long: "Check this client's operations against the server's OpenAPI document.\n\n" +
			"Exits non-zero when the server is missing an operation this client calls.\n" +
			"The document needs no authentication, so this works before a key is set.",
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, args []string) error {
			client := api.New(app.Cfg.APIURL, app.Cfg.APIKey, app.Timeout)
			ctx, cancel := app.Context()
			defer cancel()

			result, err := client.Check(ctx)
			if err != nil {
				return err
			}

			for _, op := range result.Covered {
				app.Out.Human("ok      %-22s %s", op.ID, op.Command)
			}
			for _, op := range result.Missing {
				app.Out.Human("MISSING %-22s %s", op.ID, op.Command)
			}
			if len(result.NewOnServer) > 0 {
				app.Out.Human("")
				app.Out.Human("%d server operations this client does not use yet", len(result.NewOnServer))
			}
			app.Out.Human("")
			app.Out.Human("%d of %d client operations present; server offers %d",
				len(result.Covered), result.ClientOperations, result.ServerOperations)

			if err := app.Out.Data(result); err != nil {
				return err
			}
			if !result.OK() {
				return fmt.Errorf("%d operation(s) this client calls are missing from the server", len(result.Missing))
			}
			return nil
		},
	}
}

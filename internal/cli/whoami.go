package cli

import (
	"github.com/TakashiAihara/kaneo-cli/internal/api"
	"github.com/spf13/cobra"
)

type whoamiReport struct {
	APIURL     string          `json:"api_url"`
	Workspaces []api.Workspace `json:"workspaces"`
}

// newWhoamiCommand verifies the credential.
//
// It lists workspaces rather than calling /auth/get-session: that endpoint
// answers 200 with null for a valid key, an invalid key and no key at all, so
// it cannot tell them apart. Listing workspaces fails with 401 on a bad key,
// which is what makes this check worth running.
func newWhoamiCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "whoami",
		Short: "Verify the configured API key and show what it can reach",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.Client()
			if err != nil {
				return err
			}
			ctx, cancel := app.Context()
			defer cancel()

			workspaces, err := client.ListWorkspaces(ctx)
			if err != nil {
				return err
			}

			app.Out.Human("api url    %s", client.BaseURL)
			app.Out.Human("api key    accepted")
			app.Out.Human("workspaces %d", len(workspaces))
			for _, w := range workspaces {
				app.Out.Human("  %s  %s", w.ID, w.Name)
			}
			return app.Out.Data(whoamiReport{APIURL: client.BaseURL, Workspaces: workspaces})
		},
	}
}

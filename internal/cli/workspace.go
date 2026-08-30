package cli

import "github.com/spf13/cobra"

func newWorkspaceCommand(app *App) *cobra.Command {
	cmd := &cobra.Command{
		Use:     "workspace",
		Aliases: []string{"ws"},
		Short:   "Work with workspaces",
	}
	cmd.AddCommand(&cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List workspaces the key can reach",
		Args:    cobra.NoArgs,
		RunE: func(c *cobra.Command, args []string) error {
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
			for _, w := range workspaces {
				app.Out.Human("%s  %s", w.ID, w.Name)
			}
			return app.Out.Data(workspaces)
		},
	})
	return cmd
}

package cli

import (
	"strings"

	"github.com/spf13/cobra"
)

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
	cmd.AddCommand(&cobra.Command{
		Use:   "rename <name>",
		Short: "Rename the workspace (-w / KANEO_WORKSPACE); the slug is kept",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			client, err := app.Client()
			if err != nil {
				return err
			}
			workspace, err := app.Workspace()
			if err != nil {
				return err
			}
			ctx, cancel := app.Context()
			defer cancel()

			w, err := client.RenameWorkspace(ctx, workspace, strings.Join(args, " "))
			if err != nil {
				return err
			}
			app.Out.Human("renamed %s  %s", w.ID, w.Name)
			return app.Out.Data(w)
		},
	})
	return cmd
}

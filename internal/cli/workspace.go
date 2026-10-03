package cli

import (
	"fmt"
	"strings"

	"github.com/TakashiAihara/kaneo-cli/internal/api"
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
	// The id is a required argument rather than resolved like -w: resolution
	// falls back to .kaneo.json and the owners map, so a rename typed inside a
	// checkout would quietly hit whichever workspace that repo maps to.
	cmd.AddCommand(&cobra.Command{
		Use:   "rename <workspace-id> <name>",
		Short: "Rename a workspace; the slug is kept",
		Args:  cobra.MinimumNArgs(2),
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
			var before *api.Workspace
			for i := range workspaces {
				if workspaces[i].ID == args[0] {
					before = &workspaces[i]
				}
			}
			if before == nil {
				return fmt.Errorf("workspace %q is not one this key can reach (see kaneo workspace ls)", args[0])
			}

			w, err := client.RenameWorkspace(ctx, before.ID, strings.Join(args[1:], " "))
			if err != nil {
				return err
			}
			app.Out.Human("renamed %s  %s -> %s", w.ID, before.Name, w.Name)
			return app.Out.Data(map[string]any{"id": w.ID, "slug": w.Slug, "from": before.Name, "to": w.Name})
		},
	})
	return cmd
}

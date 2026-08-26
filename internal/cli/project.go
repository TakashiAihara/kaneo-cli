package cli

import "github.com/spf13/cobra"

func newProjectCommand(app *App) *cobra.Command {
	cmd := &cobra.Command{
		Use:     "project",
		Aliases: []string{"proj"},
		Short:   "Work with projects",
	}

	cmd.AddCommand(&cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List the projects in a workspace",
		Args:    cobra.NoArgs,
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

			projects, err := client.ListProjects(ctx, workspace)
			if err != nil {
				return err
			}
			for _, p := range projects {
				app.Out.Human("%s  %s", p.ID, p.Name)
			}
			return app.Out.Data(projects)
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use:   "get [project-id]",
		Short: "Show one project",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			client, err := app.Client()
			if err != nil {
				return err
			}
			id := ""
			if len(args) == 1 {
				id = args[0]
			} else if id, err = app.Project(); err != nil {
				return err
			}
			ctx, cancel := app.Context()
			defer cancel()

			p, err := client.GetProject(ctx, id)
			if err != nil {
				return err
			}
			app.Out.Human("%s  %s", p.ID, p.Name)
			if p.Description != "" {
				app.Out.Human("%s", p.Description)
			}
			return app.Out.Data(p)
		},
	})

	return cmd
}

package cli

import (
	"fmt"
	"strings"

	"github.com/TakashiAihara/kaneo-cli/internal/api"
	"github.com/spf13/cobra"
)

func newProjectCommand(app *App) *cobra.Command {
	cmd := &cobra.Command{
		Use:     "project",
		Aliases: []string{"proj"},
		Short:   "Work with projects",
	}

	var listArchived bool
	list := &cobra.Command{
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

			projects, err := client.ListProjects(ctx, workspace, listArchived)
			if err != nil {
				return err
			}
			for _, p := range projects {
				if p.Archived() {
					app.Out.Human("%s  %s  (archived)", p.ID, p.Name)
					continue
				}
				app.Out.Human("%s  %s", p.ID, p.Name)
			}
			return app.Out.Data(projects)
		},
	}
	list.Flags().BoolVar(&listArchived, "archived", false,
		"include archived projects, so one can be found again to unarchive")
	cmd.AddCommand(list)

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

	cmd.AddCommand(newProjectCreateCommand(app), newProjectUpdateCommand(app))
	cmd.AddCommand(newProjectArchiveCommand(app, true), newProjectArchiveCommand(app, false))

	return cmd
}

func newProjectCreateCommand(app *App) *cobra.Command {
	var icon, slug, description string

	cmd := &cobra.Command{
		Use:   "create <name>",
		Short: "Create a project in a workspace",
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

			project, err := client.CreateProject(ctx, api.NewProject{
				Name:        strings.Join(args, " "),
				WorkspaceID: workspace,
				Icon:        icon,
				Slug:        slug,
				Description: description,
			})
			if err != nil {
				return err
			}
			app.Out.Human("created %s  %s", project.ID, project.Name)
			return app.Out.Data(project)
		},
	}

	f := cmd.Flags()
	f.StringVar(&icon, "icon", "", "icon name (default Layers)")
	f.StringVar(&slug, "slug", "", "url slug")
	f.StringVarP(&description, "description", "d", "", "project description")
	return cmd
}

// newProjectUpdateCommand changes a project in place, so a project can be
// renamed without archive + create, which would lose its tasks and comments.
//
// The id is required rather than resolved like `project get`: resolution falls
// back to .kaneo.json and the repos map, so an update typed inside a checkout
// would quietly hit whichever project that repo maps to.
func newProjectUpdateCommand(app *App) *cobra.Command {
	var name, slug, description, icon string

	cmd := &cobra.Command{
		Use:   "update <project-id>",
		Short: "Change a project's name, slug, description or icon; the rest is kept",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			// Built per run: a ProjectChanges held by the command would keep a
			// field set on one run into the next.
			var ch api.ProjectChanges
			f := c.Flags()
			if f.Changed("name") {
				ch.Name = &name
			}
			if f.Changed("slug") {
				ch.Slug = &slug
			}
			if f.Changed("description") {
				ch.Description = &description
			}
			if f.Changed("icon") {
				ch.Icon = &icon
			}
			if ch == (api.ProjectChanges{}) {
				return fmt.Errorf("nothing to change: pass --name, --slug, --description or --icon")
			}

			client, err := app.Client()
			if err != nil {
				return err
			}
			ctx, cancel := app.Context()
			defer cancel()

			before, p, err := client.UpdateProject(ctx, args[0], ch)
			if err != nil {
				return err
			}
			app.Out.Human("updated %s", p.ID)
			for _, f := range [][3]string{
				{"name", before.Name, p.Name}, {"slug", before.Slug, p.Slug},
				{"description", before.Description, p.Description}, {"icon", before.Icon, p.Icon},
			} {
				if f[1] != f[2] {
					app.Out.Human("  %s  %q -> %q", f[0], f[1], f[2])
				}
			}
			if before.Slug != p.Slug {
				app.Out.Human("  task identifiers now start with %s", p.Slug)
			}
			return app.Out.Data(map[string]any{"from": before, "to": p})
		},
	}

	f := cmd.Flags()
	f.StringVar(&name, "name", "", "new name")
	f.StringVar(&slug, "slug", "", "new url slug (the prefix of task identifiers)")
	f.StringVarP(&description, "description", "d", "", "new description; empty clears it")
	f.StringVar(&icon, "icon", "", "new icon name")
	return cmd
}

// newProjectArchiveCommand builds `project archive` and its inverse.
//
// Archiving is how a finished project leaves the board. Dropping it from the
// repo map would do that too, but it would also lose the record that the
// repository ever had that work, so the board filters on the server's own
// archived flag instead and the mapping stays put. Nothing is deleted, and
// unarchive puts it back.
func newProjectArchiveCommand(app *App, archive bool) *cobra.Command {
	verb, past := "archive", "archived"
	if !archive {
		verb, past = "unarchive", "unarchived"
	}
	return &cobra.Command{
		Use:   verb + " [project-id]",
		Short: strings.ToUpper(verb[:1]) + verb[1:] + " a project",
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

			if err := client.SetProjectArchived(ctx, id, archive); err != nil {
				return err
			}
			app.Out.Human("%s %s", past, id)
			return app.Out.Data(map[string]any{"project": id, "archived": archive})
		},
	}
}

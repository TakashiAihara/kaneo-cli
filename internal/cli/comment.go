package cli

import (
	"strings"

	"github.com/spf13/cobra"
)

func newCommentCommand(app *App) *cobra.Command {
	cmd := &cobra.Command{
		Use:     "comment",
		Aliases: []string{"cmt"},
		Short:   "Work with task comments",
	}

	cmd.AddCommand(&cobra.Command{
		Use:     "list <task>",
		Aliases: []string{"ls"},
		Short:   "List a task's comments",
		Args:    cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			client, err := app.Client()
			if err != nil {
				return err
			}
			project, _ := app.Project()
			ctx, cancel := app.Context()
			defer cancel()

			task, err := resolveTask(ctx, client, project, args[0])
			if err != nil {
				return err
			}
			comments, err := client.ListComments(ctx, task.ID)
			if err != nil {
				return err
			}
			for _, cm := range comments {
				app.Out.Human("%s  %s", cm.CreatedAt, strings.ReplaceAll(cm.Content, "\n", "\n  "))
			}
			return app.Out.Data(comments)
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use:   "add <task> <text...>",
		Short: "Add a comment to a task",
		Args:  cobra.MinimumNArgs(2),
		RunE: func(c *cobra.Command, args []string) error {
			client, err := app.Client()
			if err != nil {
				return err
			}
			project, _ := app.Project()
			ctx, cancel := app.Context()
			defer cancel()

			task, err := resolveTask(ctx, client, project, args[0])
			if err != nil {
				return err
			}
			cm, err := client.AddComment(ctx, task.ID, strings.Join(args[1:], " "))
			if err != nil {
				return err
			}
			app.Out.Human("commented on #%d", task.Number)
			return app.Out.Data(cm)
		},
	})

	return cmd
}

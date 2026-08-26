package cli

import (
	"fmt"
	"strings"

	"github.com/TakashiAihara/kaneo-cli/internal/api"
	"github.com/spf13/cobra"
)

func newTaskCommand(app *App) *cobra.Command {
	cmd := &cobra.Command{
		Use:     "task",
		Aliases: []string{"t"},
		Short:   "Work with tasks",
	}
	cmd.AddCommand(newTaskListCommand(app), newTaskGetCommand(app), newTaskStatusCommand(app))
	return cmd
}

func newTaskListCommand(app *App) *cobra.Command {
	var status, priority string
	var includeDone bool

	cmd := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List the tasks in a project",
		Args:    cobra.NoArgs,
		RunE: func(c *cobra.Command, args []string) error {
			client, err := app.Client()
			if err != nil {
				return err
			}
			project, err := app.Project()
			if err != nil {
				return err
			}
			ctx, cancel := app.Context()
			defer cancel()

			board, err := client.GetBoard(ctx, project)
			if err != nil {
				return err
			}

			tasks := filterTasks(board.Tasks(), status, priority, includeDone)
			for _, t := range tasks {
				app.Out.Human("%s", formatTaskLine(t))
			}
			return app.Out.Data(tasks)
		},
	}

	f := cmd.Flags()
	f.StringVar(&status, "status", "", "only tasks in this column")
	f.StringVar(&priority, "priority", "", "only tasks with this priority")
	// Done tasks accumulate without bound, so the listing hides them unless
	// asked. --status done still shows them, since that is an explicit request.
	f.BoolVar(&includeDone, "all", false, "include tasks in the done column")
	return cmd
}

func filterTasks(tasks []api.Task, status, priority string, includeDone bool) []api.Task {
	out := make([]api.Task, 0, len(tasks))
	for _, t := range tasks {
		if status != "" && t.Status != status {
			continue
		}
		if priority != "" && t.Priority != priority {
			continue
		}
		if !includeDone && status == "" && t.Status == "done" {
			continue
		}
		out = append(out, t)
	}
	return out
}

func formatTaskLine(t api.Task) string {
	return fmt.Sprintf("#%-4d [%-11s] %-13s %s", t.Number, t.Priority, t.Status, t.Title)
}

func newTaskGetCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "get <task-id>",
		Short: "Show one task",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			client, err := app.Client()
			if err != nil {
				return err
			}
			ctx, cancel := app.Context()
			defer cancel()

			t, err := client.GetTask(ctx, args[0])
			if err != nil {
				return err
			}
			app.Out.Human("#%d  %s", t.Number, t.Title)
			app.Out.Human("status    %s", t.Status)
			app.Out.Human("priority  %s", t.Priority)
			if t.Description != "" {
				app.Out.Human("")
				app.Out.Human("%s", t.Description)
			}
			return app.Out.Data(t)
		},
	}
}

func newTaskStatusCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "status <task-id> <status>",
		Short: "Move a task to another column",
		Long: "Move a task to another column.\n\n" +
			"A status is a column id. `kaneo project get` lists the columns a project has;\n" +
			"the defaults are to-do, in-progress, in-review and done.",
		Args: cobra.ExactArgs(2),
		RunE: func(c *cobra.Command, args []string) error {
			client, err := app.Client()
			if err != nil {
				return err
			}
			ctx, cancel := app.Context()
			defer cancel()

			taskID, status := args[0], strings.TrimSpace(args[1])
			if err := client.SetTaskStatus(ctx, taskID, status); err != nil {
				return err
			}
			app.Out.Human("%s -> %s", taskID, status)
			return app.Out.Data(map[string]string{"id": taskID, "status": status})
		},
	}
}

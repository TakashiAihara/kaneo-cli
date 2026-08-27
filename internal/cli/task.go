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
	cmd.AddCommand(
		newTaskListCommand(app),
		newTaskGetCommand(app),
		newTaskCreateCommand(app),
		newTaskStatusCommand(app),
		newTaskPriorityCommand(app),
		newTaskAssignCommand(app),
		newTaskMoveCommand(app),
		newTaskRemoveCommand(app),
		newTaskLinkCommand(app),
		newTaskLinksCommand(app),
	)
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
		Use:   "get <task>",
		Short: "Show one task",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			client, err := app.Client()
			if err != nil {
				return err
			}
			project, _ := app.Project()
			ctx, cancel := app.Context()
			defer cancel()

			t, err := resolveTask(ctx, client, project, args[0])
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
		Use:   "status <task> <status>",
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
			project, _ := app.Project()
			ctx, cancel := app.Context()
			defer cancel()

			task, err := resolveTask(ctx, client, project, args[0])
			if err != nil {
				return err
			}
			status := strings.TrimSpace(args[1])
			if err := client.SetTaskStatus(ctx, task.ID, status); err != nil {
				return err
			}
			app.Out.Human("#%d -> %s", task.Number, status)
			return app.Out.Data(map[string]any{"id": task.ID, "number": task.Number, "status": status})
		},
	}
}

func newTaskCreateCommand(app *App) *cobra.Command {
	var description, priority, status, dueDate, assignee string

	cmd := &cobra.Command{
		Use:   "create <title>",
		Short: "Create a task in a project",
		Args:  cobra.MinimumNArgs(1),
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

			task, err := client.CreateTask(ctx, project, api.NewTask{
				Title:       strings.Join(args, " "),
				Description: description,
				Priority:    priority,
				Status:      status,
				DueDate:     dueDate,
				AssigneeID:  assignee,
			})
			if err != nil {
				return err
			}
			app.Out.Human("created #%d %s", task.Number, task.Title)
			return app.Out.Data(task)
		},
	}

	f := cmd.Flags()
	f.StringVarP(&description, "description", "d", "", "task description")
	f.StringVar(&priority, "priority", "", "urgent, high, medium, low or no-priority (default medium)")
	f.StringVar(&status, "status", "", "column id to create the task in (default to-do)")
	f.StringVar(&dueDate, "due-date", "", "due date")
	f.StringVar(&assignee, "assignee", "", "user id to assign")
	return cmd
}

func newTaskPriorityCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "priority <task> <priority>",
		Short: "Change a task's priority",
		Long:  "Change a task's priority.\n\nOne of: " + strings.Join(api.Priorities, ", ") + ".",
		Args:  cobra.ExactArgs(2),
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
			priority := strings.TrimSpace(args[1])
			if api.PriorityRank(priority) == len(api.Priorities) {
				return fmt.Errorf("unknown priority %q; use one of: %s", priority, strings.Join(api.Priorities, ", "))
			}
			if err := client.SetTaskPriority(ctx, task.ID, priority); err != nil {
				return err
			}
			app.Out.Human("#%d priority %s", task.Number, priority)
			return app.Out.Data(map[string]any{"id": task.ID, "number": task.Number, "priority": priority})
		},
	}
}

func newTaskAssignCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "assign <task> [user-id]",
		Short: "Assign a task, or clear the assignee when no user is given",
		Args:  cobra.RangeArgs(1, 2),
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
			var user string
			if len(args) == 2 {
				user = args[1]
			}
			if err := client.SetTaskAssignee(ctx, task.ID, user); err != nil {
				return err
			}
			if user == "" {
				app.Out.Human("#%d unassigned", task.Number)
			} else {
				app.Out.Human("#%d assigned to %s", task.Number, user)
			}
			return app.Out.Data(map[string]any{"id": task.ID, "number": task.Number, "assigneeId": user})
		},
	}
}

func newTaskMoveCommand(app *App) *cobra.Command {
	var target string

	cmd := &cobra.Command{
		Use:   "move <task> --to <project-id>",
		Short: "Move a task to another project",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if target == "" {
				return fmt.Errorf("no destination: pass --to <project-id>")
			}
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
			if err := client.MoveTask(ctx, task.ID, target); err != nil {
				return err
			}
			app.Out.Human("#%d moved to %s", task.Number, target)
			return app.Out.Data(map[string]any{"id": task.ID, "projectId": target})
		},
	}
	cmd.Flags().StringVar(&target, "to", "", "destination project id")
	return cmd
}

func newTaskRemoveCommand(app *App) *cobra.Command {
	var yes bool

	cmd := &cobra.Command{
		Use:     "rm <task>",
		Aliases: []string{"delete"},
		Short:   "Delete a task",
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
			// Deleting a task takes its comments with it, and the session
			// history lives in those. Requiring the flag keeps that from
			// happening by a slip of the hand.
			if !yes {
				return fmt.Errorf("refusing to delete #%d %q without --yes; this also removes its comments, where session history is kept",
					task.Number, task.Title)
			}
			if err := client.DeleteTask(ctx, task.ID); err != nil {
				return err
			}
			app.Out.Human("deleted #%d %s", task.Number, task.Title)
			return app.Out.Data(map[string]any{"id": task.ID, "number": task.Number})
		},
	}
	cmd.Flags().BoolVar(&yes, "yes", false, "confirm the deletion")
	return cmd
}

func newTaskLinkCommand(app *App) *cobra.Command {
	var relationType string

	cmd := &cobra.Command{
		Use:   "link <parent> <child>",
		Short: "Relate two tasks",
		Long: "Relate two tasks.\n\n" +
			"For a subtask link the first task is the parent. Types: " +
			strings.Join(api.RelationTypes, ", ") + ".",
		Args: cobra.ExactArgs(2),
		RunE: func(c *cobra.Command, args []string) error {
			client, err := app.Client()
			if err != nil {
				return err
			}
			if !validRelation(relationType) {
				return fmt.Errorf("unknown relation type %q; use one of: %s",
					relationType, strings.Join(api.RelationTypes, ", "))
			}
			project, _ := app.Project()
			ctx, cancel := app.Context()
			defer cancel()

			parent, err := resolveTask(ctx, client, project, args[0])
			if err != nil {
				return err
			}
			child, err := resolveTask(ctx, client, project, args[1])
			if err != nil {
				return err
			}
			rel, err := client.LinkTasks(ctx, parent.ID, child.ID, relationType)
			if err != nil {
				return err
			}
			app.Out.Human("#%d %s #%d", parent.Number, relationType, child.Number)
			return app.Out.Data(rel)
		},
	}
	cmd.Flags().StringVar(&relationType, "type", "subtask",
		"relation type: "+strings.Join(api.RelationTypes, ", "))
	return cmd
}

func validRelation(t string) bool {
	for _, known := range api.RelationTypes {
		if t == known {
			return true
		}
	}
	return false
}

func newTaskLinksCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "links <task>",
		Short: "List a task's relations",
		Args:  cobra.ExactArgs(1),
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
			relations, err := client.ListRelations(ctx, task.ID)
			if err != nil {
				return err
			}
			for _, r := range relations {
				app.Out.Human("%s  %s -> %s", r.RelationType, r.SourceTaskID, r.TargetTaskID)
			}
			return app.Out.Data(relations)
		},
	}
}

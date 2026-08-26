package cli

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/TakashiAihara/kaneo-cli/internal/api"
	"github.com/TakashiAihara/kaneo-cli/internal/session"
	"github.com/spf13/cobra"
)

func newSessionCommand(app *App) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "session",
		Short: "Tie the current agent session to a task",
		Long: "Tie the current agent session to a task.\n\n" +
			"Tasks have no custom fields, so the association is written as a marker in a\n" +
			"task comment. The session is identified by KANEO_SESSION_ID, falling back to\n" +
			"CLAUDE_CODE_SESSION_ID.",
	}
	cmd.AddCommand(newSessionAttachCommand(app), newSessionNextCommand(app), newSessionCloseCommand(app))
	return cmd
}

func sessionStore() *session.Store {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return session.DefaultStore(home, os.Getenv)
}

func requireSessionID() (string, error) {
	id := session.CurrentID(os.Getenv)
	if id == "" {
		return "", fmt.Errorf("no session id: set KANEO_SESSION_ID")
	}
	return id, nil
}

func newSessionAttachCommand(app *App) *cobra.Command {
	var strict bool

	cmd := &cobra.Command{
		Use:   "attach <task> [next step...]",
		Short: "Record that this session is working on a task",
		Args:  cobra.MinimumNArgs(1),
	}
	cmd.RunE = failOpen(app, &strict, func(c *cobra.Command, args []string) error {
		sessionID, err := requireSessionID()
		if err != nil {
			return err
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

		marker := session.Describe(os.Getenv, cwd(), session.StateRunning)
		marker.NextStep = strings.Join(args[1:], " ")
		if _, err := client.AddComment(ctx, task.ID, marker.Format()); err != nil {
			return err
		}
		if err := sessionStore().Save(sessionID, session.Attachment{
			TaskID: task.ID, TaskNumber: task.Number, Title: task.Title,
		}); err != nil {
			return err
		}

		app.Out.Human("attached: #%d %s", task.Number, task.Title)
		return app.Out.Data(map[string]any{"taskId": task.ID, "number": task.Number, "title": task.Title})
	})

	addStrictFlag(cmd, &strict)
	return cmd
}

func newSessionNextCommand(app *App) *cobra.Command {
	var strict bool

	cmd := &cobra.Command{
		Use:   "next [task] <next step...>",
		Short: "Record what this session will do next",
		Long: "Record what this session will do next.\n\n" +
			"With no task, the one this session attached to is used.",
		Args: cobra.MinimumNArgs(1),
	}
	cmd.RunE = failOpen(app, &strict, func(c *cobra.Command, args []string) error {
		client, err := app.Client()
		if err != nil {
			return err
		}
		project, _ := app.Project()

		ctx, cancel := app.Context()
		defer cancel()

		taskID, number, err := targetTask(ctx, client, project, args)
		if err != nil {
			return err
		}
		step := strings.Join(argsAfterTask(args), " ")
		if strings.TrimSpace(step) == "" {
			return fmt.Errorf("no next step given")
		}

		marker := session.Describe(os.Getenv, cwd(), session.StateRunning)
		marker.NextStep = step
		if _, err := client.AddComment(ctx, taskID, marker.Format()); err != nil {
			return err
		}

		app.Out.Human("#%d next: %s", number, step)
		return app.Out.Data(map[string]any{"taskId": taskID, "number": number, "nextStep": step})
	})

	addStrictFlag(cmd, &strict)
	return cmd
}

// looksLikeTaskRef reports whether the first argument names a task rather than
// being the first word of the next step.
func looksLikeTaskRef(s string) bool {
	if strings.HasPrefix(s, "#") {
		return true
	}
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func argsAfterTask(args []string) []string {
	if len(args) > 1 && looksLikeTaskRef(args[0]) {
		return args[1:]
	}
	return args
}

// targetTask picks the task a command acts on: the one named in the arguments,
// otherwise the one this session attached to.
func targetTask(ctx context.Context, client *api.Client, project string, args []string) (string, int, error) {
	if len(args) > 0 && looksLikeTaskRef(args[0]) {
		task, err := resolveTask(ctx, client, project, args[0])
		if err != nil {
			return "", 0, err
		}
		return task.ID, task.Number, nil
	}
	sessionID, err := requireSessionID()
	if err != nil {
		return "", 0, err
	}
	attached, ok := sessionStore().Load(sessionID)
	if !ok {
		return "", 0, fmt.Errorf("this session is not attached to a task; name one, or run 'kaneo session attach' first")
	}
	return attached.TaskID, attached.TaskNumber, nil
}

func newSessionCloseCommand(app *App) *cobra.Command {
	var strict bool

	cmd := &cobra.Command{
		Use:   "close",
		Short: "Mark this session's task as no longer held",
		Args:  cobra.NoArgs,
	}
	cmd.RunE = failOpen(app, &strict, func(c *cobra.Command, args []string) error {
		sessionID, err := requireSessionID()
		if err != nil {
			return err
		}
		attached, ok := sessionStore().Load(sessionID)
		if !ok {
			return fmt.Errorf("this session is not attached to a task")
		}
		client, err := app.Client()
		if err != nil {
			return err
		}
		ctx, cancel := app.Context()
		defer cancel()

		marker := session.Describe(os.Getenv, cwd(), session.StateClosed)
		marker.NextStep = fmt.Sprintf("Session ended. Resume with `claude --resume %s`.", sessionID)
		if _, err := client.AddComment(ctx, attached.TaskID, marker.Format()); err != nil {
			return err
		}
		sessionStore().Clear(sessionID)

		app.Out.Human("closed: #%d %s", attached.TaskNumber, attached.Title)
		return app.Out.Data(map[string]any{"taskId": attached.TaskID, "number": attached.TaskNumber})
	})

	addStrictFlag(cmd, &strict)
	return cmd
}

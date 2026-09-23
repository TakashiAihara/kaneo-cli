package cli

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

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

		// Looked up before the marker is posted, so the lookups do not widen
		// the window where the server has a marker and this host has no record.
		attachment := session.Attachment{TaskID: task.ID, TaskNumber: task.Number, Title: task.Title}
		describeBoard(ctx, client, task, &attachment)

		marker := session.Describe(os.Getenv, cwd(), session.StateRunning)
		marker.NextStep = strings.Join(args[1:], " ")
		if _, err := client.AddComment(ctx, task.ID, marker.Format()); err != nil {
			return err
		}
		if err := sessionStore().Save(sessionID, attachment); err != nil {
			// The marker is already on the server. Reporting success here
			// would leave `session next` believing nothing is attached, and a
			// retry would post a second marker.
			return hard("attached #%d on the server, but could not record it locally: %w", task.Number, err)
		}

		app.Out.Human("attached: #%d %s", task.Number, task.Title)
		return app.Out.Data(attachment)
	})

	addStrictFlag(cmd, &strict)
	return cmd
}

func newSessionNextCommand(app *App) *cobra.Command {
	var strict bool

	var taskRef string

	cmd := &cobra.Command{
		Use:   "next <next step...> [--task <task>]",
		Short: "Record what this session will do next",
		Long: "Record what this session will do next.\n\n" +
			"Without --task, the task this session attached to is used. The task is\n" +
			"named by a flag rather than a leading argument so that a next step which\n" +
			"happens to start with a number is not mistaken for one.",
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

		taskID, number, err := targetTask(ctx, client, project, taskRef)
		if err != nil {
			return err
		}
		step := strings.TrimSpace(strings.Join(args, " "))
		if step == "" {
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

	cmd.Flags().StringVar(&taskRef, "task", "", "task to record against, by number or id; defaults to the attached one")
	addStrictFlag(cmd, &strict)
	return cmd
}

// describeBoard fills in which project and workspace the task is on.
//
// Best effort: failing the attach over a name a statusline wants would leave
// the session unattached. A lookup that fails leaves its fields empty, which a
// reader treats as absent.
func describeBoard(ctx context.Context, client *api.Client, task *api.Task, a *session.Attachment) {
	// The marker post that follows shares this deadline. Slow lookups may
	// spend only half of what is left, so they cannot starve it.
	if deadline, ok := ctx.Deadline(); ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Until(deadline)/2)
		defer cancel()
	}

	// Never filled from the cwd's project: that is the wrong answer this
	// field exists to avoid, so an unknown project stays unknown.
	a.ProjectID = task.ProjectID
	if a.ProjectID == "" {
		debugf("attach: task %s carries no projectId; board not recorded", task.ID)
		return
	}
	p, err := client.GetProject(ctx, a.ProjectID)
	if err != nil {
		debugf("attach: project %s lookup failed: %v", a.ProjectID, err)
		return
	}
	a.ProjectName, a.WorkspaceID = p.Name, p.WorkspaceID
	if a.WorkspaceID == "" {
		return
	}
	workspaces, err := client.ListWorkspaces(ctx)
	if err != nil {
		debugf("attach: workspace lookup failed: %v", err)
		return
	}
	for _, w := range workspaces {
		if w.ID == p.WorkspaceID {
			a.WorkspaceName = w.Name
			break
		}
	}
}

// targetTask picks the task a command acts on: the one named explicitly,
// otherwise the one this session attached to.
func targetTask(ctx context.Context, client *api.Client, project, ref string) (string, int, error) {
	if strings.TrimSpace(ref) != "" {
		task, err := resolveTask(ctx, client, project, ref)
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

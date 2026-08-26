package cli

import (
	"context"
	"os"

	"github.com/TakashiAihara/kaneo-cli/internal/api"
	"github.com/TakashiAihara/kaneo-cli/internal/session"
	"github.com/spf13/cobra"
)

type boardSession struct {
	TaskNumber int    `json:"taskNumber"`
	TaskTitle  string `json:"taskTitle"`
	SessionID  string `json:"sessionId"`
	Host       string `json:"host"`
	Branch     string `json:"branch"`
	Cwd        string `json:"cwd"`
	NextStep   string `json:"nextStep,omitempty"`
}

type boardReport struct {
	Project   string         `json:"project"`
	Open      []api.Task     `json:"open"`
	DoneCount int            `json:"doneCount"`
	Sessions  []boardSession `json:"sessions"`
}

// newBoardCommand prints the open tasks and which sessions hold them.
//
// It is meant to be called from a session-start hook, so it is fail-open and
// prints nothing at all when no project is configured for this repository.
func newBoardCommand(app *App) *cobra.Command {
	var strict bool

	cmd := &cobra.Command{
		Use:   "board",
		Short: "Show open tasks and the sessions working on them",
		Args:  cobra.NoArgs,
	}
	cmd.RunE = failOpen(app, &strict, func(c *cobra.Command, args []string) error {
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

		var open []api.Task
		done := 0
		for _, t := range board.Tasks() {
			if t.Status == "done" {
				done++
				continue
			}
			open = append(open, t)
		}
		if len(open) == 0 && done == 0 {
			return nil
		}

		sessions := collectSessions(ctx, client, open)

		app.Out.Human("## %s (open %d / done %d)", board.ProjectName, len(open), done)
		for _, t := range open {
			app.Out.Human("- [%s] #%d %s (%s)", t.Priority, t.Number, t.Title, t.Status)
		}
		if len(sessions) > 0 {
			app.Out.Human("")
			app.Out.Human("### Sessions holding a task")
			for _, s := range sessions {
				app.Out.Human("- #%d %s — session %s @%s branch=%s", s.TaskNumber, s.TaskTitle, short(s.SessionID), s.Host, s.Branch)
				if s.NextStep != "" {
					app.Out.Human("  - next: %s", s.NextStep)
				}
			}
		}

		return app.Out.Data(boardReport{
			Project: board.ProjectName, Open: open, DoneCount: done, Sessions: sessions,
		})
	})

	addStrictFlag(cmd, &strict)
	return cmd
}

// collectSessions reads each open task's comments for session markers. A task
// whose comments cannot be read is skipped rather than failing the board: a
// partial board is more useful than none.
func collectSessions(ctx context.Context, client *api.Client, tasks []api.Task) []boardSession {
	var out []boardSession
	for _, t := range tasks {
		comments, err := client.ListComments(ctx, t.ID)
		if err != nil {
			debugf("comments for #%d: %v", t.Number, err)
			continue
		}
		var markers []session.Marker
		for _, c := range comments {
			if m, ok := session.Parse(c.Content, c.CreatedAt); ok {
				markers = append(markers, m)
			}
		}
		for _, m := range session.Running(session.LatestPerSession(markers)) {
			out = append(out, boardSession{
				TaskNumber: t.Number, TaskTitle: t.Title,
				SessionID: m.SessionID, Host: m.Host, Branch: m.Branch, Cwd: m.Cwd,
				NextStep: m.NextStep,
			})
		}
	}
	return out
}

func short(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func cwd() string {
	d, err := os.Getwd()
	if err != nil {
		return ""
	}
	return d
}

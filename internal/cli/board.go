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
//
// A repository mapped to several projects gets one section per project. board
// is the only command that takes more than one: it reads, so there is no
// question of which board a write lands on.
//
// Archived projects are left out. Projects are made per plan, so a repository
// accumulates finished ones, and the alternative — dropping them from the repo
// map — would lose the record that the repository ever had that work.
func newBoardCommand(app *App) *cobra.Command {
	var strict bool
	var includeArchived bool

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
		projects, err := app.Projects()
		if err != nil {
			return err
		}
		ctx, cancel := app.Context()
		defer cancel()

		reports := make([]boardReport, 0, len(projects))
		var firstErr error
		for _, project := range projects {
			// The board listing does not carry the archived flag, so the
			// project itself is read first. An archived project is not a
			// failure — it is finished work that has been put away, and
			// skipping it is the whole point of archiving it.
			if !includeArchived {
				p, err := client.GetProject(ctx, project)
				if err != nil {
					debugf("project %s: %v", project, err)
					if firstErr == nil {
						firstErr = err
					}
					continue
				}
				if p.Archived() {
					continue
				}
			}

			report, err := buildBoard(ctx, client, project)
			if err != nil {
				// One project that cannot be read should not cost the others
				// their board, for the same reason a task whose comments
				// cannot be read is skipped rather than failing the report.
				debugf("board for %s: %v", project, err)
				if firstErr == nil {
					firstErr = err
				}
				continue
			}
			reports = append(reports, report)
		}
		if len(reports) == 0 && firstErr != nil {
			return firstErr
		}

		printed := 0
		for _, report := range reports {
			// An empty board prints nothing, so the separator counts what was
			// actually written rather than what was fetched.
			if report.empty() {
				continue
			}
			if printed > 0 {
				app.Out.Human("")
			}
			printBoard(app, report)
			printed++
		}

		return app.Out.Data(reports)
	})

	cmd.Flags().BoolVar(&includeArchived, "archived", false,
		"include archived projects, which are left out by default")
	addStrictFlag(cmd, &strict)
	return cmd
}

// buildBoard fetches one project's board and splits it into what is open, what
// is done, and which sessions hold a task.
func buildBoard(ctx context.Context, client *api.Client, project string) (boardReport, error) {
	board, err := client.GetBoard(ctx, project)
	if err != nil {
		return boardReport{}, err
	}

	open := []api.Task{}
	done := 0
	for _, t := range board.Tasks() {
		if t.Status == "done" {
			done++
			continue
		}
		open = append(open, t)
	}

	// An empty board still owes a script its document, so it becomes a report
	// with nothing in it rather than no report at all. Producing nothing is
	// reserved for "no project is configured here", which is decided before
	// any of this runs.
	sessions := []boardSession{}
	if len(open) > 0 {
		sessions = collectSessions(ctx, client, open)
	}

	return boardReport{
		Project: board.ProjectName, Open: open, DoneCount: done, Sessions: sessions,
	}, nil
}

// empty reports a board with no tasks at all, open or done.
func (r boardReport) empty() bool { return len(r.Open) == 0 && r.DoneCount == 0 }

func printBoard(app *App, report boardReport) {
	app.Out.Human("## %s (open %d / done %d)", report.Project, len(report.Open), report.DoneCount)
	for _, t := range report.Open {
		app.Out.Human("- [%s] #%d %s (%s)", t.Priority, t.Number, t.Title, t.Status)
	}
	if len(report.Sessions) > 0 {
		app.Out.Human("")
		app.Out.Human("### Sessions holding a task")
		for _, s := range report.Sessions {
			app.Out.Human("- #%d %s — session %s @%s branch=%s", s.TaskNumber, s.TaskTitle, short(s.SessionID), s.Host, s.Branch)
			if s.NextStep != "" {
				app.Out.Human("  - next: %s", s.NextStep)
			}
		}
	}
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

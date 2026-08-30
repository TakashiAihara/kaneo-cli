package cli

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TakashiAihara/kaneo-cli/internal/config"
	"github.com/TakashiAihara/kaneo-cli/internal/output"
	"github.com/spf13/cobra"
)

const testBoard = `{"data":{"id":"proj1","name":"Board","columns":[
  {"id":"to-do","name":"To Do","tasks":[
    {"id":"real-task-id","number":7,"title":"seven","priority":"high","status":"to-do"}]}]}}`

// newTestApp builds an App aimed at a test server, with a project already
// resolved.
func newTestApp(t *testing.T, h http.HandlerFunc) *App {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)

	return &App{
		Cfg: config.Resolved{
			APIURL: srv.URL, APIKey: "k", ProjectID: "proj1",
			Origin: map[string]config.Source{},
		},
		Out:     &output.Writer{Mode: output.Mode{JSON: false}, Out: &strings.Builder{}, Err: &strings.Builder{}},
		Timeout: 5 * time.Second,
	}
}

func run(t *testing.T, cmd *cobra.Command, args ...string) error {
	t.Helper()
	cmd.SetArgs(args)
	cmd.SetOut(&strings.Builder{})
	cmd.SetErr(&strings.Builder{})
	return cmd.ExecuteContext(context.Background())
}

// A task number is what a person reads off the board, so every command taking
// a task must accept one. Sending the number straight through as an id makes
// the server answer 400 for a reason that names neither the task nor the
// number, which is how this went unnoticed once already.
func TestTaskCommandsResolveANumberToAnID(t *testing.T) {
	cases := []struct {
		name    string
		build   func(*App) *cobra.Command
		args    []string
		method  string
		wantURL string
	}{
		{
			name:    "status",
			build:   newTaskStatusCommand,
			args:    []string{"7", "done"},
			method:  http.MethodPut,
			wantURL: "/api/task/status/real-task-id",
		},
		{
			name:    "priority",
			build:   newTaskPriorityCommand,
			args:    []string{"7", "low"},
			method:  http.MethodPut,
			wantURL: "/api/task/priority/real-task-id",
		},
		{
			name:    "assign",
			build:   newTaskAssignCommand,
			args:    []string{"7", "user-1"},
			method:  http.MethodPut,
			wantURL: "/api/task/assignee/real-task-id",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotMethod, gotPath string
			app := newTestApp(t, func(w http.ResponseWriter, r *http.Request) {
				if strings.HasPrefix(r.URL.Path, "/api/task/tasks/") {
					_, _ = w.Write([]byte(testBoard))
					return
				}
				gotMethod, gotPath = r.Method, r.URL.Path
				w.WriteHeader(http.StatusOK)
			})

			if err := run(t, tc.build(app), tc.args...); err != nil {
				t.Fatal(err)
			}
			if gotMethod != tc.method || gotPath != tc.wantURL {
				t.Errorf("%s %s, want %s %s", gotMethod, gotPath, tc.method, tc.wantURL)
			}
		})
	}
}

// The same commands must still take a raw id, which needs no board lookup.
func TestTaskCommandsAcceptAnIDDirectly(t *testing.T) {
	var boardFetched bool
	var gotPath string
	app := newTestApp(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/task/tasks/") {
			boardFetched = true
			_, _ = w.Write([]byte(testBoard))
			return
		}
		if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/task/") {
			_, _ = w.Write([]byte(`{"id":"real-task-id","number":7,"title":"seven"}`))
			return
		}
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	})

	if err := run(t, newTaskStatusCommand(app), "real-task-id", "done"); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/task/status/real-task-id" {
		t.Errorf("path = %q", gotPath)
	}
	if boardFetched {
		t.Error("an explicit id should not need a board lookup")
	}
}

func TestTaskGetResolvesANumber(t *testing.T) {
	var getPath string
	app := newTestApp(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/task/tasks/") {
			_, _ = w.Write([]byte(testBoard))
			return
		}
		getPath = r.URL.Path
		_, _ = w.Write([]byte(`{"id":"real-task-id","number":7,"title":"seven"}`))
	})

	if err := run(t, newTaskGetCommand(app), "7"); err != nil {
		t.Fatal(err)
	}
	// A number is answered from the board, so no per-task GET is needed.
	if getPath != "" && getPath != "/api/task/real-task-id" {
		t.Errorf("fetched %q; a number must not be used as an id", getPath)
	}
	if strings.HasSuffix(getPath, "/7") {
		t.Errorf("fetched %q: the number was sent as an id", getPath)
	}
}

func TestUnknownTaskNumberIsReportedClearly(t *testing.T) {
	app := newTestApp(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(testBoard))
	})

	err := run(t, newTaskStatusCommand(app), "404", "done")
	if err == nil {
		t.Fatal("expected an error for a number that is not on the board")
	}
	if !strings.Contains(err.Error(), "404") {
		t.Errorf("error %q does not name the task that was asked for", err)
	}
}

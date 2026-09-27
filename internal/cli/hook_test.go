package cli

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TakashiAihara/kaneo-cli/internal/config"
)

func hookTestApp(t *testing.T, hooks map[string]string) *App {
	app := newTestApp(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "GET /api/task/task-2":
			w.Write([]byte(`{"id":"task-2","number":3,"title":"three","projectId":"proj2"}`))
		case "GET /api/project/proj2":
			w.Write([]byte(`{"id":"proj2","name":"Other Board","slug":"other","workspaceId":"ws2"}`))
		case "GET /api/auth/organization/list":
			w.Write([]byte(`[{"id":"ws2","name":"W"}]`))
		case "POST /api/comment/task-2":
			w.Write([]byte(`{"id":"c1"}`))
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	})
	app.Global = &config.Global{Hooks: hooks}
	return app
}

// attach and close each hand the hook the task, so a follower such as
// `ccx session task` can be set and cleared without knowing about kaneo.
func TestSessionHooksReceiveTheTask(t *testing.T) {
	config := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", config)
	t.Setenv("KANEO_SESSION_ID", "s1")
	got := filepath.Join(t.TempDir(), "got")

	cmd := `echo "$KANEO_HOOK_EVENT|$KANEO_SESSION_ID|$KANEO_TASK_ID|$KANEO_TASK_NUMBER|$KANEO_TASK_REF" >> ` + got
	app := hookTestApp(t, map[string]string{"attach": cmd, "close": cmd})

	if err := run(t, newSessionAttachCommand(app), "task-2", "--strict"); err != nil {
		t.Fatal(err)
	}
	if err := run(t, newSessionCloseCommand(app), "--strict"); err != nil {
		t.Fatal(err)
	}

	b, err := os.ReadFile(got)
	if err != nil {
		t.Fatal(err)
	}
	want := "attach|s1|task-2|3|kaneo other#3\nclose|s1|task-2|3|\n"
	if string(b) != want {
		t.Errorf("hook saw\n%s\nwant\n%s", b, want)
	}
}

// A failing hook must not fail the attach, which already happened on the
// server, and must leave a record behind rather than vanish.
func TestSessionAttachSurvivesAFailingHook(t *testing.T) {
	config := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", config)
	t.Setenv("KANEO_SESSION_ID", "s1")

	app := hookTestApp(t, map[string]string{"attach": "echo boom; exit 3"})
	if err := run(t, newSessionAttachCommand(app), "task-2", "--strict"); err != nil {
		t.Fatalf("attach failed over its hook: %v", err)
	}
	if _, err := os.Stat(filepath.Join(config, "kaneo", "sessions", "s1.json")); err != nil {
		t.Errorf("attachment not recorded: %v", err)
	}

	b, err := os.ReadFile(filepath.Join(config, "kaneo", "hooks.log"))
	if err != nil {
		t.Fatal(err)
	}
	if s := string(b); !strings.Contains(s, "session=s1 attach hook failed: exit status 3: boom") {
		t.Errorf("hooks.log = %q", s)
	}
}

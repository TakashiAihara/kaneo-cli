package cli

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TakashiAihara/kaneo-cli/internal/config"
	"github.com/TakashiAihara/kaneo-cli/internal/output"
)

// hookTestApp serves one task. commentStatus is what posting the marker
// answers; before, when set, runs as the marker is posted.
func hookTestApp(t *testing.T, hooks map[string]string, commentStatus int, before func()) *App {
	app := newTestApp(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "GET /api/task/task-2":
			w.Write([]byte(`{"id":"task-2","number":3,"title":"three","projectId":"proj2"}`))
		case "GET /api/project/proj2":
			w.Write([]byte(`{"id":"proj2","name":"Other Board","slug":"other","workspaceId":"ws2"}`))
		case "GET /api/auth/organization/list":
			w.Write([]byte(`[{"id":"ws2","name":"W"}]`))
		case "POST /api/comment/task-2":
			if before != nil {
				before()
			}
			w.WriteHeader(commentStatus)
			w.Write([]byte(`{"id":"c1"}`))
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	})
	app.Global = &config.Global{Hooks: hooks}
	return app
}

func hookEnvForTest(t *testing.T) string {
	config := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", config)
	// Through the fallback, so that a hook reading KANEO_SESSION_ID sees it
	// only if kaneo hands it over.
	t.Setenv("KANEO_SESSION_ID", "")
	t.Setenv("CLAUDE_CODE_SESSION_ID", "s1")
	return config
}

func readHookLog(t *testing.T, config string) string {
	b, err := os.ReadFile(filepath.Join(config, "kaneo", "hooks.log"))
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return string(b)
}

// attach and close each hand the hook the task, after the marker is on the
// server, so a follower such as `ccx session task` can be set and cleared
// without knowing about kaneo.
func TestSessionHooksReceiveTheTask(t *testing.T) {
	config := hookEnvForTest(t)
	got := filepath.Join(t.TempDir(), "got")

	cmd := `echo "$KANEO_HOOK_EVENT|$KANEO_SESSION_ID|$KANEO_TASK_ID|$KANEO_TASK_NUMBER|$KANEO_TASK_REF" >> ` + got + `; echo junk`
	posts := 0
	app := hookTestApp(t, map[string]string{"attach": cmd, "close": cmd}, http.StatusOK, func() {
		b, _ := os.ReadFile(got)
		if lines := strings.Count(string(b), "\n"); lines != posts {
			t.Errorf("post %d: hook already ran %d times", posts+1, lines)
		}
		posts++
	})
	stdout := &strings.Builder{}
	app.Out = &output.Writer{Mode: output.Mode{JSON: true}, Out: stdout, Err: &strings.Builder{}}

	if err := run(t, newSessionAttachCommand(app), "task-2", "--strict"); err != nil {
		t.Fatal(err)
	}
	var attached map[string]any
	if err := json.Unmarshal([]byte(stdout.String()), &attached); err != nil {
		t.Errorf("attach --json output is not JSON: %v: %q", err, stdout.String())
	}
	if err := run(t, newSessionCloseCommand(app), "--strict"); err != nil {
		t.Fatal(err)
	}

	b, err := os.ReadFile(got)
	if err != nil {
		t.Fatal(err)
	}
	if want := "attach|s1|task-2|3|kaneo other#3\nclose|s1|task-2|3|\n"; string(b) != want {
		t.Errorf("hook saw\n%s\nwant\n%s", b, want)
	}
	if log := readHookLog(t, config); log != "" {
		t.Errorf("hooks.log = %q, want nothing", log)
	}
}

// A failing hook must not fail the attach, which already happened on the
// server, and must leave a record behind rather than vanish.
func TestSessionAttachSurvivesAFailingHook(t *testing.T) {
	config := hookEnvForTest(t)

	app := hookTestApp(t, map[string]string{"attach": "echo boom; exit 3"}, http.StatusOK, nil)
	if err := run(t, newSessionAttachCommand(app), "task-2", "--strict"); err != nil {
		t.Fatalf("attach failed over its hook: %v", err)
	}
	if _, ok := sessionStore().Load("s1"); !ok {
		t.Error("attachment not recorded")
	}
	if log := readHookLog(t, config); !strings.Contains(log, "session=s1 attach hook failed: exit status 3: boom") {
		t.Errorf("hooks.log = %q", log)
	}
}

// Nothing happened on the server, so there is nothing for a follower to
// follow.
func TestSessionAttachRunsNoHookWhenThePostFails(t *testing.T) {
	hookEnvForTest(t)
	ran := filepath.Join(t.TempDir(), "ran")

	app := hookTestApp(t, map[string]string{"attach": "touch " + ran}, http.StatusInternalServerError, nil)
	if err := run(t, newSessionAttachCommand(app), "task-2", "--strict"); err == nil {
		t.Fatal("attach succeeded against a failing server")
	}
	if _, err := os.Stat(ran); err == nil {
		t.Error("hook ran although the attach failed")
	}
}

// A timed-out hook is killed with everything it started; a child left
// running could finish after the close hook and undo it.
func TestHookTimeoutKillsTheWholeHook(t *testing.T) {
	config := hookEnvForTest(t)
	late := filepath.Join(t.TempDir(), "late")
	defer func(d time.Duration) { hookTimeout = d }(hookTimeout)
	hookTimeout = 200 * time.Millisecond

	// The subshell is a child of sh, which is what killing sh alone misses.
	app := hookTestApp(t, map[string]string{"attach": "(sleep 1; touch " + late + "); true"}, http.StatusOK, nil)
	start := time.Now()
	if err := run(t, newSessionAttachCommand(app), "task-2", "--strict"); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d > 900*time.Millisecond {
		t.Errorf("attach took %s", d)
	}
	time.Sleep(1500 * time.Millisecond)
	if _, err := os.Stat(late); err == nil {
		t.Error("the hook's child outlived the timeout")
	}
	if log := readHookLog(t, config); !strings.Contains(log, "attach hook failed: killed after 200ms") {
		t.Errorf("hooks.log = %q", log)
	}
}

// A hook that leaves a background process behind still succeeded.
func TestHookLeavingABackgroundProcessIsNotAFailure(t *testing.T) {
	config := hookEnvForTest(t)

	app := hookTestApp(t, map[string]string{"attach": "sleep 2 &"}, http.StatusOK, nil)
	start := time.Now()
	if err := run(t, newSessionAttachCommand(app), "task-2", "--strict"); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d > time.Second {
		t.Errorf("attach waited %s for the background process", d)
	}
	if log := readHookLog(t, config); log != "" {
		t.Errorf("hooks.log = %q, want nothing", log)
	}
}

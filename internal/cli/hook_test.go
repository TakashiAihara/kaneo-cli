package cli

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
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
	// The hook's "echo junk" must not reach the process's own stdout either,
	// which is where a real --json reader looks.
	realStdout := os.Stdout
	procOut, err := os.CreateTemp(t.TempDir(), "stdout")
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = procOut
	defer func() { os.Stdout = realStdout }()

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

	if b, _ := os.ReadFile(procOut.Name()); len(b) != 0 {
		t.Errorf("hook wrote to the process's stdout: %q", b)
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

// A hook that leaves a background process behind still succeeded, and the
// process is left to finish.
func TestHookLeavingABackgroundProcessIsNotAFailure(t *testing.T) {
	config := hookEnvForTest(t)
	done := filepath.Join(t.TempDir(), "done")

	app := hookTestApp(t, map[string]string{"attach": "(sleep 1.2; touch " + done + ") &"}, http.StatusOK, nil)
	start := time.Now()
	if err := run(t, newSessionAttachCommand(app), "task-2", "--strict"); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d > time.Second {
		t.Errorf("attach waited %s for the background process", d)
	}
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(100 * time.Millisecond) {
		if _, err := os.Stat(done); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the background process did not get to finish")
		}
	}
	if log := readHookLog(t, config); log != "" {
		t.Errorf("hooks.log = %q, want nothing", log)
	}
}

// A noisy failing hook is reported by the end of its output, where the
// reason usually is, and not in full.
func TestHookFailureReportsTheEndOfItsOutput(t *testing.T) {
	config := hookEnvForTest(t)

	// 6000 a's then exactly 4096 b's: the report must be the b's and nothing
	// before them. Literals, not hookOutputLimit, so changing it is noticed.
	app := hookTestApp(t, map[string]string{"attach": "head -c 6000 /dev/zero | tr '\\0' a; head -c 4096 /dev/zero | tr '\\0' b; exit 1"}, http.StatusOK, nil)
	if err := run(t, newSessionAttachCommand(app), "task-2", "--strict"); err != nil {
		t.Fatal(err)
	}
	log := readHookLog(t, config)
	if want := "exit status 1: " + strings.Repeat("b", 4096) + "\n"; !strings.HasSuffix(log, want) {
		t.Errorf("hooks.log does not end with exactly the last 4096 bytes: %d bytes, %d b's", len(log), strings.Count(log, "b"))
	}
}

// kaneo stopped by a signal takes the hook down with it; the hook is in its
// own process group, so nothing else would, and no timeout is left to.
func TestHookIsKilledWhenKaneoIsSignalled(t *testing.T) {
	config := hookEnvForTest(t)
	late := filepath.Join(t.TempDir(), "late")
	var reraised []os.Signal
	defer func(f func(os.Signal)) { reraise = f }(reraise)
	reraise = func(s os.Signal) { reraised = append(reraised, s) }

	// The child is started before the signal, so killing sh alone would
	// leave it running. $PPID is the test process, standing in for kaneo.
	app := hookTestApp(t, map[string]string{"attach": "(sleep 1; touch " + late + ") & sleep 0.2; kill -TERM $PPID; wait"}, http.StatusOK, nil)
	start := time.Now()
	if err := run(t, newSessionAttachCommand(app), "task-2", "--strict"); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d > 900*time.Millisecond {
		t.Errorf("attach took %s", d)
	}
	time.Sleep(1500 * time.Millisecond)
	if _, err := os.Stat(late); err == nil {
		t.Error("the hook outlived the signal")
	}
	if log := readHookLog(t, config); !strings.Contains(log, "attach hook failed: killed: kaneo received a signal") {
		t.Errorf("hooks.log = %q", log)
	}
	if len(reraised) != 1 || reraised[0] != syscall.SIGTERM {
		t.Errorf("reraised %v, want [terminated]", reraised)
	}
}

// The real reraise ends the process with the signal. Checked in a child,
// since it would end the test binary too.
func TestReraiseEndsTheProcess(t *testing.T) {
	if os.Getenv("KANEO_TEST_RERAISE") == "1" {
		reraise(syscall.SIGTERM)
		os.Exit(0)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestReraiseEndsTheProcess$")
	cmd.Env = append(os.Environ(), "KANEO_TEST_RERAISE=1")
	err := cmd.Run()
	if cmd.ProcessState == nil {
		t.Fatal(err)
	}
	ws, ok := cmd.ProcessState.Sys().(syscall.WaitStatus)
	if !ok || !ws.Signaled() || ws.Signal() != syscall.SIGTERM {
		t.Errorf("child ended with %v, want killed by SIGTERM", err)
	}
}

package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// hookTimeout bounds a hook. attach and close run from session hooks, so a
// hook that hangs would hang the session start with them. A variable only so
// a test need not wait ten seconds.
var hookTimeout = 10 * time.Second

// hookOutputLimit caps how much of a failed hook's output is reported.
const hookOutputLimit = 4096

// runHook runs the command configured for event, if any.
//
// A failing hook never fails the command that ran it: the attach or close has
// already happened on the server, and undoing it over a follower's failure
// would be the larger harm. The failure is written to stderr and appended to
// hooks.log instead, so it is not lost when stderr is.
func runHook(app *App, event string, env map[string]string) {
	if app.Global == nil {
		return
	}
	command := strings.TrimSpace(app.Global.Hooks[event])
	if command == "" {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), hookTimeout)
	defer cancel()

	// Captured rather than inherited: a hook printing to stdout would corrupt
	// the --json output of the command that ran it. A file and not a pipe: a
	// background process the hook leaves behind would hold a pipe open, and
	// Wait would report a hook that exited 0 as failed.
	// ponytail: the file is unbounded; a hook spewing for its whole timeout,
	// or leaving a spewing process behind, fills the temp dir. Cap it with a
	// pipe that discards past the limit if a real hook ever does that.
	out, err := os.CreateTemp("", "kaneo-hook-*.log")
	if err != nil {
		reportHookFailure(event, env, fmt.Errorf("capture output: %w", err), "")
		return
	}
	defer os.Remove(out.Name())
	defer out.Close()

	cmd := exec.CommandContext(ctx, "sh", "-c", command)
	cmd.Env = os.Environ()
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.Stdout, cmd.Stderr = out, out
	// Killing sh alone leaves its children running, and a timed-out attach
	// hook could then finish after the close hook and undo it. A child that
	// leaves the process group (setsid) is out of reach, and so is the hook
	// from whoever signals kaneo's own group; the timeout covers that case.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }

	err = cmd.Run()
	if err == nil {
		return
	}
	if ctx.Err() != nil {
		err = fmt.Errorf("killed after %s", hookTimeout)
	}
	// The end, not the start: the reason a command failed is usually the
	// last thing it printed.
	var from int64
	if fi, statErr := out.Stat(); statErr == nil && fi.Size() > hookOutputLimit {
		from = fi.Size() - hookOutputLimit
	}
	tail := make([]byte, hookOutputLimit)
	n, _ := io.ReadFull(io.NewSectionReader(out, from, hookOutputLimit), tail)
	reportHookFailure(event, env, err, string(tail[:n]))
}

func reportHookFailure(event string, env map[string]string, err error, output string) {
	msg := fmt.Sprintf("%s hook failed: %v: %s", event, err, strings.TrimSpace(output))
	fmt.Fprintln(os.Stderr, "kaneo: "+msg)
	logHookFailure(env["KANEO_SESSION_ID"], msg)
}

func logHookFailure(sessionID, msg string) {
	path := filepath.Join(filepath.Dir(sessionStore().Dir), "hooks.log")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		debugf("hook log: %v", err)
		return
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		debugf("hook log: %v", err)
		return
	}
	defer f.Close()
	line := strings.ReplaceAll(msg, "\n", " ")
	fmt.Fprintf(f, "%s session=%s %s\n", time.Now().Format(time.RFC3339), sessionID, line)
}

// hookEnv is what a hook learns about the task. KANEO_TASK_REF is the form
// people write, "kaneo <project slug>#<number>", and is empty when the slug
// is unknown: a half-built reference would point at nothing.
func hookEnv(event, sessionID, taskID string, number int, slug string) map[string]string {
	ref := ""
	if slug != "" {
		ref = fmt.Sprintf("kaneo %s#%d", slug, number)
	}
	return map[string]string{
		"KANEO_HOOK_EVENT":  event,
		"KANEO_SESSION_ID":  sessionID,
		"KANEO_TASK_ID":     taskID,
		"KANEO_TASK_NUMBER": fmt.Sprint(number),
		"KANEO_TASK_REF":    ref,
	}
}

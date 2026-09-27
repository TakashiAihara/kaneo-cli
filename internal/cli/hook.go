package cli

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// hookTimeout bounds a hook. attach and close run from session hooks, so a
// hook that hangs would hang the session start with them.
const hookTimeout = 10 * time.Second

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

	cmd := exec.CommandContext(ctx, "sh", "-c", command)
	cmd.Env = os.Environ()
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	// Captured rather than inherited: a hook printing to stdout would corrupt
	// the --json output of the command that ran it.
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	cmd.WaitDelay = 500 * time.Millisecond

	err := cmd.Run()
	if err == nil {
		return
	}
	if ctx.Err() != nil {
		err = fmt.Errorf("timed out after %s", hookTimeout)
	}
	msg := fmt.Sprintf("%s hook failed: %v: %s", event, err, strings.TrimSpace(out.String()))
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

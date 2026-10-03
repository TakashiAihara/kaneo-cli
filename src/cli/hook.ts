import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { debug, type App } from "./app";
import { sessionStore } from "../session/store";

// Bounds a hook. attach and close run from session hooks, so a hook that hangs
// would hang the session start with them.
const HOOK_TIMEOUT_MS = 10_000;

// Caps how much of a failed hook's output is reported.
const HOOK_OUTPUT_LIMIT = 4096;

// The signals caught while a hook runs, so the hook can be killed before kaneo
// dies of one. A signal kaneo was started with ignored (nohup) was meant to stay
// ignored, and Bun offers no way to read an inherited disposition, so the
// handler is installed either way and that case is accepted rather than guessed
// at.
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

// Runs the command configured for event, if any.
//
// A failing hook never fails the command that ran it: the attach or close has
// already happened on the server, and undoing it over a follower's failure would
// be the larger harm. The failure is written to stderr and appended to
// hooks.log instead, so it is not lost when stderr is.
export const runHook = async (app: App, event: string, env: Record<string, string>): Promise<void> => {
  const command = (app.global.hooks?.[event] ?? "").trim();
  if (command === "") return;

  // Captured rather than inherited: a hook printing to stdout would corrupt the
  // --json output of the command that ran it. A file and not a pipe: a
  // background process the hook leaves behind would hold a pipe open, and
  // waiting for it would report a hook that exited 0 as failed.
  // NOTE: the file is unbounded; a hook spewing for its whole timeout, or
  // leaving a spewing process behind, fills the temp dir. `ulimit -f` in front
  // of the command is the likely cap.
  const captured = mkdtempSync(join(tmpdir(), "kaneo-hook-"));
  const log = join(captured, "out.log");
  const fd = openSync(log, "w");
  try {
    const hook = Bun.spawn(["sh", "-c", command], {
      env: { ...process.env, ...env },
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
      // Its own session, so a signal meant for kaneo's group does not reach it.
      detached: true,
    });

    // Killing sh alone leaves its children running, and a timed-out attach hook
    // could then finish after the close hook and undo it. A child that leaves
    // the group is out of reach, and so is everything if kaneo is killed with
    // SIGKILL; both are accepted.
    let caught: string | undefined;
    let killed: "timeout" | "signalled" | undefined;
    const killGroup = (why: "timeout" | "signalled") => {
      killed ??= why;
      try {
        process.kill(-hook.pid, "SIGKILL");
      } catch {
        // Already gone, or never started: the exit status says so anyway.
      }
    };
    const deadline = setTimeout(() => killGroup("timeout"), HOOK_TIMEOUT_MS);
    const listeners = SIGNALS.map((signal) => {
      const handler = () => {
        caught ??= signal;
        killGroup("signalled");
      };
      process.on(signal, handler);
      return { signal, handler };
    });

    await hook.exited;
    clearTimeout(deadline);
    // Removing the last listener for a signal restores the default action,
    // which is what the signal below is delivered to.
    for (const { signal, handler } of listeners) process.off(signal, handler);
    closeSync(fd);

    const failure = failureOf(hook, killed);
    if (failure !== undefined) reportHookFailure(event, env, failure, tailOf(log));
    // Taken away before the re-raise below, which ends this process without
    // running the finally. force makes the second removal a no-op.
    rmSync(captured, { recursive: true, force: true });

    // Delivered again with its default action, so kaneo still dies of it and
    // `kaneo session attach && next` stops. The wait is because delivery is
    // asynchronous, and without it kaneo could print its success line first.
    if (caught !== undefined) {
      process.kill(process.pid, caught);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    rmSync(captured, { recursive: true, force: true });
  }
};

// How a hook ended badly, in the Go build's words, because that is what
// hooks.log has always held.
//
// A hook that ended cleanly is not a failure whatever arrived while it ran: it
// did what it was asked to do. Otherwise being killed is reported first, since
// the status of a process killed for that reason says nothing useful.
const failureOf = (hook: Bun.Subprocess, killed: "timeout" | "signalled" | undefined): string | undefined => {
  if (killed === undefined && hook.signalCode === null && hook.exitCode === 0) return undefined;
  if (killed === "timeout") return `killed after ${HOOK_TIMEOUT_MS / 1000}s`;
  if (killed === "signalled") return "killed: kaneo received a signal";
  if (hook.signalCode !== null) return `signal: ${signalName(hook.signalCode)}`;
  return `exit status ${hook.exitCode}`;
};

// Go names a signal after what it does; anything it does not name is spelled as
// the platform spells it.
const NAMES: Record<string, string> = {
  SIGINT: "interrupt",
  SIGQUIT: "quit",
  SIGKILL: "killed",
  SIGTERM: "terminated",
  SIGHUP: "hangup",
};

const signalName = (code: string): string => NAMES[code] ?? code.slice(3).toLowerCase();

// The end, not the start: the reason a command failed is usually the last thing
// it printed.
const tailOf = (log: string): string => {
  const size = statSync(log).size;
  return readFileSync(log).subarray(size > HOOK_OUTPUT_LIMIT ? size - HOOK_OUTPUT_LIMIT : 0).toString("utf8");
};

const reportHookFailure = (event: string, env: Record<string, string>, failure: string, output: string): void => {
  const message = `${event} hook failed: ${failure}: ${output.trim()}`;
  writeSync(2, `kaneo: ${message}\n`);
  logHookFailure(env["KANEO_SESSION_ID"] ?? "", message);
};

const logHookFailure = (sessionId: string, message: string): void => {
  const file = hooksLog();
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // The whole failure on one line, so a hook that printed lines of its own
    // cannot leave the log unreadable.
    appendFileSync(file, `${rfc3339(new Date())} session=${sessionId} ${message.replaceAll("\n", " ")}\n`, {
      mode: 0o600,
    });
  } catch (e) {
    debug(`hook log: ${(e as Error).message}`);
  }
};

// RFC 3339 to the second, the form the log has always held.
const rfc3339 = (at: Date): string => at.toISOString().replace(/\.\d+Z$/, "Z");

// Where hook failures are recorded: beside the store, next to the config.
const hooksLog = (): string => join(dirname(sessionStore().dir), "hooks.log");

// What a hook learns about the task. KANEO_TASK_REF is the form people write,
// "kaneo <project slug>#<number>", and is empty when the slug is unknown: a
// half-built reference would point at nothing.
export const hookEnv = (
  event: string,
  sessionId: string,
  taskId: string,
  number: number,
  slug: string,
): Record<string, string> => ({
  KANEO_HOOK_EVENT: event,
  KANEO_SESSION_ID: sessionId,
  KANEO_TASK_ID: taskId,
  KANEO_TASK_NUMBER: String(number),
  KANEO_TASK_REF: slug === "" ? "" : `kaneo ${slug}#${number}`,
});
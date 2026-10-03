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

// The signals caught around a hook, so the hook can be killed before kaneo
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

  // The signals are caught from before the hook exists, as the Go build calls
  // signal.Notify before cmd.Run: the hook is what sends them, so a handler that
  // is not yet there when one arrives lets kaneo die of it outright and takes the
  // hook's group with it, leaving that group to run on with no timeout and
  // nothing cleaning up after it.
  //
  // They come down only at the very end, so a signal arriving while the failure
  // is being reported, or the capture is being given back, still finds one.
  let caught: string | undefined;
  let killed: "timeout" | "signalled" | undefined;
  // The hook's process group, once it has one. Signalling -pid is what reaches
  // the whole group, which is what has to die: killing sh alone leaves its
  // children running, and a timed-out attach hook could then finish after the
  // close hook and undo it. A child that leaves the group is out of reach, and
  // so is everything if kaneo is killed with SIGKILL; both are accepted.
  let group: number | undefined;
  // The group is only this process's to kill while the hook is in it: afterwards
  // the number has been given back and may already name somebody else's, and a
  // hook that ended cleanly is a hook that did its work whatever arrived while it
  // was running.
  let running = true;
  // Set once the capture has been given back, which is the point from which a
  // caught signal has nothing left to act on but this process.
  let over = false;
  let captured: string | undefined;
  let output: number | undefined;

  const killGroup = (why: "timeout" | "signalled") => {
    if (!running) return;
    killed ??= why;
    // The hook has not been started yet, so there is no group to signal: the
    // kill waits for one and is applied the moment there is.
    if (group === undefined) return;
    try {
      process.kill(-group, "SIGKILL");
    } catch {
      // Already gone, or never started: the exit status says so anyway.
    }
  };

  const listeners = SIGNALS.map((signal) => {
    const handler = () => {
      caught ??= signal;
      // Nothing is left to read what the handler recorded, so the process ends
      // here. Ending it from inside the handler is what keeps a signal from ever
      // arriving with nobody to act on it: this is the last thing one can arrive
      // at, and taking the handlers down here is what gives it the default action
      // that ends this process.
      if (over) raise(caught);
      else killGroup("signalled");
    };
    process.on(signal, handler);
    return { signal, handler };
  });

  const stopListening = (): void => {
    for (const { signal, handler } of listeners) process.off(signal, handler);
  };

  // Delivers a caught signal again with its default action, so kaneo still dies
  // of it and `kaneo session attach && next` stops. Removing the last listener
  // for a signal restores that default action, which is why this is where the
  // handlers go; the removal and the delivery are one turn of the loop with
  // nothing awaited between them, and what is delivered is the signal a handler
  // recorded rather than whatever has arrived since.
  const raise = (signal: string | undefined): void => {
    stopListening();
    if (signal !== undefined) process.kill(process.pid, signal);
  };

  try {
    // Captured rather than inherited: a hook printing to stdout would corrupt the
    // --json output of the command that ran it. A file and not a pipe: a
    // background process the hook leaves behind would hold a pipe open, and
    // waiting for it would report a hook that exited 0 as failed.
    // NOTE: the file is unbounded; a hook spewing for its whole timeout, or
    // leaving a spewing process behind, fills the temp dir. `ulimit -f` in front
    // of the command is the likely cap.
    try {
      captured = mkdtempSync(join(tmpdir(), "kaneo-hook-"));
    } catch (e) {
      // A hook that cannot even be started is a hook that failed, and is reported
      // like one: the attach it was following has already happened, and a temp
      // directory nobody can create is not a reason to fail that.
      reportHookFailure(event, env, `capture output: ${(e as Error).message}`, "");
      return;
    }
    const log = join(captured, "out.log");
    // One descriptor for both streams, which is the single file Go handed the child.
    // Two Bun.file targets on one path are two opens of it, and each truncates what
    // the other wrote, so the report keeps one stream's worth of the hook's output
    // and loses the rest. Opened here rather than left to Bun, and given back in
    // the finally below, so this process is not left holding it either.
    try {
      output = openSync(log, "w", 0o600);
    } catch (e) {
      // A file nobody can create is the same failure as a directory nobody can,
      // and is reported the way the Go build reported its CreateTemp.
      reportHookFailure(event, env, `capture output: ${(e as Error).message}`, "");
      return;
    }

    let hook: Bun.Subprocess;
    try {
      hook = Bun.spawn(["sh", "-c", command], {
        env: { ...process.env, ...env },
        stdin: "ignore",
        stdout: output,
        stderr: output,
        // Its own session, so a signal meant for kaneo's group does not reach it.
        detached: true,
      });
    } catch (e) {
      // No sh on PATH, or nothing left to run it with. Reported the way the Go
      // build reported a command it could not start.
      reportHookFailure(event, env, `fork/exec sh: ${(e as Error).message}`, "");
      return;
    }
    group = hook.pid;
    // A kill recorded while the hook did not exist yet is applied here, so that a
    // report cannot claim a kill that never happened and the hook does not get to
    // run before being killed.
    if (killed !== undefined) killGroup(killed);

    const deadline = setTimeout(() => killGroup("timeout"), HOOK_TIMEOUT_MS);

    await hook.exited;
    running = false;
    clearTimeout(deadline);

    // A signal is queued when it arrives and its handler runs on the next turn of
    // the loop, and the turn that brings the hook's exit is not always that one —
    // measured at about one time in eight. So this wait is part of the decision
    // rather than a margin on it: without it a hook that signals kaneo on its way
    // out is reported as a hook killed for some other reason, or as one that ran
    // clean, and nothing is re-raised at all.
    await nextTurn();

    // Decided with the handlers still installed, which is what a signal arriving
    // during the report below finds.
    const failure = failureOf(hook, killed);
    if (failure !== undefined) reportHookFailure(event, env, failure, tailOf(log));
  } finally {
    // Given back here rather than left to the operating system, which only takes
    // it when the re-raise below ends this process without running the finally.
    // Closed before the directory holding it goes, in the order the Go build's
    // deferred calls ran.
    if (output !== undefined) closeSync(output);
    if (captured !== undefined) rmSync(captured, { recursive: true, force: true });
    over = true;

    // The last wait, and the one the report makes necessary: hooks.log is appended
    // to, and a FIFO in its place holds that append open for as long as nobody is
    // reading it, so a signal can arrive while the failure is being written and
    // find no turn to be handled on until this one. The handler ends the process
    // from there.
    await nextTurn();

    raise(caught);
    // Delivery is asynchronous, and without the wait kaneo could print its
    // success line before it dies.
    if (caught !== undefined) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};

// The next turn of the loop, which is where a signal kaneo has been given is
// handled: the signal is queued when it arrives, and its handler runs on a turn
// after that. Bun documents none of that ordering, so it is measured: a queued
// signal's handler runs before the next immediate, and every signal queued
// before the loop turned is handled on that one turn.
//
// One is the whole of it once a hook has ended, because everything the hook sent
// was queued before its exit was and so is already ahead of this. What was sent
// after it exited is not waited for, since there is no telling how long that
// could be, and it reaches the default action anyway.
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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

// Go names every signal after what it does rather than after its number, and
// that wording is what hooks.log has always held: a hook that kills itself with
// SIGUSR1 is reported as "user defined signal 1", which says what happened, where
// the abbreviation says only which constant was used. Anything this table does
// not hold is spelled the way the platform spells it, as Go falls back on the
// name for a number its table does not carry.
const SIGNAL_NAMES: Record<string, string> = {
  SIGHUP: "hangup",
  SIGINT: "interrupt",
  SIGQUIT: "quit",
  SIGILL: "illegal instruction",
  SIGTRAP: "trace/breakpoint trap",
  SIGABRT: "aborted",
  SIGBUS: "bus error",
  SIGFPE: "floating point exception",
  SIGKILL: "killed",
  SIGUSR1: "user defined signal 1",
  SIGSEGV: "segmentation fault",
  SIGUSR2: "user defined signal 2",
  SIGPIPE: "broken pipe",
  SIGALRM: "alarm clock",
  SIGTERM: "terminated",
  SIGSTKFLT: "stack fault",
  SIGCHLD: "child exited",
  SIGCONT: "continued",
  SIGSTOP: "stopped (signal)",
  SIGTSTP: "stopped",
  SIGTTIN: "stopped (tty input)",
  SIGTTOU: "stopped (tty output)",
  SIGURG: "urgent I/O condition",
  SIGXCPU: "CPU time limit exceeded",
  SIGXFSZ: "file size limit exceeded",
  SIGVTALRM: "virtual timer expired",
  SIGPROF: "profiling timer expired",
  SIGWINCH: "window changed",
  SIGIO: "I/O possible",
  SIGPWR: "power failure",
  SIGSYS: "bad system call",
};

const signalName = (code: string): string => SIGNAL_NAMES[code] ?? code.slice(3).toLowerCase();

// The end, not the start: the reason a command failed is usually the last thing
// it printed. A file that cannot be read at all has nothing to report, and that
// is not a second failure on top of the first.
const tailOf = (log: string): string => {
  try {
    const size = statSync(log).size;
    return readFileSync(log).subarray(size > HOOK_OUTPUT_LIMIT ? size - HOOK_OUTPUT_LIMIT : 0).toString("utf8");
  } catch {
    return "";
  }
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

// RFC 3339 to the second, in the time of the machine that wrote it.
//
// Local rather than UTC: the log says when a hook failed on the host it failed
// on, and that is the clock whoever reads it will compare against. The zone goes
// with the time, since a bare wall-clock reading is not an instant, and "Z" is
// how RFC 3339 spells an offset of zero.
const rfc3339 = (at: Date): string => {
  // How far local time is from UTC, in minutes, which is the other way round from
  // the offset JS reports. The clock is shifted by it and then read back as UTC,
  // which spells the wall clock without a formatter of its own.
  const ahead = -at.getTimezoneOffset();
  const wall = new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
  if (ahead === 0) return `${wall}Z`;
  const sign = ahead < 0 ? "-" : "+";
  return `${wall}${sign}${two(Math.floor(Math.abs(ahead) / 60))}:${two(Math.abs(ahead) % 60)}`;
};

const two = (part: number): string => String(part).padStart(2, "0");

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
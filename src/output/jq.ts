// The `--jq` expression, as a filter over what a command wrote.
//
// jq-wasm's raw() blocks the thread it runs on, so an expression that never
// finishes (`def f: f; f`, `[range(1e9)]`) would hold the process after the
// command's side effects already ran — and only another thread can be killed
// for it. The filter therefore evaluates in a worker thread, where
// --timeout's bound can terminate it, while the main thread blocks on
// Atomics.wait for the answer, which keeps Filter synchronous for the Writer.
//
// The worker cannot resolve "jq-wasm/inline" — a compiled binary ships no
// node_modules — so the module's own source travels as text and is imported
// from a data: URL. The "inline" entry carries the WebAssembly inside the
// JavaScript, so nothing sits beside the binary either way.

import { writeSync } from "node:fs";
import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { sanitizeControl } from "./output";

// jq-wasm's inline entry as source text, for the worker's data: URL import.
// The text loader returns the module's bytes as a string; tsc types the
// import as the module itself, so what follows is the loader's shape, not a
// guess at the package's.
// @ts-expect-error Bun's text loader returns a string, not the module's types
import jqModuleSource from "jq-wasm/inline" with { type: "text" };

// A JSON document in, whatever the expression makes of it out.
export type Filter = (json: string) => string;

// -c and not -r. The wrapper trims jq's stdout, which would take the spaces off
// the ends of a raw string and drop an empty one altogether; a compact JSON line
// has no whitespace at either end to lose, so each value survives and strings
// are unquoted here instead.
const FLAGS = ["-c"];

// A failure of the expression rather than of the command, and a class of its own
// because it is reported differently: the payload that was to be filtered is
// not there, so nothing of it belongs on stdout. exitCode is jq's own — the
// status the same expression would have given a jq process, so halt_error(n)
// keeps the n the caller asked for.
export class JqFailure extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

// The position jq reports is a line of kaneo's own serialisation of the
// payload, which the caller never sees, so it is taken out.
const failure = (message: string, exitCode: number, after = ""): JqFailure =>
  new JqFailure(`--jq: ${message.trim().replace(/ \(at \/dev\/stdin:\d+\)/g, "")}${after}`, exitCode);

// Every command hands over its payload as its last step, so by the time the
// filter runs, whatever the command changes has been changed — and a caller that
// retries on a non-zero exit has to know a retry would do it again. That says
// nothing about whether the command went on to fail (api-check does, after
// reporting), so the message does not claim it succeeded.
const RAN = "\nthe command had already run when --jq failed; anything it changes has been changed";

// A string prints as itself, as gh --jq does it, so `--jq .number` and
// `--jq .title` are both something a script can read. Anything else is already
// the compact JSON gh prints to a pipe.
const unquoted = (value: string): string => (value.startsWith('"') ? JSON.parse(value) : value);

// Each value ends with a newline (a raw string may hold more of its own), so an
// expression that printed nothing stays nothing rather than a blank line.
const lines = (stdout: string): string =>
  stdout
    .split("\n")
    .filter((value) => value !== "")
    .map((value) => `${unquoted(value)}\n`)
    .join("");

// jq writes two kinds of text into one stderr stream: its diagnostics, each a
// line that opens "jq: ", and what the program itself printed — debug's
// ["DEBUG:",...] arrays, stderr's raw values, halt_error's bare message. On
// success everything goes to fd 2 raw; on failure the diagnostics are the
// error and the rest is still output. A printed value that does not end its
// line glues the next write onto it, so the split is by what opens a line,
// not by writer — a diagnostic glued mid-line reads as program output, and a
// failure with no diagnostic line at all keeps the whole stream as its
// message, which is what halt_error's bare message needs.
const splitStderr = (stderr: string): { diagnostics: string[]; program: string[] } => {
  const all = stderr.split("\n");
  if (all[all.length - 1] === "") all.pop();
  const diagnostics: string[] = [];
  const program: string[] = [];
  for (const line of all) (line.startsWith("jq: ") ? diagnostics : program).push(line);
  return { diagnostics, program };
};

// What `debug` and `stderr` print, as jq itself would show it. It can carry
// server text, so a terminal gets it with control characters neutralised.
const emit = (text: string, stderrIsTerminal: boolean): void => {
  if (text === "") return;
  writeSync(2, `${stderrIsTerminal ? sanitizeControl(text) : text}\n`);
};

// The worker's own source, eval'd because a compiled binary cannot hand a
// Worker a file to run. It is plain JavaScript — no type annotations — for
// that reason. jq-wasm arrives as text through workerData and is imported
// from a data: URL, the one specifier a string-spawned worker can resolve on
// every build the CLI ships as. ctrl is a one-word mailbox: the worker stores
// 1 and notifies when a result is on the port, which is what Atomics.wait on
// the main thread blocks on.
const WORKER = `
const wt = require("node:worker_threads");
const ctrl = new Int32Array(wt.workerData.sab);
let port = null;
let jq = null;
wt.parentPort.on("message", (msg) => {
  if (msg.port === undefined) return;
  port = msg.port;
  port.on("message", (job) => {
    const r = jq.raw(job.json, wt.workerData.expression, wt.workerData.flags);
    port.postMessage({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode });
    Atomics.store(ctrl, 0, 1);
    Atomics.notify(ctrl, 0);
  });
  port.start();
  (async () => {
    const m = await import("data:text/javascript;base64," + Buffer.from(wt.workerData.source).toString("base64"));
    jq = await m.loadJq();
    const compiled = jq.raw("", wt.workerData.expression, wt.workerData.flags);
    wt.parentPort.postMessage({ type: "ready", exitCode: compiled.exitCode, stderr: compiled.stderr });
  })();
});
`;

type Ready = { exitCode: number; stderr: string };

// The worker loads jq-wasm and compiles the expression before it answers a
// job, so its ready message carries the compile check's verdict. Startup is
// bounded by the same --timeout as an evaluation: on a build where the worker
// cannot start at all, the command fails the way an expression that never
// finishes does rather than hanging.
const readyResult = (worker: Worker, timeoutMs: number): Promise<Ready> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(failure(`the filter did not start within ${timeoutMs}ms`, 1));
    }, timeoutMs);
    worker.once("message", (ready: Ready) => {
      clearTimeout(timer);
      resolve(ready);
    });
    worker.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      reject(failure(`the jq worker exited ${code} before it was ready`, 1));
    });
  });

type Answer = { stdout: string; stderr: string; exitCode: number };

// Loads jq once for the whole command — in the worker, where its synchronous
// evaluations can be killed — and checks the expression against it. Whether
// stderr is a terminal is passed in, as it is to the Writer for stdout, so
// that both ways of printing what jq says can be exercised.
export const loadFilter = async (expression: string, stderrIsTerminal: boolean, timeoutMs: number): Promise<Filter> => {
  const { port1, port2 } = new MessageChannel();
  const sab = new SharedArrayBuffer(8);
  const ctrl = new Int32Array(sab);
  const worker = new Worker(WORKER, {
    eval: true,
    workerData: { sab, source: jqModuleSource, expression, flags: FLAGS },
  });
  // The command ends in process.exit either way; unref keeps a stray caller —
  // a test, a future embedder — from being held open by the worker.
  worker.unref();
  port1.unref();
  worker.postMessage({ port: port2 }, [port2]);

  const ready = await readyResult(worker, timeoutMs);
  if (ready.exitCode !== 0) {
    void worker.terminate();
    throw failure(ready.stderr, ready.exitCode);
  }

  return (json) => {
    Atomics.store(ctrl, 0, 0);
    port1.postMessage({ json });
    if (Atomics.wait(ctrl, 0, 0, timeoutMs) === "timed-out") {
      // The worker is still inside jq.raw; terminate is the only way out of a
      // synchronous wasm loop, and the next call — if a caller retries —
      // bounds itself the same way.
      void worker.terminate();
      throw failure(`the expression did not finish within ${timeoutMs}ms`, 1, RAN);
    }
    const answer = receiveMessageOnPort(port1)?.message as Answer | undefined;
    // The worker posts its answer before it signals done, so a missing one
    // means it died between the two — unreachable unless the runtime breaks.
    if (answer === undefined) throw new Error("internal error: the jq worker finished without an answer");
    const { stdout, stderr, exitCode } = answer;
    if (exitCode !== 0) {
      const { diagnostics, program } = splitStderr(stderr);
      if (diagnostics.length > 0) {
        emit(program.join("\n"), stderrIsTerminal);
        throw failure(diagnostics.join("\n"), exitCode, RAN);
      }
      // No "jq: " line: the whole stream is what the program printed. debug's
      // arrays still read as debug and go to fd 2; what remains is
      // halt_error's message.
      const debug = program.filter((line) => line.startsWith('["DEBUG:",'));
      const rest = program.filter((line) => !line.startsWith('["DEBUG:",'));
      emit(debug.join("\n"), stderrIsTerminal);
      throw failure(rest.length > 0 ? rest.join("\n") : stderr, exitCode, RAN);
    }
    emit(stderr, stderrIsTerminal);
    return lines(stdout);
  };
};

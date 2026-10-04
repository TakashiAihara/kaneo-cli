// The `--jq` expression, as a filter over what a command wrote.
//
// The WebAssembly comes in through the "inline" entry, which carries it inside
// the JavaScript rather than in a file beside it, so a compiled binary needs
// nothing next to itself. The import is dynamic, so a command without --jq
// never pays to instantiate a module it will not run.

import { writeSync } from "node:fs";

// A JSON document in, whatever the expression makes of it out.
export type Filter = (json: string) => string;

// -c and not -r. The wrapper trims jq's stdout, which would take the spaces off
// the ends of a raw string and drop an empty one altogether; a compact JSON line
// has no whitespace at either end to lose, so each value survives and strings
// are unquoted here instead.
const FLAGS = ["-c"];

// A failure of the expression rather than of the command, and a class of its own
// because it is reported differently: the payload that was to be filtered is
// not there, so nothing of it belongs on stdout.
export class JqFailure extends Error {}

// The position jq reports is a line of kaneo's own serialisation of the
// payload, which the caller never sees, so it is taken out.
const failure = (stderr: string, after = ""): JqFailure =>
  new JqFailure(`--jq: ${stderr.trim().replace(/ \(at \/dev\/stdin:\d+\)/g, "")}${after}`);

// By the time the payload reaches the filter the command has done its work, and
// a caller that retries on a non-zero exit has to know a retry would do it again.
const RAN = "\nthe command itself succeeded; only the --jq expression failed";

// A string prints as itself, as gh --jq does it, so `--jq .number` and
// `--jq .title` are both something a script can read. Anything else is already
// the compact JSON gh prints to a pipe.
const unquoted = (value: string): string => (value.startsWith('"') ? JSON.parse(value) : value);

// One line per value, each terminated, so an expression that printed nothing
// stays nothing rather than turning into a blank line.
const lines = (stdout: string): string =>
  stdout
    .split("\n")
    .filter((value) => value !== "")
    .map((value) => `${unquoted(value)}\n`)
    .join("");

// Loads jq and the expression, once, for the whole command.
export const loadFilter = async (expression: string): Promise<Filter> => {
  const { loadJq } = await import("jq-wasm/inline");
  const jq = await loadJq();
  // jq compiles a program before it reads any input, and with no input at all it
  // runs nothing, so this checks the expression without executing it against a
  // made-up value — one that loops, or halts, on null would otherwise hang or
  // fail the command. Refusing here also means no request is made to find out
  // that the expression was never going to work.
  const compiled = jq.raw("", expression, FLAGS);
  if (compiled.exitCode !== 0) throw failure(compiled.stderr);
  return (json) => {
    const { stdout, stderr, exitCode } = jq.raw(json, expression, FLAGS);
    if (exitCode !== 0) throw failure(stderr, RAN);
    // What `debug` and `stderr` print, as jq itself would show it.
    if (stderr !== "") writeSync(2, `${stderr}\n`);
    return lines(stdout);
  };
};

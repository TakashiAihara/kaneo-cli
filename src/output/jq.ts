// The `--jq` expression, as a filter over what a command wrote.
//
// The WebAssembly comes in through the "inline" entry, which carries it inside
// the JavaScript rather than in a file beside it, so a compiled binary needs
// nothing next to itself. The import is dynamic, so a command without --jq
// never pays to instantiate a module it will not run.

// A JSON document in, whatever jq prints for it out.
export type Filter = (json: string) => string;

// jq's exit code for a program it cannot compile, as against one that compiled
// and then failed on the value it was handed.
const COMPILE_ERROR = 3;

// -r: a string leaves the filter as itself rather than as a quoted JSON string,
// which is what makes `--jq .number` something a script can read.
const FLAGS = ["-r"];

// A failure of the expression rather than of the command, and a class of its own
// because it is reported differently: the payload that was to be filtered is
// not there, so nothing of it belongs on stdout.
export class JqFailure extends Error {}

const failure = (stderr: string): JqFailure => new JqFailure(`--jq: ${stderr.trim()}`);

// jq and gh both end their output with a newline, and a shell prompt that lands
// on the same line as the answer is the difference a caller notices. The wrapper
// hands back the stream without the terminator jq would have written, so it goes
// on here — but only when there is an answer to terminate, since an expression
// that printed nothing must not turn into a blank line.
const terminated = (text: string): string => (text === "" || text.endsWith("\n") ? text : `${text}\n`);

// Loads jq and the expression, once, for the whole command.
export const loadFilter = async (expression: string): Promise<Filter> => {
  const { loadJq } = await import("jq-wasm/inline");
  const jq = await loadJq();
  // jq compiles a program before it reads any input, so a run over a null tells
  // a broken expression from one that merely dislikes the value it was given —
  // and refusing here means the command makes no request to find out that the
  // expression was never going to work.
  const compiled = jq.raw("null", expression, FLAGS);
  if (compiled.exitCode === COMPILE_ERROR) throw failure(compiled.stderr);
  return (json) => {
    const { stdout, stderr, exitCode } = jq.raw(json, expression, FLAGS);
    if (exitCode !== 0) throw failure(stderr);
    return terminated(stdout);
  };
};
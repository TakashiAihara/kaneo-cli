import { fstatSync, writeSync } from "node:fs";
import { line, type Json } from "./json";
import type { Filter } from "./jq";

// How one invocation reaches the user.
//
// Two rules drive everything here:
//   - data goes to stdout, decoration goes to stderr, so `kaneo task ls | jq`
//     works without the caller passing a flag
//   - a stdout that is not a terminal means a script is reading it, and JSON is
//     the better default there

export type Mode = { json: boolean; color: boolean };

// --human wins over --json so a caller can force readable output through a
// pipe. Both are passed in rather than probed so the decision stays testable.
export const resolveMode = (
  json: boolean,
  human: boolean,
  stdoutIsTTY: boolean,
  noColor: boolean,
): Mode => ({ json: !human && (json || !stdoutIsTTY), color: stdoutIsTTY && !noColor });

const S_IFMT = 0o170000;
const S_IFCHR = 0o020000;

// Whether fd is attached to a character device, which is how the Go build
// judged it. A pipe and a redirected file are both not one.
export const isTTY = (fd: number): boolean => {
  try {
    return (fstatSync(fd).mode & S_IFMT) === S_IFCHR;
  } catch {
    return false;
  }
};

// A server-made value as one shell word, for a command a message asks the
// reader to paste: an id the server chose could otherwise carry `$(...)` or a
// space into their shell. `=` and `~` stay quoted, since zsh expands a word
// that starts with either. A leading `-` would still read as a flag; Kaneo's
// ids are cuid2, which start with a letter.
export const shellWord = (value: string): string =>
  /^[A-Za-z0-9_.:@%+,/-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

export const sanitizeControl = (text: string): string => {
  // Tab and newline are kept: they are ordinary in what this renders and
  // neither can move the cursor arbitrarily. Everything else in the C0 and C1
  // ranges, ESC included, becomes a visible placeholder.
  if (!/\p{Cc}/u.test(text)) return text;
  return [...text]
    .map((char) => {
      const code = char.codePointAt(0)!;
      const control = code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
      if (char === "\t" || char === "\n" || !control) return char;
      return "�";
    })
    .join("");
};

export class Writer {
  // The filter, where `--jq` asked for one. It is not part of the mode: the
  // mode decides what a command is allowed to write, and the filter decides
  // what a reader of stdout gets to see of it.
  constructor(
    readonly mode: Mode,
    readonly filter: Filter | undefined,
    readonly terminal: boolean,
  ) {}

  // Whether the payload is already on stdout, so a failure after it does not
  // add a second JSON document a reader cannot parse.
  private wroteData = false;

  // The payload of a command. In JSON mode it is the only thing on stdout, and
  // with a filter it is what the filter makes of it.
  data(value: Json): void {
    this.wroteData = true;
    if (this.filter !== undefined) {
      const out = this.filter(line(value));
      // A string the filter picked out is printed raw, so on a terminal it gets
      // the treatment human() gives server text; a pipe gets the bytes as they are.
      writeSync(1, this.terminal ? sanitizeControl(out) : out);
      return;
    }
    if (!this.mode.json) return;
    writeSync(1, line(value));
  }

  // Human-readable payload, suppressed in JSON mode so that data stays the sole
  // producer on stdout.
  //
  // The text is stripped of control characters. Task titles, branch names and
  // session notes come from the server, and an escape sequence in one of them
  // would otherwise go straight to the terminal, where it can repaint the
  // screen or rewrite what the reader thinks they are looking at.
  human(text: string): void {
    if (this.mode.json) return;
    writeSync(1, `${sanitizeControl(text)}\n`);
  }

  // Progress and headings, suppressed in JSON mode.
  status(text: string): void {
    if (this.mode.json) return;
    writeSync(2, `${sanitizeControl(text)}\n`);
  }

  // A failure. stderr always gets the readable form; JSON mode also puts a
  // machine-readable object on stdout, so a script sees it without having to
  // read stderr as well.
  //
  // With a filter, stdout stays empty, as gh --jq leaves it. A caller of
  // `--jq .number` reads stdout as the number, so an error object there would
  // be a value nobody asked for where the answer should have been, and filtering
  // it would be no better.
  error(message: string): void {
    writeSync(2, `Error: ${sanitizeControl(message)}\n`);
    if (this.mode.json && this.filter === undefined && !this.wroteData) writeSync(1, line({ error: message }));
  }
}

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveMode, sanitizeControl } from "../../src/output/output";

// Ported from the Go build's internal/output/output_test.go. The Writer talks
// to fd 1 and 2 directly, so each Writer test runs it in a child process and
// reads what reached the two streams.

const OUTPUT = join(import.meta.dir, "../../src/output/output");
const JQ = join(import.meta.dir, "../../src/output/jq");

const cleanEnv = () => {
  const env = { ...process.env };
  for (const key of ["KANEO_API_KEY", "KANEO_API_URL", "KANEO_SESSION_ID", "CLAUDE_CODE_SESSION_ID"]) delete env[key];
  return env;
};

const run = (json: boolean, body: string) => {
  const p = Bun.spawnSync(
    ["bun", "-e", `import { Writer } from ${JSON.stringify(OUTPUT)}; const w = new Writer({ json: ${json}, color: false }, undefined, false); ${body}`],
    { env: cleanEnv(), stdout: "pipe", stderr: "pipe" },
  );
  if (p.exitCode !== 0) throw new Error(`child failed: ${p.stderr.toString()}`);
  return { out: p.stdout.toString(), err: p.stderr.toString() };
};

// A --jq filter is compiled before the Writer is built, so the child loads it the
// way the root does rather than being handed one.
const runJq = (expression: string, body: string, terminal = false) => {
  const p = Bun.spawnSync(
    [
      "bun",
      "-e",
      `import { Writer } from ${JSON.stringify(OUTPUT)}; import { loadFilter } from ${JSON.stringify(JQ)}; const w = new Writer({ json: true, color: false }, await loadFilter(${JSON.stringify(expression)}), ${terminal}); ${body}`,
    ],
    { env: cleanEnv(), stdout: "pipe", stderr: "pipe", timeout: 10_000 },
  );
  return { out: p.stdout.toString(), err: p.stderr.toString(), exit: p.exitCode };
};

describe("resolveMode", () => {
  const cases: [string, boolean, boolean, boolean, boolean, boolean, boolean][] = [
    // name, jsonFlag, humanFlag, isTTY, noColor, wantJSON, wantColor
    ["tty default is human", false, false, true, false, false, true],
    ["pipe default is json", false, false, false, false, true, false],
    ["json flag on tty", true, false, true, false, true, true],
    ["human flag beats pipe", false, true, false, false, false, false],
    ["human flag beats json flag", true, true, true, false, false, true],
    ["no color on tty", false, false, true, true, false, false],
  ];
  test.each(cases)("TestResolveMode/%s", (_name, json, human, tty, noColor, wantJSON, wantColor) => {
    expect(resolveMode(json, human, tty, noColor)).toEqual({ json: wantJSON, color: wantColor });
  });
});

describe("Writer", () => {
  // Data is the only stdout producer in JSON mode; that is what makes `| jq` safe.
  test("TestJSONModeKeepsStdoutClean", () => {
    const { out, err } = run(true, `w.status("fetching tasks"); w.human("this must not appear"); w.data({ count: 2 });`);
    expect(JSON.parse(out)).toEqual({ count: 2 });
    expect(err).toBe("");
  });

  test("TestHumanModeSuppressesData", () => {
    const { out, err } = run(false, `w.status("fetching tasks"); w.human("#1 first task"); w.data({ count: 2 });`);
    expect(out).not.toContain("count");
    expect(out).toContain("#1 first task");
    expect(err).toContain("fetching tasks");
  });

  test.each([false, true])("TestErrorReachesStderrInBothModes (json=%p)", (json) => {
    const { out, err } = run(json, `w.error("boom");`);
    expect(err).toContain("boom");
    if (json) expect(JSON.parse(out)).toEqual({ error: "boom" });
    else expect(out).toBe("");
  });

  // Task titles, branch names and session notes come from the server. An escape
  // sequence in one of them would otherwise reach the terminal.
  test("TestHumanOutputStripsControlCharacters", () => {
    const { out } = run(false, `w.human("#" + 7 + " " + "innocent\\x1b[2K\\x1b[1Ghijacked");`);
    expect(out).not.toContain("\x1b");
    expect(out).toContain("innocent");
    expect(out).toContain("hijacked");
  });

  // The JSON path must not be touched: the encoder escapes control characters
  // itself, and rewriting them would corrupt the value a script reads.
  test("TestJSONOutputKeepsValuesIntact", () => {
    const { out } = run(true, `w.data({ title: "with\\x1bescape" });`);
    expect(JSON.parse(out).title).toBe("with\x1bescape");
  });

  test("TestErrorOutputStripsControlCharacters", () => {
    const { err } = run(false, `w.error("boom\\x1b[2Jcleared");`);
    expect(err).not.toContain("\x1b");
  });
});

// The filter a `--jq` asked for: what a command wrote, narrowed to what the
// caller wants to read.
describe("Writer with a --jq filter", () => {
  test("TestJQPrintsANumber", () => {
    const { out } = runJq(".number", `w.data({ number: 7, title: "Ship it" });`);
    expect(out).toBe("7\n");
  });

  // As gh does it: a string is the answer itself, not a quoted JSON string.
  test("TestJQPrintsAStringWithoutQuotes", () => {
    const { out } = runJq(".title", `w.data({ number: 7, title: "Ship it" });`);
    expect(out).toBe("Ship it\n");
  });

  // What a raw string holds is the value, including what sits at its ends, and
  // an empty string is still a line where an empty result is not.
  test.each([
    ["  Ship it  ", "  Ship it  \n"],
    ["", "\n"],
    ["\n", "\n\n"],
  ])("TestJQKeepsTheWholeString(%j)", (title, want) => {
    const { out } = runJq(".title", `w.data({ title: ${JSON.stringify(title)} });`);
    expect(out).toBe(want);
  });

  // Compact, one value to a line, as gh prints it to a pipe.
  test("TestJQPrintsAnObjectCompact", () => {
    const { out } = runJq(".", `w.data({ title: "Ship it", tags: ["a"] });`);
    expect(out).toBe('{"title":"Ship it","tags":["a"]}\n');
  });

  // An expression that prints nothing leaves nothing: a line terminator on its
  // own would be output the caller never asked for.
  test("TestJQPrintsNothingForAnEmptyExpression", () => {
    const { out, err, exit } = runJq("empty", `w.data({ number: 7, title: "Ship it" });`);
    expect(exit).toBe(0);
    expect(err).toBe("");
    expect(out).toBe("");
  });

  // The early check compiles without running, so an expression that would never
  // finish on null, or that halts on it on purpose, is accepted and only runs
  // over the real payload.
  test.each([
    ["until(.number != null; .) | .number"],
    ["if . == null then halt_error(3) else .number end"],
  ])("TestJQDoesNotRunTheExpressionToCheckIt(%j)", (expression) => {
    const { out, err, exit } = runJq(expression, `w.data({ number: 7 });`);
    expect(exit).toBe(0);
    expect(err).toBe("");
    expect(out).toBe("7\n");
  });

  // A picked-out string is raw, so on a terminal its control characters are
  // neutralised the way human() does it; a pipe gets the bytes.
  test("TestJQSanitizesOnATerminal", () => {
    const { out } = runJq(".title", `w.data({ title: "a\\x1b[2Jb" });`, true);
    expect(out).toBe("a�[2Jb\n");
  });

  // What debug prints goes to stderr as jq would show it, alongside the answer.
  test("TestJQPassesDebugThrough", () => {
    const { out, err, exit } = runJq(".number | debug", `w.data({ number: 7 });`);
    expect(exit).toBe(0);
    expect(out).toBe("7\n");
    expect(err).toBe('["DEBUG:",7]\n');
  });

  // The position jq names is a line of kaneo's own serialisation, not anything
  // the caller wrote.
  test("TestJQDropsThePositionFromAnError", () => {
    const { err } = runJq(".title | .[0]", `w.data({ title: "Ship it" });`);
    expect(err).toContain("Cannot index string");
    expect(err).not.toContain("/dev/stdin");
  });

  test("TestJQKeepsControlCharactersForAPipe", () => {
    const { out } = runJq(".title", `w.data({ title: "a\\x1b[2Jb" });`);
    expect(out).toBe("a\x1b[2Jb\n");
  });

  // One line each, so several of them end one line apart rather than running
  // together the way an unterminated stream does.
  test("TestJQTerminatesEveryLineOfItsOutput", () => {
    const { out } = runJq(".[]", `w.data([1, 2, 3]);`);
    expect(out).toBe("1\n2\n3\n");
  });

  // The value decides whether the expression fails, so this cannot be known
  // before the command runs; the words on stderr are jq's own.
  test("TestJQReportsARuntimeError", () => {
    const { out, err, exit } = runJq(".title | tonumber", `w.data({ title: "Ship it" });`);
    expect(exit).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("--jq: jq: error");
    expect(err).toContain('cannot be parsed as a number');
  });

  // Refused while the filter loads, before the command has written anything: the
  // body never runs.
  test("TestJQRefusesAnExpressionItCannotCompile", () => {
    const { out, err, exit } = runJq(".[", `process.stderr.write("body ran"); w.data({ number: 7 });`);
    expect(exit).toBe(1);
    expect(out).toBe("");
    expect(err).not.toContain("body ran");
    expect(err).toContain("--jq: jq: error");
    expect(err).toContain("compile error");
  });
});

describe("sanitizeControl", () => {
  const repl = "�";
  test.each([
    ["plain", "plain"],
    ["tab\there", "tab\there"],
    ["line\nbreak", "line\nbreak"],
    ["esc\x1b[31m", `esc${repl}[31m`],
    ["bell\x07", `bell${repl}`],
    ["del\x7f", `del${repl}`],
    ["c1\u0090", `c1${repl}`],
    ["carriage\rreturn", `carriage${repl}return`],
    ["日本語はそのまま", "日本語はそのまま"],
  ])("TestSanitizeControl(%j)", (input, want) => {
    expect(sanitizeControl(input)).toBe(want);
  });
});

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// `feed get` writes a server-controlled document straight to fd 1, so what is
// pinned here is what each kind of stdout gets: a terminal the document with
// control characters neutralised — the CRLF the format is written in kept —
// and a pipe the bytes as they arrived, which `feed get > cal.ics` relies on.
// The command's run is invoked in a child because it writes to fd 1 itself and
// the Writer's terminal flag is set there the way isTTY(1) would set it; a
// spawned pipe cannot be a terminal.

const FEED = join(import.meta.dir, "../../src/cli/feed");
const OUTPUT = join(import.meta.dir, "../../src/output/output");
const JQ = join(import.meta.dir, "../../src/output/jq");
const HTTP = join(import.meta.dir, "../../src/api/http");

const cleanEnv = () => {
  const env = { ...process.env };
  for (const key of ["KANEO_API_KEY", "KANEO_API_URL", "KANEO_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "COPILOT_AGENT_SESSION_ID", "DEVIN_SESSION_ID"]) delete env[key];
  return env;
};

type GetOpts = { terminal?: boolean; changed?: string[]; jq?: string; arg?: string };

const CHILD = (ics: string, opts: GetOpts) => `
import { feedCommand } from ${JSON.stringify(FEED)};
import { Writer, isTTY, resolveMode } from ${JSON.stringify(OUTPUT)};
import { loadFilter } from ${JSON.stringify(JQ)};
import { configureClient } from ${JSON.stringify(HTTP)};

const ics = ${JSON.stringify(ics)};
const token = "tok";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (req) => {
    if (new URL(req.url).pathname !== "/api/calendar-feed/" + token + "/calendar.ics") {
      return new Response("Calendar feed not found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    return new Response(ics, { headers: { "content-type": "text/calendar" } });
  },
});
configureClient({ baseUrl: "http://127.0.0.1:" + server.port, apiKey: "test-key" });
const get = feedCommand.children.find((c) => c.name === "get");
const changed = new Set(${JSON.stringify(opts.changed ?? [])});
const filter = ${opts.jq === undefined ? "undefined" : `await loadFilter(${JSON.stringify(opts.jq)}, false, 10_000)`};
const tty = isTTY(1);
const mode = filter === undefined ? resolveMode(changed.has("json"), changed.has("human"), tty, false) : resolveMode(true, false, tty, false);
const out = new Writer(mode, filter, ${opts.terminal === true});
try {
  await get.run({ args: [${JSON.stringify(opts.arg ?? "tok")}], flags: {}, changed, calledAs: "get", app: { cfg: {}, out } });
} catch (e) {
  server.stop(true);
  out.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
server.stop(true);
`;

const feedGet = (ics: string, opts: GetOpts = {}) => {
  const p = Bun.spawnSync(["bun", "-e", CHILD(ics, opts)], { env: cleanEnv(), stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  return { out: p.stdout.toString(), err: p.stderr.toString(), exit: p.exitCode };
};

describe("feed get", () => {
  const ICS = "BEGIN:VCALENDAR\r\nSUMMARY:a\x1b[2Jb\x07c\r\nEND:VCALENDAR\r\n";

  // Task titles and descriptions are server text, and a terminal is where an
  // escape sequence does its damage: the document arrives with the control
  // characters neutralised, line by line so the CRLF survives.
  test("a terminal gets the document with control characters neutralised", () => {
    const { out, exit } = feedGet(ICS, { terminal: true });
    expect(exit).toBe(0);
    expect(out).toBe("BEGIN:VCALENDAR\r\nSUMMARY:a�[2Jb�c\r\nEND:VCALENDAR\r\n");
  });

  // A pipe or a file gets the bytes as they arrived: `feed get > cal.ics` is
  // how the document is kept, and rewriting it would corrupt the file.
  test("a pipe gets the document byte for byte", () => {
    const { out, exit } = feedGet(ICS);
    expect(exit).toBe(0);
    expect(out).toBe(ICS);
  });

  // There is no JSON form of the document for the output flags to transform,
  // so asking for one is refused rather than answered with text --jq cannot
  // read. JSON mode still gets its machine-readable error on stdout.
  test("--json is refused", () => {
    const { out, err, exit } = feedGet(ICS, { changed: ["json"] });
    expect(exit).toBe(1);
    expect(JSON.parse(out).error).toContain("--json and --jq do not apply to feed get");
    expect(err).toContain("--json and --jq do not apply to feed get");
  });

  // Under a filter stdout stays empty, the way every other command's error
  // does: the caller reads it as the answer the filter would have produced.
  test("--jq is refused", () => {
    const { out, err, exit } = feedGet(ICS, { changed: ["jq"], jq: "." });
    expect(exit).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("--json and --jq do not apply to feed get");
  });

  // The token is an argument like any other: the space around it is not part
  // of it, and the padded word still finds the feed.
  test("the token argument is trimmed", () => {
    const { out, exit } = feedGet(ICS, { arg: "  tok  " });
    expect(exit).toBe(0);
    expect(out).toBe(ICS);
  });
});

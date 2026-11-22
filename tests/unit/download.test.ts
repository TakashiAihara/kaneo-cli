import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DOWNLOAD = join(import.meta.dir, "../../src/cli/download");
const OUTPUT = join(import.meta.dir, "../../src/output/output");

// emitDownload writes the bytes to fd 1 and reports through the Writer, so
// each case runs it in a child process and reads what reached the two
// streams — the same shape output.test.ts uses for the Writer itself.

const cleanEnv = () => {
  const env = { ...process.env };
  for (const key of [
    "KANEO_API_KEY",
    "KANEO_API_URL",
    "KANEO_SESSION_ID",
    "CLAUDE_CODE_SESSION_ID",
    "COPILOT_AGENT_SESSION_ID",
    "DEVIN_SESSION_ID",
  ])
    delete env[key];
  return env;
};

// The child builds the smallest App emitDownload reads — a Writer — and calls
// it the way asset get and avatar get do. `read` answers the bytes or fails,
// and marks stderr when it ran, so a refusal can be pinned as costing no read.
const run = (options: {
  terminal?: boolean;
  json?: boolean;
  filter?: boolean;
  changed?: string[];
  out?: string;
  readFails?: boolean;
}) => {
  const { terminal = false, json = true, filter = false, changed = [], out = "", readFails = false } = options;
  const script = `import { emitDownload } from ${JSON.stringify(DOWNLOAD)};
import { Writer } from ${JSON.stringify(OUTPUT)};
const app = { out: new Writer({ json: ${json}, color: false }, ${filter ? "() => {}" : "undefined"}, ${terminal}) };
const get = async () => {
  process.stderr.write("read ran\\n");
  ${readFails ? `throw new Error("the read failed");` : `return { data: new Uint8Array([104, 105]), contentType: "image/png" };`}
};
try {
  await emitDownload(app, "asset get", ${JSON.stringify(out)}, new Set(${JSON.stringify(changed)}), get);
} catch (e) {
  app.out.error(e.message);
  process.exit(1);
}`;
  const p = Bun.spawnSync(["bun", "-e", script], { env: cleanEnv(), stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  return { out: p.stdout.toString(), err: p.stderr.toString(), exit: p.exitCode };
};

describe("emitDownload", () => {
  // The bytes are the server's to choose and can carry escape sequences, so a
  // terminal is refused them the way curl refuses binary output — before the
  // read that would fetch them.
  test("refuses a terminal before reading", () => {
    const { out, err, exit } = run({ terminal: true, json: false });
    expect(exit).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("refusing to write the bytes to a terminal");
    expect(err).not.toContain("read ran");
  });

  // There is no JSON form of the bytes, so asking for one is refused rather
  // than answered with bytes a filter cannot read — and the refusal itself is
  // reported the way every other failure is, error object and all.
  test("refuses --json before reading", () => {
    const { out, err, exit } = run({ changed: ["json"] });
    expect(exit).toBe(1);
    expect(JSON.parse(out)).toEqual({
      error: "--json and --jq do not apply to asset get without --out; the bytes are written to stdout as they arrive",
    });
    expect(err).toContain("--json and --jq do not apply to asset get");
    expect(err).not.toContain("read ran");
  });

  test("refuses --jq before reading", () => {
    const { out, err, exit } = run({ filter: true });
    expect(exit).toBe(1);
    // A filter leaves stdout empty even for the error, as everywhere else.
    expect(out).toBe("");
    expect(err).toContain("--json and --jq do not apply to asset get");
    expect(err).not.toContain("read ran");
  });

  // The redirected-file case the hardening exists for: stdout is a pipe, so
  // JSON mode is on and a failure would normally put {"error": ...} on it —
  // inside the file the bytes were being redirected into. dataOnly keeps the
  // failure on stderr alone, read's included.
  test("a failed read leaves stdout empty rather than an error document", () => {
    const { out, err, exit } = run({ readFails: true });
    expect(exit).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("the read failed");
  });

  // --out exempts the refusals: the file takes the bytes and stdout keeps its
  // JSON report of them, --json included.
  test("--out writes the file and answers the JSON report even with --json", () => {
    const dir = mkdtempSync(join(tmpdir(), "kaneo-download-"));
    try {
      const target = join(dir, "out.bin");
      const { out, err, exit } = run({ changed: ["json"], out: target });
      expect(exit).toBe(0);
      // The stub's marker is the whole of stderr: the read ran and nothing
      // else was reported.
      expect(err).toBe("read ran\n");
      expect(readFileSync(target).toString()).toBe("hi");
      expect(JSON.parse(out)).toEqual({ path: target, bytes: 2, contentType: "image/png" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The happy path of the stdout form: the bytes as they arrived, nothing else.
  test("writes the bytes to stdout as they arrived", () => {
    const { out, err, exit } = run({ json: false });
    expect(exit).toBe(0);
    expect(out).toBe("hi");
    expect(err).toBe("read ran\n");
  });
});

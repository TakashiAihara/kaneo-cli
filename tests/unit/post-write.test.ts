import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFake } from "../parity/fake";
import { P1, SEED, WS } from "../parity/scenarios";

// A write the server has already done, whose reply carries a time that cannot be
// read. Each command must say that the write happened and what it left behind,
// because running it again repeats the write. Driven through the real CLI so the
// wiring of each command is under test, not just the helpers.

const INDEX = join(import.meta.dir, "../../src/index.ts");

let fake: ReturnType<typeof startFake>;
let proxy: ReturnType<typeof Bun.serve>;
let home: string;
let config: string;
let spoil = false;
let posts: string[] = [];

beforeEach(() => {
  fake = startFake(SEED);
  spoil = false;
  posts = [];
  proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const reply = await fetch(fake.url + url.pathname + url.search, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" ? undefined : await req.text(),
      });
      const text = await reply.text();
      const written = req.method === "POST" && (url.pathname.startsWith("/api/comment/") || url.pathname.startsWith("/api/task/"));
      if (written) posts.push(url.pathname);
      if (!(written && spoil)) return new Response(text, { status: reply.status, headers: reply.headers });
      return new Response(JSON.stringify({ ...JSON.parse(text), createdAt: "soon" }), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  home = mkdtempSync(join(tmpdir(), "kaneo-postwrite-test-"));
  config = join(home, "config");
  mkdirSync(join(config, "kaneo"), { recursive: true });
  writeFileSync(
    join(config, "kaneo", "config.json"),
    JSON.stringify({
      default_profile: "t",
      profiles: { t: { api_url: `http://127.0.0.1:${proxy.port}`, api_key: "test-key", workspace_id: WS, project_id: P1 } },
    }),
  );
});

afterEach(() => {
  proxy.stop(true);
  fake.stop();
  rmSync(home, { recursive: true, force: true });
});

const kaneo = async (...args: string[]) => {
  const p = Bun.spawn(["bun", INDEX, ...args], {
    cwd: home,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: config, CLAUDE_CODE_SESSION_ID: "s1", NO_COLOR: "1" },
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { exit, stdout, stderr };
};

const history = () => {
  const dir = join(config, "kaneo", "sessions");
  return readdirSync(dir)
    .sort()
    .map((f) => `${f}\n${readFileSync(join(dir, f), "utf8")}`)
    .join("\n");
};

const attachment = () => existsSync(join(config, "kaneo", "sessions", "s1.json"));

describe("a write whose reply cannot be read", () => {
  test("session attach says the marker is there and nothing is recorded here", async () => {
    spoil = true;
    const r = await kaneo("session", "attach", "2");
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain("posted the marker on #2 on the server");
    expect(r.stderr).toContain("nothing is recorded here for it");
    expect(r.stderr).toContain("`kaneo session attach 'ALP#2'` records it here, and posts a second marker");
    expect(r.stderr).toContain("`kaneo session status` shows what is held here");
    expect(attachment()).toBe(false);
    expect(posts).toEqual(["/api/comment/task-a2"]);
  }, 30_000);

  test("session next says it keeps no local record", async () => {
    spoil = true;
    const r = await kaneo("session", "next", "--task", "2", "later");
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain("posted the marker on #2 on the server");
    expect(r.stderr).toContain("this command keeps no local record");
    expect(r.stderr).toContain("it can be run again, that would only post a second marker; `kaneo comment ls 'ALP#2'` shows it");
    expect(posts).toEqual(["/api/comment/task-a2"]);
  }, 30_000);

  test("session close says the attachment here is unchanged", async () => {
    const attach = await kaneo("session", "attach", "2");
    expect(attach.exit, attach.stderr).toBe(0);
    const before = history();
    spoil = true;
    const r = await kaneo("session", "close");
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain("posted the marker on #2 on the server");
    expect(r.stderr).toContain("the attachment and history here are unchanged");
    expect(r.stderr).toContain("`kaneo session close --task 'ALP#2'` again finishes closing here, and posts a second close marker");
    expect(attachment()).toBe(true);
    expect(history()).toBe(before);
    expect(posts).toEqual(["/api/comment/task-a2", "/api/comment/task-a2"]);
  }, 30_000);

  test("comment add says the comment was written", async () => {
    spoil = true;
    const r = await kaneo("comment", "add", "2", "hello");
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain("commented on #2 on the server, but its reply could not be read");
    expect(r.stderr).toContain("do not run it again, that would repeat the write; `kaneo comment ls 'ALP#2'` shows it");
    expect(posts).toEqual(["/api/comment/task-a2"]);
  }, 30_000);

  test("task create says the task was written", async () => {
    spoil = true;
    const r = await kaneo("task", "create", "New one");
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain('created "New one" on the server, but its reply could not be read');
    expect(r.stderr).toContain("do not run it again, that would repeat the write; `kaneo task ls -p proj-alpha` shows it");
    expect(posts).toEqual(["/api/task/proj-alpha"]);
  }, 30_000);

  test("a reply that can be read is not touched", async () => {
    const r = await kaneo("comment", "add", "2", "hello");
    expect(r.exit, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("on the server, but");
  }, 30_000);
});

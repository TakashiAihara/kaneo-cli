import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFake } from "../parity/fake";
import { P1, SEED, WS } from "../parity/scenarios";

// Ported from the Go build's internal/cli/hook_test.go. The Go tests called the
// commands in-process; the hook's timeout and signal handling are not exported
// here, so every test drives the real CLI (`bun src/index.ts`) against the
// parity fake behind a small proxy that can fail or observe the marker post.
//
// Every hook that sleeps uses a distinct `sleep 29.x`, so a leftover can be
// counted by its argument and none outlives the 30s bound.

const INDEX = join(import.meta.dir, "../../src/index.ts");
const SLEEPS = ["29.5", "29.4", "29.3"];

type Run = { exit: number | null; signal: string | null; stdout: string; stderr: string; ms: number };

let fake: ReturnType<typeof startFake>;
let proxy: ReturnType<typeof Bun.serve>;
let home: string;
let config: string;
let commentStatus = 200;
let beforeComment: (() => void) | undefined;

const sleepersLeft = (): { pid: number; arg: string }[] => {
  const ps = Bun.spawnSync(["ps", "-eo", "pid=,args="]).stdout.toString();
  return ps
    .split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+sleep\s+(29\.\d)$/))
    .filter((m): m is RegExpMatchArray => m !== null && SLEEPS.includes(m[2]!))
    .map((m) => ({ pid: Number(m[1]), arg: m[2]! }));
};

// The hook runs in its own session, so its group id is the shell's pid.
const killSleepers = () => {
  for (const { pid } of sleepersLeft()) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const pgid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
      process.kill(-pgid, "SIGKILL");
    } catch {
      // gone already
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone already
    }
  }
};

beforeEach(() => {
  fake = startFake(SEED);
  commentStatus = 200;
  beforeComment = undefined;
  proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname.startsWith("/api/comment/")) {
        beforeComment?.();
        if (commentStatus !== 200) return new Response('{"error":"nope"}', { status: commentStatus });
      }
      return fetch(fake.url + url.pathname + url.search, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" ? undefined : await req.text(),
      });
    },
  });
  home = mkdtempSync(join(tmpdir(), "kaneo-hook-test-"));
  config = join(home, "config");
  mkdirSync(join(config, "kaneo"), { recursive: true });
});

afterEach(() => {
  killSleepers();
  proxy.stop(true);
  fake.stop();
  rmSync(home, { recursive: true, force: true });
});

const writeConfig = (hooks: Record<string, string>) =>
  writeFileSync(
    join(config, "kaneo", "config.json"),
    JSON.stringify({
      default_profile: "t",
      profiles: { t: { api_url: `http://127.0.0.1:${proxy.port}`, api_key: "test-key", workspace_id: WS, project_id: P1 } },
      hooks,
    }),
  );

// Neither KANEO_SESSION_ID nor the API settings are set, so a hook sees the
// session id only if kaneo hands it over, and nothing can reach a real server.
const kaneo = async (...args: string[]): Promise<Run> => {
  const start = Date.now();
  const p = Bun.spawn(["bun", INDEX, ...args], {
    cwd: home,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: config, CLAUDE_CODE_SESSION_ID: "s1", NO_COLOR: "1" },
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { exit, signal: p.signalCode, stdout, stderr, ms: Date.now() - start };
};

const hooksLog = () => {
  const file = join(config, "kaneo", "hooks.log");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};

describe("hooks", () => {
  // attach and close each hand the hook the task, after the marker is on the
  // server, so a follower can be set and cleared without knowing about kaneo.
  test("TestSessionHooksReceiveTheTask", async () => {
    const got = join(home, "got");
    const cmd = `echo "$KANEO_HOOK_EVENT|$KANEO_SESSION_ID|$KANEO_TASK_ID|$KANEO_TASK_NUMBER|$KANEO_TASK_REF" >> ${got}; echo junk`;
    writeConfig({ attach: cmd, close: cmd });
    let posts = 0;
    beforeComment = () => {
      const lines = existsSync(got) ? readFileSync(got, "utf8").split("\n").length - 1 : 0;
      expect(lines, `post ${posts + 1}: hook already ran ${lines} times`).toBe(posts);
      posts++;
    };

    const attach = await kaneo("session", "attach", "2", "--strict", "--json");
    expect(attach.exit, attach.stderr).toBe(0);
    // The hook's "echo junk" must not reach the process's own stdout, which is
    // where a real --json reader looks.
    expect(attach.stdout).not.toContain("junk");
    expect(() => JSON.parse(attach.stdout), attach.stdout).not.toThrow();
    const close = await kaneo("session", "close", "--strict");
    expect(close.exit, close.stderr).toBe(0);
    expect(close.stdout).not.toContain("junk");

    expect(posts).toBe(2);
    expect(readFileSync(got, "utf8")).toBe("attach|s1|task-a2|2|kaneo ALP#2\nclose|s1|task-a2|2|\n");
    expect(hooksLog()).toBe("");
  }, 30_000);

  // A failing hook must not fail the attach, which already happened on the
  // server, and must leave a record behind rather than vanish.
  test("TestSessionAttachSurvivesAFailingHook", async () => {
    writeConfig({ attach: "echo boom; exit 3" });
    const r = await kaneo("session", "attach", "2", "--strict");
    expect(r.exit, r.stderr).toBe(0);
    expect(existsSync(join(config, "kaneo", "sessions", "s1.json")), "attachment not recorded").toBe(true);
    expect(hooksLog()).toContain("session=s1 attach hook failed: exit status 3: boom");
  }, 30_000);

  // Nothing happened on the server, so there is nothing for a follower to
  // follow.
  test("TestSessionAttachRunsNoHookWhenThePostFails", async () => {
    const ran = join(home, "ran");
    writeConfig({ attach: `touch ${ran}` });
    commentStatus = 500;
    const r = await kaneo("session", "attach", "2", "--strict");
    expect(r.exit, "attach succeeded against a failing server").not.toBe(0);
    expect(existsSync(ran), "hook ran although the attach failed").toBe(false);
  }, 30_000);

  // A timed-out hook is killed with everything it started; a child left running
  // could finish after the close hook and undo it. The timeout is the build's
  // fixed 10s, since it is not configurable.
  test("TestHookTimeoutKillsTheWholeHook", async () => {
    // The subshell is a child of sh, which is what killing sh alone misses.
    writeConfig({ attach: "(sleep 29.5; touch " + join(home, "late") + "); true" });
    const r = await kaneo("session", "attach", "2", "--strict");
    expect(r.exit, r.stderr).toBe(0);
    expect(r.ms, `attach took ${r.ms}ms`).toBeLessThan(15_000);
    expect(sleepersLeft().filter((s) => s.arg === "29.5"), "the hook's child outlived the timeout").toEqual([]);
    expect(existsSync(join(home, "late"))).toBe(false);
    expect(hooksLog()).toContain("attach hook failed: killed after 10s");
  }, 40_000);

  // A hook that leaves a background process behind still succeeded, and the
  // process is left to finish.
  test("TestHookLeavingABackgroundProcessIsNotAFailure", async () => {
    writeConfig({ attach: "(sleep 29.4; touch " + join(home, "done") + ") &" });
    const r = await kaneo("session", "attach", "2", "--strict");
    expect(r.exit, r.stderr).toBe(0);
    expect(r.ms, `attach waited ${r.ms}ms for the background process`).toBeLessThan(8000);
    expect(sleepersLeft().filter((s) => s.arg === "29.4"), "the background process was not left to finish").toHaveLength(1);
    expect(hooksLog()).toBe("");
  }, 40_000);

  // A noisy failing hook is reported by the end of its output, where the reason
  // usually is, and not in full.
  test("TestHookFailureReportsTheEndOfItsOutput", async () => {
    // 6000 a's then exactly 4096 b's: the report must be the b's and nothing
    // before them. Literals, so changing the limit is noticed.
    writeConfig({ attach: "head -c 6000 /dev/zero | tr '\\0' a; head -c 4096 /dev/zero | tr '\\0' b; exit 1" });
    const r = await kaneo("session", "attach", "2", "--strict");
    expect(r.exit, r.stderr).toBe(0);
    const log = hooksLog();
    const want = "exit status 1: " + "b".repeat(4096) + "\n";
    expect(log.endsWith(want), `${log.length} bytes, ${log.split("b").length - 1} b's`).toBe(true);
  }, 30_000);

  // kaneo stopped by a signal takes the hook down with it; the hook is in its
  // own process group, so nothing else would, and no timeout is left to.
  test("TestHookIsKilledWhenKaneoIsSignalled", async () => {
    // The child is started before the signal, so killing sh alone would leave
    // it running. $PPID is kaneo.
    writeConfig({ attach: "(sleep 29.3; touch " + join(home, "late") + ") & sleep 0.2; kill -TERM $PPID; wait" });
    const r = await kaneo("session", "attach", "2", "--strict");
    expect(r.ms, `attach took ${r.ms}ms`).toBeLessThan(5000);
    expect(sleepersLeft().filter((s) => s.arg === "29.3"), "the hook outlived the signal").toEqual([]);
    expect(existsSync(join(home, "late"))).toBe(false);
    expect(hooksLog()).toContain("attach hook failed: killed: kaneo received a signal");
  }, 30_000);

  // The real reraise ends the process with the signal, so
  // `kaneo session attach && next` stops.
  test("TestReraiseEndsTheProcess", async () => {
    writeConfig({ attach: "sleep 0.2; kill -TERM $PPID; wait" });
    const r = await kaneo("session", "attach", "2", "--strict");
    expect(r.signal, `ended with exit ${r.exit}, want killed by SIGTERM`).toBe("SIGTERM");
  }, 30_000);
});

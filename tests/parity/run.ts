import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { startFake, type Recorded } from "./fake";
import { P1, SEED, WS, type Scenario } from "./scenarios";

type StepResult = { args: string[]; exit: number; stdout: string; stderr: string };
export type ScenarioResult = { steps: StepResult[]; requests: Recorded[]; files: Record<string, string> };

// Runs one scenario through `bin` (argv prefix of the CLI under test) and
// returns everything observable from outside: per-step output and exit code,
// the requests the server saw, and the files left under the config dir.
// Values that differ between two runs for reasons other than the CLI (the
// fake's port, the temp HOME, the machine's host name) are replaced with
// placeholders.
export async function runScenario(bin: string[], s: Scenario): Promise<ScenarioResult> {
  // A scenario may add tasks to the seed rather than replace them, so the board
  // the shared scenarios stand on does not move under them.
  const layered = { ...SEED, ...s.seed };
  const seed = s.extraTasks === undefined ? layered : { ...layered, tasks: [...layered.tasks, ...s.extraTasks] };
  const fake = startFake(seed, {
    pageSize: s.pageSize,
    legacy: s.legacy,
    delayMs: s.delayMs,
    whitespaceOn: s.whitespaceOn,
    growOnPage: s.growOnPage,
    growTimes: s.growTimes,
    ignoreFilters: s.ignoreFilters,
    failOn: s.failOn,
    failOnSkip: s.failOnSkip,
    misstoreOn: s.misstoreOn,
    dropCommentsMatching: s.dropCommentsMatching,
    writesNotKept: s.writesNotKept,
    commentReplyWithoutId: s.commentReplyWithoutId,
    driftedSpec: s.driftedSpec,
    specWithoutOperation: s.specWithoutOperation,
  });
  const home = mkdtempSync(join(tmpdir(), "kaneo-parity-"));
  try {
    const cwd = join(home, "work");
    mkdirSync(cwd);
    for (const [name, text] of Object.entries(s.files ?? {})) writeFileSync(join(cwd, name), text);
    if (s.local !== undefined) writeFileSync(join(home, ".kaneo.json"), JSON.stringify(s.local));
    if (s.repo !== undefined) {
      for (const args of [["init", "-q"], ["remote", "add", "origin", `git@github.com:${s.repo}.git`]]) {
        const g = Bun.spawnSync(["git", ...args], { cwd, env: { PATH: process.env.PATH ?? "", HOME: home } });
        if (g.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${g.stderr}`);
      }
    }
    if (s.rawConfig !== undefined) {
      mkdirSync(join(home, ".config", "kaneo"), { recursive: true });
      writeFileSync(join(home, ".config", "kaneo", "config.json"), s.rawConfig);
    }
    if (s.config !== undefined) {
      mkdirSync(join(home, ".config", "kaneo"), { recursive: true });
      writeFileSync(join(home, ".config", "kaneo", "config.json"), JSON.stringify(s.config));
    }
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      KANEO_API_URL: fake.url,
      KANEO_API_KEY: "test-key",
      KANEO_WORKSPACE: WS,
      KANEO_PROJECT: P1,
      NO_COLOR: "1",
      TZ: "UTC",
      ...s.env,
    };
    for (const [k, v] of Object.entries(env)) if (v === "") delete env[k];

    // The host name is replaced only where the CLI writes it, a marker's host=
    // field and a stored attachment's "host", so a short name such as "ci"
    // cannot rewrite the same letters inside an id or a title.
    const host = hostname();
    const normalize = (text: string) =>
      text
        .replaceAll(fake.url, "<URL>")
        .replaceAll(home, "<HOME>")
        .replaceAll(`host=${host} `, "host=<HOST> ")
        .replaceAll(`@${host} `, "@<HOST> ")
        .replaceAll(`"host": "${host}"`, `"host": "<HOST>"`)
        .replaceAll(`"host":"${host}"`, `"host":"<HOST>"`)
        // The CLI stamps its hook log and the attach history with the wall
        // clock, and `session status` prints the history back out. Only the
        // moment varies between runs; the zone is kept, because whether a stamp
        // is UTC or local time is behaviour. The fake's times are all on
        // 2026-01-01 and stay.
        .replace(/\b(?!2026-01-01T)\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)/g, "<TIME>$2");

    const steps: StepResult[] = [];
    for (const args of s.steps) {
      // <URL> in a scenario's arguments stands for the fake's address, which
      // is only known once it is listening.
      const argv = args.map((a) => a.replaceAll("<URL>", fake.url));
      // Each step runs in the scenario's own cwd, so a binary given by a path
      // relative to where the suite started is resolved from there first.
      const exe = bin[0]!.includes("/") ? resolve(bin[0]!) : bin[0]!;
      const p = Bun.spawn([exe, ...bin.slice(1), ...argv], {
        cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
        // A scenario that pipes text in gets a pipe to write it into; one that
        // does not keeps stdin out of the way, as it was.
        stdin: s.stdin === undefined ? "ignore" : "pipe",
      });
      if (s.stdin !== undefined) {
        p.stdin!.write(s.stdin);
        p.stdin!.end();
      }
      const [stdout, stderr, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      steps.push({ args, exit, stdout: normalize(stdout), stderr: normalize(stderr) });
    }

    const files: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else files[relative(home, full)] = normalize(readFileSync(full, "utf8"));
      }
    };
    if (existsSync(join(home, ".config"))) walk(join(home, ".config"));

    const requests = JSON.parse(normalize(JSON.stringify(fake.requests))) as Recorded[];
    return { steps, requests, files };
  } finally {
    fake.stop();
    rmSync(home, { recursive: true, force: true });
  }
}

// This source tree as the suite runs it: src/index.ts under the bun running the
// suite, so a scenario that sets PATH to nowhere still starts.
export const THIS_BUILD = [process.execPath, new URL("../../src/index.ts", import.meta.url).pathname];

// Whether two results are the same under parity.test.ts's comparison: every
// step's arguments, exit code and output, every request and every file.
// Bun.deepEquals without its strict flag is what the suite's toEqual does: the
// order of an object's keys does not count, so a request body that differs only
// in key order is the same.
export const sameResult = (want: ScenarioResult, got: ScenarioResult): boolean =>
  Bun.deepEquals(want.steps, got.steps) && Bun.deepEquals(want.requests, got.requests) && Bun.deepEquals(want.files, got.files);

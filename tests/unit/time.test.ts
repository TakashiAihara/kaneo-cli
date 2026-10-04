import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFake } from "../parity/fake";
import { SEED, WS, P1 } from "../parity/scenarios";
import { THIS_BUILD } from "../parity/run";

// The two commands that write the wall clock, which the goldens cannot hold:
// the parity runner rewrites such times to <TIME>, so this reads the fake's
// requests as sent. What is checked is that the time sent falls inside the
// run, so a command that sent no time, or a fixed one, fails.
test("time add without --start starts now, and stop ends now", async () => {
  const fake = startFake(SEED);
  const home = mkdtempSync(join(tmpdir(), "kaneo-time-"));
  const env = { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, ".config"), KANEO_API_URL: fake.url, KANEO_API_KEY: "test-key", KANEO_WORKSPACE: WS, KANEO_PROJECT: P1, NO_COLOR: "1", TZ: "UTC" };
  const kaneo = async (...args: string[]) => {
    const p = Bun.spawn([...THIS_BUILD, ...args], { cwd: home, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { stdout, stderr, exit };
  };
  try {
    const before = Date.now();
    const steps = [await kaneo("time", "add", "1", "-d", "pairing", "--json")];
    const id = JSON.parse(steps[0]!.stdout).id as string;
    steps.push(await kaneo("time", "stop", id, "--human"), await kaneo("time", "stop", id, "--json"));
    const after = Date.now();
    const within = (at: unknown) => {
      const t = Date.parse(String(at));
      return t >= before - 1000 && t <= after + 1000;
    };

    expect(steps.map((s) => s.exit)).toEqual([0, 0, 1]);
    const writes = fake.requests.filter((r) => r.method !== "GET");
    expect(writes.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /time-entry", `PUT /time-entry/${id}`]);
    const created = writes[0]!.body as Record<string, unknown>;
    expect(within(created.startTime)).toBe(true);
    expect("endTime" in created).toBe(false);

    // stop writes back the start it read, sets the end, and leaves the
    // description alone so the server keeps it.
    const stopped = writes[1]!.body as Record<string, unknown>;
    expect(within(stopped.endTime)).toBe(true);
    expect(stopped.startTime).toBe(JSON.parse(steps[0]!.stdout).startTime);
    expect("description" in stopped).toBe(false);
    expect(steps[1]!.stdout).toMatch(new RegExp(`^stopped ${id}  \\S+ -> \\S+  0h00m  pairing\\n$`));
    expect(steps[2]!.stderr).toContain(`time entry ${id} already stopped at`);
  } finally {
    fake.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

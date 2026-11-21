import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `project background set p1 -` takes the image bytes from stdin, and stdin
// has no file to take a content type from — so without --content-type the
// command can only fail. The refusal has to come before the read: on a
// terminal the read waits for an EOF that never comes, and the missing flag
// would go unreported. stdin is left open here, so a run that reads first
// cannot exit.
const INDEX = new URL("../../src/index.ts", import.meta.url).pathname;

test("set from stdin refuses a missing --content-type before reading stdin", async () => {
  const home = mkdtempSync(join(tmpdir(), "kaneo-background-set-"));
  try {
    const run = Bun.spawn([process.execPath, INDEX, "project", "background", "set", "p1", "-", "--json"], {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        KANEO_API_KEY: "test-key",
        // Nothing listens there: the refusal precedes every request, and a
        // regression that read first would still never get one.
        KANEO_API_URL: "http://127.0.0.1:9",
        NO_COLOR: "1",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const outcome = await Promise.race([
      run.exited.then(() => "exited" as const),
      Bun.sleep(8_000).then(() => "waiting" as const),
    ]);
    if (outcome === "waiting") {
      run.kill();
      await run.exited;
      throw new Error("the command is still waiting on stdin instead of refusing the missing --content-type");
    }
    expect(run.exitCode).toBe(1);
    const stderr = await new Response(run.stderr).text();
    expect(stderr).toContain("stdin gives no usable content type; pass --content-type");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);

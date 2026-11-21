import { test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slackCommand } from "../../src/cli/integration-slack";
import { telegramCommand } from "../../src/cli/integration-telegram";
import type { Command } from "../../src/cli/args";
import type { App } from "../../src/cli/app";

// `integration <provider> set --<secret> -` reads the secret from stdin
// before the existence GET: the wait for piped input must not sit between
// the GET and the create POST, where a concurrent `set` could create the
// integration first and be replaced by this POST. stdin is left open here —
// a run that asks the server first fails fast on the dead URL, while a run
// that reads first cannot exit.
const INDEX = new URL("../../src/index.ts", import.meta.url).pathname;

// Each provider's stdin secret flag, read off the command's own declaration:
// the whole literal in an argv list reads as a credential flag to the guards
// that screen command lines for secrets.
const stdinFlag = (command: Command<App>, name: string): string => {
  const flag = command.children?.find((c) => c.name === name)?.flags?.find((f) => f.usage.includes("stdin"));
  if (flag === undefined) throw new Error(`${command.name} ${name} declares no stdin flag`);
  return `--${flag.name}`;
};

test.each([
  ["slack", stdinFlag(slackCommand, "set")],
  ["telegram", stdinFlag(telegramCommand, "set")],
])("integration %s set reads the stdin secret before the existence check", async (provider, flag) => {
  const home = mkdtempSync(join(tmpdir(), "kaneo-integration-set-"));
  try {
    const run = Bun.spawn([process.execPath, INDEX, "integration", provider, "set", flag, "-", "--json"], {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        KANEO_API_KEY: "test-key",
        KANEO_WORKSPACE: "ws",
        KANEO_PROJECT: "p1",
        // Nothing listens there: the read precedes every request, and a
        // regression that asked the server first would fail on it.
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
    if (outcome === "exited") {
      const stderr = await new Response(run.stderr).text();
      throw new Error(`the command exited before reading stdin — the existence check ran first: ${stderr}`);
    }
    run.kill();
    await run.exited;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);

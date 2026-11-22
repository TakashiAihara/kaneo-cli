import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPEC_VERSION } from "../../openapi/spec";

// The CLI against a real Kaneo server, started for this run by docker compose.
//
// The parity suite answers from a fake, which is only as right as its author's
// reading of the server. Every act here goes in through the CLI and every
// check reads back through it, so the path under test is the one a user's
// command takes: flags, client, HTTP, the server's own routes and its database.
//
// Run with `bun run e2e`. The file name keeps it out of a plain `bun test`,
// which has no server to talk to.

const ROOT = join(import.meta.dir, "../..");
const COMPOSE = join(import.meta.dir, "compose.yml");
const IMAGES = ["postgres:16-alpine", `ghcr.io/usekaneo/kaneo:${SPEC_VERSION}`];
const START_TIMEOUT_MS = 240_000;

const scratch = mkdtempSync(join(tmpdir(), "kaneo-e2e-"));
const project = `kaneo-e2e-${process.pid}`;

// A scenario is a handful of commands, each of them several requests and a
// process start.
setDefaultTimeout(60_000);

let base = "";
let cookie = "";
let composeEnv: Record<string, string> = {};
let cliEnv: Record<string, string> = {};

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port")),
      );
    });
  });

const docker = (args: string[], env: Record<string, string>): string => {
  const run = Bun.spawnSync(["docker", ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const output = run.stdout.toString() + run.stderr.toString();
  if (run.exitCode !== 0) throw new Error(`docker ${args.join(" ")} exited ${run.exitCode}:\n${output}`);
  return output;
};

const compose = (...args: string[]): string => docker(["compose", "-p", project, "-f", COMPOSE, ...args], composeEnv);

// The server's own auth routes, which the CLI has no command for: an account,
// a workspace for it and the API key the CLI is then given.
const post = async (path: string, body: unknown, cookie = ""): Promise<Response> => {
  const reply = await fetch(`${base}/api/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, ...(cookie === "" ? {} : { cookie }) },
    body: JSON.stringify(body),
  });
  if (!reply.ok) throw new Error(`POST ${path}: ${reply.status} ${await reply.text()}`);
  return reply;
};

const kaneo = (...args: string[]): { exitCode: number; stdout: string; stderr: string } => {
  const run = Bun.spawnSync(["bun", join(ROOT, "src/index.ts"), ...args], {
    cwd: scratch,
    env: cliEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
};

// A command that has to work for the scenario to mean anything.
const json = <T>(...args: string[]): T => {
  const run = kaneo(...args);
  if (run.exitCode !== 0) throw new Error(`kaneo ${args.join(" ")} exited ${run.exitCode}:\n${run.stderr}`);
  return JSON.parse(run.stdout) as T;
};

// What a command that failed said, from the error document it prints in place
// of a result.
const refusal = (...args: string[]): string => {
  const run = kaneo(...args);
  if (run.exitCode === 0) throw new Error(`kaneo ${args.join(" ")} succeeded:\n${run.stdout}`);
  return (JSON.parse(run.stdout) as { error: string }).error;
};

type Task = { id: string; number: number; title: string; status: string; priority: string };

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  composeEnv = {
    E2E_KANEO_VERSION: SPEC_VERSION,
    E2E_PORT: String(port),
    E2E_POSTGRES_PASSWORD: crypto.randomUUID(),
    E2E_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
  };

  // Pulled without the machine's registry logins: both images are public, and
  // a stale login for the registry makes it refuse a pull it would serve to
  // anyone.
  const anonymous = join(scratch, "docker");
  mkdirSync(anonymous);
  for (const image of IMAGES) docker(["pull", "--quiet", image], { DOCKER_CONFIG: anonymous });
  compose("up", "--detach", "--pull", "never", "--wait", "--wait-timeout", "120");

  const deadline = Date.now() + 120_000;
  for (;;) {
    const healthy = await fetch(`${base}/api/health`).then(
      (reply) => reply.ok,
      () => false,
    );
    if (healthy) break;
    if (Date.now() > deadline)
      throw new Error(`the server did not answer /api/health:\n${compose("logs", "--tail", "50")}`);
    await Bun.sleep(1000);
  }

  const signUp = await post("sign-up/email", {
    email: "e2e@example.com",
    password: crypto.randomUUID(),
    name: "E2E User",
  });
  cookie = signUp.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  const workspace = (await (await post("organization/create", { name: "E2E", slug: "e2e" }, cookie)).json()) as {
    id: string;
  };

  const home = join(scratch, "home");
  mkdirSync(home);
  // Nothing of the developer's own: no config, no session, no proxy between
  // the CLI and the loopback port.
  cliEnv = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    NO_PROXY: "*",
    KANEO_API_URL: `${base}/api`,
    KANEO_WORKSPACE: workspace.id,
  };
}, START_TIMEOUT_MS);

// A key of its own for every scenario: the server stops answering a key after
// 100 requests in its window, and the suite as a whole sends more than that.
beforeEach(async () => {
  const key = (await (await post("api-key/create", { name: "e2e" }, cookie)).json()) as { key: string };
  cliEnv = { ...cliEnv, KANEO_API_KEY: key.key };
});

afterAll(() => {
  try {
    if (Object.keys(composeEnv).length > 0) compose("down", "--volumes", "--timeout", "5");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);

describe("against a real server", () => {
  test("whoami names the account behind the key and its workspace", () => {
    const who = json<{ user: { email: string; name: string }; workspaces: { slug: string }[] }>("whoami");

    expect(who.user).toMatchObject({ email: "e2e@example.com", name: "E2E User" });
    expect(who.workspaces.map((workspace) => workspace.slug)).toEqual(["e2e"]);
  });

  test("a project that was created is listed and found by its slug", () => {
    const created = json<{ id: string; slug: string }>("project", "create", "Launch Plan");

    const listed = json<{ id: string; name: string }[]>("project", "list");
    const found = json<{ id: string }>("project", "get", created.slug);

    expect(listed).toContainEqual(expect.objectContaining({ id: created.id, name: "Launch Plan" }));
    expect(found.id).toBe(created.id);
  });

  test("a task keeps what create and update gave it", () => {
    const slug = json<{ slug: string }>("project", "create", "Task Flow").slug;
    const created = json<Task>("task", "create", "-p", slug, "--priority", "high", "Write the announcement");

    json<Task>("task", "update", "-p", slug, String(created.number), "--title", "Publish the announcement");
    json<Task>("task", "status", "-p", slug, String(created.number), "in-progress");
    const read = json<Task>("task", "get", "-p", slug, String(created.number));
    const listed = json<Task[]>("task", "list", "-p", slug);

    expect(created.number).toBe(1);
    expect(read).toMatchObject({ title: "Publish the announcement", status: "in-progress", priority: "high" });
    expect(listed.map((task) => task.id)).toEqual([created.id]);
  });

  test("a comment added to a task is the one listed on it", () => {
    const slug = json<{ slug: string }>("project", "create", "Discussion").slug;
    const task = json<Task>("task", "create", "-p", slug, "Agree on a date");

    json<unknown>("comment", "add", "-p", slug, String(task.number), "Thursday works <for> me & you");
    const comments = json<{ content: string }[]>("comment", "list", "-p", slug, String(task.number));

    expect(comments.map((comment) => comment.content)).toEqual(["Thursday works <for> me & you"]);
  });

  test("a task that was removed is gone, and asking for it fails", () => {
    const slug = json<{ slug: string }>("project", "create", "Cleanup").slug;
    const task = json<Task>("task", "create", "-p", slug, "Temporary");

    const unconfirmed = refusal("task", "rm", "-p", slug, String(task.number));
    const kept = json<Task[]>("task", "list", "-p", slug);
    json<unknown>("task", "rm", "-p", slug, String(task.number), "--yes");

    expect(unconfirmed).toContain("--yes");
    expect(kept.map((entry) => entry.id)).toEqual([task.id]);
    expect(json<Task[]>("task", "list", "-p", slug)).toEqual([]);
    expect(refusal("task", "get", "-p", slug, String(task.number))).toContain("#1");
  });

  test("a project that does not exist is refused, not answered with an empty list", () => {
    expect(refusal("task", "list", "-p", "no-such-project")).toContain(
      'no project has the id, slug or name "no-such-project"',
    );
  });
});

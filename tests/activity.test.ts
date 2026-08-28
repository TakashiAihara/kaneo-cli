import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

// activity コマンドの縦テスト

const TOKEN = "valid-token";

type Call = { method: string; path: string };
let calls: Call[] = [];

const activity = (over: Record<string, unknown>) => ({
  id: "a-1",
  taskId: "t-abc",
  type: "comment",
  createdAt: "2026-08-28T09:30:00.000Z",
  userId: "u-1",
  content: "hi there",
  eventData: null,
  ...over,
});

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
        return Response.json({ message: "Unauthorized" }, { status: 401 });
      }
      calls.push({ method: req.method, path });

      if (path === "/api/activity/t-abc") {
        return Response.json([
          activity({}),
          activity({
            id: "a-2",
            type: "status_changed",
            content: null,
            eventData: { oldStatus: "to-do", newStatus: "done" },
          }),
        ]);
      }
      return Response.json({ message: `no mock for ${req.method} ${path}` }, { status: 404 });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

beforeEach(() => {
  calls = [];
});

afterAll(() => {
  server.stop(true);
});

async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", "run", "src/index.ts", ...args], {
    env: { ...process.env, KANEO_URL: baseUrl, KANEO_TOKEN: TOKEN },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("activity", () => {
  test("renders content, and the rendered eventData when content is null", async () => {
    const r = await runCli(["activity", "t-abc"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("2026-08-28 09:30 comment hi there");
    expect(r.stdout).toContain("status_changed");
    expect(r.stdout).toContain('"oldStatus":"to-do"');
    expect(calls.find((c) => c.path === "/api/activity/t-abc")).toBeDefined();
  });

  test("--json prints the raw array", async () => {
    const r = await runCli(["activity", "t-abc", "--json"]);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toHaveLength(2);
  });
});

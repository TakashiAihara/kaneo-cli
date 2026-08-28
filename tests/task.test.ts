import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

// task コマンドの縦テスト。mock は openapi.json の board / task スキーマの形に合わせる

const TOKEN = "valid-token";

type Call = { method: string; path: string; query: URLSearchParams; body: unknown };
let calls: Call[] = [];

const boardTask = (over: Record<string, unknown>) => ({
  id: "t-abc",
  title: "sample",
  number: 12,
  description: null,
  status: "to-do",
  priority: "medium",
  startDate: null,
  dueDate: null,
  position: 1,
  createdAt: "2026-08-28T00:00:00.000Z",
  userId: null,
  assigneeName: null,
  assigneeId: null,
  assigneeImage: null,
  projectId: "p-1",
  labels: [],
  externalLinks: [],
  ...over,
});

const board = {
  id: "p-1",
  name: "Demo",
  slug: "demo",
  icon: null,
  description: null,
  isPublic: null,
  workspaceId: "w-1",
  columns: [
    {
      id: "to-do",
      slug: "to-do",
      name: "To do",
      icon: null,
      isFinal: false,
      tasks: [boardTask({}), boardTask({ id: "t-def", number: 13, title: "日本語タイトル" })],
    },
    { id: "done", slug: "done", name: "Done", icon: null, isFinal: true, tasks: [] },
  ],
  archivedTasks: [],
  plannedTasks: [],
};

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
        return Response.json({ message: "Unauthorized" }, { status: 401 });
      }
      const body = req.method === "GET" || req.method === "DELETE" ? undefined : await req.json();
      calls.push({ method: req.method, path, query: new URLSearchParams(url.search), body });

      if (path === "/api/task/tasks/p-1") {
        return Response.json({
          data: board,
          pagination: { total: 2, page: 1, pageSize: 2, totalPages: 1 },
        });
      }
      if (path === "/api/task/t-abc" && req.method === "GET") {
        return Response.json({ ...boardTask({}), assigneeName: null, assigneeId: null });
      }
      if (path === "/api/task/p-1" && req.method === "POST") {
        const b = body as { title: string; status: string; priority: string };
        return Response.json(boardTask({ id: "t-new", number: 14, title: b.title, status: b.status }));
      }
      if (/^\/api\/task\/(title|description|priority|status|due-date|assignee)\/t-abc$/.test(path)) {
        return Response.json(boardTask({}));
      }
      if (path === "/api/task/move/t-abc" && req.method === "PUT") {
        return Response.json({ task: boardTask({ projectId: "p-2" }) });
      }
      if (path === "/api/task/t-abc" && req.method === "DELETE") {
        return Response.json(boardTask({}));
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

describe("task list", () => {
  test("groups by column and skips empty columns", async () => {
    const r = await runCli(["task", "list", "--project", "p-1"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("To do (to-do) — 2");
    expect(r.stdout).toContain("#12");
    expect(r.stdout).toContain("日本語タイトル");
    expect(r.stdout).not.toContain("Done");
  });

  test("--json prints the raw board", async () => {
    const r = await runCli(["task", "list", "--project", "p-1", "--json"]);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.columns).toHaveLength(2);
  });

  test("filters are passed through as query params", async () => {
    await runCli([
      "task", "list", "--project", "p-1",
      "--priority", "high", "--status", "to-do", "--assignee", "u-1",
    ]);
    const boardCall = calls.find((c) => c.path === "/api/task/tasks/p-1");
    expect(boardCall).toBeDefined();
    expect(boardCall!.query.get("priority")).toBe("high");
    expect(boardCall!.query.get("status")).toBe("to-do");
    expect(boardCall!.query.get("assigneeId")).toBe("u-1");
  });

  test("invalid priority is a usage error, not an API call", async () => {
    const r = await runCli(["task", "list", "--project", "p-1", "--priority", "banana"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("must be one of");
    expect(calls).toHaveLength(0);
  });
});

describe("task view", () => {
  test("by id", async () => {
    const r = await runCli(["task", "view", "t-abc"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("#12 sample");
    expect(r.stdout).toContain("status:    to-do");
  });

  test("by number with --project resolves via the board", async () => {
    const r = await runCli(["task", "view", "#12", "--project", "p-1"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("#12 sample");
    expect(calls.map((c) => c.path)).toContain("/api/task/tasks/p-1");
  });

  test("by number without --project fails with a hint", async () => {
    const r = await runCli(["task", "view", "12"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--project");
    expect(calls).toHaveLength(0);
  });

  test("unknown number fails as not-found", async () => {
    const r = await runCli(["task", "view", "#99", "--project", "p-1"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not found");
  });
});

describe("task create", () => {
  test("defaults status to the first column when omitted", async () => {
    const r = await runCli(["task", "create", "new task", "--project", "p-1"]);
    expect(r.exitCode).toBe(0);
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/task/p-1");
    expect(post).toBeDefined();
    expect((post!.body as { status: string }).status).toBe("to-do");
    expect(r.stdout).toContain("created #14 new task");
  });

  test("explicit --status skips the board fetch", async () => {
    await runCli(["task", "create", "x", "--project", "p-1", "--status", "done"]);
    expect(calls.map((c) => c.path)).not.toContain("/api/task/tasks/p-1");
    const post = calls.find((c) => c.method === "POST");
    expect((post!.body as { status: string }).status).toBe("done");
  });
});

describe("task edit", () => {
  test("fans out one request per provided field", async () => {
    const r = await runCli([
      "task", "edit", "t-abc",
      "--title", "t2",
      "--priority", "high",
      "--due", "2026-09-01",
    ]);
    expect(r.exitCode).toBe(0);
    const paths = calls.map((c) => c.path);
    expect(paths).toContain("/api/task/title/t-abc");
    expect(paths).toContain("/api/task/priority/t-abc");
    expect(paths).toContain("/api/task/due-date/t-abc");
    expect(paths).not.toContain("/api/task/description/t-abc");
  });

  test("--unassign sends userId null", async () => {
    await runCli(["task", "edit", "t-abc", "--unassign"]);
    const call = calls.find((c) => c.path === "/api/task/assignee/t-abc");
    expect((call!.body as { userId: unknown }).userId).toBeNull();
  });

  test("no field flags is a usage error", async () => {
    const r = await runCli(["task", "edit", "t-abc"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("nothing to edit");
    expect(calls).toHaveLength(0);
  });

  test("--assignee with --unassign is rejected", async () => {
    const r = await runCli(["task", "edit", "t-abc", "--assignee", "u-1", "--unassign"]);
    expect(r.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe("task move / delete", () => {
  test("move sends destinationProjectId", async () => {
    const r = await runCli(["task", "move", "t-abc", "--to-project", "p-2"]);
    expect(r.exitCode).toBe(0);
    const call = calls.find((c) => c.path === "/api/task/move/t-abc");
    expect((call!.body as { destinationProjectId: string }).destinationProjectId).toBe("p-2");
  });

  test("delete calls DELETE /task/{id}", async () => {
    const r = await runCli(["task", "delete", "t-abc"]);
    expect(r.exitCode).toBe(0);
    expect(calls.find((c) => c.method === "DELETE" && c.path === "/api/task/t-abc")).toBeDefined();
  });
});

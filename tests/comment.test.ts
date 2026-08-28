import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

// comment コマンドの縦テスト。#number 解決は task.test.ts と同じ board mock を再利用する

const TOKEN = "valid-token";

type Call = { method: string; path: string; body: unknown };
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
  columns: [{ id: "to-do", slug: "to-do", name: "To do", icon: null, isFinal: false, tasks: [boardTask({})] }],
  archivedTasks: [],
  plannedTasks: [],
};

const comment = (over: Record<string, unknown>) => ({
  id: "c-1",
  taskId: "t-abc",
  userId: "u-1",
  content: "hello",
  createdAt: "2026-08-28T09:30:00.000Z",
  updatedAt: "2026-08-28T09:30:00.000Z",
  user: { name: "Alice", image: null },
  ...over,
});

const activity = (over: Record<string, unknown>) => ({
  id: "a-1",
  taskId: "t-abc",
  type: "comment",
  createdAt: "2026-08-28T09:30:00.000Z",
  updatedAt: "2026-08-28T09:30:00.000Z",
  userId: "u-1",
  content: "hello",
  eventData: null,
  externalUserName: null,
  externalUserAvatar: null,
  externalSource: null,
  externalUrl: null,
  ...over,
});

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
      const raw = req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ method: req.method, path, body });

      if (path === "/api/task/tasks/p-1") {
        return Response.json({ data: board, pagination: { total: 1, page: 1, pageSize: 1, totalPages: 1 } });
      }
      if (path === "/api/comment/t-abc" && req.method === "GET") {
        return Response.json([
          comment({}),
          comment({ id: "c-2", user: { name: "Bob", image: null }, content: "second one" }),
        ]);
      }
      if (path === "/api/comment/t-abc" && req.method === "POST") {
        return Response.json(activity({ content: (body as { content: string }).content }));
      }
      if (path === "/api/comment/c-1" && req.method === "PUT") {
        return Response.json(activity({ content: (body as { content: string }).content }));
      }
      if (path === "/api/comment/c-1" && req.method === "DELETE") {
        return Response.json(activity({}));
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

describe("comment list", () => {
  test("renders author, timestamp, id and content", async () => {
    const r = await runCli(["comment", "list", "t-abc"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Alice (2026-08-28 09:30) [c-1]");
    expect(r.stdout).toContain("hello");
    expect(r.stdout).toContain("Bob (2026-08-28 09:30) [c-2]");
    expect(r.stdout).toContain("second one");
  });

  test("#number resolves via the board with --project", async () => {
    const r = await runCli(["comment", "list", "#12", "--project", "p-1"]);
    expect(r.exitCode).toBe(0);
    expect(calls.map((c) => c.path)).toContain("/api/task/tasks/p-1");
    expect(r.stdout).toContain("hello");
  });
});

describe("comment add", () => {
  test("posts { content }", async () => {
    const r = await runCli(["comment", "add", "t-abc", "new comment"]);
    expect(r.exitCode).toBe(0);
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/comment/t-abc");
    expect(post).toBeDefined();
    expect((post!.body as { content: string }).content).toBe("new comment");
    expect(r.stdout).toContain("commented on t-abc");
  });
});

describe("comment edit / delete", () => {
  test("edit sends PUT with new content", async () => {
    const r = await runCli(["comment", "edit", "c-1", "updated content"]);
    expect(r.exitCode).toBe(0);
    const put = calls.find((c) => c.method === "PUT" && c.path === "/api/comment/c-1");
    expect((put!.body as { content: string }).content).toBe("updated content");
  });

  test("delete calls DELETE /comment/{id}", async () => {
    const r = await runCli(["comment", "delete", "c-1"]);
    expect(r.exitCode).toBe(0);
    expect(calls.find((c) => c.method === "DELETE" && c.path === "/api/comment/c-1")).toBeDefined();
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

// project コマンドの縦テスト。mock は openapi.json の Project / ProjectListItem スキーマの形に合わせる

const TOKEN = "valid-token";
const WORKSPACE = "w-1";

type Call = { method: string; path: string; query: URLSearchParams; body: unknown };
let calls: Call[] = [];

const project = (over: Record<string, unknown>) => ({
  id: "p-1",
  workspaceId: WORKSPACE,
  slug: "demo",
  icon: "📁",
  name: "Demo",
  description: null,
  createdAt: "2026-08-28T00:00:00.000Z",
  isPublic: null,
  archivedAt: null,
  position: 0,
  lastTaskNumber: 3,
  ...over,
});

const projectListItem = (over: Record<string, unknown>) => ({
  ...project({}),
  statistics: { completionPercentage: 0.5, totalTasks: 4, dueDate: null },
  archivedTasks: [],
  plannedTasks: [],
  columns: [],
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
      calls.push({ method: req.method, path, query: new URLSearchParams(url.search), body });

      if (path === "/api/project" && req.method === "GET") {
        return Response.json([
          projectListItem({}),
          projectListItem({ id: "p-2", slug: "archived-one", name: "Archived", archivedAt: "2026-08-01T00:00:00.000Z" }),
        ]);
      }
      if (path === "/api/project" && req.method === "POST") {
        const b = body as { name: string; slug: string; icon: string; workspaceId: string };
        return Response.json(project({ id: "p-new", name: b.name, slug: b.slug, icon: b.icon, workspaceId: b.workspaceId }));
      }
      if (path === "/api/project/p-1" && req.method === "GET") {
        return Response.json(project({ description: "existing description", isPublic: true }));
      }
      if (path === "/api/project/p-1" && req.method === "PUT") {
        const b = body as Record<string, unknown>;
        return Response.json(project({ ...b }));
      }
      if (path === "/api/project/p-1/archive" && req.method === "PUT") {
        return Response.json(project({ archivedAt: "2026-08-28T00:00:00.000Z" }));
      }
      if (path === "/api/project/p-1/unarchive" && req.method === "PUT") {
        return Response.json(project({ archivedAt: null }));
      }
      if (path === "/api/project/p-1" && req.method === "DELETE") {
        return Response.json(project({}));
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

async function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  const proc = Bun.spawn(["bun", "run", "src/index.ts", ...args], {
    env: {
      ...process.env,
      KANEO_URL: baseUrl,
      KANEO_TOKEN: TOKEN,
      KANEO_WORKSPACE: WORKSPACE,
      ...env,
    } as Record<string, string>,
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

describe("project list", () => {
  test("passes workspaceId as a query param", async () => {
    const r = await runCli(["project", "list"]);
    expect(r.exitCode).toBe(0);
    const call = calls.find((c) => c.path === "/api/project");
    expect(call).toBeDefined();
    expect(call!.query.get("workspaceId")).toBe(WORKSPACE);
    expect(call!.query.has("includeArchived")).toBe(false);
    expect(r.stdout).toContain("demo");
  });

  test("--archived passes includeArchived=true", async () => {
    await runCli(["project", "list", "--archived"]);
    const call = calls.find((c) => c.path === "/api/project");
    expect(call!.query.get("includeArchived")).toBe("true");
  });

  test("missing workspace exits 1 with a hint", async () => {
    const r = await runCli(["project", "list"], { KANEO_WORKSPACE: undefined });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no workspace");
    expect(calls).toHaveLength(0);
  });

  test("--json prints the raw array", async () => {
    const r = await runCli(["project", "list", "--json"]);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toHaveLength(2);
  });
});

describe("project view", () => {
  test("prints key: value lines", async () => {
    const r = await runCli(["project", "view", "p-1"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("demo Demo");
    expect(r.stdout).toContain("id:          p-1");
  });
});

describe("project create", () => {
  test("derives slug from the name", async () => {
    const r = await runCli(["project", "create", "My Project"]);
    expect(r.exitCode).toBe(0);
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/project");
    expect((post!.body as { slug: string }).slug).toBe("my-project");
    expect((post!.body as { workspaceId: string }).workspaceId).toBe(WORKSPACE);
  });

  test("explicit --slug wins over the derived one", async () => {
    await runCli(["project", "create", "My Project", "--slug", "custom"]);
    const post = calls.find((c) => c.method === "POST");
    expect((post!.body as { slug: string }).slug).toBe("custom");
  });

  test("sends the default icon when not given", async () => {
    await runCli(["project", "create", "x"]);
    const post = calls.find((c) => c.method === "POST");
    expect((post!.body as { icon: string }).icon).toBe("📁");
  });
});

describe("project edit", () => {
  test("merges changed fields over the current project", async () => {
    const r = await runCli(["project", "edit", "p-1", "--name", "Renamed"]);
    expect(r.exitCode).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain("GET /api/project/p-1");
    const put = calls.find((c) => c.method === "PUT" && c.path === "/api/project/p-1");
    const b = put!.body as Record<string, unknown>;
    expect(b.name).toBe("Renamed");
    // 変更していないフィールドは GET で取れた現在値のまま
    expect(b.slug).toBe("demo");
    expect(b.icon).toBe("📁");
    expect(b.description).toBe("existing description");
    expect(b.isPublic).toBe(true);
  });

  test("--no-public flips visibility off and keeps the untouched name", async () => {
    await runCli(["project", "edit", "p-1", "--no-public"]);
    const put = calls.find((c) => c.method === "PUT" && c.path === "/api/project/p-1");
    const b = put!.body as Record<string, unknown>;
    expect(b.isPublic).toBe(false);
    expect(b.name).toBe("Demo");
  });

  test("no flags is a usage error", async () => {
    const r = await runCli(["project", "edit", "p-1"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("nothing to edit");
    expect(calls).toHaveLength(0);
  });
});

describe("project archive / unarchive / delete", () => {
  test("archive calls PUT /project/{id}/archive", async () => {
    const r = await runCli(["project", "archive", "p-1"]);
    expect(r.exitCode).toBe(0);
    expect(calls.find((c) => c.method === "PUT" && c.path === "/api/project/p-1/archive")).toBeDefined();
  });

  test("unarchive calls PUT /project/{id}/unarchive", async () => {
    const r = await runCli(["project", "unarchive", "p-1"]);
    expect(r.exitCode).toBe(0);
    expect(calls.find((c) => c.method === "PUT" && c.path === "/api/project/p-1/unarchive")).toBeDefined();
  });

  test("delete calls DELETE /project/{id}", async () => {
    const r = await runCli(["project", "delete", "p-1"]);
    expect(r.exitCode).toBe(0);
    expect(calls.find((c) => c.method === "DELETE" && c.path === "/api/project/p-1")).toBeDefined();
  });
});

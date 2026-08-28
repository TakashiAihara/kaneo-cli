import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

// search コマンドの縦テスト。mock は openapi.json の SearchResponse / SearchResult スキーマの形に合わせる

const TOKEN = "valid-token";
const WORKSPACE = "w-1";

type Call = { method: string; path: string; query: URLSearchParams };
let calls: Call[] = [];

const searchResult = (over: Record<string, unknown>) => ({
  id: "t-1",
  type: "task",
  title: "sample task",
  createdAt: "2026-08-28T00:00:00.000Z",
  relevanceScore: 1,
  projectName: "Demo",
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
      calls.push({ method: req.method, path, query: new URLSearchParams(url.search) });

      if (path === "/api/search") {
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? Number(limitParam) : 2;
        const results = [
          searchResult({}),
          searchResult({ id: "p-1", type: "project", title: "sample project", projectName: undefined }),
        ].slice(0, limit);
        return Response.json({ results, totalCount: 5, searchQuery: url.searchParams.get("q") });
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

describe("search", () => {
  test("sends q and workspaceId as query params", async () => {
    const r = await runCli(["search", "hello"]);
    expect(r.exitCode).toBe(0);
    const call = calls.find((c) => c.path === "/api/search");
    expect(call).toBeDefined();
    expect(call!.query.get("q")).toBe("hello");
    expect(call!.query.get("workspaceId")).toBe(WORKSPACE);
  });

  test("--type is validated client-side, invalid value makes no API call", async () => {
    const r = await runCli(["search", "hello", "--type", "bogus"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("must be one of");
    expect(calls).toHaveLength(0);
  });

  test("valid --type is passed through", async () => {
    await runCli(["search", "hello", "--type", "tasks"]);
    const call = calls.find((c) => c.path === "/api/search");
    expect(call!.query.get("type")).toBe("tasks");
  });

  test("--project and --limit are passed through", async () => {
    await runCli(["search", "hello", "--project", "p-9", "--limit", "1"]);
    const call = calls.find((c) => c.path === "/api/search");
    expect(call!.query.get("projectId")).toBe("p-9");
    expect(call!.query.get("limit")).toBe("1");
  });

  test("prints a table with project name", async () => {
    const r = await runCli(["search", "hello", "--limit", "2"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("TYPE");
    expect(r.stdout).toContain("sample task");
    expect(r.stdout).toContain("Demo");
  });

  test("shows 'showing N of totalCount' when more results exist", async () => {
    const r = await runCli(["search", "hello", "--limit", "1"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("showing 1 of 5");
  });

  test("missing workspace exits 1 with a hint", async () => {
    const r = await runCli(["search", "hello"], { KANEO_WORKSPACE: undefined });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no workspace");
    expect(calls).toHaveLength(0);
  });
});

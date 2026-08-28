import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

// workspace コマンドの縦テスト。glossary どおり "organization" という語は CLI 側に一切出ない前提を確認する

const TOKEN = "valid-token";
const WORKSPACE = "w-1";

type Call = { method: string; path: string; query: URLSearchParams };
let calls: Call[] = [];

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

      if (path === "/api/auth/organization/list") {
        return Response.json([
          { id: "w-1", slug: "acme", name: "Acme" },
          { id: "w-2", slug: "beta", name: "Beta Co" },
        ]);
      }
      if (path === "/api/workspace/w-1/members") {
        return Response.json([
          { id: "u-1", name: "Alice", email: "alice@example.com", image: null, role: "owner" },
          { id: "u-2", name: "Bob", email: "bob@example.com", image: null, role: "member" },
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

async function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  const proc = Bun.spawn(["bun", "run", "src/index.ts", ...args], {
    env: { ...process.env, KANEO_URL: baseUrl, KANEO_TOKEN: TOKEN, ...env } as Record<string, string>,
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

describe("workspace list", () => {
  test("renders a table without ever saying organization", async () => {
    const r = await runCli(["workspace", "list"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ID");
    expect(r.stdout).toContain("SLUG");
    expect(r.stdout).toContain("NAME");
    expect(r.stdout).toContain("acme");
    expect(r.stdout).toContain("Beta Co");
    expect(r.stdout.toLowerCase()).not.toContain("organization");
    expect(calls.find((c) => c.path === "/api/auth/organization/list")).toBeDefined();
  });

  test("--json prints the raw array", async () => {
    const r = await runCli(["workspace", "list", "--json"]);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toHaveLength(2);
  });
});

describe("workspace members", () => {
  test("positional workspace id renders a table", async () => {
    const r = await runCli(["workspace", "members", "w-1"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ID");
    expect(r.stdout).toContain("NAME");
    expect(r.stdout).toContain("EMAIL");
    expect(r.stdout).toContain("ROLE");
    expect(r.stdout).toContain("Alice");
    expect(r.stdout).toContain("alice@example.com");
    expect(r.stdout).toContain("owner");
  });

  test("falls back to the configured workspace when omitted", async () => {
    const r = await runCli(["workspace", "members"], { KANEO_WORKSPACE: WORKSPACE });
    expect(r.exitCode).toBe(0);
    expect(calls.find((c) => c.path === "/api/workspace/w-1/members")).toBeDefined();
  });

  test("no positional and no configured workspace fails with a hint", async () => {
    const r = await runCli(["workspace", "members"], { KANEO_WORKSPACE: undefined });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no workspace");
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// 実 CLI プロセスを mock サーバに向けて叩く縦の 1 本。
// get-session が未認証でも 200/null を返す Kaneo の実挙動 (2026-08-28 実測) を mock で再現し、
// whoami が /notification の 401 で無効 token を弾くことを pin する

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

const VALID = "valid-token";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");
      if (url.pathname === "/api/auth/get-session") {
        // Kaneo は token が session に解決できないと 200 で null を返す (無効 token でも 401 にしない)
        return Response.json(null);
      }
      if (url.pathname === "/api/notification") {
        if (auth !== `Bearer ${VALID}`) {
          return Response.json({ message: "Unauthorized" }, { status: 401 });
        }
        return Response.json([]);
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

async function runCli(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(["bun", "run", "src/index.ts", ...args], {
    env: { ...process.env, KANEO_PROFILE: undefined as unknown as string, ...env },
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

describe("kaneo whoami (mock server)", () => {
  test("valid API key authenticates", async () => {
    const r = await runCli(["whoami"], { KANEO_URL: baseUrl, KANEO_TOKEN: VALID });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("authenticated against");
  });

  test("invalid token exits 1 with a 401 hint", async () => {
    const r = await runCli(["whoami"], { KANEO_URL: baseUrl, KANEO_TOKEN: "wrong" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("401");
    expect(r.stderr).toContain("check your token");
    expect(r.stdout).toBe("");
  });

  test("--json prints JSON only on stdout", async () => {
    const r = await runCli(["whoami", "--json"], { KANEO_URL: baseUrl, KANEO_TOKEN: VALID });
    expect(r.exitCode).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });
});

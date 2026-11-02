import { afterEach, expect, test } from "bun:test";
import { configureClient } from "../../src/api/http";
import { allProjects } from "../../src/cli/lookup";

const servers: { stop: (force?: boolean) => void }[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop(true);
});

const json = (value: unknown, status = 200) => Response.json(value, { status });

const project = (id: string, workspaceId: string) => ({
  id,
  workspaceId,
  name: id,
  slug: id.toUpperCase(),
  icon: "Layout",
  description: "",
  isPublic: false,
  archivedAt: null,
  statistics: { completionPercentage: 0, totalTasks: 0, dueDate: null },
  archivedTasks: [],
  plannedTasks: [],
});

const serve = (listing: (workspaceId: string) => Response | Promise<Response>) => {
  const s = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/auth/organization/list") {
        return json(["w1", "w2", "w3"].map((id) => ({ id, name: `name-${id}`, slug: id, createdAt: "2026-01-01T00:00:00.000Z" })));
      }
      if (url.pathname === "/api/project") return listing(url.searchParams.get("workspaceId") ?? "");
      return json({ error: "unexpected" }, 404);
    },
  });
  servers.push(s);
  configureClient({ baseUrl: `http://127.0.0.1:${s.port}`, apiKey: "test-key" });
};

test("workspaces are listed at the same time, and come back in workspace order", async () => {
  // Each listing waits until all three have arrived, so a one-at-a-time loop
  // never gets past the first and the test times out instead of passing.
  let arrived = 0;
  let release!: () => void;
  const everyone = new Promise<void>((resolve) => (release = resolve));
  serve(async (workspaceId) => {
    if (++arrived === 3) release();
    await everyone;
    return json([project(`p-${workspaceId}`, workspaceId)]);
  });
  const { found, unlisted } = await allProjects(false);
  expect(found.map((f) => `${f.workspaceName}/${f.project.id}`)).toEqual(["name-w1/p-w1", "name-w2/p-w2", "name-w3/p-w3"]);
  expect(unlisted).toEqual([]);
}, 5_000);

test("a workspace that cannot be listed is reported beside the projects of the others", async () => {
  serve((workspaceId) => (workspaceId === "w2" ? json({ success: false, error: "forbidden here" }, 403) : json([project(`p-${workspaceId}`, workspaceId)])));
  const { found, unlisted } = await allProjects(false);
  expect(found.map((f) => f.project.id)).toEqual(["p-w1", "p-w3"]);
  expect(unlisted).toHaveLength(1);
  expect(unlisted[0]!.workspaceName).toBe("name-w2");
  expect(unlisted[0]!.message).toContain("forbidden here");
});

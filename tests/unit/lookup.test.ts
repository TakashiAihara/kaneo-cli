import { afterEach, expect, test } from "bun:test";
import { configureClient } from "../../src/api/http";
import { KaneoApiError } from "../../src/api/http";
import { allProjects, withProject } from "../../src/cli/lookup";

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

const notFound = () => new KaneoApiError("PUT", "/api/task/move/t", 404, ["Project not found"]);
// The cache of resolved values lives for the process, so each test uses a slug of its own.
const byId = async (id: string) => {
  if (id.startsWith("SAME")) throw notFound();
  return id;
};

test("a destination resolved before is not reused for a task in another workspace", async () => {
  let both = false;
  serve((workspaceId) => json(workspaceId === "w3" || (workspaceId === "w2" && !both) ? [] : [{ ...project(`p-${workspaceId}`, workspaceId), slug: "SAME0" }]));
  expect(await withProject("SAME0", byId)).toBe("p-w1");
  both = true;
  expect(await withProject("SAME0", byId, { sameWorkspaceAs: "p-w2" })).toBe("p-w2");
});

test("a destination resolved for one workspace is not kept for later lookups", async () => {
  serve((workspaceId) => json(workspaceId === "w3" ? [] : [{ ...project(`p-${workspaceId}`, workspaceId), slug: "SAME1" }]));
  expect(await withProject("SAME1", byId, { sameWorkspaceAs: "p-w1" })).toBe("p-w1");
  await expect(withProject("SAME1", byId)).rejects.toThrow("matches several projects");
});

test("explain is added when the value names a project only in another workspace", async () => {
  serve((workspaceId) => json(workspaceId === "w2" ? [{ ...project("p-w2", "w2"), slug: "SAME2" }] : [project("p-w1", "w1")]));
  await expect(withProject("SAME2", byId, { sameWorkspaceAs: "p-w1", explain: async () => "; EXPLAINED" })).rejects.toThrow("only within its own workspace; EXPLAINED");
});

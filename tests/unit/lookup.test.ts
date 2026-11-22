import { afterEach, expect, test } from "bun:test";
import { configureClient, kaneoFetch, KaneoApiError } from "../../src/api/http";
import { allProjects, unknownProject, withProject } from "../../src/cli/lookup";

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
        return json(
          ["w1", "w2", "w3"].map((id) => ({ id, name: `name-${id}`, slug: id, createdAt: "2026-01-01T00:00:00.000Z" })),
        );
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
  expect(found.map((f) => `${f.workspaceName}/${f.project.id}`)).toEqual([
    "name-w1/p-w1",
    "name-w2/p-w2",
    "name-w3/p-w3",
  ]);
  expect(unlisted).toEqual([]);
}, 5_000);

test("a workspace that cannot be listed is reported beside the projects of the others", async () => {
  serve((workspaceId) =>
    workspaceId === "w2"
      ? json({ success: false, error: "forbidden here" }, 403)
      : json([project(`p-${workspaceId}`, workspaceId)]),
  );
  const { found, unlisted } = await allProjects(false);
  expect(found.map((f) => f.project.id)).toEqual(["p-w1", "p-w3"]);
  expect(unlisted).toHaveLength(1);
  expect(unlisted[0]!.workspaceName).toBe("name-w2");
  expect(unlisted[0]!.reason).toContain("forbidden here");
});

test("two workspaces that cannot be listed are reported in workspace order", async () => {
  serve((workspaceId) =>
    workspaceId === "w1"
      ? json({ success: false, error: "first" }, 403)
      : workspaceId === "w3"
        ? json({ success: false, error: "third" }, 500)
        : json([project("p-w2", "w2")]),
  );
  const { found, unlisted } = await allProjects(false);
  expect(found.map((f) => f.project.id)).toEqual(["p-w2"]);
  expect(unlisted.map((u) => u.workspaceName)).toEqual(["name-w1", "name-w3"]);
  expect(unlisted[0]!.reason).toStartWith("403");
  expect(unlisted[1]!.reason).toStartWith("500");
});

test("when the workspaces themselves cannot be listed there is no partial answer", async () => {
  const s = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => json({ success: false, error: "no workspaces for you" }, 403),
  });
  servers.push(s);
  configureClient({ baseUrl: `http://127.0.0.1:${s.port}`, apiKey: "test-key" });
  await expect(allProjects(false)).rejects.toThrow("no workspaces for you");
});

const notFound = () => new KaneoApiError("PUT", "/api/task/move/t", 404, ["Project not found"]);
// The cache of resolved values lives for the process, so each test uses a slug of its own.
const byId = async (id: string) => {
  if (id.startsWith("SAME")) throw notFound();
  return id;
};

test("a destination resolved before is not reused for a task in another workspace", async () => {
  let both = false;
  serve((workspaceId) =>
    json(
      workspaceId === "w3" || (workspaceId === "w2" && !both)
        ? []
        : [{ ...project(`p-${workspaceId}`, workspaceId), slug: "SAME0" }],
    ),
  );
  expect(await withProject("SAME0", byId)).toBe("p-w1");
  both = true;
  expect(await withProject("SAME0", byId, { sameWorkspaceAs: "p-w2" })).toBe("p-w2");
});

test("a destination resolved for one workspace is not kept for later lookups", async () => {
  serve((workspaceId) =>
    json(workspaceId === "w3" ? [] : [{ ...project(`p-${workspaceId}`, workspaceId), slug: "SAME1" }]),
  );
  expect(await withProject("SAME1", byId, { sameWorkspaceAs: "p-w1" })).toBe("p-w1");
  await expect(withProject("SAME1", byId)).rejects.toThrow("matches several projects");
});

test("explain is added when the value names a project only in another workspace", async () => {
  serve((workspaceId) =>
    json(workspaceId === "w2" ? [{ ...project("p-w2", "w2"), slug: "SAME2" }] : [project("p-w1", "w1")]),
  );
  await expect(
    withProject("SAME2", byId, { sameWorkspaceAs: "p-w1", explain: async () => "; EXPLAINED" }),
  ).rejects.toThrow("only within its own workspace; EXPLAINED");
});

test("a scoped miss is still hedged by a workspace that could not be listed", async () => {
  serve((workspaceId) =>
    workspaceId === "w2"
      ? json({ success: false, error: "down" }, 500)
      : json([project(`p-${workspaceId}`, workspaceId)]),
  );
  await expect(withProject("SAME3", byId, { sameWorkspaceAs: "p-w1" })).rejects.toThrow(
    'could not list the projects of workspace "name-w2"',
  );
});

test("a scoped match in the task's workspace is not hedged by one that could not be listed", async () => {
  serve((workspaceId) =>
    workspaceId === "w2"
      ? json({ success: false, error: "down" }, 500)
      : json([
          { ...project(`p-${workspaceId}`, workspaceId), slug: workspaceId === "w1" ? "SAME4" : `P-${workspaceId}` },
        ]),
  );
  expect(await withProject("SAME4", byId, { sameWorkspaceAs: "p-w1" })).toBe("p-w1");
});

// Kaneo 2.50 sends every HTTPException as {"message","code"} JSON, where 2.32
// sent the message as text/plain. The lookup decides on the message, so it has
// to find it in that shape too: a slug or a name in the path is answered like
// an id the server does not know.
test.each([
  [404, "Project not found", "NOT_FOUND"],
  [400, "Workspace ID could not be determined", "BAD_REQUEST"],
])("a slug the server refuses with %p %p (%p) in its JSON error shape is looked up", async (status, message, code) => {
  const s = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/auth/organization/list")
        return json([{ id: "w1", name: "name-w1", slug: "w1", createdAt: "2026-01-01T00:00:00.000Z" }]);
      if (url.pathname === "/api/project") return json([{ ...project("p-w1", "w1"), slug: `JSON${status}` }]);
      if (url.pathname === "/api/task/tasks/p-w1") return json({ tasks: [] });
      return json({ message, code }, status);
    },
  });
  servers.push(s);
  configureClient({ baseUrl: `http://127.0.0.1:${s.port}`, apiKey: "test-key" });
  const op = async (id: string) => {
    await kaneoFetch<unknown>(`/task/tasks/${id}`, { method: "GET" });
    return id;
  };
  expect(await withProject(`JSON${status}`, op)).toBe("p-w1");
});

// A gone project arrives in two spellings — the older server's 400 and Kaneo
// v2.50's 404 — and both are the same "nothing here" answer. Anything else is
// a different failure: a 403 the key cannot pass, a 5xx, a 404 for another
// resource, or no API error at all.
test("unknownProject reads only the two spellings of a project the server cannot place", () => {
  const api = (status: number, messages: string[]) => new KaneoApiError("GET", "/api/project/p", status, messages);
  expect(unknownProject(api(400, ["Workspace ID could not be determined"]))).toBe(true);
  expect(unknownProject(api(404, ["Project not found"]))).toBe(true);
  expect(unknownProject(api(403, ["Project not found"]))).toBe(false);
  expect(unknownProject(api(404, ["Task not found"]))).toBe(false);
  expect(unknownProject(api(500, ["Project not found"]))).toBe(false);
  expect(unknownProject(new Error("socket hangup"))).toBe(false);
});

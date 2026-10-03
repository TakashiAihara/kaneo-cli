import { z } from "zod";
import * as M from "../../src/api/gen/model";
import { SPEC_PATH } from "../../openapi/spec";

// An in-memory Kaneo that answers the operations in src/api/registry.ts the
// way a v2.29.2 server does. Every response is parsed with the generated zod
// schema before it is sent, so the fake cannot drift from the document the
// client is generated from. Ids and timestamps are deterministic, so two runs
// of the same scenario (the Go reference and the TS build) see the same bytes.

export type Seed = {
  workspaces: { id: string; name: string; slug: string }[];
  projects: { id: string; workspaceId: string; name: string; slug: string; archived?: boolean }[];
  columns?: { slug: string; name: string; isFinal?: boolean }[];
  tasks: {
    id: string;
    projectId: string;
    title: string;
    status?: string;
    priority?: string;
    description?: string | null;
    userId?: string | null;
  }[];
  comments?: { taskId: string; content: string }[];
  // Users the server knows, so assign has a name to report.
  users?: { id: string; name: string }[];
};

export type Recorded = { method: string; path: string; query: string; body: unknown };

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const DEFAULT_COLUMNS = [
  { slug: "to-do", name: "To Do" },
  { slug: "in-progress", name: "In Progress" },
  { slug: "done", name: "Done", isFinal: true },
];

export type FakeOptions = {
  pageSize?: number;
  // Answers the way a server older than the pinned document does: fields the
  // document has since added are missing, and a comment's author can be null.
  // Responses are then not checked against the schema, since departing from
  // it is the point.
  legacy?: boolean;
  // Holds every response back this long, for timeouts.
  delayMs?: number;
  // Answers a request whose "METHOD path" matches with a 200 holding only
  // whitespace, a reply no schema accepts and Go's client rejects.
  whitespaceOn?: string;
};

export function startFake(seed: Seed, opts: FakeOptions = {}) {
  let clock = 0;
  const now = () => new Date(T0 + 1000 * clock++).toISOString();
  let seq = 0;
  const id = (prefix: string) => `${prefix}${String(++seq).padStart(4, "0")}`;

  const columns = seed.columns ?? DEFAULT_COLUMNS;
  const firstColumn = columns[0]!.slug;
  const users = new Map((seed.users ?? []).map((u) => [u.id, u.name]));
  const workspaces = seed.workspaces.map((w) => ({ ...w }));
  const projects = seed.projects.map((p, i) => ({
    id: p.id,
    workspaceId: p.workspaceId,
    backgroundVersion: null,
    slug: p.slug,
    icon: "Layout",
    name: p.name,
    description: null as string | null,
    createdAt: now(),
    isPublic: false,
    archivedAt: p.archived ? now() : (null as string | null),
    position: i,
    lastTaskNumber: 0,
  }));
  const tasks: z.input<typeof M.Task>[] = [];
  const addTask = (projectId: string, t: Partial<z.input<typeof M.Task>> & { title: string }, taskId?: string) => {
    const project = projects.find((p) => p.id === projectId)!;
    project.lastTaskNumber += 1;
    const task = {
      id: taskId ?? id("task"),
      projectId,
      position: tasks.filter((x) => x.projectId === projectId).length,
      number: project.lastTaskNumber,
      userId: t.userId ?? null,
      title: t.title,
      description: t.description ?? null,
      status: t.status ?? firstColumn,
      priority: t.priority ?? "no-priority",
      startDate: null,
      dueDate: null,
      createdAt: now(),
    };
    tasks.push(task);
    return task;
  };
  for (const t of seed.tasks) addTask(t.projectId, t, t.id);

  const comments: z.input<typeof M.Comment>[] = [];
  const addComment = (taskId: string, content: string) => {
    const at = now();
    const c = { id: id("cmt"), taskId, userId: "user-self", content, createdAt: at, updatedAt: at, user: { name: "Self", image: null } };
    comments.push(c);
    return c;
  };
  for (const c of seed.comments ?? []) addComment(c.taskId, c.content);

  const relations: z.input<typeof M.TaskRelation>[] = [];
  const requests: Recorded[] = [];

  const ok = <S extends z.ZodTypeAny>(schema: S, body: z.input<S>, status = 200) =>
    Response.json(opts.legacy ? legacy(body) : schema.parse(body), { status });
  const fail = (status: number, message: string) => Response.json({ success: false, error: message }, { status });

  const boardTask = (t: (typeof tasks)[number]) => ({
    id: t.id,
    title: t.title,
    number: t.number,
    description: t.description,
    status: t.status,
    priority: t.priority,
    startDate: t.startDate,
    dueDate: t.dueDate,
    position: t.position,
    createdAt: t.createdAt,
    userId: t.userId,
    assigneeName: t.userId ? (users.get(t.userId) ?? null) : null,
    assigneeId: t.userId,
    assigneeImage: null,
    projectId: t.projectId,
    subtaskCounts: { completed: 0, total: 0 },
    labels: [],
    externalLinks: [],
  });
  const related = (t: (typeof tasks)[number] | undefined) =>
    t
      ? {
          id: t.id,
          title: t.title,
          status: t.status,
          isCompleted: !!columns.find((c) => c.slug === t.status)?.isFinal,
          priority: t.priority,
          number: t.number,
          projectId: t.projectId,
          userId: t.userId,
          assigneeName: t.userId ? (users.get(t.userId) ?? null) : null,
        }
      : null;

  const route = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, "");
    const body = req.method === "GET" || req.method === "DELETE" ? undefined : await req.json().catch(() => null);
    requests.push({ method: req.method, path, query: url.search, body });

    if (!url.pathname.startsWith("/api/")) return new Response("<html>app</html>", { headers: { "content-type": "text/html" } });
    if (req.headers.get("authorization") !== "Bearer test-key") return fail(401, "Unauthorized");

    // The server validates request bodies against the same schemas the
    // document declares, and answers 400 with the first issue.
    const BODIES: [string, RegExp, z.ZodTypeAny][] = [
      ["POST", /^\/auth\/organization\/update$/, M.UpdateOrganizationBody],
      ["POST", /^\/project$/, M.CreateProjectBody],
      ["PUT", /^\/project\/[^/]+$/, M.UpdateProjectBody],
      ["POST", /^\/task\/[^/]+$/, M.CreateTaskBody],
      ["PUT", /^\/task\/status\/[^/]+$/, M.UpdateTaskStatusBody],
      ["PUT", /^\/task\/priority\/[^/]+$/, M.UpdateTaskPriorityBody],
      ["PUT", /^\/task\/assignee\/[^/]+$/, M.UpdateTaskAssigneeBody],
      ["PUT", /^\/task\/move\/[^/]+$/, M.MoveTaskBody],
      ["POST", /^\/task-relation$/, M.CreateTaskRelationBody],
      ["POST", /^\/comment\/[^/]+$/, M.CreateTaskCommentBody],
    ];
    for (const [method, re, schema] of BODIES) {
      if (req.method !== method || !re.test(path)) continue;
      const r = schema.safeParse(body);
      if (!r.success) {
        const i = r.error.issues[0]!;
        return fail(400, `Invalid key: ${i.path.join(".")}: ${i.message}`);
      }
    }

    // Every route's groups are read only where the route guarantees them.
    type Groups = [string, string, string, string];
    const m = (re: RegExp) => path.match(re) as Groups | null;
    let p: Groups | null;

    if (req.method === "GET" && path === "/openapi") return new Response(Bun.file(SPEC_PATH));
    if (req.method === "GET" && path === "/auth/organization/list") return ok(z.array(M.Organization), workspaces);
    if (req.method === "POST" && path === "/auth/organization/update") {
      const w = workspaces.find((x) => x.id === (body as any)?.organizationId);
      if (!w) return fail(404, "Organization not found");
      Object.assign(w, (body as any).data);
      return ok(M.Organization, w);
    }

    if (req.method === "GET" && path === "/project") {
      const ws = url.searchParams.get("workspaceId");
      const all = url.searchParams.get("includeArchived") === "true";
      const list = projects
        .filter((x) => x.workspaceId === ws && (all || !x.archivedAt))
        .map((x) => ({
          ...x,
          statistics: { completionPercentage: 0, totalTasks: tasks.filter((t) => t.projectId === x.id).length, dueDate: null },
          archivedTasks: [],
          plannedTasks: [],
          columns: [],
        }));
      return ok(z.array(M.ProjectListItem), list);
    }
    if (req.method === "POST" && path === "/project") {
      const b = body as any;
      const proj = { id: id("proj"), workspaceId: b.workspaceId, backgroundVersion: null, slug: b.slug, icon: b.icon, name: b.name, description: null, createdAt: now(), isPublic: false, archivedAt: null, position: projects.length, lastTaskNumber: 0 };
      projects.push(proj);
      return ok(M.Project, proj);
    }
    if ((p = m(/^\/project\/([^/]+)(\/(archive|unarchive))?$/))) {
      const proj = projects.find((x) => x.id === decodeURIComponent(p![1]));
      if (!proj) return fail(404, "Project not found");
      if (req.method === "GET" && !p[2]) return ok(M.Project, proj);
      if (req.method === "PUT" && !p[2]) {
        Object.assign(proj, body);
        return ok(M.Project, proj);
      }
      if (req.method === "PUT" && p[3] === "archive") return ok(M.Project, Object.assign(proj, { archivedAt: now() }));
      if (req.method === "PUT" && p[3] === "unarchive") return ok(M.Project, Object.assign(proj, { archivedAt: null }));
    }

    if (req.method === "GET" && (p = m(/^\/task\/tasks\/([^/]+)$/))) {
      const proj = projects.find((x) => x.id === decodeURIComponent(p![1]));
      if (!proj) return fail(404, "Project not found");
      const mine = tasks.filter((t) => t.projectId === proj.id);
      const size = opts.pageSize ?? 50;
      const page = Number(url.searchParams.get("page") ?? 1);
      const slice = url.searchParams.has("page") || url.searchParams.has("limit") || opts.pageSize ? mine.slice((page - 1) * size, page * size) : mine;
      const { lastTaskNumber, archivedAt, createdAt, position, ...head } = proj;
      return ok(M.BoardResponse, {
        data: {
          ...head,
          columns: columns.map((c, i) => ({ id: c.slug, slug: c.slug, name: c.name, icon: null, isFinal: !!c.isFinal, position: i, tasks: slice.filter((t) => t.status === c.slug).map(boardTask) })),
          archivedTasks: [],
          plannedTasks: [],
        },
        pagination: { total: mine.length, page, pageSize: size, totalPages: Math.max(1, Math.ceil(mine.length / size)), relatedPage: 1, relatedPageSize: 100, relatedTotalPages: 1 },
      });
    }
    if (req.method === "POST" && (p = m(/^\/task\/([^/]+)$/))) {
      const proj = projects.find((x) => x.id === decodeURIComponent(p![1]));
      if (!proj) return fail(404, "Project not found");
      return ok(M.Task, addTask(proj.id, body as any));
    }
    if ((p = m(/^\/task\/(status|priority|assignee|move)\/([^/]+)$/)) && req.method === "PUT") {
      const t = tasks.find((x) => x.id === decodeURIComponent(p![2]));
      if (!t) return fail(404, "Task not found");
      const b = body as any;
      if (p[1] === "status") t.status = b.status;
      if (p[1] === "priority") t.priority = b.priority;
      if (p[1] === "assignee") {
        if (!("userId" in (b ?? {}))) return fail(400, 'Invalid key: Expected "userId" but received undefined');
        t.userId = b.userId;
      }
      if (p[1] === "move") {
        if (!b?.destinationProjectId) return fail(400, 'Invalid key: Expected "destinationProjectId" but received undefined');
        const from = t.projectId;
        const dest = projects.find((x) => x.id === b.destinationProjectId);
        if (!dest) return fail(404, "Project not found");
        dest.lastTaskNumber += 1;
        Object.assign(t, { projectId: dest.id, number: dest.lastTaskNumber, status: b.destinationStatus ?? firstColumn });
        return ok(M.MoveTaskResult, { task: t, sourceProjectId: from, destinationProjectId: dest.id });
      }
      return ok(M.Task, t);
    }
    if ((p = m(/^\/task\/([^/]+)$/))) {
      const i = tasks.findIndex((x) => x.id === decodeURIComponent(p![1]));
      if (i < 0) return fail(404, "Task not found");
      const t = tasks[i]!;
      if (req.method === "GET") return ok(M.TaskWithAssignee, { ...t, assigneeId: t.userId, assigneeName: t.userId ? (users.get(t.userId) ?? null) : null });
      if (req.method === "DELETE") {
        tasks.splice(i, 1);
        return ok(M.Task, t);
      }
    }

    if ((p = m(/^\/comment\/([^/]+)$/))) {
      const taskId = decodeURIComponent(p[1]);
      if (!tasks.some((t) => t.id === taskId)) return fail(404, "Task not found");
      if (req.method === "GET") return ok(z.array(M.Comment), comments.filter((c) => c.taskId === taskId));
      if (req.method === "POST") return ok(M.Comment, addComment(taskId, (body as any).content));
    }

    if (req.method === "POST" && path === "/task-relation") {
      const b = body as any;
      const r = { id: id("rel"), sourceTaskId: b.sourceTaskId, targetTaskId: b.targetTaskId, relationType: b.relationType, createdAt: now() };
      relations.push(r);
      return ok(M.TaskRelation, r);
    }
    if ((p = m(/^\/task-relation\/([^/]+)$/))) {
      const key = decodeURIComponent(p[1]);
      if (req.method === "GET") {
        const list = relations
          .filter((r) => r.sourceTaskId === key || r.targetTaskId === key)
          .map((r) => ({ ...r, sourceTask: related(tasks.find((t) => t.id === r.sourceTaskId)), targetTask: related(tasks.find((t) => t.id === r.targetTaskId)) }));
        return ok(z.array(M.TaskRelationWithTasks), list);
      }
      if (req.method === "DELETE") {
        const i = relations.findIndex((r) => r.id === key);
        if (i < 0) return fail(404, "Relation not found");
        return ok(M.TaskRelation, relations.splice(i, 1)[0]!);
      }
    }

    return fail(404, `no route: ${req.method} ${path}`);
  };

  const whitespace = opts.whitespaceOn ? new RegExp(opts.whitespaceOn) : undefined;
  const delayed = async (req: Request) => {
    if (opts.delayMs) await Bun.sleep(opts.delayMs);
    if (whitespace?.test(`${req.method} ${new URL(req.url).pathname.replace(/^\/api/, "")}`)) {
      requests.push({ method: req.method, path: new URL(req.url).pathname.replace(/^\/api/, ""), query: new URL(req.url).search, body: req.method === "GET" ? undefined : await req.json().catch(() => null) });
      return new Response("  \n", { status: 200, headers: { "content-type": "application/json" } });
    }
    return route(req);
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: delayed });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

// What a server older than the document leaves out, applied to any response.
const LEGACY_DROPPED = new Set(["backgroundVersion", "pagination", "labels", "externalLinks", "subtaskCounts", "assigneeImage", "lastTaskNumber"]);
function legacy(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(legacy);
  if (!body || typeof body !== "object") return body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (LEGACY_DROPPED.has(k)) continue;
    out[k] = k === "user" ? null : legacy(v);
  }
  return out;
}

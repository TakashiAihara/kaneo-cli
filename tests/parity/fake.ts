import { z } from "zod";
import * as M from "../../src/api/gen/model";
import { SPEC_PATH } from "../../openapi/spec";
import { readFileSync } from "node:fs";

// An in-memory Kaneo that answers the operations in src/api/registry.ts the
// way the pinned release's server does. Behaviour checked against a release
// is named with it below (most of it against v2.29.2, before the pin moved to
// 2.32.0); 2.32.0 changes are followed only where the generated schema
// requires it. Every response is parsed with the generated zod
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
  // A comment with a userId of its own was written by someone else, so only
  // the server's author check stands between it and a delete.
  comments?: { taskId: string; content: string; id?: string; userId?: string }[];
  // Labels already on a task, for a board that carries one before anything runs.
  labels?: { taskId: string; name: string; color?: string }[];
  // Users the server knows, so assign has a name to report.
  users?: { id: string; name: string }[];
  // The key's own notifications, oldest first.
  notifications?: { type: string; title?: string | null; content?: string | null; isRead?: boolean | null; eventData?: unknown }[];
  // Every workspace's members, as the members route lists them.
  members?: { id: string; name: string; email: string; role: string }[];
  // Invitations the detail route can be asked about.
  invitations?: { id: string; workspaceId: string; inviterName: string; expiresAt: string; status?: string }[];
  // A rule names its column by slug here, since the seeded columns' ids are only
  // handed out when the fake starts.
  workflowRules?: { projectId: string; integrationType: string; eventType: string; columnSlug: string }[];
  // A link without an integration is one a person added by hand.
  externalLinks?: { taskId: string; url: string; title?: string | null; resourceType?: string; externalId?: string; integration?: { id: string; type: string } }[];
};

export type Recorded = { method: string; path: string; query: string; body: unknown };

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
// The address every seeded invitation is sent to, and the moment the fake judges
// expiry at: later on the seed's day, so a seeded expiry can sit on either side
// of it and still be a 2026-01-01 time the goldens record rather than mask.
const INVITEE = "ada@example.com";
const INVITATIONS_JUDGED_AT = T0 + 12 * 3600 * 1000;
const DEFAULT_COLUMNS = [
  { slug: "to-do", name: "To Do" },
  { slug: "in-progress", name: "In Progress" },
  { slug: "done", name: "Done", isFinal: true },
];

// The columns a project starts with, as the server's own shape so the routes
// below can hand them straight to their schemas.
type SeedColumn = z.input<typeof M.Column>;

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
  // Adds a task when the listing is asked for this page, so the board changes
  // while it is being read and the total it reports moves under the reader.
  // Unbounded unless growTimes caps how many requests grow it, which is how a
  // board that never settles is reproduced.
  growOnPage?: number;
  growTimes?: number;
  // Answers the listing without applying status or priority, so what the CLI
  // prints is seen not to rest on the server having filtered.
  ignoreFilters?: boolean;
  // Answers a request whose "METHOD path" matches with a 500, having changed
  // nothing, for a write that is refused or a read that fails.
  failOn?: string;
  // Answers a matching PUT with the ordinary 200 while storing its title or
  // description with " (altered)" appended, so a client that reads the task
  // back finds something other than what it sent.
  misstoreOn?: string;
  // Answers a comment listing without the comments whose content matches, which
  // is how a marker the server accepted but did not keep is exercised.
  dropCommentsMatching?: string;
  // Answers a status, priority, assignee or move write with the task as it was,
  // each in the shape its own route answers in, which is how a write the server
  // accepted and did not keep is exercised.
  writesNotKept?: boolean;
  // Answers a comment post without the comment's id, so a marker that cannot be
  // looked for in the listing is exercised.
  commentReplyWithoutId?: boolean;
  // Serves the pinned document with createActivity requiring userId, as
  // Kaneo 2.20 does, and createTask without customFields, the request drift
  // api-check reports.
  driftedSpec?: boolean;
  // Serves the pinned document without createTask, an operation the client calls.
  specWithoutOperation?: boolean;
};

export function startFake(seed: Seed, opts: FakeOptions = {}) {
  let clock = 0;
  const now = () => new Date(T0 + 1000 * clock++).toISOString();
  let seq = 0;
  const id = (prefix: string) => `${prefix}${String(++seq).padStart(4, "0")}`;
  // Columns are numbered apart from the rest, because every project starts with
  // its own set: sharing the counter above would move the id a comment or a
  // relation is given later, which is what the recorded outputs name.
  let columnSeq = 0;
  const columnId = () => `col${String(++columnSeq).padStart(4, "0")}`;

  const seeded = seed.columns ?? DEFAULT_COLUMNS;
  const firstColumn = seeded[0]!.slug;
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
  // Every project gets the seeded columns as records of its own, which is what
  // makes a column created in one of them show up on that board and nowhere else.
  // They take the seed's own moment rather than a tick of the clock: a tick here
  // would move every task's timestamp in the seed, and with them every recorded
  // output.
  const seededAt = new Date(T0).toISOString();
  const columns: SeedColumn[] = [];
  for (const project of projects) {
    for (const [at, column] of seeded.entries()) {
      columns.push({
        id: columnId(),
        projectId: project.id,
        name: column.name,
        slug: column.slug,
        position: at,
        icon: null,
        color: null,
        isFinal: !!column.isFinal,
        createdAt: seededAt,
        updatedAt: seededAt,
      });
    }
  }
  const columnsOf = (projectId: string): SeedColumn[] =>
    columns.filter((c) => c.projectId === projectId).sort((a, b) => a.position - b.position);
  const addColumn = (projectId: string, wanted: z.input<typeof M.CreateColumnBody>): SeedColumn => {
    const at = now();
    const column: SeedColumn = {
      id: columnId(),
      projectId,
      name: wanted.name,
      slug: slugOf(wanted.name),
      position: Math.max(-1, ...columnsOf(projectId).map((c) => c.position)) + 1,
      icon: wanted.icon ?? null,
      color: wanted.color ?? null,
      isFinal: wanted.isFinal ?? false,
      createdAt: at,
      updatedAt: at,
    };
    columns.push(column);
    return column;
  };
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
      startDate: null as string | null,
      dueDate: null as string | null,
      createdAt: now(),
    };
    tasks.push(task);
    return task;
  };
  for (const t of seed.tasks) addTask(t.projectId, t, t.id);

  const comments: z.input<typeof M.Comment>[] = [];
  const addComment = (taskId: string, content: string, commentId = id("cmt"), userId = "user-self") => {
    const at = now();
    const c = { id: commentId, taskId, userId, content, createdAt: at, updatedAt: at, user: { name: userId === "user-self" ? "Self" : (seed.users?.find((u) => u.id === userId)?.name ?? userId), image: null } };
    comments.push(c);
    return c;
  };
  for (const c of seed.comments ?? []) addComment(c.taskId, c.content, c.id, c.userId);

  // Comments are activity rows on the server, so the feed is the comments plus
  // the events recorded beside them.
  const events: z.input<typeof M.Activity>[] = [];
  const asActivity = (a: { id: string; taskId: string; userId: string | null; content: string | null; createdAt: string; updatedAt: string }, type = "comment", eventData: unknown = null) => ({
    ...a,
    type,
    eventData,
    externalUserName: null,
    externalUserAvatar: null,
    externalSource: null,
    externalUrl: null,
  });

  const relations: z.input<typeof M.TaskRelation>[] = [];
  // One table for both kinds, as the server keeps them: a workspace label has
  // taskId null, and attaching inserts a copy carrying the task's id.
  const labels: z.input<typeof M.Label>[] = [];
  const addLabel = (name: string, color: string, workspaceId: string, taskId: string | null) => {
    const at = now();
    const l = { id: id("lbl"), name, color, createdAt: at, updatedAt: at, deletionStartedAt: null, taskId, workspaceId };
    labels.push(l);
    return l;
  };
  const timeEntries: z.input<typeof M.TimeEntry>[] = [];
  // A label on a task takes the workspace of the project the task is on, as the
  // attach route does.
  for (const l of seed.labels ?? []) {
    const project = projects.find((p) => p.id === tasks.find((t) => t.id === l.taskId)?.projectId);
    if (project !== undefined) addLabel(l.name, l.color ?? "gray", project.workspaceId, l.taskId);
  }
  const requests: Recorded[] = [];
  let grew = 0;

  // Notifications number and date themselves apart from everything else, so
  // seeding them leaves the ids and times the other scenarios record alone.
  // Workspace rules draw on the same counter.
  let nseq = 0;
  let nclock = 0;
  const nid = (prefix: string) => `${prefix}${String(++nseq).padStart(4, "0")}`;
  const nnow = () => new Date(T0 + 86_400_000 + 1000 * nclock++).toISOString();
  let notifications: z.input<typeof M.Notification>[] = [];
  const addNotification = (n: { type: string; title?: string | null; content?: string | null; isRead?: boolean | null; eventData?: unknown; resourceId?: string | null; resourceType?: string | null }) => {
    const at = nnow();
    const row = { id: nid("ntf"), userId: "user-self", title: n.title ?? null, content: n.content ?? null, type: n.type, eventData: n.eventData ?? null, isRead: n.isRead === undefined ? false : n.isRead, resourceId: n.resourceId ?? null, resourceType: n.resourceType ?? null, createdAt: at, updatedAt: at };
    notifications.push(row);
    return row;
  };
  for (const n of seed.notifications ?? []) addNotification(n);

  // Preferences as v2.29.2 keeps them: its defaults, its masking, and the
  // checks and carry-overs of notification-preferences/service.ts.
  const prefsAt = nnow();
  const secrets: Record<string, string | null> = { ntfyToken: null, gotifyToken: null, webhookSecret: null };
  const settings = {
    emailAddress: "self@example.com" as string | null,
    emailEnabled: false,
    ntfyEnabled: false,
    ntfyServerUrl: null as string | null,
    ntfyTopic: null as string | null,
    gotifyEnabled: false,
    gotifyServerUrl: null as string | null,
    webhookEnabled: false,
    webhookUrl: null as string | null,
    taskAssignmentEnabled: true,
    taskCommentEnabled: true,
    taskStatusChangeEnabled: true,
    dueDateReminderEnabled: true,
    dueDateReminderLeadTimeMinutes: 1440,
  };
  const rules: z.input<typeof M.NotificationPreferenceWorkspaceRule>[] = [];
  const masked = (s: string | null) => (!s ? null : s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : "••••");
  // Whether each channel can deliver at all, which is what a rule may turn on.
  const usable = () => ({
    emailEnabled: settings.emailEnabled && !!settings.emailAddress,
    ntfyEnabled: settings.ntfyEnabled && !!settings.ntfyServerUrl && !!settings.ntfyTopic,
    gotifyEnabled: settings.gotifyEnabled && !!settings.gotifyServerUrl && !!secrets.gotifyToken,
    webhookEnabled: settings.webhookEnabled && !!settings.webhookUrl,
  });
  const preferences = (): z.input<typeof M.NotificationPreferences> => ({
    ...settings,
    ntfyConfigured: !!(settings.ntfyServerUrl && settings.ntfyTopic),
    ntfyTokenConfigured: !!secrets.ntfyToken,
    maskedNtfyToken: masked(secrets.ntfyToken!),
    gotifyConfigured: !!(settings.gotifyServerUrl && secrets.gotifyToken),
    gotifyTokenConfigured: !!secrets.gotifyToken,
    maskedGotifyToken: masked(secrets.gotifyToken!),
    webhookConfigured: !!settings.webhookUrl,
    webhookSecretConfigured: !!secrets.webhookSecret,
    maskedWebhookSecret: masked(secrets.webhookSecret!),
    workspaces: rules,
    createdAt: prefsAt,
    updatedAt: prefsAt,
  });
  // The categories a user can turn off; a notification of a muted one is not stored.
  const CATEGORY: Record<string, keyof typeof settings> = {
    task_assignee_changed: "taskAssignmentEnabled",
    task_created: "taskAssignmentEnabled",
    task_comment: "taskCommentEnabled",
    task_mention: "taskCommentEnabled",
    task_status_changed: "taskStatusChangeEnabled",
    due_date_reminder: "dueDateReminderEnabled",
    task_overdue: "dueDateReminderEnabled",
  };

  const workflowRules: z.input<typeof M.WorkflowRuleRow>[] = [];
  for (const r of seed.workflowRules ?? []) {
    const at = now();
    const column = columnsOf(r.projectId).find((c) => c.slug === r.columnSlug)!;
    workflowRules.push({ id: id("rule"), projectId: r.projectId, integrationType: r.integrationType, eventType: r.eventType, columnId: column.id!, createdAt: at, updatedAt: at });
  }
  const links: z.input<typeof M.ExternalLink>[] = [];
  for (const l of seed.externalLinks ?? []) {
    const at = now();
    links.push({
      id: id("link"),
      taskId: l.taskId,
      integrationId: l.integration?.id ?? null,
      resourceType: l.resourceType ?? "url",
      externalId: l.externalId ?? l.url,
      url: l.url,
      title: l.title ?? null,
      metadata: null,
      createdAt: at,
      updatedAt: at,
      integration: l.integration ?? null,
    });
  }

  const ok = <S extends z.ZodTypeAny>(schema: S, body: z.input<S>, status = 200) =>
    Response.json(opts.legacy ? legacy(body) : schema.parse(body), { status });
  const fail = (status: number, message: string) => Response.json({ success: false, error: message }, { status });
  // What the real server sends for an HTTPException (its workspace middleware,
  // and the routes that throw one): the message as a text/plain body, with no
  // JSON envelope around it.
  const failText = (status: number, message: string) =>
    new Response(message, { status, headers: { "content-type": "text/plain;charset=UTF-8" } });

  // A description above 64 KiB is left out of the listing, which marks the task
  // rather than carrying the text; the task detail route still has it.
  const DEFERRED_OVER = 64 * 1024;
  const boardTask = (t: (typeof tasks)[number]) => {
    // Measured in bytes, as the server's octet_length is, not in UTF-16 units.
    const deferred = Buffer.byteLength(t.description ?? "", "utf8") > DEFERRED_OVER;
    return {
      id: t.id,
      title: t.title,
      number: t.number,
      description: deferred ? null : t.description,
      ...(deferred ? { descriptionDeferred: true } : {}),
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
      labels: labels.filter((l) => l.taskId === t.id).map((l) => ({ id: l.id, name: l.name, color: l.color })),
      externalLinks: [],
    };
  };
  const related = (t: (typeof tasks)[number] | undefined) =>
    t
      ? {
          id: t.id,
          title: t.title,
          status: t.status,
          isCompleted: !!columnsOf(t.projectId).find((c) => c.slug === t.status)?.isFinal,
          priority: t.priority,
          number: t.number,
          projectId: t.projectId,
          userId: t.userId,
          assigneeName: t.userId ? (users.get(t.userId) ?? null) : null,
        }
      : null;

  const failing = opts.failOn ? new RegExp(opts.failOn) : undefined;
  const misstoring = opts.misstoreOn ? new RegExp(opts.misstoreOn) : undefined;

  const route = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, "");
    const body = req.method === "GET" || req.method === "DELETE" ? undefined : await req.json().catch(() => null);
    requests.push({ method: req.method, path, query: url.search, body });

    if (!url.pathname.startsWith("/api/")) return new Response("<html>app</html>", { headers: { "content-type": "text/html" } });
    if (req.headers.get("authorization") !== "Bearer test-key") return fail(401, "Unauthorized");
    if (failing?.test(`${req.method} ${path}`)) return fail(500, "injected failure");

    // The server validates request bodies against the same schemas the
    // document declares, and answers 400 with the first issue.
    const BODIES: [string, RegExp, z.ZodTypeAny][] = [
      ["POST", /^\/auth\/organization\/update$/, M.UpdateOrganizationBody],
      ["POST", /^\/project$/, M.CreateProjectBody],
      ["PUT", /^\/project\/(?!reorder$)[^/]+$/, M.UpdateProjectBody],
      ["PUT", /^\/project\/reorder$/, M.ReorderProjectsBody],
      ["PUT", /^\/workflow-rule\/[^/]+$/, M.UpsertWorkflowRuleBody],
      ["POST", /^\/column\/[^/]+$/, M.CreateColumnBody],
      ["PUT", /^\/column\/[^/]+$/, M.UpdateColumnBody],
      ["PUT", /^\/column\/reorder\/[^/]+$/, M.ReorderColumnsBody],
      ["POST", /^\/task\/[^/]+$/, M.CreateTaskBody],
      ["PUT", /^\/task\/status\/[^/]+$/, M.UpdateTaskStatusBody],
      ["PUT", /^\/task\/priority\/[^/]+$/, M.UpdateTaskPriorityBody],
      ["PUT", /^\/task\/assignee\/[^/]+$/, M.UpdateTaskAssigneeBody],
      ["PUT", /^\/task\/move\/[^/]+$/, M.MoveTaskBody],
      ["PUT", /^\/task\/[^/]+$/, M.UpdateTaskBody],
      ["PUT", /^\/task\/title\/[^/]+$/, M.UpdateTaskTitleBody],
      ["PUT", /^\/task\/description\/[^/]+$/, M.UpdateTaskDescriptionBody],
      ["PUT", /^\/task\/due-date\/[^/]+$/, M.UpdateTaskDueDateBody],
      ["PATCH", /^\/task\/bulk$/, M.BulkUpdateTasksBody],
      ["POST", /^\/task\/import\/[^/]+$/, M.ImportTasksBody],
      ["POST", /^\/task-relation$/, M.CreateTaskRelationBody],
      ["POST", /^\/comment\/[^/]+$/, M.CreateTaskCommentBody],
      ["POST", /^\/notification$/, M.CreateNotificationBody],
      ["PUT", /^\/notification-preferences$/, M.UpdateNotificationPreferencesBody],
      ["PUT", /^\/notification-preferences\/workspaces\/[^/]+$/, M.UpsertNotificationPreferenceWorkspaceRuleBody],
      ["PUT", /^\/comment\/[^/]+$/, M.UpdateTaskCommentBody],
      ["POST", /^\/activity\/create$/, M.CreateActivityBody],
      ["POST", /^\/label$/, M.CreateLabelBody],
      ["PUT", /^\/label\/[^/]+$/, M.UpdateLabelBody],
      ["PUT", /^\/label\/[^/]+\/task$/, M.AttachLabelToTaskBody],
      ["POST", /^\/time-entry$/, M.CreateTimeEntryBody],
      ["PUT", /^\/time-entry\/[^/]+$/, M.UpdateTimeEntryBody],
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

    if (req.method === "GET" && path === "/openapi") {
      if (!opts.driftedSpec && !opts.specWithoutOperation) return new Response(Bun.file(SPEC_PATH));
      const doc = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
      if (opts.specWithoutOperation) {
        delete doc.paths["/task/{projectId}"].post;
        return Response.json(doc);
      }
      const body = (p: string, m: string) => doc.paths[p][m].requestBody.content["application/json"].schema;
      delete body("/task/{projectId}", "post").properties.customFields;
      body("/activity/create", "post").required.push("userId");
      return Response.json(doc);
    }
    if (req.method === "GET" && path === "/auth/organization/list") return ok(z.array(M.Organization), workspaces);
    if (req.method === "POST" && path === "/auth/organization/update") {
      const w = workspaces.find((x) => x.id === (body as any)?.organizationId);
      if (!w) return fail(404, "Organization not found");
      Object.assign(w, (body as any).data);
      return ok(M.Organization, w);
    }

    if (req.method === "GET" && (p = m(/^\/workspace\/([^/]+)\/members$/))) {
      const ws = decodeURIComponent(p[1]);
      if (!workspaces.some((x) => x.id === ws)) return fail(403, "You don't have access to this workspace");
      return ok(z.array(M.WorkspaceMember), (seed.members ?? []).map((u) => ({ ...u, image: null })));
    }

    // Expiry is judged at a fixed moment, so the outcome does not depend on when
    // the suite runs. The answers are v2.29.2's getInvitationDetails: an accepted
    // or canceled invitation has its details withheld but says which it was.
    if (req.method === "GET" && (p = m(/^\/invitation\/([^/]+)$/))) {
      const found = (seed.invitations ?? []).find((i) => i.id === decodeURIComponent(p![1]));
      if (!found) return ok(M.InvitationDetails, { valid: false, error: "Invitation not found" });
      const status = found.status ?? "pending";
      if (status === "accepted") return ok(M.InvitationDetails, { valid: false, error: "This invitation has already been accepted" });
      if (status === "canceled") return ok(M.InvitationDetails, { valid: false, error: "This invitation has been canceled" });
      const expired = Date.parse(found.expiresAt) < INVITATIONS_JUDGED_AT;
      const details = {
        id: found.id,
        email: INVITEE,
        workspaceName: workspaces.find((w) => w.id === found.workspaceId)?.name ?? "",
        inviterName: found.inviterName,
        expiresAt: found.expiresAt,
        status,
        expired,
      };
      if (expired) return ok(M.InvitationDetails, { valid: false, invitation: details, error: "This invitation has expired" });
      return ok(M.InvitationDetails, { valid: true, invitation: details });
    }

    if (req.method === "GET" && path === "/search") {
      const ws = url.searchParams.get("workspaceId") ?? "";
      if (!workspaces.some((x) => x.id === ws)) return fail(403, "You don't have access to this workspace");
      const type = url.searchParams.get("type") ?? "all";
      // The server's validation hook reports the first issue as "<field>: <message>".
      const typed = z.enum(["all", "tasks", "projects", "workspaces", "comments", "activities"]).safeParse(type);
      if (!typed.success) return fail(400, `type: ${typed.error.issues[0]!.message}`);
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const only = url.searchParams.get("projectId");
      const hit = (...texts: (string | null | undefined)[]) => texts.some((t) => (t ?? "").toLowerCase().includes(q));
      // As in v2.29.2, each type's query is limited on its own, totalCount is the
      // sum of what they returned, and projects are not narrowed by projectId.
      const limit = Number(url.searchParams.get("limit") ?? "20");
      const capped = <T>(list: T[]) => list.slice(0, limit);
      const inWorkspace = projects.filter((x) => x.workspaceId === ws);
      const inScope = inWorkspace.filter((x) => only === null || x.id === only);
      const where = (x: (typeof projects)[number]) => ({ projectId: x.id, projectName: x.name, projectSlug: x.slug, workspaceId: ws, workspaceName: workspaces.find((w) => w.id === ws)!.name });
      type Hit = z.input<typeof M.SearchResult>;
      const found: Hit[] = [];
      const taskHits: Hit[] = [];
      const commentHits: Hit[] = [];
      // Workspaces are matched across every one the key can reach whichever
      // workspace is asked, and each once per member, as in v2.29.2 (it joins
      // the members without narrowing them), so the same match comes back from a
      // search of each, and more than once.
      const workspaceHits: Hit[] = [];
      for (const w of workspaces) {
        if ((type === "all" || type === "workspaces") && hit(w.name)) {
          for (let n = 0; n < Math.max(1, seed.members?.length ?? 0); n++) {
            workspaceHits.push({ id: w.id, type: "workspace", title: w.name, createdAt: seededAt, relevanceScore: 3, workspaceId: w.id, workspaceName: w.name });
          }
        }
      }
      for (const x of inWorkspace) {
        if ((type === "all" || type === "projects") && hit(x.name, x.slug)) {
          found.push({ id: x.id, type: "project", title: x.name, createdAt: x.createdAt, relevanceScore: 3, ...where(x) });
        }
      }
      for (const x of inScope) {
        for (const t of tasks.filter((t) => t.projectId === x.id)) {
          if ((type === "all" || type === "tasks") && hit(t.title, t.description)) {
            taskHits.push({ id: t.id, type: "task", title: t.title, ...(t.description ? { description: t.description } : {}), createdAt: t.createdAt, relevanceScore: 2, taskNumber: t.number ?? undefined, priority: t.priority, status: t.status, ...where(x) });
          }
          for (const c of comments.filter((c) => c.taskId === t.id)) {
            if ((type === "all" || type === "comments" || type === "activities") && hit(c.content)) {
              commentHits.push({ id: c.id, type: "comment", title: `Comment on ${t.title}`, content: c.content, createdAt: c.createdAt, relevanceScore: 1, taskNumber: t.number ?? undefined, userId: c.userId, userName: users.get(c.userId) ?? "", ...where(x) });
            }
          }
        }
      }
      const ranked = (list: Hit[]) => list.sort((a, b) => b.relevanceScore - a.relevanceScore || Date.parse(b.createdAt) - Date.parse(a.createdAt));
      const results = ranked([...capped(ranked(found)), ...capped(ranked(taskHits)), ...capped(workspaceHits), ...capped(ranked(commentHits))]);
      return ok(M.SearchResponse, { results: capped(results), totalCount: results.length, searchQuery: url.searchParams.get("q") ?? "" });
    }

    if (req.method === "GET" && path === "/project") {
      const ws = url.searchParams.get("workspaceId");
      // A workspace the key has no access to and one that does not exist are the
      // same answer, which is what made --workspace <name> read as a permission
      // problem rather than as an unknown value.
      if (!workspaces.some((x) => x.id === ws)) return fail(403, "You don't have access to this workspace");
      const all = url.searchParams.get("includeArchived") === "true";
      // Sidebar order, as upstream's get-projects.ts sorts it.
      const list = [...projects]
        .sort((a, b) => a.position - b.position)
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
    if (req.method === "PUT" && path === "/project/reorder") {
      // As upstream's reorder-projects.ts: the payload's positions only say an
      // order, a project left out keeps its rank, and the requested ones fill the
      // slots around it. The whole workspace comes back, archived projects too.
      const ws = url.searchParams.get("workspaceId");
      if (!workspaces.some((x) => x.id === ws)) return fail(403, "You don't have access to this workspace");
      const wanted = ((body as any)?.projects ?? []) as { id: string; position: number }[];
      const ids = wanted.map((x) => x.id);
      if (new Set(ids).size !== ids.length) return fail(400, "Duplicate project ids in reorder payload");
      const existing = projects.filter((x) => x.workspaceId === ws).sort((a, b) => a.position - b.position);
      const foreign = ids.find((x) => !existing.some((e) => e.id === x));
      if (foreign) return fail(400, `Project ${foreign} does not belong to this workspace`);
      const requested = [...wanted].sort((a, b) => a.position - b.position).map((x) => x.id)[Symbol.iterator]();
      const order = existing.map((e) => (ids.includes(e.id) ? requested.next().value! : e.id));
      for (const [at, pid] of order.entries()) projects.find((x) => x.id === pid)!.position = at;
      return ok(z.array(M.Project), projects.filter((x) => x.workspaceId === ws).sort((a, b) => a.position - b.position));
    }
    if ((p = m(/^\/project\/([^/]+)(\/(archive|unarchive))?$/))) {
      const proj = projects.find((x) => x.id === decodeURIComponent(p![1]));
      // Checked by the server's workspace middleware before the route runs, as on
      // the task routes below.
      if (!proj) return failText(400, "Workspace ID could not be determined");
      if (req.method === "GET" && !p[2]) return ok(M.Project, proj);
      if (req.method === "PUT" && !p[2]) {
        Object.assign(proj, body);
        return ok(M.Project, proj);
      }
      if (req.method === "PUT" && p[3] === "archive") return ok(M.Project, Object.assign(proj, { archivedAt: now() }));
      if (req.method === "PUT" && p[3] === "unarchive") return ok(M.Project, Object.assign(proj, { archivedAt: null }));
      // Everything in the project goes with it, as the database's cascades do.
      if (req.method === "DELETE" && !p[2]) {
        const reply = ok(M.Project, proj);
        const gone = new Set(tasks.filter((t) => t.projectId === proj.id).map((t) => t.id));
        for (const list of [tasks, columns, workflowRules] as { projectId?: string }[][]) {
          for (let i = list.length - 1; i >= 0; i--) if (list[i]!.projectId === proj.id) list.splice(i, 1);
        }
        for (let i = links.length - 1; i >= 0; i--) if (gone.has(links[i]!.taskId)) links.splice(i, 1);
        for (let i = comments.length - 1; i >= 0; i--) if (gone.has(comments[i]!.taskId)) comments.splice(i, 1);
        // A link between two tasks is two rows of one thing, so one end going
        // takes it with it, as the cascade on task_relation does.
        for (let i = relations.length - 1; i >= 0; i--) {
          const r = relations[i]!;
          if (gone.has(r.sourceTaskId) || gone.has(r.targetTaskId)) relations.splice(i, 1);
        }
        projects.splice(projects.indexOf(proj), 1);
        return reply;
      }
    }

    if ((p = m(/^\/column\/reorder\/([^/]+)$/)) && req.method === "PUT") {
      const proj = projects.find((x) => x.id === decodeURIComponent(p![1]));
      if (!proj) return fail(404, "Project not found");
      const mine = new Map(columnsOf(proj.id).map((c) => [c.id, c]));
      const wanted = (body as any)?.columns ?? [];
      const off = wanted.filter((c: any) => !mine.has(c.id));
      if (off.length > 0) return fail(400, `Column not in this project: ${off.map((c: any) => c.id).join(", ")}`);
      for (const c of wanted) mine.get(c.id)!.position = c.position;
      return ok(z.array(M.Column), columnsOf(proj.id));
    }
    if ((p = m(/^\/column\/([^/]+)$/))) {
      const key = decodeURIComponent(p![1]);
      if (req.method === "GET" || req.method === "POST") {
        // The workspace middleware finds no project before the controller runs,
        // and its HTTPException is plain text.
        if (!projects.some((x) => x.id === key)) return failText(400, "Workspace ID could not be determined");
        if (req.method === "GET") return ok(z.array(M.Column), columnsOf(key));
        const wanted = (body ?? {}) as z.input<typeof M.CreateColumnBody>;
        // The slug comes from the name, and one this project already holds is
        // refused rather than given a second column of the same name.
        const slug = slugOf(wanted.name);
        if (slug === "") return fail(400, "Column name must contain at least one alphanumeric character");
        if (VIRTUAL_STATUSES.includes(slug)) return fail(409, `Column slug "${slug}" is reserved for virtual task statuses`);
        if (columnsOf(key).some((c) => c.slug === slug)) return fail(409, `Column with slug "${slug}" already exists in this project`);
        return ok(M.Column, addColumn(key, wanted));
      }
      const column = columns.find((c) => c.id === key);
      if (!column) return fail(404, "Column not found");
      // A field left out of the update keeps its value, which is what icon and
      // color take null for: clearing one is asking for it.
      if (req.method === "PUT") {
        Object.assign(column, body);
        column.updatedAt = now();
        return ok(M.Column, column);
      }
      if (req.method === "DELETE") {
        if (tasks.some((t) => t.projectId === column.projectId && t.status === column.slug)) {
          return fail(409, "Cannot delete column that contains tasks. Move or delete tasks first.");
        }
        // The rules that point at it go with it, as workflow_rule.column_id does
        // on delete: a rule cannot outlive its column.
        for (let i = workflowRules.length - 1; i >= 0; i--) if (workflowRules[i]!.columnId === column.id) workflowRules.splice(i, 1);
        columns.splice(columns.indexOf(column), 1);
        return ok(M.Column, column);
      }
    }

    if (req.method === "GET" && (p = m(/^\/task\/tasks\/([^/]+)$/))) {
      const proj = projects.find((x) => x.id === decodeURIComponent(p![1]));
      // The real server reads the path segment as a project id, finds no such
      // project and falls back to guessing a workspace from the key, which it
      // cannot: 400 with that complaint rather than a 404.
      if (!proj) return failText(400, "Workspace ID could not be determined");
      const page = Number(url.searchParams.get("page") ?? 1);
      // Grown before the page is cut, so the reply carries both the task and the
      // new total: a board that moved while it was read says so in the total.
      if (opts.growOnPage === page && grew < (opts.growTimes ?? Infinity)) {
        grew += 1;
        addTask(proj.id, { title: `Arrived late ${grew}` });
      }
      // Filters apply before the page is cut, as the document says they do.
      const filterStatus = opts.ignoreFilters ? null : url.searchParams.get("status");
      const filterPriority = opts.ignoreFilters ? null : url.searchParams.get("priority");
      const mine = tasks.filter(
        (t) =>
          t.projectId === proj.id &&
          (filterStatus === null || t.status === filterStatus) &&
          (filterPriority === null || t.priority === filterPriority),
      );
      const size = opts.pageSize ?? 50;
      const slice = url.searchParams.has("page") || url.searchParams.has("limit") || opts.pageSize ? mine.slice((page - 1) * size, page * size) : mine;
      const { lastTaskNumber, archivedAt, createdAt, position, ...head } = proj;
      return ok(M.BoardResponse, {
        data: {
          ...head,
          columns: columnsOf(proj.id).map((c) => ({ id: c.slug, slug: c.slug, name: c.name, icon: c.icon, isFinal: c.isFinal, position: c.position, tasks: slice.filter((t) => t.status === c.slug).map(boardTask) })),
          // A task in no column is answered beside the columns, one list each.
          archivedTasks: slice.filter((t) => t.status === "archived").map(boardTask),
          plannedTasks: slice.filter((t) => t.status === "planned").map(boardTask),
        },
        pagination: { total: mine.length, page, pageSize: size, totalPages: Math.max(1, Math.ceil(mine.length / size)), relatedPage: 1, relatedPageSize: 100, relatedTotalPages: 1 },
      });
    }
    if (req.method === "PUT" && (p = m(/^\/task\/due-date\/([^/]+)$/))) {
      const t = tasks.find((x) => x.id === decodeURIComponent(p![1]));
      if (!t) return fail(404, "Task not found");
      const given = (body as any)?.dueDate as string | undefined;
      // An empty string clears, as a missing one does: upstream reads the field
      // as `dueDate ? parse(dueDate) : null`.
      if (given) {
        const at = parsedDate(given, "dueDate");
        if (typeof at !== "string") return at;
        t.dueDate = at;
      } else t.dueDate = null;
      return ok(M.Task, t);
    }
    if (req.method === "PATCH" && path === "/task/bulk") {
      const b = body as z.input<typeof M.BulkUpdateTasksBody>;
      const found = tasks.filter((t) => b.taskIds.includes(t.id));
      if (found.length === 0) return fail(404, "No tasks found");
      const spaces = new Set(found.map((t) => projects.find((x) => x.id === t.projectId)!.workspaceId));
      if (spaces.size > 1) return fail(400, "All tasks must belong to the same workspace");
      const value = b.value ?? null;
      switch (b.operation) {
        // One project at a time, checked and then written, with no transaction:
        // a status the second project lacks is refused after the first one's
        // tasks have moved, as upstream's bulk-update-tasks.ts does.
        case "updateStatus":
          if (!value) return fail(400, "Status value is required");
          for (const projectId of new Set(found.map((t) => t.projectId))) {
            if (!columnsOf(projectId).some((c) => c.slug === value) && !VIRTUAL_STATUSES.includes(value)) {
              return fail(400, `Invalid status "${value}"`);
            }
            for (const t of found) if (t.projectId === projectId) t.status = value;
          }
          break;
        case "updatePriority":
          if (!value) return fail(400, "Priority value is required");
          for (const t of found) t.priority = value;
          break;
        case "updateAssignee": {
          const assignee = value?.trim() || null;
          if (assignee && !users.has(assignee)) return fail(403, "Assignee is not a member of this workspace");
          for (const t of found) t.userId = assignee;
          break;
        }
        case "delete":
          for (const t of found) tasks.splice(tasks.indexOf(t), 1);
          break;
        case "updateDueDate": {
          const at = value ? parsedDate(value, "date value") : null;
          if (at !== null && typeof at !== "string") return at;
          for (const t of found) t.dueDate = at;
          break;
        }
        // The fake keeps no labels, so every label id is one the server would not
        // find.
        default:
          return fail(404, "Label not found");
      }
      return ok(M.BulkTaskResult, { success: true, updatedCount: found.length });
    }
    if (req.method === "GET" && (p = m(/^\/task\/export\/([^/]+)$/))) {
      const proj = projects.find((x) => x.id === decodeURIComponent(p![1]));
      if (!proj) return fail(400, "Workspace ID could not be determined");
      return ok(M.TaskExport, {
        project: { name: proj.name, slug: proj.slug, description: proj.description, exportedAt: now() },
        tasks: tasks
          .filter((t) => t.projectId === proj.id)
          .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
          .map((t) => ({ title: t.title, description: t.description || "", status: t.status, priority: t.priority || "low", dueDate: t.dueDate ?? null, startDate: t.startDate ?? null, userId: t.userId || null, labels: [] })),
      });
    }
    if (req.method === "POST" && (p = m(/^\/task\/import\/([^/]+)$/))) {
      const proj = projects.find((x) => x.id === decodeURIComponent(p![1]));
      if (!proj) return fail(400, "Workspace ID could not be determined");
      const results = ((body as any).tasks as z.input<typeof M.ImportTasksBody>["tasks"]).map((wanted) => {
        const assignee = wanted.userId?.trim() || null;
        if (assignee && !users.has(assignee)) return { success: false, error: "Assignee is not a member of this workspace", task: wanted };
        const warnings: string[] = [];
        let status = wanted.status;
        if (!columnsOf(proj.id).some((c) => c.slug === status) && !VIRTUAL_STATUSES.includes(status)) {
          warnings.push(`Unknown status "${status}" mapped to "planned"`);
          status = "planned";
        }
        let priority = wanted.priority || "low";
        if (!["no-priority", "low", "medium", "high", "urgent"].includes(priority)) {
          warnings.push(`Unknown priority "${priority}" mapped to "no-priority"`);
          priority = "no-priority";
        }
        // The server builds a Date from each without checking it, so one that
        // does not parse fails that task alone.
        const bad = [wanted.dueDate, wanted.startDate].find((d) => d && Number.isNaN(Date.parse(d)));
        if (bad) return { success: false, error: "Invalid time value", task: wanted };
        const created = addTask(proj.id, { title: wanted.title, description: wanted.description || "", status, priority, userId: assignee });
        created.dueDate = wanted.dueDate ? new Date(wanted.dueDate).toISOString() : null;
        created.startDate = wanted.startDate ? new Date(wanted.startDate).toISOString() : null;
        return { success: true, task: created, ...(warnings.length > 0 && { warnings }) };
      });
      return ok(M.TaskImportResult, {
        results: { total: results.length, successful: results.filter((r) => r.success).length, failed: results.filter((r) => !r.success).length, tasks: results },
      });
    }
    if (req.method === "POST" && (p = m(/^\/task\/([^/]+)$/))) {
      const proj = projects.find((x) => x.id === decodeURIComponent(p![1]));
      if (!proj) return failText(400, "Workspace ID could not be determined");
      return ok(M.Task, addTask(proj.id, body as any));
    }
    if ((p = m(/^\/task\/(status|priority|assignee|move|title|description)\/([^/]+)$/)) && req.method === "PUT") {
      const t = tasks.find((x) => x.id === decodeURIComponent(p![2]));
      if (!t) return fail(404, "Task not found");
      const b = body as any;
      // Every route below answers the shape its caller reads, and none of them
      // stores anything: what the server accepted is not what the task holds.
      if (opts.writesNotKept) {
        if (p[1] !== "move") return ok(M.Task, t);
        if (!b?.destinationProjectId) return fail(400, 'Invalid key: Expected "destinationProjectId" but received undefined');
        return ok(M.MoveTaskResult, { task: t, sourceProjectId: t.projectId, destinationProjectId: b.destinationProjectId });
      }
      if (p[1] === "status") {
        // The only write the server judges against the project rather than
        // against a fixed list: a column is the project's own, and the two
        // virtual statuses a task can hold are valid beside them. The 400 names
        // them all, the way apps/api/src/task/validate-task-fields.ts does.
        const statuses = [...columnsOf(t.projectId).map((c) => c.slug), ...VIRTUAL_STATUSES];
        if (!statuses.includes(b.status)) {
          return fail(400, `Invalid status "${b.status}". Valid statuses for this project: ${statuses.join(", ")}`);
        }
        t.status = b.status;
      }
      if (p[1] === "priority") t.priority = b.priority;
      const altered = misstoring?.test(`${req.method} ${path}`) === true;
      if (p[1] === "title") t.title = altered ? `${b.title} (altered)` : b.title;
      if (p[1] === "description") t.description = altered ? `${b.description} (altered)` : b.description;
      if (p[1] === "assignee") {
        if (!("userId" in (b ?? {}))) return fail(400, 'Invalid key: Expected "userId" but received undefined');
        t.userId = b.userId;
      }
      if (p[1] === "move") {
        if (!b?.destinationProjectId) return fail(400, 'Invalid key: Expected "destinationProjectId" but received undefined');
        const from = t.projectId;
        const dest = projects.find((x) => x.id === b.destinationProjectId);
        if (!dest) return failText(404, "Project not found");
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
      // The detail view of v2.32.0's get-task.ts. The fake keeps no column
      // reference on a task, so it is the column the status names; a virtual
      // status has none.
      if (req.method === "GET") {
        return ok(M.TaskWithAssignee, {
          ...t,
          columnId: columnsOf(t.projectId).find((c) => c.slug === t.status)?.id ?? null,
          workspaceId: projects.find((x) => x.id === t.projectId)?.workspaceId,
          assigneeId: t.userId,
          assigneeName: t.userId ? (users.get(t.userId) ?? null) : null,
        });
      }
      // A full replace, as upstream's update-task.ts does it: a start date, due
      // date or assignee left out is stored as none, a description left out is
      // kept, and moving to another project is refused.
      if (req.method === "PUT") {
        const b = body as z.input<typeof M.UpdateTaskBody>;
        if (b.projectId !== t.projectId) return fail(400, "Use the task move endpoint to move tasks between projects");
        if (!columnsOf(t.projectId).some((c) => c.slug === b.status) && !VIRTUAL_STATUSES.includes(b.status)) {
          return fail(400, `Invalid status "${b.status}"`);
        }
        const assignee = b.userId?.trim() || null;
        if (assignee && !users.has(assignee)) return fail(403, "Assignee is not a member of this workspace");
        const start = b.startDate === undefined ? null : parsedDate(b.startDate, "startDate");
        if (start !== null && typeof start !== "string") return start;
        const due = b.dueDate === undefined ? null : parsedDate(b.dueDate, "dueDate");
        if (due !== null && typeof due !== "string") return due;
        if (start !== null && due !== null && Date.parse(start) > Date.parse(due)) {
          return fail(400, "Start date cannot be after due date. Please adjust the date range.");
        }
        Object.assign(t, {
          title: b.title,
          status: b.status,
          priority: b.priority,
          position: b.position,
          startDate: start,
          dueDate: due,
          userId: assignee,
          ...(b.description === undefined ? {} : { description: b.description }),
        });
        return ok(M.Task, t);
      }
      if (req.method === "DELETE") {
        tasks.splice(i, 1);
        // The document says a task takes its time entries with it.
        for (let j = timeEntries.length - 1; j >= 0; j--) if (timeEntries[j]!.taskId === t.id) timeEntries.splice(j, 1);
        return ok(M.Task, t);
      }
    }

    if (req.method === "DELETE" && (p = m(/^\/comment\/([^/]+)$/))) {
      // Upstream resolves the comment's workspace first and only then looks
      // for it among the caller's own comments.
      const i = comments.findIndex((c) => c.id === decodeURIComponent(p![1]));
      if (i < 0) return failText(400, "Workspace ID could not be determined");
      if (comments[i]!.userId !== "user-self") return fail(404, "Comment not found or you are not the author");
      const { user: _, ...c } = comments[i]!;
      const reply = ok(M.Activity, { ...c, type: "comment", externalUserName: null, externalUserAvatar: null, externalSource: null, externalUrl: null });
      comments.splice(i, 1);
      return reply;
    }

    if ((p = m(/^\/comment\/([^/]+)$/)) && req.method !== "PUT") {
      const taskId = decodeURIComponent(p[1]);
      if (!tasks.some((t) => t.id === taskId)) return fail(404, "Task not found");
      if (req.method === "GET") {
        return ok(z.array(M.Comment), comments.filter((c) => c.taskId === taskId && !(dropped?.test(c.content) ?? false)));
      }
      if (req.method === "POST") {
        const added = addComment(taskId, (body as any).content);
        // Sent past the schema, which requires the id this reply exists to leave out.
        if (opts.commentReplyWithoutId) return Response.json({ ...M.Comment.parse(added), id: undefined });
        return ok(M.Comment, added);
      }
    }
    // PUT takes the comment's id where GET and POST take the task's, and
    // answers like DELETE for an unknown id and for someone else's comment.
    if ((p = m(/^\/comment\/([^/]+)$/)) && req.method === "PUT") {
      const c = comments.find((x) => x.id === decodeURIComponent(p![1]));
      if (!c) return fail(400, "Workspace ID could not be determined");
      if (c.userId !== "user-self") return fail(404, "Comment not found or you are not the author");
      Object.assign(c, { content: (body as any).content, updatedAt: now() });
      return ok(M.Activity, asActivity(c));
    }

    if ((p = m(/^\/activity\/([^/]+)$/)) && req.method === "GET") {
      const taskId = decodeURIComponent(p[1]);
      const feed = [...comments.filter((c) => c.taskId === taskId).map((c) => asActivity(c)), ...events.filter((e) => e.taskId === taskId)];
      return ok(z.array(M.Activity), feed.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    }
    if (req.method === "POST" && path === "/activity/create") {
      const b = body as any;
      // 400 for both, as the pinned document has it; comments are refused here from 2.27.0.
      if (!tasks.some((t) => t.id === b.taskId)) return fail(400, "Task not found");
      if (b.type === "comment") return fail(400, "Use the comment endpoint");
      const at = now();
      const e = asActivity({ id: id("act"), taskId: b.taskId, userId: "user-self", content: b.message, createdAt: at, updatedAt: at }, b.type, b.eventData ?? null);
      events.push(e);
      return ok(M.Activity, e);
    }

    // As v2.29.2 answers: an update keeps the end and description the body
    // leaves out, and an end before the start is a 400. An unknown task or entry
    // never reaches a controller: the workspace-access middleware finds no
    // workspace for it first and says so. The duration cap is not modelled.
    const noWorkspace = () => fail(400, "Workspace ID could not be determined");
    const duration = (start: string, end: string | null | undefined) => {
      if (!end) return null;
      const d = Math.floor((Date.parse(end) - Date.parse(start)) / 1000);
      return d < 0 ? undefined : d;
    };
    if (req.method === "POST" && path === "/time-entry") {
      const b = body as any;
      if (!tasks.some((t) => t.id === b.taskId)) return noWorkspace();
      const d = duration(b.startTime, b.endTime);
      if (d === undefined) return fail(400, "Start time cannot be after end time. Please adjust the time range.");
      const at = now();
      const e = { id: id("time"), taskId: b.taskId, userId: "user-self", description: b.description || "", startTime: new Date(b.startTime).toISOString(), endTime: b.endTime ? new Date(b.endTime).toISOString() : null, duration: d, createdAt: at, updatedAt: at };
      timeEntries.push(e);
      return ok(M.TimeEntry, e);
    }
    if ((p = m(/^\/time-entry\/task\/([^/]+)$/))) {
      const taskId = decodeURIComponent(p[1]);
      if (!tasks.some((t) => t.id === taskId)) return noWorkspace();
      const list = timeEntries
        .filter((e) => e.taskId === taskId)
        .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))
        .map((e) => ({ ...e, userName: "Self" }));
      return ok(z.array(M.TimeEntryWithUser), list);
    }
    if ((p = m(/^\/time-entry\/([^/]+)$/))) {
      const e = timeEntries.find((x) => x.id === decodeURIComponent(p![1]));
      if (!e) return noWorkspace();
      if (req.method === "GET") return ok(M.TimeEntry, e);
      if (req.method === "PUT") {
        const b = body as any;
        const end = b.endTime ? new Date(b.endTime).toISOString() : e.endTime;
        const d = duration(b.startTime, end);
        if (d === undefined) return fail(400, "Start time cannot be after end time. Please adjust the time range.");
        Object.assign(e, { startTime: new Date(b.startTime).toISOString(), endTime: end, duration: d, updatedAt: now() }, b.description === undefined ? {} : { description: b.description });
        return ok(M.TimeEntry, e);
      }
    }

    if ((p = m(/^\/workflow-rule\/([^/]+)$/))) {
      const key = decodeURIComponent(p[1]);
      if (req.method === "DELETE") {
        // The workspace middleware looks the rule up first, so an unknown one is
        // its 400 rather than the controller's 404.
        const i = workflowRules.findIndex((r) => r.id === key);
        if (i < 0) return fail(400, "Workspace ID could not be determined");
        return ok(M.WorkflowRuleRow, workflowRules.splice(i, 1)[0]!);
      }
      if (!projects.some((x) => x.id === key)) return failText(400, "Workspace ID could not be determined");
      if (req.method === "GET") {
        return ok(
          z.array(M.WorkflowRule),
          workflowRules
            .filter((r) => r.projectId === key)
            .map((r) => {
              const column = columns.find((c) => c.id === r.columnId);
              return { ...r, columnName: column?.name ?? null, columnSlug: column?.slug ?? null };
            }),
        );
      }
      if (req.method === "PUT") {
        const b = body as z.input<typeof M.UpsertWorkflowRuleBody>;
        if (!columnsOf(key).some((c) => c.id === b.columnId)) return fail(400, "Column does not belong to the provided project");
        const found = workflowRules.find((r) => r.projectId === key && r.integrationType === b.integrationType && r.eventType === b.eventType);
        if (found) return ok(M.WorkflowRuleRow, Object.assign(found, { columnId: b.columnId, updatedAt: now() }));
        const at = now();
        const rule = { id: id("rule"), projectId: key, integrationType: b.integrationType, eventType: b.eventType, columnId: b.columnId, createdAt: at, updatedAt: at };
        workflowRules.push(rule);
        return ok(M.WorkflowRuleRow, rule);
      }
    }

    if (req.method === "GET" && (p = m(/^\/external-link\/task\/([^/]+)$/))) {
      const taskId = decodeURIComponent(p[1]);
      if (!tasks.some((t) => t.id === taskId)) return fail(400, "Workspace ID could not be determined");
      return ok(z.array(M.ExternalLink), links.filter((l) => l.taskId === taskId));
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

    if (req.method === "GET" && path === "/notification") {
      return ok(z.array(M.Notification), [...notifications].reverse().slice(0, 50));
    }
    if (req.method === "POST" && path === "/notification") {
      const b = body as any;
      const reachable =
        (b.relatedEntityId === undefined && b.relatedEntityType === undefined) ||
        (b.relatedEntityType === "task" && tasks.some((t) => t.id === b.relatedEntityId)) ||
        (b.relatedEntityType === "workspace" && workspaces.some((w) => w.id === b.relatedEntityId));
      const category = CATEGORY[b.type];
      if (!reachable || (category && settings[category] === false)) return Response.json(null);
      return ok(M.Notification, addNotification({ type: b.type, title: b.title, content: b.message, resourceId: b.relatedEntityId, resourceType: b.relatedEntityType }));
    }
    if (req.method === "PATCH" && path === "/notification/read-all") {
      for (const n of notifications) n.isRead = true;
      return ok(M.NotificationBulkResult, { success: true });
    }
    if (req.method === "DELETE" && path === "/notification/clear-all") {
      notifications = [];
      return ok(M.NotificationBulkResult, { success: true });
    }
    if (req.method === "PATCH" && (p = m(/^\/notification\/([^/]+)\/read$/))) {
      const n = notifications.find((x) => x.id === decodeURIComponent(p![1]));
      if (!n) return new Response("Notification not found", { status: 404 });
      n.isRead = true;
      return ok(M.Notification, n);
    }
    if (req.method === "GET" && path === "/notification-preferences") return ok(M.NotificationPreferences, preferences());
    if (req.method === "PUT" && path === "/notification-preferences") {
      const b = body as Record<string, unknown>;
      // Stored flags before the write: the carry-over below compares with them.
      const had = { emailEnabled: settings.emailEnabled, ntfyEnabled: settings.ntfyEnabled, gotifyEnabled: settings.gotifyEnabled, webhookEnabled: settings.webhookEnabled };
      const next = { ...settings };
      const nextSecrets = { ...secrets };
      for (const [k, v] of Object.entries(b)) {
        if (k in nextSecrets) {
          if (v !== undefined) nextSecrets[k] = v === null || v === "" ? null : (v as string);
        }
        // A null address keeps the stored one: the server reads `input ?? existing`.
        else if (v !== null) (next as any)[k] = v;
      }
      if (next.emailEnabled && !next.emailAddress) return new Response("Email notifications require an account email address", { status: 400 });
      if ((next.ntfyEnabled || "ntfyServerUrl" in b || "ntfyTopic" in b || "ntfyToken" in b) && (!next.ntfyServerUrl || !next.ntfyTopic)) {
        return new Response("ntfy requires a server URL and topic", { status: 400 });
      }
      if ((next.gotifyEnabled || "gotifyServerUrl" in b || "gotifyToken" in b) && (!next.gotifyServerUrl || !nextSecrets.gotifyToken)) {
        return new Response("Gotify requires a server URL and app token", { status: 400 });
      }
      if ((next.webhookEnabled || "webhookUrl" in b || "webhookSecret" in b) && !next.webhookUrl) {
        return new Response("Webhook notifications require an endpoint URL", { status: 400 });
      }
      Object.assign(settings, next);
      Object.assign(secrets, nextSecrets);

      // The server carries the switches into the active rules that have some
      // channel on, and into no other: a channel that cannot deliver is turned
      // off there, and one switched on just now is turned on there.
      const off = {
        emailEnabled: !settings.emailEnabled,
        ntfyEnabled: !settings.ntfyEnabled || !settings.ntfyServerUrl || !settings.ntfyTopic,
        gotifyEnabled: !settings.gotifyEnabled || !settings.gotifyServerUrl || !secrets.gotifyToken,
        webhookEnabled: !settings.webhookEnabled || !settings.webhookUrl,
      };
      const on = {
        emailEnabled: settings.emailEnabled && !had.emailEnabled && !!settings.emailAddress,
        ntfyEnabled: settings.ntfyEnabled && !had.ntfyEnabled && !off.ntfyEnabled,
        gotifyEnabled: settings.gotifyEnabled && !had.gotifyEnabled && !off.gotifyEnabled,
        webhookEnabled: settings.webhookEnabled && !had.webhookEnabled && !off.webhookEnabled,
      };
      for (const rule of rules) {
        if (!rule.isActive || !(rule.emailEnabled || rule.ntfyEnabled || rule.gotifyEnabled || rule.webhookEnabled)) continue;
        for (const channel of Object.keys(off) as (keyof typeof off)[]) {
          if (off[channel]) rule[channel] = false;
          else if (on[channel]) rule[channel] = true;
        }
      }
      return ok(M.NotificationPreferences, preferences());
    }
    if ((p = m(/^\/notification-preferences\/workspaces\/([^/]+)$/))) {
      const ws = workspaces.find((w) => w.id === decodeURIComponent(p![1]));
      if (!ws) return new Response("No access to the workspace", { status: 403 });
      const i = rules.findIndex((r) => r.workspaceId === ws.id);
      if (req.method === "PUT") {
        const b = body as any;
        if (b.projectMode === "selected") {
          const ids: string[] = b.selectedProjectIds ?? [];
          if (ids.length === 0) return new Response("Select at least one project for selected project mode", { status: 400 });
          // Counted as rows found, so a repeated id fails like an unknown one.
          if (projects.filter((x) => x.workspaceId === ws.id && ids.includes(x.id)).length !== ids.length) {
            return new Response("One or more selected projects are invalid", { status: 400 });
          }
        }
        const can = usable();
        for (const [channel, name] of [["emailEnabled", "email"], ["ntfyEnabled", "ntfy"], ["webhookEnabled", "webhook"], ["gotifyEnabled", "Gotify"]] as const) {
          if (b[channel] && !can[channel]) return new Response(`Enable ${name} notifications globally before using them here`, { status: 400 });
        }
        const at = nnow();
        const rule = { id: i < 0 ? nid("rule") : rules[i]!.id, workspaceId: ws.id, workspaceName: ws.name, ...b, selectedProjectIds: b.projectMode === "selected" ? b.selectedProjectIds : [], createdAt: i < 0 ? at : rules[i]!.createdAt, updatedAt: at } as z.input<typeof M.NotificationPreferenceWorkspaceRule>;
        if (i < 0) rules.push(rule);
        else rules[i] = rule;
        return ok(M.NotificationPreferences, preferences());
      }
      if (req.method === "DELETE") {
        if (i < 0) return new Response("Workspace rule not found", { status: 404 });
        rules.splice(i, 1);
        return ok(M.NotificationPreferences, preferences());
      }
    }

    const workspaceOf = (taskId: string) => projects.find((x) => x.id === tasks.find((t) => t.id === taskId)?.projectId)?.workspaceId;
    if (req.method === "GET" && (p = m(/^\/label\/workspace\/([^/]+)$/))) {
      return ok(z.array(M.Label), labels.filter((l) => l.workspaceId === decodeURIComponent(p![1])));
    }
    if (req.method === "GET" && (p = m(/^\/label\/task\/([^/]+)$/))) {
      return ok(z.array(M.Label), labels.filter((l) => l.taskId === decodeURIComponent(p![1])));
    }
    if (req.method === "POST" && path === "/label") {
      const b = body as any;
      // An existing name answers with the label it names, as the server's
      // insert-or-nothing does.
      const have = labels.find((l) => l.workspaceId === b.workspaceId && l.name === b.name && l.taskId === null);
      return ok(M.Label, have ?? addLabel(b.name, b.color, b.workspaceId, null));
    }
    if ((p = m(/^\/label\/([^/]+)(\/task)?$/))) {
      const l = labels.find((x) => x.id === decodeURIComponent(p![1]));
      // The server's workspace check runs first and cannot place an unknown id.
      if (!l) return fail(400, "Workspace ID could not be determined");
      if (req.method === "GET" && !p[2]) return ok(M.Label, l);
      if (req.method === "PUT" && !p[2]) {
        const b = body as any;
        // A workspace label carries the change to its copies.
        if (l.taskId === null) for (const c of labels) if (c.taskId !== null && c.workspaceId === l.workspaceId && c.name === l.name) Object.assign(c, { name: b.name, color: b.color });
        return ok(M.Label, Object.assign(l, { name: b.name, color: b.color, updatedAt: now() }));
      }
      if (req.method === "DELETE" && !p[2]) {
        // The server removes copies 25 at a time and answers 202 until none
        // are left; one at a time here, so two copies go through the repeat.
        const copies = l.taskId === null ? labels.filter((c) => c.taskId !== null && c.workspaceId === l.workspaceId && c.name === l.name) : [];
        if (copies.length > 0) {
          labels.splice(labels.indexOf(copies[0]!), 1);
          if (copies.length > 1) return ok(M.PendingLabelDeletion, { ...l, pendingDeletion: true }, 202);
        }
        return ok(M.Label, labels.splice(labels.indexOf(l), 1)[0]!);
      }
      if (req.method === "PUT" && p[2]) {
        const taskId = (body as any).taskId;
        if (workspaceOf(taskId) === undefined) return fail(404, "Task not found");
        if (workspaceOf(taskId) !== l.workspaceId) return fail(400, "Label and task must belong to the same workspace");
        if (l.taskId === taskId) return ok(M.Label, l);
        if (l.taskId !== null) labels.splice(labels.indexOf(l), 1);
        const have = labels.find((c) => c.taskId === taskId && c.name === l.name);
        return ok(M.Label, have ?? addLabel(l.name, l.color, l.workspaceId!, taskId));
      }
      if (req.method === "DELETE" && p[2]) {
        if (l.taskId === null) return fail(400, "Label is not assigned to a task");
        return ok(M.Label, labels.splice(labels.indexOf(l), 1)[0]!);
      }
    }

    return fail(404, `no route: ${req.method} ${path}`);
  };

  const whitespace = opts.whitespaceOn ? new RegExp(opts.whitespaceOn) : undefined;
  const dropped = opts.dropCommentsMatching ? new RegExp(opts.dropCommentsMatching) : undefined;
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

// The slug the server derives from a column's name, which is what a task's
// status has to be set to in order to land in the column. Copied from toSlug in
// usekaneo/kaneo v2.29.2 apps/api/src/column/controllers/create-column.ts, so a
// name outside ASCII gets the slug the server gives it.
const slugOf = (name: string): string => {
  const slug = name
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return /[\p{L}\p{N}]/u.test(slug) ? slug : "";
};

// Statuses the server takes without a column, so no column may take their slug.
const VIRTUAL_STATUSES = ["planned", "archived"];

// What a server older than the document leaves out, applied to any response.
const LEGACY_DROPPED = new Set(["backgroundVersion", "pagination", "labels", "externalLinks", "subtaskCounts", "assigneeImage", "lastTaskNumber"]);
// What it sends as null. The relation summaries are nullable in the document,
// so the id fallback is exercised here.
const LEGACY_NULLED = new Set(["user", "sourceTask", "targetTask"]);
function legacy(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(legacy);
  if (!body || typeof body !== "object") return body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (LEGACY_DROPPED.has(k)) continue;
    out[k] = LEGACY_NULLED.has(k) ? null : legacy(v);
  }
  return out;
}

// A date as the server parses one: anything Date reads, stored as an ISO instant.
// A failure is the server's 400, with its message.
const parsedDate = (given: string, field: string): string | Response => {
  const at = new Date(given);
  if (given.trim() === "" || Number.isNaN(at.getTime())) {
    return Response.json({ success: false, error: `Invalid ${field} "${given}"` }, { status: 400 });
  }
  return at.toISOString();
};

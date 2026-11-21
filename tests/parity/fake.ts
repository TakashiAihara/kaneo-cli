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
  workspaces: { id: string; name: string; slug: string; description?: string | null; metadata?: unknown }[];
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
    // Calendar feeds only list tasks carrying a start or a due date.
    startDate?: string;
    dueDate?: string;
  }[];
  // A comment with a userId of its own was written by someone else, so only
  // the server's author check stands between it and a delete.
  comments?: { taskId: string; content: string; id?: string; userId?: string }[];
  // Labels already on a task, for a board that carries one before anything runs.
  labels?: { taskId: string; name: string; color?: string }[];
  // Workspace labels whose deletion has already started: still listed, but a
  // feed create naming one is refused the way the server refuses it.
  deletingLabels?: { workspaceId: string; name: string; color?: string }[];
  // Users the server knows, so assign has a name to report.
  users?: { id: string; name: string }[];
  // The key's own notifications, oldest first.
  notifications?: { type: string; title?: string | null; content?: string | null; isRead?: boolean | null; eventData?: unknown }[];
  // Every workspace's members, as the members route lists them.
  // A member with a workspaceId belongs to that workspace alone; one without is in all.
  members?: { id: string; name: string; email: string; role: string; workspaceId?: string }[];
  // Invitations the detail route can be asked about.
  invitations?: { id: string; workspaceId: string; inviterName: string; expiresAt: string; status?: string }[];
  // A rule names its column by slug here, since the seeded columns' ids are only
  // handed out when the fake starts.
  workflowRules?: { projectId: string; integrationType: string; eventType: string; columnSlug: string }[];
  // A link without an integration is one a person added by hand.
  externalLinks?: { taskId: string; url: string; title?: string | null; resourceType?: string; externalId?: string; integration?: { id: string; type: string } }[];
  // Custom field definitions. position defaults to the field's place in the
  // project's list, as the create route assigns it.
  customFields?: { projectId: string; name: string; type: string; required?: boolean; defaultValue?: string | null; options?: string[]; position?: number }[];
  // Values tasks hold for fields, named by the field's name in the task's
  // project: only fields somebody set a value on have a row.
  customFieldValues?: { taskId: string; field: string; value: string | null }[];
  // A project's link to a GitLab project, as the integration routes keep it.
  // token is stored raw and only ever answered masked; hookSecret likewise
  // only to a caller that may manage the workspace's settings.
  gitlabIntegrations?: {
    projectId: string;
    baseUrl: string;
    projectPath: string;
    token: string;
    tokenType?: "private" | "bearer";
    hookSecret?: string;
    isActive?: boolean;
    commentLink?: boolean;
    branchPattern?: string;
  }[];
  // A feed names its labels the way create's body does; the workspace
  // definitions it resolves to are materialized as the route would.
  calendarFeeds?: { projectId: string; labels?: string[]; timeZone?: string }[];
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
  // Leaves these fields out of a project read, as a server older than the
  // document does; the reply to a write is whole.
  readWithout?: string[];
  // Sends these fields with these values in a project read (null, or a value
  // of another type): a fault to inject, not a reply Kaneo is known to send.
  readAs?: Record<string, unknown>;
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
  // The most tasks /task/assigned returns; total still counts them all.
  assignedLimit?: number;
  // Answers a request whose "METHOD path" matches with a 500, having changed
  // nothing, for a write that is refused or a read that fails.
  failOn?: string;
  // Narrows failOn to requests whose query string matches, so one workspace's
  // listing can fail while the others answer.
  failOnQuery?: string;
  // The status failOn answers with, 500 unless a scenario wants another.
  failStatus?: number;
  // The error failOn answers with, for a branch that reads the server's words,
  // sent as text/plain as the server sends an HTTPException.
  failMessage?: string;
  // The key's user lacks the project update and delete permissions, so those
  // routes answer as Kaneo 2.32.0's requireWorkspacePermission does.
  plainMember?: boolean;
  // The key's user lacks what a project move needs in this destination
  // workspace (project creation and workspace settings management), so the
  // move route answers 403 for a move into it while the source check passes.
  moveDeniedTarget?: string;
  // A server older than v2.28.0, which has no /user/me.
  noCurrentUser?: boolean;
  blankCurrentUserId?: boolean;
  // How many matching requests are answered as usual before failOn starts, so
  // a scenario can set something up through the route it then breaks.
  failOnSkip?: number;
  // Answers this many workspace listings with better-auth's 429, asking the
  // caller to come back after rateLimitWaitMs.
  rateLimitTimes?: number;
  rateLimitWaitMs?: number;
  // The code the 429 carries, RATE_LIMITED unless a scenario wants another.
  rateLimitCode?: string;
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
  // The errors an import-issues answer carries, for a partial import.
  gitlabImportErrors?: string[];
  // Fields the verify answer carries instead of the canned success, merged
  // over it, for the failure bodies a real GitLab instance produces.
  gitlabVerify?: Record<string, unknown>;
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
    backgroundVersion: null as string | null,
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
      // Stored as the instants they parse to, as create-task's route does.
      startDate: t.startDate ? new Date(t.startDate).toISOString() : (null as string | null),
      dueDate: t.dueDate ? new Date(t.dueDate).toISOString() : (null as string | null),
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
  const addLabel = (name: string, color: string, workspaceId: string, taskId: string | null, deleting = false) => {
    const at = now();
    const l = { id: id("lbl"), name, color, createdAt: at, updatedAt: at, deletionStartedAt: deleting ? at : null, taskId, workspaceId };
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
  for (const l of seed.deletingLabels ?? []) addLabel(l.name, l.color ?? "gray", l.workspaceId, null, true);
  const requests: Recorded[] = [];
  let grew = 0;

  // Notifications number and date themselves apart from everything else, so
  // seeding them leaves the ids and times the other scenarios record alone.
  // Workspace rules draw on the same counter.
  let nseq = 0;
  let nclock = 0;
  const nid = (prefix: string) => `${prefix}${String(++nseq).padStart(4, "0")}`;
  const nnow = () => new Date(T0 + 86_400_000 + 1000 * nclock++).toISOString();

  // Custom fields number and date themselves apart too, for the same reason:
  // a seed of them must not move the ids and times the other scenarios record.
  let fseq = 0;
  let fclock = 0;
  const fid = (prefix: string) => `${prefix}${String(++fseq).padStart(4, "0")}`;
  const fnow = () => new Date(T0 + 2 * 86_400_000 + 1000 * fclock++).toISOString();
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

  // Custom field definitions and the values tasks hold for them. A value row
  // keeps only the field id; the routes join the definition the way the
  // server's queries do, so a rename or reorder shows through at once.
  const fields: z.input<typeof M.CustomFieldDefinition>[] = [];
  const fieldValues: { id: string; taskId: string; fieldId: string; value: string | null }[] = [];
  const addFieldValue = (taskId: string, fieldId: string, value: string | null) => {
    const row = { id: fid("cfv"), taskId, fieldId, value };
    fieldValues.push(row);
    return row;
  };
  for (const f of seed.customFields ?? []) {
    const at = fnow();
    const field: z.input<typeof M.CustomFieldDefinition> = {
      id: fid("fld"),
      projectId: f.projectId,
      name: f.name,
      type: f.type,
      required: f.required ?? false,
      defaultValue: f.defaultValue ?? null,
      options: f.options ?? null,
      position: f.position ?? fields.filter((x) => x.projectId === f.projectId).length,
      createdAt: at,
      updatedAt: at,
    };
    fields.push(field);
    // A default fills the tasks that already exist, as the create route's
    // insert does for a field made after them.
    if (field.defaultValue != null && field.defaultValue.trim() !== "") {
      for (const t of tasks.filter((t) => t.projectId === f.projectId)) addFieldValue(t.id, field.id, field.defaultValue);
    }
  }
  for (const v of seed.customFieldValues ?? []) {
    const task = tasks.find((t) => t.id === v.taskId)!;
    const field = fields.find((f) => f.projectId === task.projectId && f.name === v.field)!;
    // A value the seed names for a task replaces the default the field's
    // backfill wrote for the same pair: the row is keyed by task and field,
    // so one row holds the explicit value, as upstream's unique constraint
    // and its on-conflict upsert leave it.
    const have = fieldValues.find((x) => x.taskId === v.taskId && x.fieldId === field.id);
    if (have) have.value = v.value;
    else addFieldValue(v.taskId, field.id, v.value);
  }
  // The joined row the value routes send: the definition's current name,
  // position, type and options beside the stored value.
  const servedValue = (v: (typeof fieldValues)[number]) => {
    const f = fields.find((x) => x.id === v.fieldId)!;
    return {
      id: v.id,
      taskId: v.taskId,
      fieldId: v.fieldId,
      value: v.value,
      fieldName: f.name,
      fieldPosition: f.position,
      fieldType: f.type,
      fieldOptions: f.options ?? null,
    };
  };
  const servedValues = (rows: typeof fieldValues) =>
    rows.filter((v) => fields.some((f) => f.id === v.fieldId)).map(servedValue);
  // A task's value rows go with it, as the foreign key's cascade does.
  const dropFieldValues = (taskId: string) => {
    for (let j = fieldValues.length - 1; j >= 0; j--) if (fieldValues[j]!.taskId === taskId) fieldValues.splice(j, 1);
  };

  // The value checks the custom-field routes borrow from validate-task-fields,
  // kept to the types those routes call them for.
  const multiselectValueEmpty = (value: string): boolean => {
    if (value.trim() === "") return true;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) && parsed.length === 0;
    } catch {
      return false;
    }
  };
  const dateValueError = (value: string, fieldName: string): string | null => {
    const isoMatch = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})?)?$/.exec(value);
    if (!isoMatch) return `Custom field "${fieldName}" expects a date in YYYY-MM-DD or ISO 8601 format, got "${value}".`;
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) return `Custom field "${fieldName}" expects a valid ISO 8601 date, got "${value}".`;
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    const calendarDate = new Date(0);
    calendarDate.setUTCFullYear(year, month - 1, day);
    calendarDate.setUTCHours(0, 0, 0, 0);
    if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day)
      return `Custom field "${fieldName}" expects a valid ISO 8601 date, got "${value}".`;
    return null;
  };
  const multiselectDefaultError = (value: string, fieldName: string, options: string[] | undefined): string | null => {
    let selectedValues: unknown;
    try {
      selectedValues = JSON.parse(value);
    } catch {
      return `Custom field "${fieldName}" expects a JSON array of selected options, got "${value}".`;
    }
    if (!Array.isArray(selectedValues) || selectedValues.length === 0) return `Custom field "${fieldName}" expects at least one selected option.`;
    const parsedOptions = options ?? [];
    const invalidValues = selectedValues.filter((v) => typeof v !== "string" || !parsedOptions.includes(v));
    if (invalidValues.length > 0) return `Custom field "${fieldName}" expects values from: ${parsedOptions.join(", ")}, got invalid value(s): ${invalidValues.join(", ")}.`;
    return null;
  };

  // Calendar feeds number, date and mint their tokens apart from everything
  // else, like notifications do, so seeding them leaves the ids and times the
  // other scenarios record alone. A token is the feed's whole credential — 64
  // hex characters — so "feed" repeated to the sequence's width stays hex and
  // readable in a recorded subscribe URL.
  let feedSeq = 0;
  let feedClock = 0;
  const feeds: z.input<typeof M.CalendarFeed>[] = [];
  const addFeed = (projectId: string, labelIds: string[], timeZone: string) => {
    feedSeq += 1;
    const feed = {
      id: `feed${String(feedSeq).padStart(4, "0")}`,
      projectId,
      token: `${"feed".repeat(15)}${feedSeq.toString(16).padStart(4, "0")}`,
      labelIds,
      timeZone,
      createdAt: new Date(T0 + 3_600_000 + 1000 * feedClock++).toISOString(),
    };
    feeds.push(feed);
    return feed;
  };
  for (const f of seed.calendarFeeds ?? []) {
    const project = projects.find((p) => p.id === f.projectId)!;
    const names = [...new Set(f.labels ?? [])].sort((a, b) => a.localeCompare(b));
    const roots = names.map((name) => {
      let root = labels.find((l) => l.workspaceId === project.workspaceId && l.name === name && l.taskId === null);
      if (!root) root = addLabel(name, "gray", project.workspaceId, null);
      return root;
    });
    addFeed(f.projectId, roots.map((r) => r.id), f.timeZone ?? "UTC");
  }

  // A project's board background, as v2.32.0 keeps it: the project row carries
  // the finalized key and version, and the bytes live under the staged key the
  // presigned PUT wrote them to. Versions number apart from every other id so
  // the sequences the other scenarios record stay put.
  const backgrounds = new Map<string, { key: string; version: string; contentType: string; size: number }>();
  const staged = new Map<string, { bytes: Uint8Array; contentType: string }>();
  let bgSeq = 0;
  const bgVersion = () => `bg${String(++bgSeq).padStart(4, "0")}`;
  // The image types and size cap v2.32.0's validateProjectBackgroundUploadInput
  // enforces, in its order, for both the prepare and the finalize call.
  const ALLOWED_IMAGE_TYPES = new Set(["image/apng", "image/avif", "image/gif", "image/heic", "image/heif", "image/jpeg", "image/jpg", "image/png", "image/webp"]);
  const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
  const backgroundKeyPrefix = (proj: (typeof projects)[number]) => `workspace/${proj.workspaceId}/project/${proj.id}/backgrounds/`;
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

  // Kaneo 2.32.0 refuses a project key another project in the workspace uses,
  // archived ones included, comparing NFKC case-folded
  // (apps/api/src/project/project-key.ts).
  const sameKey = (a: string, b: string) => a.normalize("NFKC").toLowerCase() === b.normalize("NFKC").toLowerCase();
  const keyTaken = (workspaceId: string, key: string, except?: string) =>
    projects.find((x) => x.workspaceId === workspaceId && x.id !== except && sameKey(x.slug, key));
  const keyTakenMessage = (key: string, name: string) =>
    `This workspace already has a project using the key "${key}" (${name}). Choose a different key.`;

  // GitLab integrations number and date apart from everything else, so
  // connecting one in a scenario leaves the ids and times the other
  // scenarios record alone.
  let gseq = 0;
  let gclock = 0;
  const gid = (prefix: string) => `${prefix}${String(++gseq).padStart(4, "0")}`;
  const gnow = () => new Date(T0 + 172_800_000 + 1000 * gclock++).toISOString();
  type GitlabRow = {
    id: string;
    projectId: string;
    baseUrl: string;
    projectPath: string;
    token: string;
    kind: "private" | "bearer";
    hookSecret: string;
    isActive: boolean;
    commentTaskLink: boolean;
    branchPattern: string;
    createdAt: string;
    updatedAt: string;
  };
  const gitlabs: GitlabRow[] = [];
  for (const g of seed.gitlabIntegrations ?? []) {
    const at = gnow();
    gitlabs.push({
      id: gid("gitl"),
      projectId: g.projectId,
      baseUrl: g.baseUrl,
      projectPath: g.projectPath,
      token: g.token,
      kind: g.tokenType ?? "private",
      hookSecret: g.hookSecret ?? gid("sec"),
      isActive: g.isActive ?? true,
      commentTaskLink: g.commentLink ?? true,
      branchPattern: g.branchPattern ?? "{slug}-{number}",
      createdAt: at,
      updatedAt: at,
    });
  }

  // As upstream's plugins/gitlab/config.ts and utils/normalize-input.ts: the
  // base URL keeps origin and path only and plain http is refused unless
  // private destinations are allowed (no scenario enables them), and the
  // project path is its segments joined, refusing relative ones. Both answer
  // the way the server's HTTPException does: the message as text.
  const gitlabBase = (raw: string): string | Response => {
    try {
      const trimmed = raw.trim().replace(/\/+$/, "");
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return failText(400, "GitLab base URL must use http or https");
      }
      if (parsed.search || parsed.hash || parsed.username || parsed.password) {
        return failText(400, "GitLab base URL must not contain a query, fragment, or credentials");
      }
      if (parsed.protocol === "http:") {
        return failText(400, "GitLab URL must use https unless KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS is enabled");
      }
      return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
    } catch (e) {
      return failText(400, e instanceof Error ? e.message : "Invalid GitLab input");
    }
  };
  const gitlabPath = (raw: string): string | Response => {
    const segments = raw
      .trim()
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter(Boolean);
    if (segments.length < 2) {
      return failText(400, "GitLab project path must include a namespace, for example group/project");
    }
    if (segments.some((s) => s === "." || s === "..")) {
      return failText(400, "GitLab project path must not contain relative segments");
    }
    return segments.join("/");
  };

  // The token checks that would call GitLab are canned: the fake has no
  // GitLab instance to ask, so a well-formed request succeeds and failOn /
  // failMessage inject the failures a scenario needs.
  const GITLAB_PROJECTS = [
    { id: 101, name: "Web App", path_with_namespace: "acme/web-app", name_with_namespace: "Acme / Web App", visibility: "private", web_url: "https://gitlab.example.com/acme/web-app" },
    { id: 102, name: "Docs", path_with_namespace: "acme/docs", name_with_namespace: "Acme / Docs", visibility: "internal", web_url: "https://gitlab.example.com/acme/docs" },
  ];

  // As upstream's get-gitlab-integration.ts: a token of eight characters or
  // fewer is masked whole, and the secrets are answered only to a caller
  // that may manage the workspace's settings.
  const maskGitlabToken = (token: string): string =>
    token.length <= 8 ? "••••••••" : `${token.slice(0, 4)}••••••${token.slice(-4)}`;
  const gitlabJson = (row: GitlabRow, includeSecrets: boolean, origin: string) => ({
    id: row.id,
    projectId: row.projectId,
    baseUrl: row.baseUrl,
    projectPath: row.projectPath,
    tokenType: row.kind,
    maskedAccessToken: includeSecrets ? maskGitlabToken(row.token) : "",
    webhookUrl: `${origin}/api/gitlab-integration/webhook/${row.id}`,
    webhookSecret: includeSecrets ? row.hookSecret : "",
    branchPattern: row.branchPattern,
    commentTaskLinkOnGitlabIssue: row.commentTaskLink,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  const failing = opts.failOn ? new RegExp(opts.failOn) : undefined;
  const failingQuery = opts.failOnQuery ? new RegExp(opts.failOnQuery) : undefined;
  let skipped = 0;
  let limited = 0;
  const misstoring = opts.misstoreOn ? new RegExp(opts.misstoreOn) : undefined;

  const route = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    // The presigned PUT a background upload is given lands outside /api and
    // carries no key — the URL itself is the credential — so it is answered
    // before the JSON body read below would consume its bytes.
    if (req.method === "PUT" && url.pathname.startsWith("/storage/")) {
      const key = decodeURIComponent(url.pathname.slice("/storage/".length));
      const bytes = new Uint8Array(await req.arrayBuffer());
      requests.push({ method: req.method, path: url.pathname, query: url.search, body: { key, bytes: bytes.byteLength } });
      // A storage refusal is not an API error: it answers with the storage
      // server's own body, which is what failMessage carries here.
      if (failing?.test(`${req.method} ${url.pathname}`) && (failingQuery?.test(url.search) ?? true) && skipped++ >= (opts.failOnSkip ?? 0)) {
        return failText(opts.failStatus ?? 500, opts.failMessage ?? "injected failure");
      }
      staged.set(key, { bytes, contentType: req.headers.get("content-type") ?? "" });
      return new Response(null, { status: 200 });
    }
    const path = url.pathname.replace(/^\/api/, "");
    const body = req.method === "GET" || req.method === "DELETE" ? undefined : await req.json().catch(() => null);
    requests.push({ method: req.method, path, query: url.search, body });

    if (!url.pathname.startsWith("/api/")) return new Response("<html>app</html>", { headers: { "content-type": "text/html" } });
    // The document is served without authentication, as the real server does —
    // and so is the calendar itself: its route declares security: [] and the
    // token in the path is the credential.
    const open = (req.method === "GET" && path === "/openapi") || (req.method === "GET" && /^\/calendar-feed\/[^/]+\/calendar\.ics$/.test(path));
    if (!open && req.headers.get("authorization") !== "Bearer test-key") return fail(401, "Unauthorized");
    if (failing?.test(`${req.method} ${path}`) && (failingQuery?.test(url.search) ?? true) && skipped++ >= (opts.failOnSkip ?? 0)) return opts.failMessage === undefined ? fail(opts.failStatus ?? 500, "injected failure") : failText(opts.failStatus ?? 500, opts.failMessage);

    // The server validates request bodies against the same schemas the
    // document declares, and answers 400 with the first issue.
    const BODIES: [string, RegExp, z.ZodTypeAny][] = [
      ["POST", /^\/auth\/organization\/update$/, M.UpdateOrganizationBody],
      ["POST", /^\/project$/, M.CreateProjectBody],
      ["PUT", /^\/project\/(?!reorder$)[^/]+$/, M.UpdateProjectBody],
      ["PUT", /^\/project\/reorder$/, M.ReorderProjectsBody],
      ["PUT", /^\/project\/[^/]+\/move$/, M.MoveProjectBody],
      ["PUT", /^\/project\/[^/]+\/background-upload$/, M.UploadProjectBackgroundBody],
      ["POST", /^\/project\/[^/]+\/background-upload\/finalize$/, M.FinalizeProjectBackgroundUploadBody],
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
      ["POST", /^\/calendar-feed\/project\/[^/]+$/, M.CreateCalendarFeedBody],
      ["POST", /^\/time-entry$/, M.CreateTimeEntryBody],
      ["PUT", /^\/time-entry\/[^/]+$/, M.UpdateTimeEntryBody],
      ["POST", /^\/custom-field$/, M.CreateCustomFieldBody],
      ["PUT", /^\/custom-field\/value$/, M.SetCustomFieldValueBody],
      ["PUT", /^\/custom-field\/reorder\/[^/]+$/, M.ReorderCustomFieldsBody],
      ["POST", /^\/gitlab-integration\/projects$/, M.ListGitlabProjectsBody],
      ["POST", /^\/gitlab-integration\/verify$/, M.VerifyGitlabAccessBody],
      ["POST", /^\/gitlab-integration\/import-issues$/, M.ImportGitlabIssuesBody],
      ["POST", /^\/gitlab-integration\/project\/[^/]+$/, M.CreateGitlabIntegrationBody],
      ["PATCH", /^\/gitlab-integration\/project\/[^/]+$/, M.UpdateGitlabIntegrationBody],
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
      const body = (p: string, m: string) => doc.paths[p][m].requestBody.content["application/json"].schema;
      if (opts.driftedSpec) {
        delete body("/task/{projectId}", "post").properties.customFields;
        body("/activity/create", "post").required.push("userId");
      }
      if (opts.specWithoutOperation) {
        // The operation alone, so another method a later pin adds to the path
        // stays served; the path goes too once nothing is left on it.
        delete doc.paths["/task/{projectId}"].post;
        if (Object.keys(doc.paths["/task/{projectId}"]).length === 0) delete doc.paths["/task/{projectId}"];
      }
      return Response.json(doc);
    }
    // Kaneo sets the request's user from the key, so /user/me answers for it.
    if (req.method === "GET" && path === "/user/me" && !opts.noCurrentUser) {
      return ok(M.CurrentUser, { id: opts.blankCurrentUserId ? "" : "user-self", name: "Self", email: "self@example.com", image: null, role: "user" });
    }
    if (req.method === "GET" && path === "/auth/organization/list" && limited < (opts.rateLimitTimes ?? 0)) {
      limited++;
      return Response.json(
        { message: "Rate limit exceeded.", code: opts.rateLimitCode ?? "RATE_LIMITED", details: { tryAgainIn: opts.rateLimitWaitMs ?? 0 } },
        { status: 429 },
      );
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
      return ok(z.array(M.WorkspaceMember), (seed.members ?? []).filter((u) => u.workspaceId === undefined || u.workspaceId === ws).map(({ workspaceId: _, ...u }) => ({ ...u, image: null })));
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
      const taken = keyTaken(b.workspaceId, b.slug);
      if (taken) return failText(409, keyTakenMessage(b.slug, taken.name));
      const proj = { id: id("proj"), workspaceId: b.workspaceId, backgroundVersion: null, slug: b.slug, icon: b.icon, name: b.name, description: null, createdAt: now(), isPublic: false, archivedAt: null, position: projects.length, lastTaskNumber: 0 };
      projects.push(proj);
      return ok(M.Project, proj);
    }
    if (req.method === "PUT" && path === "/project/reorder" && opts.plainMember) return failText(403, "Insufficient permissions");
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
      if (req.method === "GET" && !p[2]) {
        if (opts.readWithout === undefined && opts.readAs === undefined) return ok(M.Project, proj);
        const reply: Record<string, unknown> = { ...M.Project.parse(proj), ...opts.readAs };
        for (const field of opts.readWithout ?? []) delete reply[field];
        return Response.json(reply);
      }
      if (opts.plainMember) return failText(403, "Insufficient permissions");
      if (req.method === "PUT" && !p[2]) {
        // Upstream's update body requires the slug; the CLI always sends it.
        const slug = (body as any).slug;
        const taken = typeof slug === "string" && !sameKey(slug, proj.slug) ? keyTaken(proj.workspaceId, slug, proj.id) : undefined;
        if (taken) return failText(409, keyTakenMessage(slug, taken.name));
        Object.assign(proj, body);
        return ok(M.Project, proj);
      }
      if (req.method === "PUT" && p[3] === "archive") return ok(M.Project, Object.assign(proj, { archivedAt: now() }));
      if (req.method === "PUT" && p[3] === "unarchive") {
        const taken = keyTaken(proj.workspaceId, proj.slug, proj.id);
        if (taken) {
          return failText(409, `This workspace already has a project using the key "${proj.slug}" (${taken.name}). Change one of the keys before unarchiving this project.`);
        }
        return ok(M.Project, Object.assign(proj, { archivedAt: null }));
      }
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
        for (const taskId of gone) dropFieldValues(taskId);
        projects.splice(projects.indexOf(proj), 1);
        return reply;
      }
    }

    // Move, as v2.32.0's move-project.ts answers it: the source permission is
    // the route middleware's (plainMember above), the destination must exist,
    // the key must be free there, no relation may cross the boundary, and an
    // assignee who is not a member of the destination loses the task.
    if (req.method === "PUT" && (p = m(/^\/project\/([^/]+)\/move$/))) {
      const proj = projects.find((x) => x.id === decodeURIComponent(p![1]));
      if (!proj) return failText(400, "Workspace ID could not be determined");
      if (opts.plainMember) return failText(403, "Insufficient permissions");
      const target = workspaces.find((w) => w.id === (body as any)?.workspaceId);
      // The document's 400 is "Invalid destination or same workspace"; the
      // same-workspace case has its own answer below.
      if (!target) return failText(400, "Invalid destination");
      if (proj.workspaceId === target.id) return failText(400, "Project already belongs to this workspace");
      // The destination-side permission check: the caller may update and
      // delete in the source but lacks what a move needs in this workspace
      // (project creation and workspace settings management), so the move
      // route answers the same bare 403 the source check does.
      if (opts.moveDeniedTarget === target.id) return failText(403, "Insufficient permissions");
      const taken = keyTaken(target.id, proj.slug, proj.id);
      if (taken) {
        return failText(409, `The target workspace already has a project using the key "${proj.slug}" (${taken.name}). Change this project's key before moving it.`);
      }
      const crossProject = relations.some((r) => {
        const inProject = (taskId: string) => tasks.find((t) => t.id === taskId)?.projectId === proj.id;
        return inProject(r.sourceTaskId) !== inProject(r.targetTaskId);
      });
      if (crossProject) return failText(409, "Remove task relationships to other projects before moving this project.");
      proj.workspaceId = target.id;
      proj.position = Math.max(-1, ...projects.filter((x) => x.workspaceId === target.id).map((x) => x.position)) + 1;
      const memberOf = (userId: string) =>
        (seed.members ?? []).some((mm) => mm.id === userId && (mm.workspaceId === undefined || mm.workspaceId === target.id));
      let unassignedTaskCount = 0;
      for (const t of tasks) {
        if (t.projectId === proj.id && t.userId && !memberOf(t.userId)) {
          t.userId = null;
          unassignedTaskCount += 1;
        }
      }
      return ok(M.MovedProject, { ...proj, unassignedTaskCount });
    }

    const checkBackgroundUpload = (contentType: string, size: number): Response | undefined => {
      if (contentType.trim() === "") return failText(400, "A valid content type is required.");
      if (!ALLOWED_IMAGE_TYPES.has(contentType.toLowerCase())) {
        return failText(400, `Unsupported content type "${contentType}". Upload a supported image.`);
      }
      if (size <= 0) return failText(400, "Upload size must be greater than zero.");
      if (size > MAX_IMAGE_UPLOAD_BYTES) return failText(400, "Upload exceeds the maximum upload size of 10MB.");
      return undefined;
    };

    if (req.method === "PUT" && (p = m(/^\/project\/([^/]+)\/background-upload$/))) {
      const proj = projects.find((x) => x.id === decodeURIComponent(p![1]));
      if (!proj) return failText(400, "Workspace ID could not be determined");
      if (opts.plainMember) return failText(403, "Insufficient permissions");
      const b = body as any;
      const refusedUpload = checkBackgroundUpload(String(b?.contentType ?? ""), Number(b?.size ?? 0));
      if (refusedUpload) return refusedUpload;
      const version = bgVersion();
      const key = `${backgroundKeyPrefix(proj)}background-${version}`;
      return ok(M.ProjectBackgroundUpload, {
        key,
        uploadUrl: `${new URL(req.url).origin}/storage/${key}?signature=fake`,
        version,
        headers: { "Content-Type": String(b.contentType) },
      });
    }
    if (req.method === "POST" && (p = m(/^\/project\/([^/]+)\/background-upload\/finalize$/))) {
      const proj = projects.find((x) => x.id === decodeURIComponent(p![1]));
      if (!proj) return failText(400, "Workspace ID could not be determined");
      if (opts.plainMember) return failText(403, "Insufficient permissions");
      const b = body as any;
      const refusedUpload = checkBackgroundUpload(String(b?.contentType ?? ""), Number(b?.size ?? 0));
      if (refusedUpload) return refusedUpload;
      const key = String(b?.key ?? "").trim();
      const version = String(b?.version ?? "");
      // assertProjectBackgroundKeyMatchesContext: the key must sit under this
      // project's backgrounds prefix and name this version, with nothing else
      // after it.
      if (!key.startsWith(backgroundKeyPrefix(proj)) || key.slice(backgroundKeyPrefix(proj).length) !== `background-${version}` || !/^[A-Za-z0-9_-]+$/.test(version)) {
        return failText(400, "Image upload key does not match the project context.");
      }
      proj.backgroundVersion = version;
      backgrounds.set(proj.id, { key, version, contentType: String(b.contentType), size: Number(b.size) });
      return ok(M.ProjectBackgroundFinalize, { url: `${new URL(req.url).origin}/project/${proj.id}/background?v=${encodeURIComponent(version)}` });
    }
    if (req.method === "GET" && (p = m(/^\/project\/([^/]+)\/background$/))) {
      const proj = projects.find((x) => x.id === decodeURIComponent(p![1]));
      if (!proj) return failText(400, "Workspace ID could not be determined");
      const bg = backgrounds.get(proj.id);
      const object = bg === undefined ? undefined : staged.get(bg.key);
      // The stored object's type wins over the declared one, as upstream's
      // object.contentType || backgroundMimeType does; either way it must be
      // an image the route would serve.
      const contentType = (object?.contentType || bg?.contentType || "").toLowerCase().split(";")[0]!.trim();
      if (bg === undefined || object === undefined || !ALLOWED_IMAGE_TYPES.has(contentType)) {
        return failText(404, "Project background not found");
      }
      const etag = `"${bg.version}"`;
      const headers: Record<string, string> = { "Cache-Control": "private, max-age=300, must-revalidate", "Content-Type": contentType, ETag: etag, "X-Content-Type-Options": "nosniff" };
      if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
      return new Response(object.bytes, { headers });
    }
    if (req.method === "DELETE" && (p = m(/^\/project\/([^/]+)\/background$/))) {
      const proj = projects.find((x) => x.id === decodeURIComponent(p![1]));
      if (!proj) return failText(400, "Workspace ID could not be determined");
      if (opts.plainMember) return failText(403, "Insufficient permissions");
      const bg = backgrounds.get(proj.id);
      if (bg !== undefined) staged.delete(bg.key);
      backgrounds.delete(proj.id);
      proj.backgroundVersion = null;
      return new Response(null, { status: 204 });
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
    // The caller's open tasks across a workspace's active projects; the
    // caller is the key's user, "user-self".
    if (req.method === "GET" && path === "/task/assigned") {
      const workspaceId = url.searchParams.get("workspaceId") ?? "";
      if (workspaceId === "") return failText(400, "Invalid workspace ID or query parameters");
      const mine = tasks
        .filter((t) => t.userId === "user-self" && t.status !== "done" && t.status !== "archived")
        .map((t) => ({ t, p: projects.find((x) => x.id === t.projectId)! }))
        .filter(({ p }) => p.workspaceId === workspaceId && !p.archivedAt);
      return ok(M.AssignedTasks, {
        total: mine.length,
        tasks: mine.slice(0, opts.assignedLimit ?? 100).map(({ t, p }) => ({
          id: t.id,
          projectId: t.projectId,
          number: t.number,
          title: t.title,
          status: t.status,
          statusName: t.status,
          statusIcon: null,
          priority: t.priority,
          dueDate: t.dueDate,
          projectName: p.name,
          projectSlug: p.slug,
          projectIcon: null,
          labels: [],
        })),
      });
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
          for (const t of found) {
            tasks.splice(tasks.indexOf(t), 1);
            dropFieldValues(t.id);
          }
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
    // v2.32.0's get-task-by-ticket-id.ts: the key is whatever precedes the last
    // dash, matched to a slug ignoring case; a match in an active project wins
    // over an archived one, and a tie is a 409. Its HTTPException is plain text.
    if (req.method === "GET" && (p = m(/^\/task\/by-ticket-id\/([^/]+)$/))) {
      const match = decodeURIComponent(p[1]).normalize("NFKC").match(/^(.+)-(\d+)$/u);
      const number = Number(match?.[2]);
      if (!match || !Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) return failText(400, "Invalid task ticket ID");
      const key = match[1]!.toLowerCase();
      const found = tasks
        .filter((t) => t.number === number)
        .map((t) => ({ t, project: projects.find((x) => x.id === t.projectId)! }))
        .filter(({ project }) => project.slug.normalize("NFKC").toLowerCase() === key);
      if (found.length === 0) return failText(404, "Task not found");
      const active = found.filter(({ project }) => project.archivedAt === null);
      const pool = active.length > 0 ? active : found;
      if (pool.length > 1) return failText(409, "Task ticket ID matches multiple accessible tasks");
      const { t, project } = pool[0]!;
      return ok(M.TaskByTicketId, {
        ...t,
        columnId: columnsOf(t.projectId).find((c) => c.slug === t.status)?.id ?? null,
        workspaceId: project.workspaceId,
        assigneeId: t.userId,
        assigneeName: t.userId ? (users.get(t.userId) ?? null) : null,
      });
    }
    if (req.method === "POST" && (p = m(/^\/task\/([^/]+)$/))) {
      const proj = projects.find((x) => x.id === decodeURIComponent(p![1]));
      if (!proj) return failText(400, "Workspace ID could not be determined");
      // A date that does not parse is refused rather than stored, as the due date
      // route does.
      for (const field of ["startDate", "dueDate"]) {
        const given = (body as any)?.[field];
        if (!given) continue;
        const at = parsedDate(given, field);
        if (typeof at !== "string") return at;
      }
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
        // A destination in another workspace is answered as not found, per issue
        // #246; the status text of the same-project refusal is from there too.
        if (!dest || dest.workspaceId !== projects.find((x) => x.id === from)?.workspaceId) return failText(404, "Project not found");
        if (dest.id === from) return fail(400, "Task is already in that project");
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
        dropFieldValues(t.id);
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
      // The workspace middleware finds no task before the controller runs, and
      // its HTTPException is plain text.
      if (!tasks.some((t) => t.id === taskId)) return failText(400, "Workspace ID could not be determined");
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

    // Custom fields, following v2.32.0's controllers: every refusal is an
    // HTTPException or the workspace middleware's, so text/plain.
    const knownProject = (id: string) => projects.some((x) => x.id === id);
    if (req.method === "GET" && (p = m(/^\/custom-field\/project\/([^/]+)\/values$/))) {
      const projectId = decodeURIComponent(p[1]);
      if (!knownProject(projectId)) return failText(400, "Workspace ID could not be determined");
      const taskIds = new Set(tasks.filter((t) => t.projectId === projectId).map((t) => t.id));
      return ok(z.array(M.CustomFieldValue), servedValues(fieldValues.filter((v) => taskIds.has(v.taskId))));
    }
    if (req.method === "GET" && (p = m(/^\/custom-field\/project\/([^/]+)\/filter-values$/))) {
      const projectId = decodeURIComponent(p[1]);
      if (!knownProject(projectId)) return failText(400, "Workspace ID could not be determined");
      return ok(z.array(M.CustomFieldFilterValues), fields.filter((f) => f.projectId === projectId).map((f) => ({
        fieldId: f.id,
        fieldName: f.name,
        fieldType: f.type,
        values: [...new Set(fieldValues.filter((v) => v.fieldId === f.id && v.value !== null && v.value !== "").map((v) => v.value!))],
      })));
    }
    if (req.method === "GET" && (p = m(/^\/custom-field\/project\/([^/]+)$/))) {
      const projectId = decodeURIComponent(p[1]);
      if (!knownProject(projectId)) return failText(400, "Workspace ID could not be determined");
      return ok(z.array(M.CustomFieldDefinition), fields.filter((f) => f.projectId === projectId).sort((a, b) => a.position - b.position));
    }
    if (req.method === "GET" && (p = m(/^\/custom-field\/task\/([^/]+)$/))) {
      const taskId = decodeURIComponent(p[1]);
      if (!tasks.some((t) => t.id === taskId)) return failText(400, "Workspace ID could not be determined");
      return ok(z.array(M.CustomFieldValue), servedValues(fieldValues.filter((v) => v.taskId === taskId)));
    }
    if (req.method === "POST" && path === "/custom-field") {
      const b = body as any;
      if (!knownProject(b.projectId)) return failText(400, "Workspace ID could not be determined");
      const bad = (message: string) => failText(400, message);
      if (typeof b.name !== "string" || b.name.trim() === "") return bad("Name cannot be empty");
      const type = b.type as string;
      const required = b.required ?? false;
      const defaultValue = b.defaultValue as string | undefined;
      const options = b.options as string[] | undefined;
      if (required && (defaultValue === undefined || defaultValue === null || defaultValue.trim() === "")) return bad("Required fields must have a default value");
      if (defaultValue !== undefined && defaultValue !== null) {
        const trimmedValue = defaultValue.trim();
        if (trimmedValue !== "") {
          if (type === "number") {
            const numberRegex = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;
            const parsed = Number(trimmedValue);
            if (!numberRegex.test(trimmedValue) || Number.isNaN(parsed) || !Number.isFinite(parsed)) return bad("Default value must be a valid number for number type fields");
          } else if (type === "boolean") {
            if (trimmedValue !== "true" && trimmedValue !== "false") return bad("Default value must be 'true' or 'false' for boolean type fields");
          } else if (type === "date") {
            const error = dateValueError(trimmedValue, b.name);
            if (error) return bad(error);
          } else if (type === "dropdown" && options && options.length > 0) {
            if (!options.map((opt) => opt.trim()).includes(trimmedValue)) return bad("Default value must be one of the dropdown options");
          }
        }
      }
      if (type === "dropdown" && (!options || options.length < 1)) return bad("Dropdown fields must have at least one option");
      if (type === "multiselect") {
        const normalizedOptions = [...new Set((options ?? []).map((opt) => opt.trim()).filter((opt) => opt.length > 0))];
        if (normalizedOptions.length < 2) return bad("Multiselect fields must have at least 2 options");
      }
      if (type === "multiselect" && defaultValue != null) {
        const empty = multiselectValueEmpty(defaultValue);
        if (required && empty) return bad("Required fields must have a default value");
        if (!empty) {
          const error = multiselectDefaultError(defaultValue, b.name, options);
          if (error) return bad(error);
        }
      }
      const storedDefaultValue = type === "date" ? defaultValue?.trim() : defaultValue;
      const position = Math.max(0, ...fields.filter((f) => f.projectId === b.projectId).map((f) => f.position)) + 1;
      const at = fnow();
      const field: z.input<typeof M.CustomFieldDefinition> = {
        id: fid("fld"),
        projectId: b.projectId,
        name: b.name,
        type,
        required,
        defaultValue: storedDefaultValue ?? null,
        options: options ?? null,
        position,
        createdAt: at,
        updatedAt: at,
      };
      fields.push(field);
      if (storedDefaultValue != null && storedDefaultValue.trim() !== "") {
        for (const t of tasks.filter((t) => t.projectId === b.projectId)) {
          if (!fieldValues.some((v) => v.taskId === t.id && v.fieldId === field.id)) addFieldValue(t.id, field.id, storedDefaultValue);
        }
      }
      return ok(M.CustomFieldDefinition, field);
    }
    if (req.method === "PUT" && (p = m(/^\/custom-field\/reorder\/([^/]+)$/))) {
      const projectId = decodeURIComponent(p[1]);
      if (!knownProject(projectId)) return failText(400, "Workspace ID could not be determined");
      const mine = fields.filter((f) => f.projectId === projectId);
      const wanted = ((body as any)?.fields ?? []) as { id: string; position: number }[];
      // The transaction checks every id before it writes any, so a foreign id
      // leaves the order untouched.
      for (const f of wanted) if (!mine.some((x) => x.id === f.id)) return failText(400, `Custom field ${f.id} does not belong to this project`);
      for (const f of wanted) mine.find((x) => x.id === f.id)!.position = f.position;
      return ok(z.array(M.CustomFieldDefinition), mine.slice().sort((a, b) => a.position - b.position));
    }
    if (req.method === "PUT" && path === "/custom-field/value") {
      const b = body as any;
      const task = tasks.find((t) => t.id === b.taskId);
      if (!task) return failText(400, "Workspace ID could not be determined");
      const field = fields.find((f) => f.id === b.fieldId);
      if (!field || field.projectId !== task.projectId) return failText(404, "Custom field not found");
      const normalizedValue: string = b.value.trim();
      const bad = (message: string) => failText(400, message);
      const fieldOptions = Array.isArray(field.options) ? field.options : null;
      if (field.required) {
        if (field.type === "multiselect" ? multiselectValueEmpty(normalizedValue) : normalizedValue.length === 0) return bad("This custom field is required");
      }
      if (field.type === "dropdown" && normalizedValue.length > 0 && fieldOptions !== null && !fieldOptions.includes(normalizedValue)) return bad("Invalid option for this custom field");
      if (field.type === "number" && normalizedValue.length > 0 && Number.isNaN(Number(normalizedValue))) return bad("Value must be a valid number");
      if (field.type === "boolean" && normalizedValue.length > 0 && normalizedValue !== "true" && normalizedValue !== "false") return bad("Value must be true or false");
      if (field.type === "multiselect" && normalizedValue.length > 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(normalizedValue);
        } catch {
          return bad("Value must be a valid JSON array");
        }
        if (!Array.isArray(parsed)) return bad("Value must be a JSON array");
        if (fieldOptions !== null) {
          const invalid = parsed.some((v) => typeof v !== "string" || !fieldOptions.includes(v));
          if (invalid) return bad("Invalid option(s) for this custom field");
        }
      }
      const row = fieldValues.find((v) => v.taskId === b.taskId && v.fieldId === b.fieldId);
      const saved = row ? Object.assign(row, { value: normalizedValue }) : addFieldValue(b.taskId, b.fieldId, normalizedValue);
      return ok(M.SetCustomFieldValueResponse, { id: saved.id, taskId: saved.taskId, fieldId: saved.fieldId, value: saved.value });
    }
    if (req.method === "DELETE" && (p = m(/^\/custom-field\/([^/]+)$/))) {
      const id = decodeURIComponent(p[1]);
      const i = fields.findIndex((x) => x.id === id);
      // The workspace middleware places the field's project before the
      // controller runs, so an unknown id never reaches the 404 below.
      if (i < 0) return failText(400, "Workspace ID could not be determined");
      const deleted = fields.splice(i, 1)[0]!;
      // The value rows cascade with the definition, as the foreign key does.
      for (let j = fieldValues.length - 1; j >= 0; j--) if (fieldValues[j]!.fieldId === id) fieldValues.splice(j, 1);
      return ok(M.CustomFieldDefinition, deleted);
    }

    // GitLab integration, as usekaneo/kaneo v2.32.0's gitlab-integration
    // routes answer. The checks that would call GitLab are canned: the fake
    // has no GitLab instance to ask, so a well-formed request succeeds and
    // failOn / failMessage inject the failures a scenario needs.
    if (req.method === "POST" && path === "/gitlab-integration/projects") {
      const b = body as any;
      if (!projects.some((x) => x.id === b?.projectId)) return failText(400, "Workspace ID could not be determined");
      if (opts.plainMember) return failText(403, "Insufficient permissions");
      const base = gitlabBase(String(b?.baseUrl ?? ""));
      if (base instanceof Response) return base;
      return ok(M.GitlabProjectList, { projects: GITLAB_PROJECTS });
    }
    if (req.method === "POST" && path === "/gitlab-integration/verify") {
      const b = body as any;
      if (!projects.some((x) => x.id === b?.projectId)) return failText(400, "Workspace ID could not be determined");
      if (opts.plainMember) return failText(403, "Insufficient permissions");
      const base = gitlabBase(String(b?.baseUrl ?? ""));
      if (base instanceof Response) return base;
      const projectPath = gitlabPath(String(b?.projectPath ?? ""));
      if (projectPath instanceof Response) return projectPath;
      return ok(M.GitlabVerificationResult, {
        isInstalled: true,
        hasRequiredPermissions: true,
        projectExists: true,
        projectVisibility: "private",
        missingPermissions: [],
        message: "Token can access the project.",
        failureReason: null,
        ...(opts.gitlabVerify ?? {}),
      });
    }
    if (req.method === "POST" && path === "/gitlab-integration/import-issues") {
      const b = body as any;
      // scopeToProjectFromBody runs before the route: a missing projectId is
      // its own 400, while an unknown one is the route's 404.
      const pid = b?.projectId;
      if (typeof pid !== "string" || pid === "") return failText(400, "projectId is required");
      const holder = projects.find((x) => x.id === pid);
      if (!holder) return failText(404, "Project not found");
      const row = gitlabs.find((g) => g.projectId === holder.id);
      if (row === undefined) return failText(404, "GitLab integration not found");
      if (!row.isActive) return failText(400, "GitLab integration is not active");
      return ok(M.GitlabImportResult, {
        imported: 2,
        updated: 1,
        skipped: 1,
        ...(opts.gitlabImportErrors === undefined ? {} : { errors: opts.gitlabImportErrors }),
      });
    }
    if ((p = m(/^\/gitlab-integration\/project\/([^/]+)$/))) {
      const key = decodeURIComponent(p[1]);
      const proj = projects.find((x) => x.id === key);
      // The workspace middleware finds no project before the route runs.
      if (!proj) return failText(400, "Workspace ID could not be determined");
      const row = gitlabs.find((g) => g.projectId === key);
      const origin = new URL(req.url).origin;
      if (req.method === "GET") {
        return ok(M.GitlabIntegration, row === undefined ? null : gitlabJson(row, !opts.plainMember, origin));
      }
      if (opts.plainMember) return failText(403, "Insufficient permissions");
      if (req.method === "POST") {
        const b = body as any;
        const base = gitlabBase(String(b?.baseUrl ?? ""));
        if (base instanceof Response) return base;
        const projectPath = gitlabPath(String(b?.projectPath ?? ""));
        if (projectPath instanceof Response) return projectPath;
        const given = b?.["accessToken"];
        const supplied = typeof given === "string" ? given.trim() : "";
        if (supplied === "" && row !== undefined && row.token !== "") {
          // A saved credential is only reused while the GitLab URL is
          // unchanged (upstream's create-gitlab-integration.ts).
          const saved = gitlabBase(row.baseUrl);
          if ((saved instanceof Response ? undefined : saved) !== base) {
            return failText(400, "Enter a new access token when changing the GitLab URL");
          }
        }
        const resolved = supplied !== "" ? supplied : (row?.token ?? "");
        if (resolved === "") return failText(400, "Access token is required");
        // A GitLab project already linked to another Kaneo project is refused.
        const clash = gitlabs.find((g) => {
          if (g.projectId === key || !g.isActive) return false;
          const otherBase = gitlabBase(g.baseUrl);
          const otherPath = gitlabPath(g.projectPath);
          return !(otherBase instanceof Response) && !(otherPath instanceof Response) && otherBase === base && otherPath === projectPath;
        });
        if (clash !== undefined) {
          return failText(409, `Project ${projectPath} on this GitLab instance is already linked to another project`);
        }
        const kind = b?.["tokenType"] === "bearer" ? "bearer" : "private";
        const at = gnow();
        let saved: GitlabRow;
        if (row === undefined) {
          saved = {
            id: gid("gitl"),
            projectId: key,
            baseUrl: base,
            projectPath,
            token: resolved,
            kind,
            hookSecret: gid("sec"),
            isActive: true,
            commentTaskLink: true,
            branchPattern: "{slug}-{number}",
            createdAt: at,
            updatedAt: at,
          };
          gitlabs.push(saved);
        } else {
          // Reconnecting keeps the webhook secret and the stored settings,
          // and reactivates the link.
          Object.assign(row, { baseUrl: base, projectPath, token: resolved, kind, isActive: true, updatedAt: at });
          saved = row;
        }
        return ok(M.GitlabIntegration, gitlabJson(saved, true, origin));
      }
      if (req.method === "PATCH") {
        if (row === undefined) return ok(M.GitlabIntegrationNotFound, { error: "Integration not found" }, 404);
        const b = body as any;
        if (typeof b?.isActive === "boolean") row.isActive = b.isActive;
        if (typeof b?.commentTaskLinkOnGitlabIssue === "boolean") row.commentTaskLink = b.commentTaskLinkOnGitlabIssue;
        row.updatedAt = gnow();
        return ok(M.GitlabIntegration, gitlabJson(row, true, origin));
      }
      if (req.method === "DELETE") {
        if (row === undefined) return failText(404, "GitLab integration not found");
        gitlabs.splice(gitlabs.indexOf(row), 1);
        return ok(M.GitlabDeleteResult, { success: true, message: "GitLab integration deleted" });
      }
    }

    // The management routes sit under the project's workspace check like every
    // other project route; the calendar itself was let through above.
    if ((p = m(/^\/calendar-feed\/project\/([^/]+)$/))) {
      const projectId = decodeURIComponent(p[1]);
      const project = projects.find((x) => x.id === projectId);
      if (!project) return failText(400, "Workspace ID could not be determined");
      if (req.method === "GET") {
        return ok(
          z.array(M.CalendarFeed),
          [...feeds]
            .filter((f) => f.projectId === projectId)
            .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        );
      }
      if (req.method === "POST") {
        const b = body as z.input<typeof M.CreateCalendarFeedBody>;
        // The route's own schema refines timeZone beyond what the document can
        // carry; an unknown zone fails the same validation the others do.
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: b.timeZone ?? "UTC" });
        } catch {
          return fail(400, "Invalid key: timeZone: Invalid time zone");
        }
        // As createCalendarFeed in v2.32.0's service: the ids dedupe and must
        // all be live labels of the project's workspace, then resolve by name
        // to the workspace's definitions, materializing the ones it lacks.
        const ids = [...new Set(b.labelIds)];
        const found = labels.filter((l) => l.workspaceId === project.workspaceId && ids.includes(l.id) && l.deletionStartedAt === null);
        if (found.length !== ids.length) return failText(400, "Select labels from this workspace");
        const byName = new Map(found.map((l) => [l.name, l]));
        const roots = [...byName.keys()].sort((a, b2) => a.localeCompare(b2)).map((name) => {
          let root = labels.find((l) => l.workspaceId === project.workspaceId && l.name === name && l.taskId === null && l.deletionStartedAt === null);
          if (!root) root = addLabel(name, byName.get(name)!.color, project.workspaceId, null);
          return root;
        });
        return ok(M.CalendarFeed, addFeed(projectId, roots.map((r) => r.id), b.timeZone ?? "UTC"), 201);
      }
    }
    if (req.method === "DELETE" && (p = m(/^\/calendar-feed\/project\/([^/]+)\/([^/]+)$/))) {
      const projectId = decodeURIComponent(p[1]);
      const feedId = decodeURIComponent(p[2]);
      if (!projects.some((x) => x.id === projectId)) return failText(400, "Workspace ID could not be determined");
      const i = feeds.findIndex((f) => f.projectId === projectId && f.id === feedId);
      if (i < 0) return failText(404, "Calendar feed not found");
      feeds.splice(i, 1);
      return ok(M.RevokeCalendarFeed200, { success: true });
    }
    if (req.method === "GET" && (p = m(/^\/calendar-feed\/([^/]+)\/calendar\.ics$/))) {
      const token = decodeURIComponent(p[1]);
      // The token param's own pattern, which the validator enforces first.
      if (!/^[a-f0-9]{64}$/.test(token)) return failText(400, "Invalid feed token");
      const feed = feeds.find((f) => f.token === token);
      if (!feed) return failText(404, "Calendar feed not found");
      const project = projects.find((x) => x.id === feed.projectId)!;
      // As getCalendarFeed: the feed's label ids resolve to names on every
      // read, and a feed whose labels resolve to nothing — or that stores
      // none — is an empty calendar, never a broader one.
      const names = new Set(
        feed.labelIds.length === 0
          ? []
          : labels.filter((l) => l.workspaceId === project.workspaceId && feed.labelIds.includes(l.id)).map((l) => l.name),
      );
      const matched =
        names.size === 0
          ? []
          : tasks
              .filter(
                (t) =>
                  t.projectId === project.id &&
                  (t.startDate !== null || t.dueDate !== null) &&
                  labels.some((l) => l.taskId === t.id && l.workspaceId === project.workspaceId && names.has(l.name)),
              )
              .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      // The service bounds feed text in SQL before it is serialized.
      const icsTasks: IcsTask[] = matched.map((t) => ({
        id: t.id,
        title: excerpt(t.title, 1024),
        description: excerptOrNull(t.description, 4096),
        startDate: t.startDate,
        dueDate: t.dueDate,
        createdAt: t.createdAt,
      }));
      return new Response(calendarDocument(excerpt(project.name, 1024), feed.timeZone, icsTasks), {
        headers: {
          "content-type": "text/calendar; charset=utf-8",
          "content-disposition": 'inline; filename="kaneo.ics"',
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      });
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

// Postgres' char_length and left, which the service uses to bound feed text
// before it is serialized: counted in characters, not UTF-16 units.
const excerpt = (value: string, characters: number): string => {
  const chars = [...value];
  return chars.length > characters ? `${chars.slice(0, characters).join("")}…` : value;
};
const excerptOrNull = (value: string | null, characters: number): string | null => (value === null ? null : excerpt(value, characters));

// The document the public route streams, as apps/api/src/calendar-feed/ical.ts
// writes it at v2.32.0: CRLF lines folded at 75 octets, all-day dates in the
// feed's zone, and a due date made exclusive the way iCalendar's DTEND wants.
type IcsTask = { id: string; title: string; description: string | null; startDate: string | null; dueDate: string | null; createdAt: string };

const icsEscape = (value: string): string => value.replaceAll("\\", "\\\\").replace(/\r\n|\r|\n/g, "\\n").replaceAll(";", "\\;").replaceAll(",", "\\,");

const icsFold = (line: string): string => {
  const lines: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of line) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > 75) {
      lines.push(current);
      current = " ";
      bytes = 1;
    }
    current += character;
    bytes += size;
  }
  lines.push(current);
  return lines.join("\r\n");
};

const icsTimestamp = (iso: string): string => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

const icsDay = (iso: string, formatter: Intl.DateTimeFormat): string => {
  const parts = formatter.formatToParts(new Date(iso));
  return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)?.value).join("");
};

const icsNextDay = (date: string): string => {
  const day = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10).replaceAll("-", "");
};

const calendarDocument = (name: string, timeZone: string, tasks: IcsTask[]): string => {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const event = (task: IcsTask): string[] => {
    const scheduled = task.startDate ?? task.dueDate;
    if (!scheduled) return [];
    const start = icsDay(scheduled, formatter);
    const due = icsDay(task.dueDate ?? scheduled, formatter);
    return [
      "BEGIN:VEVENT",
      `UID:${task.id}@kaneo`,
      // The fake keeps no updatedAt; createdAt stands in for both stamps.
      `DTSTAMP:${icsTimestamp(task.createdAt)}`,
      `CREATED:${icsTimestamp(task.createdAt)}`,
      `LAST-MODIFIED:${icsTimestamp(task.createdAt)}`,
      `DTSTART;VALUE=DATE:${start}`,
      `DTEND;VALUE=DATE:${icsNextDay(due < start ? start : due)}`,
      `SUMMARY:${icsEscape(task.title)}`,
      ...(task.description ? [`DESCRIPTION:${icsEscape(task.description)}`] : []),
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    ];
  };
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Kaneo//Calendar Feed//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${icsEscape(name)}`,
    ...tasks.flatMap(event),
    "END:VCALENDAR",
  ];
  return `${lines.map(icsFold).join("\r\n")}\r\n`;
};

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

import { OPERATIONS, type Operation } from "./registry";
import { kaneoFetch, KaneoApiError } from "./http";
import {
  archiveProject,
  clearAllNotifications,
  createNotification as postNotification,
  createProject as postProject,
  createTask as postTask,
  createTaskComment,
  createTaskRelation,
  deleteNotificationPreferenceWorkspaceRule,
  deleteTask as removeTask,
  getNotificationPreferences as readNotificationPreferences,
  getProject as readProject,
  getTask as readTask,
  getTaskComments,
  getTaskRelations,
  listNotifications as getNotifications,
  listOrganization,
  listProjects,
  listTasks,
  markAllNotificationsAsRead,
  markNotificationAsRead,
  moveTask as putTaskMove,
  unarchiveProject,
  updateNotificationPreferences as putNotificationPreferences,
  updateOrganization,
  updateProject as putProject,
  upsertNotificationPreferenceWorkspaceRule,
  updateTaskAssignee,
  updateTaskPriority,
  updateTaskStatus,
} from "./gen/kaneo";
import type {
  BoardTask,
  CreateNotificationBody,
  CreateTaskBody,
  Notification as GenNotification,
  NotificationPreferences as GenNotificationPreferences,
  CreateTaskRelationBody,
  Organization,
  ProjectListItem,
  TaskLabel,
  Task as GenTask,
  TaskRelation as GenRelation,
  TaskRelationWithTasks,
  UpdateNotificationPreferencesBody,
  UpdateTaskPriorityBody,
  UpsertNotificationPreferenceWorkspaceRuleBody,
} from "./gen/model";

// What this CLI makes of a Kaneo server.
//
// Requests and response shapes come from the generated client, so a call that
// drifts from what the server documents fails to build rather than at the
// server. This module keeps what the document cannot say: where the key may be
// sent, how a failure is reported, and the CLI's own view of workspaces,
// projects and tasks.

// A call through the generated client, with a failure reported the way the Go
// build reported it: naming the path the request was made on, /api included, so
// the message can be pasted into curl as it is. The transport quotes the path
// the generated client wrote, which is the endpoint without that prefix.
//
// The quoted path is also decoded and stripped of its query, because that is what
// Go reported: it read the failure off the request's URL.Path, which holds the
// route as the server saw it. An id that had to be escaped reads back as the id
// that was asked for rather than as its percent-encoding.
const call = async <T>(pending: Promise<T>): Promise<T> => {
  try {
    return await pending;
  } catch (e) {
    if (e instanceof KaneoApiError) {
      const [route] = e.path.split("?");
      throw new KaneoApiError(e.method, served(route!), e.statusCode, e.messages, e.body);
    }
    throw e;
  }
};

// A 2xx reply with no body is the zero value of the type the document declares,
// which is what Go's generated client handed back for one: a freshly allocated
// target rather than a failure. A listing is therefore the empty list and a
// record the object of absent fields, and the mappings below read the zero Go
// would have found rather than reaching through an absence.
const zeroList = <T>(reply: T[] | undefined): T[] => reply ?? [];
const zeroRecord = <T>(reply: T | undefined): T => reply ?? ({} as T);

// The route a request was made on, with /api in front of it and without the
// encoding the endpoint was written with.
//
// The check is on the whole segment rather than on the spelling: /apix is a
// path of its own, and prefixing it with /api would name a route nobody called.
const served = (path: string): string => {
  const route = decoded(path);
  return route === "/api" || route.startsWith("/api/") ? route : `/api${route}`;
};

// A percent-encoded path as the server saw it, read back as the route it names.
// A sequence that is not valid encoding is left alone: a path this build did not
// encode must not be turned into a different one by trying.
const decoded = (path: string): string => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

// The server writes timestamps the way JavaScript's toISOString does — UTC,
// milliseconds — so a time read and printed again comes out as the server sent
// it. A timestamp written any other way is shown as the same instant in that
// form, and one the reply left out is the Go build's zero time rather than an
// empty string, because that is what its zero time.Time formatted as and a task
// with no createdAt is a fact the report has to be able to show.
const isoTime = (value: string | null | undefined): string => {
  const at = Date.parse(value ?? "");
  if (!Number.isNaN(at)) return new Date(at).toISOString();
  return value === null || value === undefined || value === "" ? ZERO_TIME : value;
};

// The instant Go's zero time.Time holds, which is what a reply that carried no
// timestamp decoded to.
const ZERO_TIME = "0001-01-01T00:00:00.000Z";

// The same, for a field that is a timestamp or nothing at all. An absent one
// stays absent rather than becoming an empty string, because a task with no due
// date and a task due at the epoch are not the same fact.
const isoTimePtr = (value: string | null | undefined): string | null =>
  value === null || value === undefined ? null : isoTime(value);

// A value the document types as a closed list, handed to the server unchanged so
// it can answer 400 for one it does not accept. That message names the field and
// the values allowed, which is more use than this client deciding the value is
// impossible; the Go build sent the same body for the same reason.
const unchecked = <T extends string>(value: string): T => value as T;

// The characters a path segment may carry unescaped: RFC 3986's unreserved set
// and the sub-delims that keep their meaning inside one segment. Everything else
// is percent-encoded.
const PATH_SAFE = /[A-Za-z0-9\-_.~$&+:=@]/;

// Escapes a value substituted into a path.
//
// The generated client writes a path parameter into the URL as it is, so an id
// holding "#" or "?" would truncate the path into a fragment and a query, and one
// holding "/" would address a different route entirely. The Go build escaped
// every id for this reason (its url.PathEscape), and the two have to agree byte
// for byte or the server sees two different requests.
const pathParam = (value: string): string =>
  [...value]
    .map((char) =>
      PATH_SAFE.test(char)
        ? char
        : [...new TextEncoder().encode(char)]
            .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
            .join(""),
    )
    .join("");

// A Kaneo workspace. The server models it as a better-auth organization, which
// is why the listing lives under /auth.
export type Workspace = { id: string; name: string; slug: string };

// The workspaces the key can see.
//
// This is also the only cheap call that can tell a valid key from an invalid
// one. /auth/get-session answers 200 with null for a valid key, an invalid key
// and no key at all, so it has no discriminating power and must not be used to
// check credentials.
export const listWorkspaces = async (signal?: AbortSignal): Promise<Workspace[]> =>
  zeroList(await call(listOrganization({ ...(signal === undefined ? {} : { signal }) }))).map((org) =>
    workspace(org),
  );

const workspace = (org: Organization): Workspace => ({
  id: org.id ?? "",
  name: org.name ?? "",
  slug: org.slug ?? "",
});

// Changes a workspace's display name. better-auth only touches the slug when
// data.slug is sent, and Kaneo's own settings page sends the same name-only
// payload, so a CLI rename matches a UI rename.
//
// The server accepts any 1-character name, including a space, so the name is
// trimmed and checked here. The reply is checked too: a 200 that does not echo
// the workspace back must not read as success.
export const renameWorkspace = async (workspaceId: string, name: string): Promise<Workspace> => {
  const wanted = name.trim();
  if (wanted === "") throw new Error("workspace name is empty");
  const renamed = workspace(
    zeroRecord(await call(updateOrganization({ organizationId: workspaceId, data: { name: wanted } }))),
  );
  if (renamed.id !== workspaceId || renamed.name !== wanted) {
    throw new Error(
      `/auth/organization/update: server answered with workspace ${quoted(renamed.id)} named ${quoted(renamed.name)}`,
    );
  }
  return renamed;
};

// A project belongs to exactly one workspace. archivedAt is set once a project
// is finished: archiving is how a project leaves a board without anything being
// deleted, so the field is a timestamp rather than a flag — it also says when.
export type Project = {
  id: string;
  name: string;
  slug: string;
  icon: string;
  description: string;
  workspaceId: string;
  isPublic: boolean;
  archivedAt: string | null;
};

export const archived = (project: Project): boolean => project.archivedAt !== null;

// The projects in a workspace. workspaceId is a required query parameter;
// omitting it is a 400, not an unfiltered listing.
//
// Archived projects are left out unless asked for, which is the same view the
// board takes.
//
// The keys are handed to the generated client in sorted order because it writes
// the query in the order it is given, and the Go build wrote it through
// url.Values, which sorts. A query string is part of what a server sees, so the
// two requests have to be the same request.
export const listProjectsIn = async (workspaceId: string, includeArchived: boolean): Promise<Project[]> =>
  zeroList(await call(listProjects({ ...(includeArchived ? { includeArchived: "true" } : {}), workspaceId }))).map(
    project,
  );

// What every route that returns a project agrees on. The listing adds rollup
// statistics and the detail route adds timestamps; neither is part of what this
// CLI reads a project for.
type ProjectFields = Pick<
  ProjectListItem,
  "id" | "workspaceId" | "name" | "slug" | "icon" | "description" | "isPublic" | "archivedAt"
>;

const project = (item: ProjectFields): Project => ({
  id: item.id ?? "",
  name: item.name ?? "",
  slug: item.slug ?? "",
  icon: item.icon ?? "",
  description: item.description ?? "",
  workspaceId: item.workspaceId ?? "",
  isPublic: item.isPublic ?? false,
  archivedAt: isoTimePtr(item.archivedAt),
});

// Fetches one project by id.
//
// A signal bounds the call when the caller shares its budget with other work,
// which is how the attach lookups leave room for the marker post. The transport
// applies the command's own deadline as well, and a signal here only ever cuts
// this one request short.
export const getProject = async (projectId: string, signal?: AbortSignal): Promise<Project> =>
  project(zeroRecord(await call(readProject(pathParam(projectId), { ...(signal === undefined ? {} : { signal }) }))));

// The payload for creating a project. description is not sent: the server's
// create route takes no description, so it is only here to be set by an update
// afterwards.
export type NewProject = { name: string; workspaceId: string; icon: string; slug: string; description: string };

// Creates a project in a workspace. The server requires an icon, so one is
// supplied when the caller has none.
export const createProject = async (wanted: NewProject): Promise<Project> =>
  project(
    zeroRecord(
      await call(
        postProject({
          name: wanted.name,
          workspaceId: wanted.workspaceId,
          icon: wanted.icon === "" ? "Layers" : wanted.icon,
          slug: wanted.slug,
        }),
      ),
    ),
  );

// Puts a project away, or brings it back.
//
// Archiving is the alternative to editing a project out of the repo map: the
// mapping and every task on it stay where they are, and only the board stops
// showing it. Nothing is deleted, so the change is reversible.
export const setProjectArchived = async (projectId: string, archived: boolean): Promise<void> => {
  const id = pathParam(projectId);
  await call(archived ? archiveProject(id) : unarchiveProject(id));
};

// The fields to change. A field left out is written back as it was read, so
// passing an empty string is what clears a description.
export type ProjectChanges = {
  name?: string;
  slug?: string;
  description?: string;
  icon?: string;
};

// Changes only the fields named in changes, and answers the project as read and
// as written so a caller can show both.
//
// The server's update is a full replace: name, icon, slug, description and
// isPublic are all required, and whatever is sent is written. So the project is
// read first and every field that was not asked for, visibility included, is
// sent back as it was when read; a change made elsewhere between the read and
// the write is overwritten. Sending isPublic unchanged also keeps the call clear
// of the project:share permission, which the server demands only on a change.
//
// A NULL description comes back as "" and is written as "": the server's body
// takes only a string, so NULL cannot be sent back. Both render the same.
export const updateProject = async (
  projectId: string,
  changes: ProjectChanges,
): Promise<{ before: Project; after: Project }> => {
  const want: ProjectChanges = { ...changes };
  // The server accepts any string, but a blank name, slug or icon leaves a
  // project that cannot be read or linked to, so those are refused here.
  for (const field of ["name", "slug", "icon"] as const) {
    const given = want[field];
    if (given === undefined) continue;
    const trimmed = given.trim();
    if (trimmed === "") throw new Error(`project ${field} is empty`);
    want[field] = trimmed;
  }

  const before = await getProject(projectId);
  // Every field of this read is written back, so a read that decoded to an empty
  // project (a null reply, a different shape) would blank the project.
  if (before.id !== projectId || before.name === "" || before.slug === "") {
    throw new Error(
      `reading project ${projectId} before the update got id ${JSON.stringify(before.id)}, name ${JSON.stringify(before.name)}, slug ${JSON.stringify(before.slug)}; not writing`,
    );
  }

  const after = project(
    zeroRecord(
      await call(
        putProject(pathParam(projectId), {
          name: want.name ?? before.name,
          icon: want.icon ?? before.icon,
          slug: want.slug ?? before.slug,
          description: want.description ?? before.description,
          isPublic: before.isPublic,
        }),
      ),
    ),
  );

  // A write the server did not echo back did not happen. Reporting it beats
  // printing a project the caller can see is not the one now stored.
  const off: string[] = [];
  for (const [name, got, expected] of [
    ["id", after.id, projectId],
    ["name", after.name, want.name ?? before.name],
    ["slug", after.slug, want.slug ?? before.slug],
    ["description", after.description, want.description ?? before.description],
    ["icon", after.icon, want.icon ?? before.icon],
    ["isPublic", after.isPublic, before.isPublic],
  ] as const) {
    if (got !== expected) off.push(`${name} ${quoted(got)}, want ${quoted(expected)}`);
  }
  if (off.length > 0) {
    throw new Error(`/project/${projectId}: server did not echo the update: ${off.join("; ")}`);
  }
  return { before, after };
};

// Go's %q, which quotes whatever it is given rather than only its strings.
const quoted = (value: string | boolean): string =>
  typeof value === "string" ? JSON.stringify(value) : JSON.stringify(String(value));

export type Label = { id: string; name: string; color: string };

// A single work item, as every route that returns one agrees on it.
//
// labels is null on the routes that answer without any, which is not the same
// fact as a task that has none: only the board listing carries them.
export type Task = {
  id: string;
  number: number;
  title: string;
  description: string;
  status: string;
  priority: string;
  position: number;
  projectId: string;
  assigneeId: string | null;
  assigneeName: string | null;
  startDate: string | null;
  dueDate: string | null;
  createdAt: string;
  labels: Label[] | null;
};

// Priorities the server accepts, most urgent first. An unknown value sorts last.
export const PRIORITIES = ["urgent", "high", "medium", "low", "no-priority"];

export const priorityRank = (priority: string): number => {
  const at = PRIORITIES.indexOf(priority);
  return at === -1 ? PRIORITIES.length : at;
};

export type Board = {
  projectId: string;
  projectName: string;
  columns: { id: string; name: string; tasks: Task[] }[];
};

// A project's columns and tasks, every page of them.
//
// The two levels of paging, as v2.29.2 serves the listing:
//   - task pages (page): 50 tasks each, in a stable order
//   - within a task page, related pages (relatedPage): the same tasks again,
//     with the next 100 labels, links and columns
//
// Tasks are keyed by id, so a task seen again on a related page only gains the
// labels that page carries, and columns are merged by id in the order they
// first appear.
//
// The first request sends neither page nor limit. A release from before
// v2.26.0 paginates only when one of them is present, and there it sorts on
// position alone, which ties within a column and so pages unstably; left
// without them it returns the whole board at once, as it always did.
//
// A server older than the document this client is generated from sends no
// pagination block at all, which reads as one page of everything and no related
// pages: zero is how Go's paging counted a block that was not there, and the
// loop stops on it after the first request instead of asking for pages that hold
// nothing.
export const getBoard = async (projectId: string): Promise<Board> => {
  let board: Board | undefined;
  const columnAt = new Map<string, number>();
  const taskAt = new Map<string, { column: number; task: number }>();

  for (let page = 1, pages = 1; page <= pages; page++) {
    for (let related = 1, relatedPages = 1; related <= relatedPages; related++) {
      const response = zeroRecord(
        await call(
          listTasks(pathParam(projectId), {
            ...(page > 1 ? { page } : {}),
            ...(related > 1 ? { relatedPage: related } : {}),
          }),
        ),
      );
      pages = response.pagination?.totalPages ?? 0;
      relatedPages = response.pagination?.relatedTotalPages ?? 0;

      const data = zeroRecord(response.data);
      if (board === undefined) {
        board = { projectId: data.id ?? "", projectName: data.name ?? "", columns: [] };
      }
      const target = board;
      for (const column of zeroList(data.columns)) {
        let at = columnAt.get(column.id);
        if (at === undefined) {
          at = target.columns.length;
          columnAt.set(column.id, at);
          target.columns.push({ id: column.id, name: column.name, tasks: [] });
        }
        for (const task of zeroList(column.tasks)) {
          const seen = taskAt.get(task.id);
          if (seen !== undefined) {
            // A repeat on a related page brings more labels; a repeat on a later
            // task page is the same task twice.
            if (related > 1) {
              target.columns[seen.column]!.tasks[seen.task]!.labels = appendNewLabels(
                target.columns[seen.column]!.tasks[seen.task]!.labels,
                labels(task.labels),
              );
            }
            continue;
          }
          taskAt.set(task.id, { column: at, task: target.columns[at]!.tasks.length });
          target.columns[at]!.tasks.push(toTask(task));
        }
      }
    }
  }
  if (board === undefined || board.projectId === "") {
    throw new Error(`board ${projectId}: the server answered without a project`);
  }
  return board;
};

// The board flattened, most urgent first, then by task number.
export const boardTasks = (board: Board): Task[] =>
  board.columns
    .flatMap((column) => column.tasks)
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.number - b.number);

// Pages are read one request at a time without a snapshot, so a label can come
// back twice when the board changes mid-read.
const appendNewLabels = (have: Label[] | null, more: Label[]): Label[] => {
  const kept = have ?? [];
  const seen = new Set(kept.map((label) => label.id));
  for (const label of more) if (!seen.has(label.id)) kept.push(label);
  return kept;
};

const labels = (from: TaskLabel[] | undefined): Label[] =>
  // A board older than the document sends no labels field at all, which Go read
  // as the empty list it made of every one it was given.
  (from ?? []).map((l) => ({ id: l.id, name: l.name, color: l.color }));

// What the three routes that answer with a task agree on, before the CLI's own
// fields are filled in: the assignee and the labels are the two that differ.
type TaskFields = Pick<
  GenTask,
  | "id"
  | "number"
  | "title"
  | "description"
  | "status"
  | "priority"
  | "position"
  | "projectId"
  | "startDate"
  | "dueDate"
  | "createdAt"
>;

const task = (from: TaskFields, extra: Pick<Task, "assigneeId" | "assigneeName" | "labels">): Task => ({
  id: from.id ?? "",
  // The document types a number and a position as nullable, and the server only
  // ever issues integers, so an absent one is read as zero rather than dropped:
  // the field is always part of the report.
  number: from.number ?? 0,
  title: from.title ?? "",
  description: from.description ?? "",
  status: from.status ?? "",
  priority: from.priority ?? "",
  position: from.position ?? 0,
  projectId: from.projectId ?? "",
  assigneeId: extra.assigneeId ?? null,
  assigneeName: extra.assigneeName ?? null,
  startDate: isoTimePtr(from.startDate),
  dueDate: isoTimePtr(from.dueDate),
  createdAt: isoTime(from.createdAt),
  labels: extra.labels,
});

// The board listing, the only route that resolves the assignee's name and carries
// the labels.
const toTask = (t: BoardTask): Task =>
  task(t, { assigneeId: t.assigneeId, assigneeName: t.assigneeName, labels: labels(t.labels) });

// Fetches one task by id, with its assignee's name resolved. Labels are not part
// of the reply, so they read as null.
export const getTask = async (taskId: string): Promise<Task> => {
  const t = zeroRecord(await call(readTask(pathParam(taskId))));
  return task(t, { assigneeId: t.assigneeId, assigneeName: t.assigneeName, labels: null });
};

// The payload for creating a task.
export type NewTask = {
  title: string;
  description: string;
  priority: string;
  status: string;
  dueDate: string;
  assigneeId: string;
};

// Adds a task to a project. The server requires description, priority and status
// on creation, so empty values are filled with defaults rather than omitted, and
// an empty due date or assignee is left out of the body altogether.
//
// The write routes answer with the stored task, which names the assignee as
// userId, resolves no name and carries no labels.
export const createTask = async (projectId: string, wanted: NewTask): Promise<Task> => {
  const created = zeroRecord(
    await call(
      postTask(pathParam(projectId), {
        title: wanted.title,
        description: wanted.description,
        ...(wanted.dueDate === "" ? {} : { dueDate: wanted.dueDate }),
        priority: unchecked<CreateTaskBody["priority"]>(wanted.priority === "" ? "medium" : wanted.priority),
        status: wanted.status === "" ? "to-do" : wanted.status,
        ...(wanted.assigneeId === "" ? {} : { userId: wanted.assigneeId }),
      }),
    ),
  );
  return task(created, { assigneeId: created.userId, assigneeName: null, labels: null });
};

// Moves a task to another column.
//
// The dedicated endpoint is used rather than PUT /task/{id}, which requires
// every field and answers 400 when used for a partial update.
export const setTaskStatus = async (taskId: string, status: string): Promise<void> => {
  await call(updateTaskStatus(pathParam(taskId), { status }));
};

export const setTaskPriority = async (taskId: string, priority: string): Promise<void> => {
  await call(updateTaskPriority(pathParam(taskId), { priority: unchecked<UpdateTaskPriorityBody["priority"]>(priority) }));
};

// Assigns a task to a user, or clears the assignee when userId is empty.
export const setTaskAssignee = async (taskId: string, userId: string): Promise<void> => {
  await call(updateTaskAssignee(pathParam(taskId), { userId: userId === "" ? null : userId }));
};

export const moveTask = async (taskId: string, projectId: string): Promise<void> => {
  await call(putTaskMove(pathParam(taskId), { destinationProjectId: projectId }));
};

export const deleteTask = async (taskId: string): Promise<void> => {
  await call(removeTask(pathParam(taskId)));
};

// A comment on a task. It is also where the session's metadata lives, since a
// task has no custom fields.
export type Comment = {
  id: string;
  content: string;
  userId: string;
  userName: string;
  createdAt: string;
};

// A task's comments, oldest first.
//
// The author's name arrives as user.name, which only this route carries, so it
// is read from there and from nowhere else. A server that sends no author, or a
// null one, has not answered who wrote it rather than answered that nobody did,
// and the name reads as empty.
export const listComments = async (taskId: string): Promise<Comment[]> =>
  zeroList(await call(getTaskComments(pathParam(taskId)))).map((c) => ({
    id: c.id ?? "",
    content: c.content ?? "",
    userId: c.userId ?? "",
    userName: c.user?.name ?? "",
    createdAt: isoTime(c.createdAt),
  }));

// Posts a comment on a task. The server answers with the stored activity row,
// which carries no author, so the reply's name is empty and a caller that needs
// one reads the listing back.
export const addComment = async (taskId: string, content: string, signal?: AbortSignal): Promise<Comment> => {
  const a = zeroRecord(
    await call(
      createTaskComment(pathParam(taskId), { content }, { ...(signal === undefined ? {} : { signal }) }),
    ),
  );
  return {
    id: a.id ?? "",
    content: a.content ?? "",
    userId: a.userId ?? "",
    userName: "",
    createdAt: isoTime(a.createdAt),
  };
};

// The links the server accepts between two tasks.
export const RELATION_TYPES = ["subtask", "blocks", "related"];

// A link between two tasks.
export type Relation = { id: string; sourceTaskId: string; targetTaskId: string; relationType: string };

// Relates two tasks. For a subtask link, source is the parent.
export const linkTasks = async (
  sourceTaskId: string,
  targetTaskId: string,
  relationType: string,
): Promise<Relation> =>
  relation(
    zeroRecord(
      await call(
        createTaskRelation({
          sourceTaskId,
          targetTaskId,
          relationType: unchecked<CreateTaskRelationBody["relationType"]>(relationType),
        }),
      ),
    ),
  );

// A task's links, as both endpoints of the link.
export const listRelations = async (taskId: string): Promise<Relation[]> =>
  zeroList(await call(getTaskRelations(pathParam(taskId)))).map(relation);

// The listing answers with a summary of each linked task as well; the link itself
// is what this CLI reports.
const relation = (r: GenRelation | TaskRelationWithTasks): Relation => ({
  id: r.id ?? "",
  sourceTaskId: r.sourceTaskId ?? "",
  targetTaskId: r.targetTaskId ?? "",
  relationType: r.relationType ?? "",
});

// A notification for the user the key belongs to. content is null for the ones
// the server raises from task and workspace events: their text is meant to be
// rendered from type and eventData, so both are kept as sent.
export type Notification = {
  id: string;
  type: string;
  title: string | null;
  content: string | null;
  eventData: unknown;
  isRead: boolean;
  resourceType: string | null;
  resourceId: string | null;
  createdAt: string;
};

const notification = (n: GenNotification): Notification => ({
  id: n.id ?? "",
  type: n.type ?? "",
  title: n.title ?? null,
  content: n.content ?? null,
  eventData: n.eventData ?? null,
  // The document allows null; the column defaults to unread, and a notification
  // nobody has opened is the fact a null stands for.
  isRead: n.isRead === true,
  resourceType: n.resourceType ?? null,
  resourceId: n.resourceId ?? null,
  createdAt: isoTime(n.createdAt),
});

// The newest 50 notifications, read and unread, newest first: the server caps
// the listing there and takes no page.
export const listNotifications = async (): Promise<Notification[]> =>
  zeroList(await call(getNotifications())).map(notification);

export const markNotificationRead = async (id: string): Promise<Notification> =>
  notification(zeroRecord(await call(markNotificationAsRead(pathParam(id)))));

export const markAllNotificationsRead = async (): Promise<void> => {
  await call(markAllNotificationsAsRead());
};

export const clearNotifications = async (): Promise<void> => {
  await call(clearAllNotifications());
};

export type NewNotification = {
  type: string;
  title: string;
  message: string;
  resourceType: string;
  resourceId: string;
};

// Raises a notification for the key's own user. The server answers null when
// that user has turned the category off, or cannot reach the task or workspace
// it points at; neither is a failure: the request was accepted and nothing was
// stored.
export const createNotification = async (wanted: NewNotification): Promise<Notification | null> => {
  const body: CreateNotificationBody = { type: wanted.type };
  if (wanted.title !== "") body.title = wanted.title;
  if (wanted.message !== "") body.message = wanted.message;
  if (wanted.resourceType !== "") body.relatedEntityType = wanted.resourceType;
  if (wanted.resourceId !== "") body.relatedEntityId = wanted.resourceId;
  const created = await call(postNotification(body));
  return created === null || created === undefined ? null : notification(created);
};

// How the key's user is notified. Secrets come back as booleans and a masked
// preview only, so the record is passed on as the server sent it.
export type NotificationPreferences = GenNotificationPreferences;
export type NotificationPreferenceChanges = UpdateNotificationPreferencesBody;
export type WorkspaceRule = UpsertNotificationPreferenceWorkspaceRuleBody;

export const getNotificationPreferences = async (): Promise<NotificationPreferences> =>
  zeroRecord(await call(readNotificationPreferences()));

// Only the fields in changes are sent. The server leaves the other settings
// alone, but carries a channel switch into the workspace rules.
export const updateNotificationPreferences = async (
  changes: NotificationPreferenceChanges,
): Promise<NotificationPreferences> => zeroRecord(await call(putNotificationPreferences(changes)));

// Replaces a workspace's rule whole: the server takes every field or none.
export const setWorkspaceRule = async (workspaceId: string, rule: WorkspaceRule): Promise<NotificationPreferences> =>
  zeroRecord(await call(upsertNotificationPreferenceWorkspaceRule(pathParam(workspaceId), rule)));

export const removeWorkspaceRule = async (workspaceId: string): Promise<NotificationPreferences> =>
  zeroRecord(await call(deleteNotificationPreferenceWorkspaceRule(pathParam(workspaceId))));

export type CheckResult = {
  serverOperations: number;
  clientOperations: number;
  covered: Operation[];
  // What this client calls but the server does not offer. Each entry is a
  // command that will fail against this server.
  missing: Operation[];
  // What the server offers and this client does not use yet.
  newOnServer: string[];
};

type Document = { paths?: Record<string, Record<string, { operationId?: string } | undefined> | undefined> };

// The comparison between this client and a server. The document is served
// without authentication, so this works before any key is configured; it goes
// through the transport like every other call so it lands under /api, since the
// site root answers 200 with the web app's HTML for any path.
export const checkApi = async (): Promise<CheckResult> => {
  const document = zeroRecord(await call(kaneoFetch<Document>("/openapi", { method: "GET" })));
  const seen = new Set<string>();
  const onServer: string[] = [];
  for (const methods of Object.values(document.paths ?? {})) {
    for (const operation of Object.values(methods ?? {})) {
      const id = operation?.operationId;
      if (id === undefined || id === "" || seen.has(id)) continue;
      seen.add(id);
      onServer.push(id);
    }
  }
  onServer.sort();

  const used = new Set(OPERATIONS.map((operation) => operation.id));
  return {
    serverOperations: onServer.length,
    clientOperations: OPERATIONS.length,
    covered: OPERATIONS.filter((operation) => seen.has(operation.id)),
    missing: OPERATIONS.filter((operation) => !seen.has(operation.id)),
    newOnServer: onServer.filter((id) => !used.has(id)),
  };
};

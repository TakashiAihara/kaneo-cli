import { OPERATIONS, type Operation } from "./registry";
import { kaneoFetch, KaneoApiError } from "./http";
import type { Json } from "../output/json";
import {
  archiveProject,
  clearAllNotifications,
  createNotification as postNotification,
  createColumn as postColumn,
  createActivity,
  getActivities,
  updateTaskComment,
  attachLabelToTask,
  createLabel as postLabel,
  deleteLabel as removeLabel,
  detachLabelFromTask,
  getLabel as readLabel,
  getTaskLabels,
  getWorkspaceLabels,
  updateLabel as putLabel,
  createProject as postProject,
  createTask as postTask,
  createTaskComment,
  createTaskRelation,
  deleteNotificationPreferenceWorkspaceRule,
  deleteColumn as removeColumn,
  createTimeEntry,
  deleteTask as removeTask,
  getNotificationPreferences as readNotificationPreferences,
  deleteTaskComment,
  deleteTaskRelation as removeRelation,
  getColumns as readColumns,
  getInvitationDetails,
  getWorkspaceMembers,
  globalSearch,
  getProject as readProject,
  getTask as readTask,
  getTaskComments,
  getTaskRelations,
  listNotifications as getNotifications,
  getTaskTimeEntries,
  getTimeEntry,
  listOrganization,
  listProjects,
  listTasks,
  markAllNotificationsAsRead,
  markNotificationAsRead,
  moveTask as putTaskMove,
  reorderColumns as putColumns,
  unarchiveProject,
  updateNotificationPreferences as putNotificationPreferences,
  updateColumn as putColumn,
  updateOrganization,
  updateProject as putProject,
  upsertNotificationPreferenceWorkspaceRule,
  updateTaskAssignee,
  updateTaskDescription,
  updateTaskPriority,
  updateTaskStatus,
  updateTaskTitle,
  updateTimeEntry,
} from "./gen/kaneo";
import type {
  Board as GenBoard,
  BoardTask,
  CreateNotificationBody,
  Column as GenColumn,
  CreateTaskBody,
  Notification as GenNotification,
  NotificationPreferences as GenNotificationPreferences,
  CreateTaskRelationBody,
  Activity as GenActivity,
  GlobalSearchParams,
  Label as GenLabel,
  Organization,
  ProjectListItem,
  RelatedTask,
  TaskLabel,
  Task as GenTask,
  TaskRelation as GenRelation,
  TaskRelationWithTasks,
  UpdateNotificationPreferencesBody,
  TimeEntry as GenTimeEntry,
  UpdateTaskPriorityBody,
  UpsertNotificationPreferenceWorkspaceRuleBody,
} from "./gen/model";

// What this CLI makes of a Kaneo server.
//
// Requests and response shapes come from the generated client, so a call that
// drifts from what the server documents fails to build rather than at the
// server. This module keeps what the document cannot say: the CLI's own view of
// workspaces, projects and tasks, and what a reply that leaves a field out, or
// puts something unusable in one, means. The failures themselves are the
// transport's to report, so a message names the request the same way whichever
// call it came from.

// A 2xx reply with no body is the zero value of the type the document declares,
// which is what Go's generated client handed back for one: a freshly allocated
// target rather than a failure. A listing is therefore the empty list and a
// record the object of absent fields, and the mappings below read the zero Go
// would have found rather than reaching through an absence.
const zeroList = <T>(reply: T[] | undefined): T[] => reply ?? [];
const zeroRecord = <T>(reply: T | undefined): T => reply ?? ({} as T);

// The server writes timestamps the way JavaScript's toISOString does — UTC,
// milliseconds — so a time read and printed again comes out as the server sent
// it. A timestamp written any other way is shown as the same instant in that
// form.
//
// Go decoded these fields into a time.Time, so a field it could not parse failed
// the decode there rather than becoming a timestamp nobody can act on, and this
// fails the call with the field and the value for the same reason. What is
// accepted is RFC 3339 and nothing looser: Date.parse also takes a bare year, a
// date alone, or a time with no offset, which it reads in the local zone, so the
// same reply would name a different instant on another machine. Go's own check
// is looser in a few spellings no server writes (a comma before the fraction, a
// one-digit hour, an offset of +24:00); those are refused here, as the design
// document records. The value is cut in the message, since the reply decides
// how long it is.
const isoTime = (field: string, value: unknown): string => {
  if (value === null || value === undefined) return ZERO_TIME;
  const at = typeof value === "string" && isRfc3339(value) ? Date.parse(value) : Number.NaN;
  if (!Number.isNaN(at)) return new Date(at).toISOString();
  const shown = Array.from(JSON.stringify(value));
  throw new Error(
    `${field} ${shown.length > VALUE_LIMIT ? `${shown.slice(0, VALUE_LIMIT).join("")}...` : shown.join("")} is not a timestamp`,
  );
};

// time.RFC3339 with any fraction of a second: upper-case T and Z, and an offset
// that is always written. The day and the hour are checked here because
// Date.parse carries a 30 February into March and 24:00 into the next day where
// Go refuses both; the other fields out of range it refuses on its own.
const isRfc3339 = (value: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return false;
  const [year, month, day, hour] = m.slice(1).map(Number);
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month! - 1] ?? 0;
  return day! <= daysInMonth && hour! <= 23;
};
const VALUE_LIMIT = 200;

// The instant Go's zero time.Time holds, which is what a reply that carried no
// timestamp, or a null one, decoded to.
const ZERO_TIME = "0001-01-01T00:00:00.000Z";

// The same, for a field that is a timestamp or nothing at all. An absent one
// stays absent rather than becoming an empty string, because a task with no due
// date and a task due at the epoch are not the same fact.
const isoTimePtr = (field: string, value: unknown): string | null =>
  value === null || value === undefined ? null : isoTime(field, value);

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
export const listWorkspaces = async (): Promise<Workspace[]> =>
  zeroList(await listOrganization()).map((org) => workspace(org));

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
    zeroRecord(await updateOrganization({ organizationId: workspaceId, data: { name: wanted } })),
  );
  if (renamed.id !== workspaceId || renamed.name !== wanted) {
    throw new Error(
      `/auth/organization/update: server answered with workspace ${quoted(renamed.id)} named ${quoted(renamed.name)}`,
    );
  }
  return renamed;
};

// Someone with access to a workspace. role is a built-in role (owner, admin,
// member, guest) or a custom role's name, so it is a string rather than a closed
// list. image is null for a member who has none.
export type Member = { id: string; name: string; email: string; image: string | null; role: string };

export const listMembers = async (workspaceId: string): Promise<Member[]> =>
  zeroList(await getWorkspaceMembers(pathParam(workspaceId))).map((m) => ({
    id: m.id ?? "",
    name: m.name ?? "",
    email: m.email ?? "",
    image: m.image ?? null,
    role: m.role ?? "",
  }));

// What the server will say about one invitation.
//
// The route answers 200 for an invitation that cannot be used, with valid false
// and the reason in error, so an unusable invitation is a reply rather than a
// failure. The details are withheld for one that does not exist, was accepted or
// was canceled, which is why invitation can be null while valid is false.
export type InvitationDetails = {
  valid: boolean;
  invitation: {
    id: string;
    email: string;
    workspaceName: string;
    inviterName: string;
    expiresAt: string;
    status: string;
    expired: boolean;
  } | null;
  error: string | null;
};

export const getInvitation = async (invitationId: string): Promise<InvitationDetails> => {
  const reply = zeroRecord(await getInvitationDetails(pathParam(invitationId)));
  const i = reply.invitation;
  return {
    valid: reply.valid ?? false,
    invitation:
      i === undefined
        ? null
        : {
            id: i.id ?? "",
            email: i.email ?? "",
            workspaceName: i.workspaceName ?? "",
            inviterName: i.inviterName ?? "",
            expiresAt: isoTime("expiresAt", i.expiresAt),
            status: i.status ?? "",
            expired: i.expired ?? false,
          },
    error: reply.error ?? null,
  };
};

// One match of a search. Every field but id, type, title, createdAt and
// relevanceScore depends on the type — a project has no task number, only a
// comment or an activity has content — so the ones a match lacks are null
// rather than absent, and every result has the same keys.
export type SearchResult = {
  id: string;
  type: string;
  title: string;
  description: string | null;
  content: string | null;
  projectId: string | null;
  projectName: string | null;
  projectSlug: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  userId: string | null;
  userName: string | null;
  createdAt: string;
  relevanceScore: number;
  taskNumber: number | null;
  priority: string | null;
  status: string | null;
};

// totalCount is what the server reports, which is not what the document says.
// The document calls it every match before the limit, but v2.29.2 applies the
// limit to each type's query first and counts what those returned, so it is not
// the number of matches. A full page is the signal that more may exist.
export type Search = { query: string; results: SearchResult[]; totalCount: number };

// What to search for. type and limit are "" to take the server's defaults (every
// type, 20 results), and projectId is "" to search the whole workspace.
export type SearchQuery = { query: string; workspaceId: string; projectId: string; type: string; limit: string };

// Searches from one workspace: tasks, comments and activities in it, though the
// server takes workspace matches from every workspace the key can reach. The
// query keys are in sorted order, as every other query this client sends is, so
// a request reads the same however the call was written.
export const search = async (wanted: SearchQuery): Promise<Search> => {
  const reply = zeroRecord(
    await globalSearch({
      ...(wanted.limit === "" ? {} : { limit: wanted.limit }),
      ...(wanted.projectId === "" ? {} : { projectId: wanted.projectId }),
      q: wanted.query,
      ...(wanted.type === "" ? {} : { type: unchecked<NonNullable<GlobalSearchParams["type"]>>(wanted.type) }),
      workspaceId: wanted.workspaceId,
    }),
  );
  return {
    query: reply.searchQuery ?? "",
    totalCount: reply.totalCount ?? 0,
    results: zeroList(reply.results).map((r) => ({
      id: r.id ?? "",
      type: r.type ?? "",
      title: r.title ?? "",
      description: r.description ?? null,
      content: r.content ?? null,
      projectId: r.projectId ?? null,
      projectName: r.projectName ?? null,
      projectSlug: r.projectSlug ?? null,
      workspaceId: r.workspaceId ?? null,
      workspaceName: r.workspaceName ?? null,
      userId: r.userId ?? null,
      userName: r.userName ?? null,
      createdAt: isoTime("createdAt", r.createdAt),
      relevanceScore: r.relevanceScore ?? 0,
      taskNumber: r.taskNumber ?? null,
      priority: r.priority ?? null,
      status: r.status ?? null,
    })),
  };
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
  zeroList(await listProjects({ ...(includeArchived ? { includeArchived: "true" } : {}), workspaceId })).map(project);

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
  archivedAt: isoTimePtr("archivedAt", item.archivedAt),
});

// Fetches one project by id. Every request is bounded by the transport's own
// timeout, so there is no budget here for a caller to divide.
export const getProject = async (projectId: string): Promise<Project> =>
  project(zeroRecord(await readProject(pathParam(projectId))));

// The payload for creating a project. The server's create route carries no
// description at all, so none is sent: a description a caller asked for is
// written by an update afterwards.
export type NewProject = { name: string; workspaceId: string; icon: string; slug: string };

// Creates a project in a workspace. The server requires an icon, so one is
// supplied when the caller has none.
export const createProject = async (wanted: NewProject): Promise<Project> =>
  project(
    zeroRecord(
      await postProject({
        name: wanted.name,
        workspaceId: wanted.workspaceId,
        icon: wanted.icon === "" ? "Layers" : wanted.icon,
        slug: wanted.slug,
      }),
    ),
  );

// Puts a project away, or brings it back.
//
// Archiving is the alternative to editing a project out of the repo map: the
// mapping and every task on it stay where they are, and only the board stops
// showing it. Nothing is deleted, so the change is reversible.
export const setProjectArchived = async (projectId: string, archived: boolean): Promise<void> => {
  const id = pathParam(projectId);
  await (archived ? archiveProject(id) : unarchiveProject(id));
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
  // Every field of this read is written back, so a read that decoded to nothing
  // (a null reply, a different shape) would blank the project. An empty slug is
  // not that: it is a state a project can be in, and writing it back is the only
  // way such a project can be changed at all.
  if (before.id !== projectId || before.name === "") {
    throw new Error(
      `reading project ${projectId} before the update got id ${JSON.stringify(before.id)}, name ${JSON.stringify(before.name)}; not writing`,
    );
  }

  const after = project(
    zeroRecord(
      await putProject(pathParam(projectId), {
        name: want.name ?? before.name,
        icon: want.icon ?? before.icon,
        slug: want.slug ?? before.slug,
        description: want.description ?? before.description,
        isPublic: before.isPublic,
      }),
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

// A lane on a project's board.
//
// A column's slug is what every task in it stores as its status, so a task's
// status and a column are the same string. The id is a separate opaque string on
// the column routes, which is why a column is named by either.
//
// icon and color are nullable rather than empty: a column may carry neither, and
// the server says so with null.
export type Column = {
  id: string;
  slug: string;
  name: string;
  position: number;
  isFinal: boolean;
  icon: string | null;
  color: string | null;
};

// Every route that returns a column agrees on these, so they are read once.
const column = (c: GenColumn): Column => ({
  id: c.id ?? "",
  slug: c.slug ?? "",
  name: c.name ?? "",
  position: c.position ?? 0,
  isFinal: c.isFinal ?? false,
  icon: c.icon ?? null,
  color: c.color ?? null,
});

// A project's columns, in board order.
export const listColumns = async (projectId: string): Promise<Column[]> =>
  zeroList(await readColumns(pathParam(projectId))).map(column);

// The payload for creating a column. An icon and a color are left out of the body
// when there are none: the route takes a string or nothing at all, never null,
// and a column without either is what the board shows by default.
export type NewColumn = { name: string; icon: string; color: string; isFinal: boolean };

// Adds a column to the end of the board. The server derives the slug from the
// name, so it is not sent and the reply's slug is the one to report back.
export const createColumn = async (projectId: string, wanted: NewColumn): Promise<Column> =>
  column(
    zeroRecord(
      await postColumn(pathParam(projectId), {
        name: wanted.name,
        isFinal: wanted.isFinal,
        ...(wanted.icon === "" ? {} : { icon: wanted.icon }),
        ...(wanted.color === "" ? {} : { color: wanted.color }),
      }),
    ),
  );

// Writes a new position for every column of a project, so the answer is the
// whole set rather than the one column that moved.
export const reorderColumns = async (projectId: string, columnIds: string[]): Promise<Column[]> =>
  zeroList(
    await putColumns(pathParam(projectId), {
      columns: columnIds.map((id, position) => ({ id, position })),
    }),
  ).map(column);

// Renames a column.
//
// Only the name is sent. The slug is derived from the name when the column is
// created and the update route takes no slug at all, so the slug — which is what
// every task in the column stores as its status — stays as it was.
export const renameColumn = async (columnId: string, name: string): Promise<Column> =>
  column(zeroRecord(await putColumn(pathParam(columnId), { name })));

// Deletes a column, which the server allows only while the column holds no tasks.
export const deleteColumn = async (columnId: string): Promise<Column> =>
  column(zeroRecord(await removeColumn(pathParam(columnId))));

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
  // The slug is here rather than read again: the listing already carries it, and
  // a report that names the board a number was not found on needs it. Asking the
  // project route as well would be a request the caller already paid for.
  projectSlug: string;
  // The board route reports a column's id as its slug, so this id is a status,
  // not the opaque id the column routes take.
  columns: { id: string; name: string; tasks: Task[] }[];
};

// The listing answers the tasks that are in no column beside the columns: a
// planned task has not been picked up, an archived one has been filed away.
// They become two columns of their own, appended after the real ones and only
// when the server sent something, so the rest of the CLI reads a project as one
// list of columns.
const OFF_BOARD = [
  { id: "planned", name: "Planned", tasks: (data: GenBoard) => data.plannedTasks },
  { id: "archived", name: "Archived", tasks: (data: GenBoard) => data.archivedTasks },
];

const isOffBoard = (column: { id: string }): boolean => OFF_BOARD.some((off) => off.id === column.id);

// What the listing is asked for. Both are sent as query parameters, which the
// server applies before it pages. The callers filter the answer as well, so what
// they print does not depend on the server having applied them.
export type TaskFilters = { status?: string; priority?: string };

// A board read page by page: the board itself, the task the read stopped on if
// one was asked for, and whether the board moved under the reader.
type Reading = { board: Board; stopped: Task | undefined; moved: boolean };

// How many more times a board that changed under the reader is read whole: one
// for a write that landed mid-read, one more for a write that landed during that
// reread. A board still moving after that is being written to steadily, so it is
// reported rather than read again for ever.
const REREADS = 2;

// What a board that never settles is reported as, naming the project because
// `board` reads several. Stderr, so the JSON a script reads on stdout stays a
// document it can parse.
const changed = (projectId: string): string =>
  `kaneo: the board of project ${projectId} changed while it was read; the listing may be incomplete`;

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
// nothing. It is also a board that cannot be seen to move, since the total only
// a paginated listing reports is what the read is compared by.
//
// The pages are read one request at a time with no snapshot behind them, so a
// board that gains or loses a task while it is read reports a different total at
// the end of the read than at the start, and the pages held in between may not
// add up to either. Such a read is taken again, and a board that is still moving
// is reported on stderr so the JSON a script reads on stdout stays a document.
//
// Only a change in the number of tasks is seen. A task that moves to another
// position, a delete and a create within one read, or a label added between two
// related pages leave the total where it was, and such a read is answered as if
// it were whole.
export const getBoard = async (projectId: string, filters: TaskFilters = {}): Promise<Board> => {
  let read = await readBoard(projectId, filters);
  for (let again = 0; read.moved && again < REREADS; again++) read = await readBoard(projectId, filters);
  if (read.moved) console.error(changed(projectId));
  return read.board;
};

// One task by number, read off the board and no further: the read stops at the
// page that holds it, once that page's related pages have been read so the task
// carries every label the listing has for it. Answers the board as far as it was
// read, which names the project, and the task, undefined when no page holds it.
//
// A miss on a board that moved under the reader is read again: the task may have
// been pulled back onto a page the read had already passed, as a delete before
// it does, and a miss fails the command that asked as if the task did not exist.
// A board still moving after the rereads is reported the way getBoard reports it.
export const findTaskByNumber = async (
  projectId: string,
  number: number,
): Promise<{ board: Board; task: Task | undefined }> => {
  const stopAt = (page: Task[]): Task | undefined => page.find((task) => task.number === number);
  let read = await readBoard(projectId, {}, stopAt);
  for (let again = 0; read.stopped === undefined && read.moved && again < REREADS; again++) {
    read = await readBoard(projectId, {}, stopAt);
  }
  if (read.stopped === undefined && read.moved) console.error(changed(projectId));
  return { board: read.board, task: read.stopped };
};

// Reads the listing into a board.
//
// stopAt, when given, is asked after a task page and all of its related pages
// have been read, and the task it answers is the read's reason to stop.
const readBoard = async (
  projectId: string,
  filters: TaskFilters,
  stopAt?: (page: Task[]) => Task | undefined,
): Promise<Reading> => {
  const status = filters.status ?? "";
  const priority = filters.priority ?? "";
  let board: Board | undefined;
  let stopped: Task | undefined;
  const columnAt = new Map<string, number>();
  const offBoard = new Map(OFF_BOARD.map((column) => [column.id, [] as Task[]]));
  const taskAt = new Map<string, Task>();
  let first: number | undefined;
  let last: number | undefined;

  for (let page = 1, pages = 1; page <= pages && stopped === undefined; page++) {
    const onPage: Task[] = [];
    for (let related = 1, relatedPages = 1; related <= relatedPages; related++) {
      // In sorted order, as above listProjectsIn: the generated client writes
      // the query in the order it is given, and the Go build sorted it.
      const response = zeroRecord(
        await listTasks(pathParam(projectId), {
          ...(page > 1 ? { page } : {}),
          ...(priority === "" ? {} : { priority }),
          ...(related > 1 ? { relatedPage: related } : {}),
          ...(status === "" ? {} : { status }),
        }),
      );
      pages = response.pagination?.totalPages ?? 0;
      relatedPages = response.pagination?.relatedTotalPages ?? 0;
      const total = response.pagination?.total;
      if (page === 1 && related === 1) first = total;
      last = total;

      const data = zeroRecord(response.data);
      if (board === undefined) {
        board = {
          projectId: data.id ?? "",
          projectName: data.name ?? "",
          projectSlug: data.slug ?? "",
          columns: [],
        };
      }
      const target = board;
      // A task seen again on a related page brings more labels; the same task on
      // a later task page is the same task twice.
      const place = (from: BoardTask[], into: Task[]): void => {
        for (const task of from) {
          const seen = taskAt.get(task.id);
          if (seen !== undefined) {
            if (related > 1) seen.labels = appendNewLabels(seen.labels, labels(task.labels));
            continue;
          }
          const placed = toTask(task);
          taskAt.set(task.id, placed);
          into.push(placed);
          onPage.push(placed);
        }
      };
      for (const column of zeroList(data.columns)) {
        let at = columnAt.get(column.id);
        if (at === undefined) {
          at = target.columns.length;
          columnAt.set(column.id, at);
          target.columns.push({ id: column.id, name: column.name, tasks: [] });
        }
        place(zeroList(column.tasks), target.columns[at]!.tasks);
      }
      for (const column of OFF_BOARD) {
        place(zeroList(column.tasks(data)), offBoard.get(column.id)!);
      }
    }
    stopped = stopAt?.(onPage);
  }

  if (board === undefined || board.projectId === "") {
    throw new Error(`board ${projectId}: the server answered without a project`);
  }
  for (const column of OFF_BOARD) {
    const tasks = offBoard.get(column.id)!;
    if (tasks.length > 0) board.columns.push({ id: column.id, name: column.name, tasks });
  }
  return { board, stopped, moved: first !== undefined && first !== last };
};

// Every task the listing answered, the planned and the archived ones included,
// most urgent first and then by task number.
export const projectTasks = (board: Board): Task[] => byPriority(board.columns);

// The tasks on the board: the same list without the two columns that are none of
// the project's, since neither a planned task nor an archived one is work a
// board is showing.
export const boardTasks = (board: Board): Task[] => byPriority(board.columns.filter((c) => !isOffBoard(c)));

const byPriority = (columns: Board["columns"]): Task[] =>
  columns
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
  startDate: isoTimePtr("startDate", from.startDate),
  dueDate: isoTimePtr("dueDate", from.dueDate),
  createdAt: isoTime("createdAt", from.createdAt),
  labels: extra.labels,
});

// The board listing, the only route that resolves the assignee's name and carries
// the labels.
//
// A description above 64 KiB is left out of that listing and the task says so
// with descriptionDeferred, which only the task detail route answers in full.
// The flag is held beside the task rather than in it, so printing a task does
// not grow a field that is only ever true of some of them.
const deferredDescriptions = new WeakSet<Task>();

export const descriptionDeferred = (task: Task): boolean => deferredDescriptions.has(task);

const toTask = (t: BoardTask): Task => {
  const read = task(t, { assigneeId: t.assigneeId, assigneeName: t.assigneeName, labels: labels(t.labels) });
  if (t.descriptionDeferred === true) deferredDescriptions.add(read);
  return read;
};

// Fetches one task by id, with its assignee's name resolved. Labels are not part
// of the reply, so they read as null.
export const getTask = async (taskId: string): Promise<Task> => {
  const t = zeroRecord(await readTask(pathParam(taskId)));
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
    await postTask(pathParam(projectId), {
      title: wanted.title,
      description: wanted.description,
      ...(wanted.dueDate === "" ? {} : { dueDate: wanted.dueDate }),
      priority: unchecked<CreateTaskBody["priority"]>(wanted.priority === "" ? "medium" : wanted.priority),
      status: wanted.status === "" ? "to-do" : wanted.status,
      ...(wanted.assigneeId === "" ? {} : { userId: wanted.assigneeId }),
    }),
  );
  return task(created, { assigneeId: created.userId, assigneeName: null, labels: null });
};

// Moves a task to another column.
//
// The dedicated endpoint is used rather than PUT /task/{id}, which requires
// every field and answers 400 when used for a partial update.
export const setTaskStatus = async (taskId: string, status: string): Promise<void> => {
  await updateTaskStatus(pathParam(taskId), { status });
};

export const setTaskPriority = async (taskId: string, priority: string): Promise<void> => {
  await updateTaskPriority(pathParam(taskId), { priority: unchecked<UpdateTaskPriorityBody["priority"]>(priority) });
};

// Renames a task.
export const setTaskTitle = async (taskId: string, title: string): Promise<void> => {
  await updateTaskTitle(pathParam(taskId), { title });
};

// Replaces a task's description. An empty description is how it is cleared: the
// endpoint takes the string as it is.
export const setTaskDescription = async (taskId: string, description: string): Promise<void> => {
  await updateTaskDescription(pathParam(taskId), { description });
};

// Assigns a task to a user, or clears the assignee when userId is empty.
export const setTaskAssignee = async (taskId: string, userId: string): Promise<void> => {
  await updateTaskAssignee(pathParam(taskId), { userId: userId === "" ? null : userId });
};

export const moveTask = async (taskId: string, projectId: string): Promise<void> => {
  await putTaskMove(pathParam(taskId), { destinationProjectId: projectId });
};

export const deleteTask = async (taskId: string): Promise<void> => {
  await removeTask(pathParam(taskId));
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
  zeroList(await getTaskComments(pathParam(taskId))).map((c) => ({
    id: c.id ?? "",
    content: c.content ?? "",
    userId: c.userId ?? "",
    userName: c.user?.name ?? "",
    createdAt: isoTime("createdAt", c.createdAt),
  }));

// Posts a comment on a task. The server answers with the stored activity row,
// which carries no author, so the reply's name is empty and a caller that needs
// one reads the listing back.
export const addComment = async (taskId: string, content: string): Promise<Comment> => {
  const a = zeroRecord(await createTaskComment(pathParam(taskId), { content }));
  return {
    id: a.id ?? "",
    content: a.content ?? "",
    userId: a.userId ?? "",
    userName: "",
    createdAt: isoTime("createdAt", a.createdAt),
  };
};

// Deletes a comment. An id that does not exist answers 400, since its
// workspace cannot be found. Someone else's comment answers 404: the server
// looks only among the caller's own. A key without task:update answers 403.
export const deleteComment = async (commentId: string): Promise<void> => {
  await deleteTaskComment(pathParam(commentId));
};

// Rewrites a comment's text. The reply carries no author name, so the comment
// as listed is returned with its new text.
//
// A write the server did not echo back is reported, as with updateProject: an
// empty 2xx would otherwise read as an edit. It may still have been stored, so
// the message says where to look.
export const editComment = async (comment: Comment, content: string): Promise<Comment> => {
  const a = zeroRecord(await updateTaskComment(pathParam(comment.id), { content }));
  if (a.id !== comment.id || a.content !== content) {
    throw new Error(`/comment/${comment.id}: server did not echo the edit; check \`kaneo comment ls\``);
  }
  return { ...comment, content: a.content };
};

// One entry of a task's history: a comment, or an event such as a status
// change, whose details are in eventData rather than in content.
export type Activity = {
  id: string;
  type: string;
  content: string;
  eventData: Json;
  userId: string;
  createdAt: string;
};

const activity = (a: GenActivity): Activity => ({
  id: a.id ?? "",
  type: a.type ?? "",
  content: a.content ?? "",
  // It came off the wire as JSON, so it is JSON.
  eventData: (a.eventData ?? null) as Json,
  userId: a.userId ?? "",
  createdAt: isoTime("createdAt", a.createdAt),
});

// A task's history, oldest first like its comments. The server sends it newest
// first.
export const listActivities = async (taskId: string): Promise<Activity[]> =>
  zeroList(await getActivities(pathParam(taskId))).map(activity).reverse();

// Records an event on a task, the way an importer writes one. An empty message
// is sent as null, which is how the server stores an event that has none.
//
// The pinned document's body. A server before Kaneo 2.23.0 also requires
// userId and answers 400 without it; that is left to fail rather than sent,
// since this client targets the pinned release.
export const addActivity = async (
  taskId: string,
  type: string,
  message: string,
  eventData: Record<string, unknown> | null,
): Promise<Activity> => {
  const a = zeroRecord(await createActivity({ taskId, type, message: message === "" ? null : message, eventData }));
  if (!a.id || a.taskId !== taskId || a.type !== type) {
    throw new Error("/activity/create: server did not echo the event; check `kaneo activity ls`");
  }
  return activity(a);
};

// Time logged against a task. endTime and duration are null while the entry is
// still running; duration is in seconds. userId is null once the user who
// logged it has been removed.
export type TimeEntry = {
  id: string;
  taskId: string;
  userId: string | null;
  description: string;
  startTime: string;
  endTime: string | null;
  duration: number | null;
};

// The task listing is the one route that resolves who logged an entry, so the
// name is only part of what it answers. A missing name is null, which is how
// the server reports a user it no longer has.
export type ListedTimeEntry = TimeEntry & { userName: string | null };

const timeEntry = (t: GenTimeEntry): TimeEntry => ({
  id: t.id ?? "",
  taskId: t.taskId ?? "",
  userId: t.userId ?? null,
  description: t.description ?? "",
  startTime: isoTime("startTime", t.startTime),
  endTime: isoTimePtr("endTime", t.endTime),
  duration: t.duration ?? null,
});

// A task's time entries, in the order the server lists them (by start).
export const listTimeEntries = async (taskId: string): Promise<ListedTimeEntry[]> =>
  zeroList(await getTaskTimeEntries(pathParam(taskId))).map((t) => ({
    ...timeEntry(t),
    userName: t.userName ?? null,
  }));

export const getTimeEntryById = async (entryId: string): Promise<TimeEntry> =>
  timeEntry(zeroRecord(await getTimeEntry(pathParam(entryId))));

// What v2.29.2 accepts as a time entry timestamp (apps/api/src/time-entry/
// schema.ts), term for term: ISO 8601 with an offset, on a date the calendar
// has. It is checked here because releases before v2.23 take any string and
// hand it to new Date(), which stores a time without an offset in the server's
// own zone, so a mistyped time would be written rather than refused.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

export const checkTimestamp = (field: string, value: string): string => {
  const [year, month, day] = [value.slice(0, 4), value.slice(5, 7), value.slice(8, 10)].map(Number) as [number, number, number];
  // Date.parse rolls an impossible date over (2026-02-30 reads as March 2), so
  // the date is rebuilt and compared. A roll-over changes both the month and
  // the day, so either comparison alone catches it and a test cannot tell them
  // apart; all three are kept so the check stays upstream's term for term.
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  const valid =
    ISO_TIMESTAMP.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day;
  if (!valid) {
    throw new Error(`${field} ${JSON.stringify(value)} is not a real date and time in ISO 8601 with an offset, such as 2026-01-31T09:00:00Z`);
  }
  return value;
};

// A write the server did not echo back is not reported as done, whatever its
// status: it may well have happened, but printing an entry with no id as the
// one just written would claim more than the reply said.
const echoed = (entry: TimeEntry, route: string, wantId?: string): TimeEntry => {
  if (entry.id === "" || (wantId !== undefined && entry.id !== wantId)) {
    throw new Error(`${route}: server answered with time entry ${JSON.stringify(entry.id)}; the write is not confirmed`);
  }
  return entry;
};

// Logs time against a task. Without an end the entry is a running timer, closed
// later by an update that sets one.
export const addTimeEntry = async (
  taskId: string,
  wanted: { startTime: string; endTime?: string; description: string },
): Promise<TimeEntry> =>
  echoed(
    timeEntry(
      zeroRecord(
        await createTimeEntry({
          taskId,
          startTime: checkTimestamp("start", wanted.startTime),
          ...(wanted.endTime === undefined ? {} : { endTime: checkTimestamp("end", wanted.endTime) }),
          ...(wanted.description === "" ? {} : { description: wanted.description }),
        }),
      ),
    ),
    "/time-entry",
  );

// An entry read in order to write its start back. A reply that decoded to no
// entry, or to another one, would move the entry to 0001-01-01 (what isoTime
// makes of a missing timestamp) or to a stranger's start, so it is refused.
const readForWrite = async (entryId: string): Promise<TimeEntry> => {
  const read = await getTimeEntryById(entryId);
  if (read.id !== entryId || read.startTime === ZERO_TIME) {
    throw new Error(`reading time entry ${entryId} before the update got id ${JSON.stringify(read.id)}, start ${read.startTime}; not writing`);
  }
  return read;
};

// Changes the fields given and keeps the rest.
//
// The document calls the update a replace, but the controller keeps the stored
// endTime and description when the body leaves them out, from v2.18 through
// v2.29.2 (apps/api/src/time-entry/controllers/update-time-entry.ts). startTime
// is the one field it requires, so it is read back from the entry when not
// given. An end, once set, cannot be cleared through this route.
//
// Because the start has to be sent, a change made to it elsewhere between the
// read and the write is overwritten.
export const updateTimeEntryById = async (
  entryId: string,
  changes: { startTime?: string; endTime?: string; description?: string },
): Promise<TimeEntry> => {
  if (changes.endTime !== undefined) checkTimestamp("end", changes.endTime);
  const startTime =
    changes.startTime === undefined ? (await readForWrite(entryId)).startTime : checkTimestamp("start", changes.startTime);
  return putTimeEntry(entryId, { ...changes, startTime });
};

const putTimeEntry = async (
  entryId: string,
  body: { startTime: string; endTime?: string; description?: string },
): Promise<TimeEntry> =>
  echoed(
    timeEntry(
      zeroRecord(
        await updateTimeEntry(pathParam(entryId), {
          startTime: body.startTime,
          ...(body.endTime === undefined ? {} : { endTime: body.endTime }),
          ...(body.description === undefined ? {} : { description: body.description }),
        }),
      ),
    ),
    `/time-entry/${entryId}`,
    entryId,
  );

// Ends a running entry. One that already had an end when it was read is
// refused rather than moved to the new one: stopping twice is a slip, and an
// end set elsewhere is somebody's record. An end set between the read and the
// write is overwritten, as with any update.
export const stopTimeEntry = async (entryId: string, endTime: string): Promise<TimeEntry> => {
  const read = await readForWrite(entryId);
  if (read.endTime !== null) {
    throw new Error(`time entry ${entryId} already stopped at ${read.endTime}; change its end with \`kaneo time update ${JSON.stringify(entryId)} --end <time>\``);
  }
  return putTimeEntry(entryId, { startTime: read.startTime, endTime });
};

// The links the server accepts between two tasks.
export const RELATION_TYPES = ["subtask", "blocks", "related"];

// What the listing says about a task at one end of a link: enough to name it the
// way the board does. Null when the server sends none, which the document allows;
// a blank object would read as task #0.
export type RelationTask = { id: string; number: number | null; title: string; status: string; projectId: string };

// A link between two tasks.
export type Relation = {
  id: string;
  sourceTaskId: string;
  targetTaskId: string;
  relationType: string;
  sourceTask: RelationTask | null;
  targetTask: RelationTask | null;
};

// Relates two tasks. For a subtask link, source is the parent.
//
// The create reply carries neither summary of the two tasks, so both stay null
// here; a caller holding the two tasks fills them in.
export const linkTasks = async (
  sourceTaskId: string,
  targetTaskId: string,
  relationType: string,
): Promise<Relation> =>
  relation(
    zeroRecord(
      await createTaskRelation({
        sourceTaskId,
        targetTaskId,
        relationType: unchecked<CreateTaskRelationBody["relationType"]>(relationType),
      }),
    ),
  );

// A task's links, as both endpoints of the link.
export const listRelations = async (taskId: string): Promise<Relation[]> =>
  zeroList(await getTaskRelations(pathParam(taskId))).map(relation);

// Removes one link and answers with the relation as the server held it, which
// like a creation reply has no summaries.
export const deleteRelation = async (relationId: string): Promise<Relation> =>
  relation(zeroRecord(await removeRelation(pathParam(relationId))));

// The listing answers with a summary of each linked task as well, which is what
// lets a link be shown by number rather than by id.
const relation = (r: GenRelation | TaskRelationWithTasks): Relation => ({
  id: r.id ?? "",
  sourceTaskId: r.sourceTaskId ?? "",
  targetTaskId: r.targetTaskId ?? "",
  relationType: r.relationType ?? "",
  sourceTask: relationTask((r as TaskRelationWithTasks).sourceTask),
  targetTask: relationTask((r as TaskRelationWithTasks).targetTask),
});

const relationTask = (t: RelatedTask | null | undefined): RelationTask | null =>
  t === null || t === undefined
    ? null
    : { id: t.id ?? "", number: t.number ?? null, title: t.title ?? "", status: t.status ?? "", projectId: t.projectId ?? "" };

// The summary a relation carries for a task already in hand.
export const taskSummary = (t: Task): RelationTask => ({
  id: t.id,
  number: t.number,
  title: t.title,
  status: t.status,
  projectId: t.projectId,
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
  createdAt: isoTime("createdAt", n.createdAt),
});

// The newest 50 notifications, read and unread, newest first: the server caps
// the listing there and takes no page.
export const listNotifications = async (): Promise<Notification[]> =>
  zeroList(await getNotifications()).map(notification);

export const markNotificationRead = async (id: string): Promise<Notification> =>
  notification(zeroRecord(await markNotificationAsRead(pathParam(id))));

export const markAllNotificationsRead = async (): Promise<void> => {
  await markAllNotificationsAsRead();
};

export const clearNotifications = async (): Promise<void> => {
  await clearAllNotifications();
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
  const created = await postNotification(body);
  return created === null || created === undefined ? null : notification(created);
};

// How the key's user is notified. Secrets come back as booleans and a masked
// preview only, so the record is passed on as the server sent it.
export type NotificationPreferences = GenNotificationPreferences;
export type NotificationPreferenceChanges = UpdateNotificationPreferencesBody;
export type WorkspaceRule = UpsertNotificationPreferenceWorkspaceRuleBody;

export const getNotificationPreferences = async (): Promise<NotificationPreferences> =>
  zeroRecord(await readNotificationPreferences());

// Only the fields in changes are sent. The server leaves the other settings
// alone, but carries a channel switch into the active workspace rules that have
// a channel on.
export const updateNotificationPreferences = async (
  changes: NotificationPreferenceChanges,
): Promise<NotificationPreferences> => zeroRecord(await putNotificationPreferences(changes));

// Replaces a workspace's rule whole: the server takes every field or none.
export const setWorkspaceRule = async (workspaceId: string, rule: WorkspaceRule): Promise<NotificationPreferences> =>
  zeroRecord(await upsertNotificationPreferenceWorkspaceRule(pathParam(workspaceId), rule));

export const removeWorkspaceRule = async (workspaceId: string): Promise<NotificationPreferences> =>
  zeroRecord(await deleteNotificationPreferenceWorkspaceRule(pathParam(workspaceId)));

// A label as the label routes return it. The server keeps two kinds of row
// under one table: a workspace label (taskId null), which is what the web app
// offers to pick from, and a copy of it on each task it is attached to, with
// the same name and its own id. Attaching inserts a copy and detaching deletes
// one, so the workspace label itself never moves.
export type LabelRecord = Label & {
  taskId: string | null;
  workspaceId: string | null;
  createdAt: string;
  updatedAt: string;
  // Set once a deletion has started and not yet finished; the server refuses
  // to attach or change such a label, and the same delete resumes it.
  deletionStartedAt: string | null;
};

const labelRecord = (l: GenLabel): LabelRecord => ({
  id: l.id ?? "",
  name: l.name ?? "",
  color: l.color ?? "",
  taskId: l.taskId ?? null,
  workspaceId: l.workspaceId ?? null,
  createdAt: isoTime("createdAt", l.createdAt),
  updatedAt: isoTime("updatedAt", l.updatedAt),
  deletionStartedAt: isoTimePtr("deletionStartedAt", l.deletionStartedAt),
});

// Every label row in a workspace, the task copies included; the caller picks
// out the workspace labels when that is what it wants.
export const listWorkspaceLabels = async (workspaceId: string): Promise<LabelRecord[]> =>
  zeroList(await getWorkspaceLabels(pathParam(workspaceId))).map(labelRecord);

// The copies attached to one task.
export const listTaskLabels = async (taskId: string): Promise<LabelRecord[]> =>
  zeroList(await getTaskLabels(pathParam(taskId))).map(labelRecord);

export const getLabel = async (labelId: string): Promise<LabelRecord> =>
  labelRecord(zeroRecord(await readLabel(pathParam(labelId))));

// Creates a workspace label. The server answers with the existing one when the
// name is already taken in the workspace rather than failing, so creating is
// safe to repeat.
export const createLabel = async (workspaceId: string, name: string, color: string): Promise<LabelRecord> => {
  const wanted = name.trim();
  if (wanted === "") throw new Error("label name is empty");
  if (color.trim() === "") throw new Error("label color is empty");
  return labelRecord(zeroRecord(await postLabel({ name: wanted, color, workspaceId })));
};

export type LabelChanges = { name?: string; color?: string };

// Changes a label's name or color and keeps the other. The server's update
// takes both, so the label is read first and the field not asked for is sent
// back as read. On a workspace label the server carries the change to every
// task copy, which is what renaming a label means in the web app as well.
export const updateLabel = async (
  labelId: string,
  changes: LabelChanges,
): Promise<{ before: LabelRecord; after: LabelRecord }> => {
  const name = changes.name?.trim();
  if (name === "") throw new Error("label name is empty");
  if (changes.color?.trim() === "") throw new Error("label color is empty");
  const before = await getLabel(labelId);
  // A read that decoded to nothing would write a blank name back.
  if (before.id !== labelId || before.name === "") {
    throw new Error(`reading label ${labelId} before the update got id ${quoted(before.id)}, name ${quoted(before.name)}; not writing`);
  }
  const after = labelRecord(
    zeroRecord(
      await putLabel(pathParam(labelId), { name: name ?? before.name, color: changes.color ?? before.color }),
    ),
  );
  return { before, after };
};

// Deletes a label. A workspace label takes its task copies with it, and the
// server removes those 25 at a time: it answers 202 with pendingDeletion until
// the last batch, and the same request resumes where the previous one stopped.
// So the request is repeated until the server says it is done. A server older
// than the batching answers 200 the first time, which ends the loop at once.
//
// 429 means the server's few deletion slots are taken, or another client is
// deleting this label right now; it asks to retry after a second. That is
// retried the way the web app does, five times in a row at most, the count
// starting over after each batch that went through.
export const deleteLabel = async (labelId: string): Promise<LabelRecord> => {
  const id = pathParam(labelId);
  // The last batch's answer: the label as it stood once a batch went through.
  let last: GenLabel | undefined;
  let busy = 0;
  for (;;) {
    let reply: GenLabel | (GenLabel & { pendingDeletion: true });
    try {
      reply = zeroRecord(await removeLabel(id));
    } catch (e) {
      const status = e instanceof KaneoApiError ? e.statusCode : 0;
      if (status === 429 && busy < LABEL_DELETE_BUSY_RETRIES) {
        busy++;
        await Bun.sleep(LABEL_DELETE_BUSY_WAIT_MS);
        continue;
      }
      // Another client finished this deletion while this one waited: the
      // label is gone, which the server reports as an id it cannot place
      // (400) or, past that check, as not found (404).
      if (last !== undefined && (status === 400 || status === 404)) return labelRecord(last);
      // The server starts deleting inside the first request, before it
      // answers, and keeps what it did; the same request resumes from there.
      // Only a refusal on the first request (a 4xx, which the server gives
      // before touching the label) means nothing changed.
      if (last === undefined && status >= 400 && status < 500) throw e;
      const hint = `; the label may be partly deleted, run \`kaneo label rm ${labelId} --yes\` again to finish`;
      if (e instanceof Error) {
        e.message += hint;
        throw e;
      }
      throw new Error(`${String(e)}${hint}`);
    }
    if (!("pendingDeletion" in reply && reply.pendingDeletion === true)) return labelRecord(reply);
    last = reply;
    busy = 0;
  }
};

// The web app's numbers (apps/web/src/fetchers/label/delete-label.ts, v2.29.2);
// the server's 429 carries Retry-After: 1.
const LABEL_DELETE_BUSY_RETRIES = 5;
const LABEL_DELETE_BUSY_WAIT_MS = 1000;

// Attaches a label to a task, which inserts a copy of it on the task and
// answers with that copy. Attaching a label the task already carries answers
// with the copy it has.
export const attachLabel = async (labelId: string, taskId: string): Promise<LabelRecord> =>
  labelRecord(zeroRecord(await attachLabelToTask(pathParam(labelId), { taskId })));

// Detaches a task copy, which deletes it. The id is the copy's, not the
// workspace label's: the server answers 400 for a label on no task.
export const detachLabel = async (copyId: string): Promise<LabelRecord> =>
  labelRecord(zeroRecord(await detachLabelFromTask(pathParam(copyId))));

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
  const document = zeroRecord(await kaneoFetch<Document>("/openapi", { method: "GET" }));
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

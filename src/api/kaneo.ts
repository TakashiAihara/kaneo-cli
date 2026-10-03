import { OPERATIONS, type Operation } from "./registry";
import { kaneoFetch, KaneoApiError } from "./http";
import { listOrganization, listProjects, listTasks, updateOrganization } from "./gen/kaneo";
import type { BoardTask, Organization, ProjectListItem, TaskLabel } from "./gen/model";

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
const call = async <T>(pending: Promise<T>): Promise<T> => {
  try {
    return await pending;
  } catch (e) {
    if (e instanceof KaneoApiError) {
      throw new KaneoApiError(
        e.method,
        e.path.startsWith("/api") ? e.path : `/api${e.path}`,
        e.statusCode,
        e.messages,
        e.body,
      );
    }
    throw e;
  }
};

// The server writes timestamps the way JavaScript's toISOString does — UTC,
// milliseconds — so a time read and printed again comes out as the server sent
// it. A timestamp written any other way is shown as the same instant in that
// form.
const isoTime = (value: string | null | undefined): string => {
  const at = Date.parse(value ?? "");
  return Number.isNaN(at) ? (value ?? "") : new Date(at).toISOString();
};

// The same, for a field that is a timestamp or nothing at all. An absent one
// stays absent rather than becoming an empty string, because a task with no due
// date and a task due at the epoch are not the same fact.
const isoTimePtr = (value: string | null | undefined): string | null =>
  value === null || value === undefined ? null : isoTime(value);

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
  (await call(listOrganization())).map((org) => workspace(org));

const workspace = (org: Organization): Workspace => ({ id: org.id, name: org.name, slug: org.slug });

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
  const renamed = await call(updateOrganization({ organizationId: workspaceId, data: { name: wanted } }));
  if (renamed.id !== workspaceId || renamed.name !== wanted) {
    throw new Error(
      `/auth/organization/update: server answered with workspace ${JSON.stringify(renamed.id)} named ${JSON.stringify(renamed.name)}`,
    );
  }
  return workspace(renamed);
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
export const listProjectsIn = async (workspaceId: string, includeArchived: boolean): Promise<Project[]> =>
  (await call(
    listProjects({ workspaceId, ...(includeArchived ? { includeArchived: "true" } : {}) }),
  )).map(project);

const project = (item: ProjectListItem): Project => ({
  id: item.id,
  name: item.name,
  slug: item.slug,
  icon: item.icon ?? "",
  description: item.description ?? "",
  workspaceId: item.workspaceId,
  isPublic: item.isPublic ?? false,
  archivedAt: isoTimePtr(item.archivedAt),
});

export type Label = { id: string; name: string; color: string };

// A single work item, as every route that returns one agrees on it.
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
  labels: Label[];
};

// Priorities the server accepts, most urgent first. An unknown value sorts last.
const PRIORITIES = ["urgent", "high", "medium", "low", "no-priority"];

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
// Two levels of paging, as v2.29.2 serves the listing:
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
export const getBoard = async (projectId: string): Promise<Board> => {
  let board: Board | undefined;
  const columnAt = new Map<string, number>();
  const taskAt = new Map<string, { column: number; task: number }>();

  for (let page = 1, pages = 1; page <= pages; page++) {
    for (let related = 1, relatedPages = 1; related <= relatedPages; related++) {
      const response = await call(
        listTasks(projectId, {
          ...(page > 1 ? { page } : {}),
          ...(related > 1 ? { relatedPage: related } : {}),
        }),
      );
      pages = response.pagination.totalPages;
      relatedPages = response.pagination.relatedTotalPages;

      if (board === undefined) {
        board = { projectId: response.data.id, projectName: response.data.name, columns: [] };
      }
      const target = board;
      for (const column of response.data.columns) {
        let at = columnAt.get(column.id);
        if (at === undefined) {
          at = target.columns.length;
          columnAt.set(column.id, at);
          target.columns.push({ id: column.id, name: column.name, tasks: [] });
        }
        for (const task of column.tasks) {
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
const appendNewLabels = (have: Label[], more: Label[]): Label[] => {
  const seen = new Set(have.map((label) => label.id));
  for (const label of more) if (!seen.has(label.id)) have.push(label);
  return have;
};

const labels = (from: TaskLabel[]): Label[] => from.map((l) => ({ id: l.id, name: l.name, color: l.color }));

const toTask = (t: BoardTask): Task => ({
  id: t.id,
  number: t.number ?? 0,
  title: t.title,
  description: t.description ?? "",
  status: t.status,
  priority: t.priority,
  position: t.position ?? 0,
  projectId: t.projectId,
  assigneeId: t.assigneeId ?? null,
  assigneeName: t.assigneeName ?? null,
  startDate: isoTimePtr(t.startDate),
  dueDate: isoTimePtr(t.dueDate),
  createdAt: isoTime(t.createdAt),
  labels: labels(t.labels),
});

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
  const document = await call(kaneoFetch<Document>("/openapi", { method: "GET" }));
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

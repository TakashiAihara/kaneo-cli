import { OPERATIONS, type Operation } from "./registry";
import {
  clientShapes,
  requestDrift,
  requestShapes,
  serverOperations,
  type Drift,
  type RequestShape,
  type ServerOperation,
} from "./shape";
import pinnedRequests from "./gen/requests.json";
import pinnedOperations from "./gen/spec-operations.json";
import { kaneoFetch, KaneoApiError, originOf, presignedPut } from "./http";
import type { Json } from "../output/json";
import { shellWord } from "../output/output";
import {
  archiveProject,
  clearAllNotifications,
  createGenericWebhookIntegration as postGenericWebhook,
  createMattermostIntegration as postMattermost,
  createNotification as postNotification,
  createColumn as postColumn,
  createActivity,
  getActivities,
  updateTaskComment,
  attachLabelToTask,
  createLabel as postLabel,
  deleteGenericWebhookIntegration as removeGenericWebhook,
  deleteLabel as removeLabel,
  deleteMattermostIntegration as removeMattermost,
  detachLabelFromTask,
  getGenericWebhookIntegration as readGenericWebhookIntegration,
  getLabel as readLabel,
  getMattermostIntegration as readMattermostIntegration,
  getTaskLabels,
  getWorkspaceLabels,
  updateGenericWebhookIntegration as patchGenericWebhook,
  updateLabel as putLabel,
  updateMattermostIntegration as patchMattermost,
  createProject as postProject,
  createTask as postTask,
  createCalendarFeed as postCalendarFeed,
  createTaskComment,
  bulkUpdateTasks,
  createDiscordIntegration as postDiscordIntegration,
  createSlackIntegration as postSlackIntegration,
  createTelegramIntegration as postTelegramIntegration,
  createTaskRelation,
  deleteDiscordIntegration as removeDiscordIntegration,
  createExternalLink as postExternalLink,
  deleteExternalLink as removeExternalLink,
  deleteNotificationPreferenceWorkspaceRule,
  deleteSlackIntegration as removeSlackIntegration,
  deleteTelegramIntegration as removeTelegramIntegration,
  deleteColumn as removeColumn,
  createTimeEntry,
  deleteProject as removeProject,
  deleteProjectBackground as removeProjectBackground,
  deleteTask as removeTask,
  duplicateTask as postDuplicate,
  createTaskImageUpload,
  finalizeTaskImageUpload,
  getNotificationPreferences as readNotificationPreferences,
  deleteTaskComment,
  deleteGiteaIntegration as removeGiteaIntegration,
  deleteTaskRelation as removeRelation,
  deleteWorkflowRule as removeRule,
  exportTasks as readExport,
  getColumns as readColumns,
  getCalendarFeed as readCalendarFeed,
  getCurrentUser,
  getGiteaIntegration as readGiteaIntegration,
  getInvitationDetails,
  getWorkspaceMembers,
  globalSearch,
  getExternalLinksByTask as readExternalLinks,
  getProject as readProject,
  getProjectBackground as readProjectBackground,
  getTask as readTask,
  getTaskByTicketId as readTaskByTicketId,
  getTaskDescriptionPage as readDescriptionPage,
  findDeferredTaskDescriptions as searchDescriptionMatches,
  getTaskComments,
  getTaskRelations,
  listNotifications as getNotifications,
  listCalendarFeeds as readCalendarFeeds,
  getDiscordIntegration as readDiscordIntegration,
  getSlackIntegration as readSlackIntegration,
  getTelegramIntegration as readTelegramIntegration,
  getTaskTimeEntries,
  getTimeEntry,
  getWorkflowRules as readRules,
  getCustomFieldsByProject as readCustomFields,
  getCustomFieldValuesByProject as readProjectFieldValues,
  getCustomFieldValuesByTask as readTaskFieldValues,
  getCustomFieldFilterValues as readFieldFilterValues,
  createCustomField as postCustomField,
  reorderCustomFields as putFieldOrder,
  setCustomFieldValue as putFieldValue,
  deleteCustomField as removeCustomField,
  listGitlabProjects as postGitlabProjects,
  verifyGitlabAccess as postGitlabVerify,
  getGitlabIntegration as readGitlabIntegration,
  createGitlabIntegration as postGitlabIntegration,
  updateGitlabIntegration as patchGitlabIntegration,
  deleteGitlabIntegration as removeGitlabIntegration,
  importGitlabIssues as postGitlabImport,
  importGiteaIssues as postGiteaImport,
  importTasks as postImport,
  listGiteaRepositories as postGiteaRepositories,
  listOrganization,
  listProjects,
  listAssignedTasks,
  listTasks,
  markAllNotificationsAsRead,
  markNotificationAsRead,
  createGiteaIntegration as postGiteaIntegration,
  moveProject as putProjectMove,
  moveTask as putTaskMove,
  finalizeProjectBackgroundUpload as postProjectBackgroundFinalize,
  reorderColumns as putColumns,
  reorderProjects as putProjects,
  revokeCalendarFeed as removeCalendarFeed,
  unarchiveProject,
  updateGiteaIntegration as patchGiteaIntegration,
  uploadProjectBackground as putProjectBackgroundUpload,
  updateDiscordIntegration as patchDiscordIntegration,
  updateNotificationPreferences as putNotificationPreferences,
  updateSlackIntegration as patchSlackIntegration,
  updateTelegramIntegration as patchTelegramIntegration,
  updateColumn as putColumn,
  updateOrganization,
  updateProject as putProject,
  upsertNotificationPreferenceWorkspaceRule,
  updateTaskAssignee,
  updateTaskDescription,
  updateTaskDueDate,
  updateTask as putTask,
  updateTaskPriority,
  updateTaskStatus,
  updateTaskTitle,
  updateTimeEntry,
  upsertWorkflowRule as putRule,
  createGitHubIntegration as postGitHubIntegration,
  deleteGitHubIntegration as removeGitHubIntegration,
  getGitHubAppInfo as readGitHubAppInfo,
  getGitHubIntegration as readGitHubIntegration,
  importGitHubIssues as postGitHubIssueImport,
  listGitHubRepositories as readGitHubRepositories,
  updateGitHubIntegration as patchGitHubIntegration,
  verifyGitHubInstallation as postGitHubVerification,
  getInstanceStatus as readInstanceStatus,
  getConfig as readInstanceConfig,
  getPublicProject as readPublicProject,
  getPublicProjectDescriptionPage as readPublicDescription,
  getPublicTaskDescriptionPage as readPublicTaskDescription,
  getAsset as readAsset,
  getUserAvatar as readAvatar,
  uploadUserAvatar as putAvatar,
  deleteUserAvatar as removeAvatar,
  verifyGiteaAccess as postGiteaVerify,
} from "./gen/kaneo";
import type {
  Board as GenBoard,
  BoardPagination,
  BoardTask,
  CalendarFeed as GenCalendarFeed,
  CreateGiteaIntegrationBody,
  CreateGenericWebhookIntegrationBody,
  CreateMattermostIntegrationBody,
  Config as GenConfig,
  CreateNotificationBody,
  BulkUpdateTasksBody,
  Column as GenColumn,
  CreateTaskBody,
  DiscordIntegration as GenDiscordIntegration,
  GiteaDeleteResult as GenGiteaDeleteResult,
  GiteaImportResult as GenGiteaImportResult,
  GiteaIntegration as GenGiteaIntegration,
  GiteaRepository as GenGiteaRepository,
  GiteaVerificationResult as GenGiteaVerificationResult,
  GenericWebhookEvents as GenGenericWebhookEvents,
  GenericWebhookIntegration as GenGenericWebhookIntegration,
  IntegrationEvents as GenIntegrationEvents,
  MattermostIntegration as GenMattermostIntegration,
  Notification as GenNotification,
  NotificationPreferences as GenNotificationPreferences,
  CreateTaskRelationBody,
  Activity as GenActivity,
  CreateGitlabIntegrationBody,
  GitlabIntegration as GenGitlabIntegration,
  GitlabProject as GenGitlabProject,
  GitlabVerificationResult as GenGitlabVerificationResult,
  GlobalSearchParams,
  Label as GenLabel,
  ListGitlabProjectsBody,
  UpdateGitlabIntegrationBody,
  VerifyGitlabAccessBody,
  ExternalLink as GenExternalLink,
  GetPublicProjectParams,
  ImportTasksBody,
  InstanceStatus as GenInstanceStatus,
  Organization,
  TaskDescriptionPage as GenDescriptionPage,
  SlackIntegration as GenSlackIntegration,
  TaskExport,
  ProjectListItem,
  RelatedTask,
  TaskLabel,
  Task as GenTask,
  TaskRelation as GenRelation,
  TaskRelationWithTasks,
  CustomFieldDefinition as GenFieldDefinition,
  CustomFieldValue as GenFieldValue,
  SetCustomFieldValueResponse as GenFieldSettingReply,
  CreateCustomFieldBody,
  TelegramIntegration as GenTelegramIntegration,
  UpdateGiteaIntegrationBody,
  UpdateGenericWebhookIntegrationBody,
  UpdateMattermostIntegrationBody,
  UpdateNotificationPreferencesBody,
  TimeEntry as GenTimeEntry,
  UpdateTaskBody,
  UpdateTaskPriorityBody,
  UpsertNotificationPreferenceWorkspaceRuleBody,
  UserAvatar as GenUserAvatar,
  UserAvatarDeleted as GenUserAvatarDeleted,
  UploadUserAvatarBody,
  VerifyGiteaAccessBody,
  WorkflowRule as GenWorkflowRule,
  WorkflowRuleRow as GenWorkflowRuleRow,
  CreateGitHubIntegrationBody,
  CreatedGitHubIntegration as GenCreatedGitHubIntegration,
  GitHubInstallation as GenGitHubInstallation,
  GitHubRepository as GenGitHubRepository,
  ImportGitHubIssuesBody,
  IssueImportResult as GenIssueImportResult,
  ListGitHubRepositoriesParams,
  UpdateGitHubIntegrationBody,
  VerifyGitHubInstallationBody,
} from "./gen/model";
import { updateTaskBodyPositionMax } from "./gen/model";

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
export const isoTime = (owner: object, field: string): string => {
  const value = (owner as Record<string, unknown>)[field];
  if (value === null || value === undefined) return ZERO_TIME;
  const at = typeof value === "string" && isRfc3339(value) ? Date.parse(value) : Number.NaN;
  if (!Number.isNaN(at)) return new Date(at).toISOString();
  const shown = Array.from(JSON.stringify(value));
  const request = originOf(owner);
  // Every object a mapper reads came out of a decoded reply, which the transport
  // has recorded. One that did not is a mapping fed something else, and naming
  // no request would hide that.
  if (request === undefined) {
    throw new TimestampError(`${field} is not a timestamp, and no request is recorded for the object that holds it`);
  }
  throw new TimestampError(
    `${request}: ${field} ${shown.length > VALUE_LIMIT ? `${shown.slice(0, VALUE_LIMIT).join("")}...` : shown.join("")} is not a timestamp`,
  );
};

// A reply whose time cannot be read. It is its own type because the call it
// belongs to may be a write that already happened, and a caller that needs to say
// so has to tell this apart from a request that never got through.
export class TimestampError extends Error {}

// Runs a write whose reply is mapped here, and says so when the mapping fails:
// the server has already done what was asked, so a caller who runs it again
// repeats the write. `look` says where to see what was written.
//
// Only task create and comment add are wrapped so far. The other writes whose
// reply is mapped (addActivity, addTimeEntry, createLabel, createProject,
// createColumn, linkTasks, createNotification, setWorkflowRule, ...) still report
// the bare timestamp error, which does not say the write happened.
export const afterWrite = async <T>(done: string, look: string, write: Promise<T>): Promise<T> => {
  try {
    return await write;
  } catch (e) {
    if (e instanceof TimestampError) {
      throw new TimestampError(
        `${done} on the server, but its reply could not be read (${e.message}); do not run it again, that would repeat the write; ${look}`,
        { cause: e },
      );
    }
    throw e;
  }
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
const isoTimePtr = (owner: object, field: string): string | null => {
  const value = (owner as Record<string, unknown>)[field];
  return value === null || value === undefined ? null : isoTime(owner, field);
};

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
export type Workspace = { id: string; name: string; slug: string; description: string };

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
  description: workspaceDescription(org),
});

// Read as Kaneo's settings page reads it (apps/web, settings/workspace/
// general.tsx in v2.32.0): the column, which that page writes, then metadata,
// which the create form writes. better-auth stores metadata as text, so it may
// arrive as the JSON string rather than the object the page expects.
const workspaceDescription = (org: Organization): string => {
  if (typeof org.description === "string") return org.description;
  let metadata = org.metadata;
  if (typeof metadata === "string") {
    try {
      metadata = JSON.parse(metadata);
    } catch {
      return "";
    }
  }
  if (typeof metadata === "object" && metadata !== null && "description" in metadata) {
    return String((metadata as { description?: unknown }).description ?? "");
  }
  return "";
};

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

// The user the API key belongs to. The key's requests carry the user's id
// (Kaneo's authenticate-api-request sets userId from the key), which /user/me
// answers with from v2.28.0; the user's name and email are not on the request,
// which is why routes that read those answer empty for a key.
export type User = { id: string; name: string; email: string };

export const currentUser = async (): Promise<User> => {
  const me = zeroRecord(await getCurrentUser());
  return { id: me.id ?? "", name: me.name ?? "", email: me.email ?? "" };
};

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
            expiresAt: isoTime(i, "expiresAt"),
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
  // The task's number under the name task get and task list give it, so a
  // script reads a task match the way it reads a task. Only a task match has
  // one: on a comment or an activity, taskNumber is the number of the task it
  // is on.
  number: number | null;
  priority: string | null;
  status: string | null;
};

// totalCount is what the server reports, which is not what the document says.
// The document calls it every match before the limit, but v2.29.2 applies the
// limit to each type's query first and counts what those returned, so it is not
// the number of matches; it also counts each repeat of a workspace match (see
// SearchPage), which results do not keep. A full page is the signal that more
// may exist.
type Search = { query: string; results: SearchResult[]; totalCount: number };

// What to search for. type and limit are "" to take the server's defaults (every
// type, 20 results), and projectId is "" to search the whole workspace.
export type SearchQuery = { query: string; workspaceId: string; projectId: string; type: string; limit: string };

// One page of a search, and how many rows the server sent for it. v2.29.2
// repeats each workspace match once per member (it joins the members without
// narrowing them), so the page keeps each match once, and rows — the repeats
// counted — is what says whether the server filled the page.
export type SearchPage = { found: Search; rows: number };

// Searches from one workspace: tasks, comments and activities in it, though the
// server takes workspace matches from every workspace the key can reach. The
// query keys are in sorted order, as every other query this client sends is, so
// a request reads the same however the call was written.
export const search = async (wanted: SearchQuery): Promise<SearchPage> => {
  const reply = zeroRecord(
    await globalSearch({
      ...(wanted.limit === "" ? {} : { limit: wanted.limit }),
      ...(wanted.projectId === "" ? {} : { projectId: wanted.projectId }),
      q: wanted.query,
      ...(wanted.type === "" ? {} : { type: unchecked<NonNullable<GlobalSearchParams["type"]>>(wanted.type) }),
      workspaceId: wanted.workspaceId,
    }),
  );
  const rows = zeroList(reply.results);
  const seen = new Set<string>();
  const kept = rows.filter((r) => {
    const key = `${r.type} ${r.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const found = {
    query: reply.searchQuery ?? "",
    totalCount: reply.totalCount ?? 0,
    results: kept.map((r) => ({
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
      createdAt: isoTime(r, "createdAt"),
      relevanceScore: r.relevanceScore ?? 0,
      taskNumber: r.taskNumber ?? null,
      number: r.type === "task" ? (r.taskNumber ?? null) : null,
      priority: r.priority ?? null,
      status: r.status ?? null,
    })),
  };
  return { found, rows: rows.length };
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

// The active projects in a workspace with the highest task number each has
// issued, which the listing carries and Project leaves out: it says whether a
// number can be on a project's board without reading the board. null where the
// server does not send it (before Kaneo 2.23.0).
export const lastTaskNumbers = async (
  workspaceId: string,
): Promise<{ project: Project; lastTaskNumber: number | null }[]> =>
  zeroList(await listProjects({ workspaceId })).map((item) => ({
    project: project(item),
    lastTaskNumber: item.lastTaskNumber ?? null,
  }));

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

// A project with the creation time the search results are ordered by, which
// Project leaves out: only the search's slug matching reads it.
export type DatedProject = Project & { createdAt: string };

// The projects of a workspace with their creation times, archived included:
// the search endpoint matches archived projects, so the slug matches the CLI
// adds for it have to see them too.
export const listProjectsForSearch = async (workspaceId: string): Promise<DatedProject[]> =>
  zeroList(await listProjects({ includeArchived: "true", workspaceId })).map((item) => ({
    ...project(item),
    createdAt: isoTime(item, "createdAt"),
  }));

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
  archivedAt: isoTimePtr(item, "archivedAt"),
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

// Deletes a project, and answers with it as it was just before it went.
//
// That is the only reading of it there will ever be: the reply is not a listing
// anything could be read back from, so a report has to be built from what this
// returns.
export const deleteProject = async (projectId: string): Promise<Project> =>
  project(zeroRecord(await removeProject(pathParam(projectId))));

// Writes a new order for a workspace's projects, so the answer is the whole
// workspace rather than the one project that moved.
//
// The positions say an order and nothing else: a project left out of the payload
// keeps the rank it had, and the ones named fill the slots around it. Naming a
// subset therefore rearranges those slots rather than moving them somewhere, so
// a caller that means "first" has to send every project. An archived project
// keeps whatever rank it holds there too: the server takes its id in the payload
// like any other, so leaving one out is this client's rule and not the server's.
export const reorderProjects = async (workspaceId: string, projectIds: string[]): Promise<Project[]> =>
  zeroList(await putProjects({ projects: projectIds.map((id, position) => ({ id, position })) }, { workspaceId })).map(
    project,
  );

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
): Promise<{ before: Project; after: Project; unread: string[]; nulled: string[] }> => {
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

  const raw = zeroRecord(await readProject(pathParam(projectId)));
  const before = project(raw);
  // Every field of this read is written back, so a read that decoded to nothing
  // (a null reply, a different shape) would blank the project. An empty slug is
  // not that: it is a state a project can be in, and writing it back is the only
  // way such a project can be changed at all. A field the reply left out, or
  // sent as null, would be written back as "" or false and blank an icon or turn
  // a public project private, and one sent as another type would be written
  // back as that value, so each one sent back has to have been read as its
  // type. Only the description may be null: the server stores NULL there and
  // this client writes it back as "". icon and isPublic are nullable upstream
  // too, but a NULL there has no value to send back.
  const present: Record<"slug" | "description" | "icon" | "isPublic", boolean> = {
    slug: typeof raw.slug === "string",
    description: typeof raw.description === "string" || raw.description === null,
    icon: typeof raw.icon === "string",
    isPublic: typeof raw.isPublic === "boolean",
  };
  const missing = (["slug", "description", "icon", "isPublic"] as const).filter(
    (field) => !present[field] && (field === "isPublic" || changes[field] === undefined),
  );
  const identified = before.id === projectId && before.name !== "";
  if (!identified || missing.length > 0) {
    // The way past is offered only for a read that was this project: a flag does
    // not get a null or foreign reply past the id and name check.
    // isPublic has no flag, so a read that lacks it is stuck whatever else it
    // lacks, and a flag for the other fields would not get it past.
    const stuck = identified && missing.includes("isPublic");
    const flags = identified && !stuck ? missing.map((field) => `--${field} TEXT`) : [];
    // A field the reply left out, sent as null, or sent as another type is
    // named apart from the others, so the refusal says which the server did.
    const absent = missing.filter((field) => raw[field] === undefined);
    const nulled = missing.filter((field) => raw[field] === null);
    const mistyped = missing.filter((field) => raw[field] !== undefined && raw[field] !== null);
    const typed = mistyped.map(
      (field) =>
        `${field} ${JSON.stringify(raw[field])} where the document has ${field === "isPublic" ? "a boolean" : "a string"}`,
    );
    const lacks = `${absent.length > 0 ? `, without ${absent.join(", ")}` : ""}${nulled.length > 0 ? `, with ${nulled.join(", ")} null` : ""}${typed.length > 0 ? `, with ${typed.join(", ")}` : ""}`;
    throw new Error(
      `reading project ${projectId} before the update got id ${JSON.stringify(before.id)}, name ${JSON.stringify(before.name)}${lacks}; not writing${flags.length > 0 ? ` (pass ${flags.join(" ")} to write it yourself)` : ""}${stuck ? "; isPublic has no flag, so this project cannot be updated until the server returns it as a boolean" : ""}`,
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
  // A field the read lacked and the caller supplied is "" in before, which would
  // read as a project that had an empty value there. Of the unread ones, a
  // field the reply sent as null was read — as no value — rather than left
  // out, and the two are said apart.
  const unread = (["slug", "description", "icon"] as const).filter((field) => !present[field]);
  const nulled = unread.filter((field) => raw[field] === null);
  return { before, after, unread, nulled };
};

// Go's %q, which quotes whatever it is given rather than only its strings.
const quoted = (value: string | boolean): string =>
  typeof value === "string" ? JSON.stringify(value) : JSON.stringify(String(value));

// A project moved into another workspace, as the move route answers it: the
// project with its new workspaceId, plus how many of its tasks lost their
// assignee because the assignee is not a member of the workspace it landed in.
export type MovedProject = Project & { unassignedTaskCount: number };

// Moves a project to another workspace, which the server does with its tasks.
// The destination is a workspace id; resolving a slug or a name to one is the
// caller's job, the same split every other workspace-taking call keeps.
export const moveProject = async (projectId: string, workspaceId: string): Promise<MovedProject> => {
  const moved = zeroRecord(await putProjectMove(pathParam(projectId), { workspaceId }));
  // The count is the move reply's own addition to the project: a reply
  // without it cannot say how many tasks lost their assignee, and reading it
  // as none would report a move that unassigned work as having unassigned
  // nothing.
  if (typeof moved.unassignedTaskCount !== "number") {
    throw new Error(`/project/${projectId}/move: reply carries no unassignedTaskCount`);
  }
  return { ...project(moved), unassignedTaskCount: moved.unassignedTaskCount };
};

// The project background image, as the bytes the route serves. The document
// declares image/*, which is not JSON, so the transport hands back a Blob.
export const getProjectBackground = async (projectId: string): Promise<Blob> =>
  readProjectBackground(pathParam(projectId), { blob: true, headers: { Accept: "image/*" } });

// Removes the project background image. The route answers 204 whether or not
// the project had one, so there is nothing to map.
export const deleteProjectBackground = async (projectId: string): Promise<void> => {
  await removeProjectBackground(pathParam(projectId));
};

// An image as the project's board background, through the three steps the web
// app's uploadProjectBackground runs: the API prepares a presigned PUT, the
// bytes go to it with the headers it signed — no key, since the URL itself is
// the credential — and the finalize names the staged key and version back.
export const setProjectBackground = async (
  projectId: string,
  contentType: string,
  bytes: Uint8Array,
): Promise<{ url: string; version: string }> => {
  const id = pathParam(projectId);
  const stage = zeroRecord(await putProjectBackgroundUpload(id, { contentType, size: bytes.byteLength }));
  // A stage that names no URL, key, version or headers cannot be finished:
  // the PUT would go nowhere or unsigned, and the finalize would be refused
  // for the empty key.
  const missing = (
    [
      ["upload URL", stage.uploadUrl],
      ["key", stage.key],
      ["version", stage.version],
      ["headers", stage.headers],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`/project/${projectId}/background-upload: reply carries no ${missing.join(", ")}`);
  }
  await presignedPut(stage.uploadUrl, stage.headers, bytes);
  const done = zeroRecord(
    await postProjectBackgroundFinalize(id, {
      key: stage.key,
      contentType,
      version: stage.version,
      size: bytes.byteLength,
    }),
  );
  // The URL is the only thing the finalize answers with: a reply without it
  // cannot say where the image landed.
  if (typeof done.url !== "string" || done.url === "") {
    throw new Error(`/project/${projectId}/background-upload/finalize: reply carries no URL`);
  }
  return { url: done.url, version: stage.version };
};

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

// The fields to change. A field left out is left as it is; icon and color take
// null, which is how one is cleared — the route's own rule.
export type ColumnChanges = {
  name?: string;
  icon?: string | null;
  color?: string | null;
  isFinal?: boolean;
};

// Changes the fields named in changes, and answers the column as written.
//
// Only the name, icon, color and done state can move this way: the slug is
// derived from the name when the column is created and the route takes no
// slug, so it — which is what every task in the column stores as its status —
// stays as it was.
export const updateColumn = async (columnId: string, changes: ColumnChanges): Promise<Column> =>
  column(zeroRecord(await putColumn(pathParam(columnId), { ...changes })));

// Renames a column.
export const renameColumn = async (columnId: string, name: string): Promise<Column> => updateColumn(columnId, { name });

// Deletes a column, which the server allows only while the column holds no tasks.
export const deleteColumn = async (columnId: string): Promise<Column> =>
  column(zeroRecord(await removeColumn(pathParam(columnId))));

// A rule that moves a task to a column when an integration event fires.
//
// The integration and the event are what a rule is named by in practice: that
// pair is enough to find one and says which rule it is, and the id is only what
// the delete route takes. They are Kaneo's own event names rather than the
// provider's webhook names — the ones its plugins fire, listed in cli/workflow.ts
// so a pair outside them can be warned about.
//
// Nothing on the server keeps one rule to a pair: the upsert looks for one and
// inserts if it finds none, and no unique index stands behind it, so a project
// can hold two rules for the same pair.
//
// columnName and columnSlug are the listing's convenience for the column the
// rule points at. They are null if the join behind them finds no column, which
// the cascade rules out: workflow_rule.column_id is not nullable and is deleted
// with its column, so a rule cannot outlive one.
export type WorkflowRule = {
  id: string;
  projectId: string;
  integrationType: string;
  eventType: string;
  columnId: string;
  columnName: string | null;
  columnSlug: string | null;
  createdAt: string;
  updatedAt: string;
};

const rule = (r: GenWorkflowRule): WorkflowRule => ({
  id: r.id ?? "",
  projectId: r.projectId ?? "",
  integrationType: r.integrationType ?? "",
  eventType: r.eventType ?? "",
  columnId: r.columnId ?? "",
  columnName: r.columnName ?? null,
  columnSlug: r.columnSlug ?? null,
  createdAt: isoTime(r, "createdAt"),
  updatedAt: isoTime(r, "updatedAt"),
});

// A project's workflow rules.
export const listWorkflowRules = async (projectId: string): Promise<WorkflowRule[]> =>
  zeroList(await readRules(pathParam(projectId))).map(rule);

// A rule as the two writes answer it: the stored row, which names the column by
// id alone. The caller of a write already knows the column it asked for, and the
// listing's two extra fields would cost a request to fill in.
export type WorkflowRuleRow = {
  id: string;
  projectId: string;
  integrationType: string;
  eventType: string;
  columnId: string;
  createdAt: string;
  updatedAt: string;
};

const ruleRow = (r: GenWorkflowRuleRow): WorkflowRuleRow => ({
  id: r.id ?? "",
  projectId: r.projectId ?? "",
  integrationType: r.integrationType ?? "",
  eventType: r.eventType ?? "",
  columnId: r.columnId ?? "",
  createdAt: isoTime(r, "createdAt"),
  updatedAt: isoTime(r, "updatedAt"),
});

// Points an integration event at a column, inserting the rule when the project
// has none for that pair and moving the column of the one it finds. That find
// and insert is the whole of the server's upsert, so a rule set twice in a moment
// can leave two rows for one pair.
export type WorkflowRuleTarget = { integrationType: string; eventType: string; columnId: string };

export const setWorkflowRule = async (projectId: string, wanted: WorkflowRuleTarget): Promise<WorkflowRuleRow> =>
  ruleRow(zeroRecord(await putRule(pathParam(projectId), { ...wanted })));

// Deletes a rule, and answers with the rule that was removed, since after this
// there is nowhere left to read it from.
export const deleteWorkflowRule = async (ruleId: string): Promise<WorkflowRuleRow> =>
  ruleRow(zeroRecord(await removeRule(pathParam(ruleId))));

type Label = { id: string; name: string; color: string };

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

// The open tasks assigned to the caller across one workspace, which is a
// different shape from a project's board: each task names its project and
// carries no description or assignee. The server returns at most 100 of them;
// total counts them all, so a reader can tell the list was cut.
export type AssignedTask = {
  id: string;
  projectId: string;
  projectSlug: string;
  number: number | null;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
};

export type AssignedTasks = { tasks: AssignedTask[]; total: number };

export const listMyTasks = async (workspaceId: string): Promise<AssignedTasks> => {
  const reply = zeroRecord(await listAssignedTasks({ workspaceId }));
  return {
    tasks: zeroList(reply.tasks).map((t) => ({
      id: t.id,
      projectId: t.projectId,
      projectSlug: t.projectSlug,
      number: t.number,
      title: t.title,
      status: t.status,
      priority: t.priority,
      dueDate: t.dueDate,
    })),
    total: reply.total ?? 0,
  };
};

export type Board = {
  projectId: string;
  projectName: string;
  // The slug is here rather than read again: the listing already carries it, and
  // a report that names the board a number was not found on needs it. Asking the
  // project route as well would be a request the caller already paid for.
  projectSlug: string;
  // The board route reports a column's id as its slug, so this id is a status,
  // not the opaque id the column routes take. isFinal is the server's own mark
  // of a column that holds finished work; a server that predates final columns
  // sends no such field, and it stays unset rather than reading as false.
  columns: { id: string; name: string; isFinal?: boolean; tasks: Task[] }[];
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
// A change seen while the pages are read is taken again, and a board that is
// still moving is reported on stderr so the JSON a script reads on stdout
// stays a document. The keyed listing sends no revisions, so what it can see
// is structural: the total, a task answered on two task pages, and a count of
// distinct tasks that does not come back to the total. A delete and a create
// inside one read, or an edit between two related pages that moves nothing,
// can still slip through — there is no snapshot behind the pages to compare
// against.
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
// What one listing page answers the merge with: the board fields and the
// paging block the loops are driven by. The keyed listing nests them under
// data and pagination; the public board sends the board fields beside
// pagination, so the page itself stands in for them.
type BoardPage = { data: GenBoard; pagination: BoardPagination | undefined };

const readBoard = async (
  projectId: string,
  filters: TaskFilters,
  stopAt?: (page: Task[]) => Task | undefined,
): Promise<Reading> => {
  const status = filters.status ?? "";
  const priority = filters.priority ?? "";
  return readPages(
    async (page, related) => {
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
      return { data: zeroRecord(response.data), pagination: response.pagination };
    },
    projectId,
    stopAt,
  );
};

// Reads a paged board listing into a board. watchRevision asks the paging
// block's revisions to be watched as well as the total: the public board
// reports them, and a board edited between pages keeps its total while its
// revisions move. relatedRevision covers the related rows of the task page it
// rides on, so it is compared only across that page's related continuations,
// never carried to the next task page whose rows it does not describe.
const readPages = async (
  fetchPage: (page: number, relatedPage: number) => Promise<BoardPage>,
  projectId: string,
  stopAt?: (page: Task[]) => Task | undefined,
  watchRevision = false,
): Promise<Reading> => {
  let board: Board | undefined;
  let stopped: Task | undefined;
  const columnAt = new Map<string, number>();
  const offBoard = new Map(OFF_BOARD.map((column) => [column.id, [] as Task[]]));
  const taskAt = new Map<string, Task>();
  // The task page each task was first answered on, so a task met again can be
  // told apart as a related page's repeat from a second task page's copy.
  const pageOf = new Map<string, number>();
  let repeated = false;
  let first: number | undefined;
  let last: number | undefined;
  let revision: string | undefined;
  let revisionMoved = false;

  for (let page = 1, pages = 1; page <= pages && stopped === undefined; page++) {
    const onPage: Task[] = [];
    let relatedRevision: string | undefined;
    for (let related = 1, relatedPages = 1; related <= relatedPages; related++) {
      const response = await fetchPage(page, related);
      pages = response.pagination?.totalPages ?? 0;
      relatedPages = response.pagination?.relatedTotalPages ?? 0;
      const total = response.pagination?.total;
      if (page === 1 && related === 1) first = total;
      last = total;
      if (watchRevision) {
        const seen = response.pagination?.revision;
        if (seen !== undefined) {
          if (revision === undefined) revision = seen;
          else if (seen !== revision) revisionMoved = true;
        }
        const seenRelated = response.pagination?.relatedRevision;
        if (seenRelated !== undefined) {
          if (relatedRevision === undefined) relatedRevision = seenRelated;
          else if (seenRelated !== relatedRevision) revisionMoved = true;
        }
      }

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
      // A task seen again on a related page of the same task page brings more
      // labels; the same task on a later task page is the same task twice.
      const place = (from: BoardTask[], into: Task[]): void => {
        for (const task of from) {
          const seen = taskAt.get(task.id);
          if (seen !== undefined) {
            if (pageOf.get(task.id) === page) {
              if (related > 1) seen.labels = appendNewLabels(seen.labels, labels(task.labels));
            } else {
              // The listing slices disjoint pages out of one order, so a task
              // answered on two task pages means the board moved while it was
              // read — a reorder the total never has to change for.
              repeated = true;
            }
            continue;
          }
          const placed = toTask(task);
          taskAt.set(task.id, placed);
          pageOf.set(task.id, page);
          into.push(placed);
          onPage.push(placed);
        }
      };
      for (const column of zeroList(data.columns)) {
        let at = columnAt.get(column.id);
        if (at === undefined) {
          at = target.columns.length;
          columnAt.set(column.id, at);
          target.columns.push({ id: column.id, name: column.name, isFinal: column.isFinal, tasks: [] });
        }
        place(zeroList(column.tasks), target.columns[at]!.tasks);
      }
      for (const column of OFF_BOARD) {
        place(zeroList(column.tasks(data)), offBoard.get(column.id)!);
      }
    }
    stopped = stopAt?.(onPage);
    // Once the distinct tasks held reach the total the listing reports, the
    // pages left can only repeat them: the first request, which names no
    // page, may already have answered the whole board while the pagination
    // still counts the pages a paged request would take.
    if (typeof last === "number" && taskAt.size >= last) break;
  }

  if (board === undefined || board.projectId === "") {
    throw new Error(`board ${projectId}: the server answered without a project`);
  }
  for (const column of OFF_BOARD) {
    const tasks = offBoard.get(column.id)!;
    if (tasks.length > 0) board.columns.push({ id: column.id, name: column.name, tasks });
  }
  // A read that stopped early holds only the pages it asked for, so the count
  // of distinct tasks it met says nothing against the whole-board total.
  const countMoved = stopped === undefined && typeof last === "number" && taskAt.size !== last;
  return { board, stopped, moved: (first !== undefined && first !== last) || revisionMoved || repeated || countMoved };
};

// Every task the listing answered, the planned and the archived ones included,
// most urgent first and then by task number.
export const projectTasks = (board: Board): Task[] => byPriority(board.columns);

// The tasks on the board: the same list without the two columns that are none of
// the project's, since neither a planned task nor an archived one is work a
// board is showing.
export const boardTasks = (board: Board): Task[] => byPriority(board.columns.filter((c) => !isOffBoard(c)));

// The statuses that hold finished work on one board: the slug of every column
// the project marked final, plus archived, the pseudo-column the listing files
// finished work away in. planned is not among them: work nobody has picked up
// is open backlog, and a task created beside it joins that backlog.
//
// The listing carries isFinal on every column of a server that has final
// columns. One that predates them sends no such field on any column, and there
// done was the only final column, so it is named instead.
export const closedStatuses = (board: Board): ReadonlySet<string> => {
  const predatesFinal = !board.columns.some((column) => column.isFinal !== undefined);
  const closed = new Set(board.columns.filter((column) => column.isFinal === true).map((column) => column.id));
  if (predatesFinal) closed.add("done");
  closed.add("archived");
  return closed;
};

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
  startDate: isoTimePtr(from, "startDate"),
  dueDate: isoTimePtr(from, "dueDate"),
  createdAt: isoTime(from, "createdAt"),
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

// The deferred flag as a listing's JSON carries it: written only when the
// listing left the description out, so an empty description and an unread one
// are two different documents. Absent otherwise, the way the API's own optional
// field reads.
export const deferredMark = (task: Task): { descriptionDeferred?: true } =>
  descriptionDeferred(task) ? { descriptionDeferred: true } : {};

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

// Fetches the task a `<slug>-<number>` ticket id names, in one request: the
// server picks the project from the slug, so no board is read. Its errors (404,
// 403, 409 when the slug names more than one project) are the caller's to show.
export const getTaskByTicketId = async (ticketId: string): Promise<Task> => {
  const t = zeroRecord(await readTaskByTicketId(pathParam(ticketId)));
  return task(t, { assigneeId: t.assigneeId, assigneeName: t.assigneeName, labels: null });
};

// A task's whole description, read through the route the listing defers big
// ones to. Each page is a slice of the text and the version it was read at;
// the version of every page but the first is sent back, so an edit landing
// mid-read fails the read (409) rather than joining two versions of it. A page
// that does not advance fails too, since following it would read for ever.
export const getTaskDescription = async (taskId: string): Promise<string> => {
  const parts: string[] = [];
  let offset = 0;
  let version: string | undefined;
  for (;;) {
    const page = zeroRecord(
      await readDescriptionPage(pathParam(taskId), {
        ...(offset === 0 ? {} : { offset }),
        ...(version === undefined ? {} : { version }),
      }),
    );
    if (version !== undefined && page.version !== version) {
      throw new Error("the description changed while it was read");
    }
    version = page.version;
    parts.push(page.content ?? "");
    const next = page.nextOffset ?? null;
    if (next === null) return parts.join("");
    if (next <= offset) throw new Error("the description page did not advance");
    offset = next;
  }
};

// The ids of the project's tasks whose descriptions the listing deferred and
// whose text contains the query, matched case-insensitively. Only deferred
// descriptions are searched: one the listing carried was already filtered on
// by the caller. The server pages by task id cursor, a hundred at a time, and
// every page is read so the caller sees the whole match set; a cursor seen
// twice fails the read rather than looping for ever.
export const findDeferredTaskDescriptions = async (projectId: string, query: string): Promise<string[]> => {
  const ids: string[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let after: string | undefined;
  for (;;) {
    const page = zeroRecord(
      await searchDescriptionMatches(pathParam(projectId), {
        query,
        ...(after === undefined ? {} : { after }),
      }),
    );
    for (const id of zeroList(page.ids)) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    const cursor = page.nextCursor ?? null;
    if (cursor === null) return ids;
    if (cursors.has(cursor)) throw new Error("the description search did not advance");
    cursors.add(cursor);
    after = cursor;
  }
};

// The payload for creating a task.
export type NewTask = {
  title: string;
  description: string;
  priority: string;
  status: string;
  // An ISO instant, or "" for none.
  startDate: string;
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
      ...(wanted.startDate === "" ? {} : { startDate: wanted.startDate }),
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

// What a full update changes that no single-field route can: when a task starts
// (null clears it) and its sort key within its column.
export type StartAndPosition = { startDate?: string | null; position?: number };

// The largest position the route takes, as the document states it.
export const MAX_TASK_POSITION = updateTaskBodyPositionMax;

// Changes a task's start date or position through PUT /task/{id}, the only route
// that writes either.
//
// The route replaces the whole task: a start date, due date or assignee left out
// of the body is stored as none, and title, priority, status, projectId and
// position are required (a server older than the pinned document also requires
// the description). So the task is read by id and every field not being changed
// is sent back as read; a change made elsewhere between the read and the write is
// overwritten, as project update does. The description is sent back whole, which
// the detail route carries even when the listing leaves it out. The server
// reports a description change only when the text differs, so sending it back
// unchanged reports nothing; a description that was null goes back as the empty
// one it reads as, which is stored and reported as a change from null. Leaving
// it out would avoid that, but a server older than the pinned document refuses
// an update without one.
//
// The reply is checked against what was written, field by field. A reply that
// does not match is reported rather than taken as done; the write may still have
// landed.
export const setStartAndPosition = async (taskId: string, changes: StartAndPosition): Promise<Task> => {
  const read = zeroRecord(await readTask(pathParam(taskId)));
  const before = task(read, { assigneeId: read.assigneeId, assigneeName: read.assigneeName, labels: null });
  // Every field of this read is written back. A read that is empty or names
  // another task would blank or move the wrong one. A field the reply left out
  // reads as a value the route takes (no due date, no assignee, an empty
  // description, position 0), so writing it back would clear or move something
  // with nothing to show it; each one sent back has to have been in the reply.
  const missing = [
    ...(typeof read.title === "string" ? [] : ["title"]),
    ...(typeof read.status === "string" ? [] : ["status"]),
    ...(typeof read.priority === "string" ? [] : ["priority"]),
    ...(read.description === undefined ? ["description"] : []),
    ...(read.dueDate === undefined ? ["dueDate"] : []),
    ...(read.assigneeId === undefined ? ["assigneeId"] : []),
    ...(changes.position === undefined && typeof read.position !== "number" ? ["position"] : []),
  ];
  if (before.id !== taskId || before.projectId === "" || missing.length > 0) {
    throw new Error(
      `reading task ${taskId} before the update got id ${quoted(before.id)}, project ${quoted(before.projectId)}${missing.length > 0 ? `, without ${missing.join(", ")}` : ""}; not writing`,
    );
  }
  const startDate = changes.startDate === undefined ? before.startDate : changes.startDate;
  const position = changes.position ?? before.position;
  const body: UpdateTaskBody = {
    title: before.title,
    description: before.description,
    priority: unchecked<UpdateTaskBody["priority"]>(before.priority),
    status: before.status,
    projectId: before.projectId,
    position,
    ...(startDate === null ? {} : { startDate }),
    ...(before.dueDate === null ? {} : { dueDate: before.dueDate }),
    ...(before.assigneeId === null ? {} : { userId: before.assigneeId }),
  };
  const t = zeroRecord(await putTask(pathParam(taskId), body));
  const after = task(t, { assigneeId: t.userId, assigneeName: before.assigneeName, labels: null });

  const sameInstant = (a: string | null, b: string | null) =>
    a === null || b === null ? a === b : Date.parse(a) === Date.parse(b);
  const off: string[] = [];
  if (after.id !== taskId) off.push(`id ${quoted(after.id)}, want ${quoted(taskId)}`);
  if (!sameInstant(after.startDate, startDate))
    off.push(`startDate ${quoted(String(after.startDate))}, want ${quoted(String(startDate))}`);
  if (after.position !== position) off.push(`position ${after.position}, want ${position}`);
  if (!sameInstant(after.dueDate, before.dueDate))
    off.push(`dueDate ${quoted(String(after.dueDate))}, want ${quoted(String(before.dueDate))}`);
  if (after.assigneeId !== before.assigneeId)
    off.push(`assignee ${quoted(String(after.assigneeId))}, want ${quoted(String(before.assigneeId))}`);
  // What was sent back unchanged has to come back unchanged too. v2.29.2 echoes
  // the row it stored, so these hold there; they are here for a server that
  // answers with something else, which would otherwise change a field under a
  // command that never named it. The description is compared only when the reply
  // carries it: one too long for a listing comes back as a summary.
  for (const [name, got, sent] of [
    ["title", after.title, before.title],
    ["status", after.status, before.status],
    ["priority", after.priority, before.priority],
    ["projectId", after.projectId, before.projectId],
  ] as const) {
    if (got !== sent) off.push(`${name} ${quoted(got)}, want ${quoted(sent)}`);
  }
  if (t.descriptionDeferred !== true && after.description !== before.description) {
    off.push(`description of ${after.description.length} characters, want ${before.description.length}`);
  }
  if (off.length > 0) throw new Error(`/task/${taskId}: the reply does not match the update: ${off.join("; ")}`);
  return after;
};

// Sets a task's due date, or clears it when dueDate is empty. The body leaves the
// field out to clear it: the route takes a string or nothing, never null, and the
// server stores nothing for a missing one.
//
// The reply is checked against what was asked, as a rename is: a set has to come
// back as the same instant, and a clear as no date. A reply that omits the field
// would otherwise read as a clear that went through. The instant is compared as
// Date reads the string, which is how the server parses it.
export const setTaskDueDate = async (taskId: string, dueDate: string): Promise<Task> => {
  const t = zeroRecord(await updateTaskDueDate(pathParam(taskId), dueDate === "" ? {} : { dueDate }));
  const updated = task(t, { assigneeId: t.userId, assigneeName: null, labels: null });
  const landed =
    dueDate === ""
      ? updated.dueDate === null
      : updated.dueDate !== null && Date.parse(updated.dueDate) === Date.parse(dueDate);
  if (updated.id !== taskId || !landed) {
    throw new Error(
      `/task/due-date/${taskId}: server answered with task ${quoted(updated.id)} due ${quoted(String(updated.dueDate))}`,
    );
  }
  return updated;
};

export type BulkOperation = BulkUpdateTasksBody["operation"];

// Applies one operation to many tasks in a single request. value is null for an
// operation that clears (an assignee, a due date) and unused by delete.
//
// The count is what the server changed, which can be fewer than the tasks named:
// adding a label skips a task that already has it, and removing one skips a task
// that never had it. Only a label may come back short: for anything else a short
// count is a task the server did not find (the route skips those as long as one
// is found), which is reported rather than passed off as done. A reply with no
// count is refused rather than read as zero; one with success false never gets
// here, since the transport fails it.
export const bulkUpdate = async (
  taskIds: string[],
  operation: BulkOperation,
  value: string | null,
): Promise<number> => {
  const reply = zeroRecord(await bulkUpdateTasks({ taskIds, operation, value }));
  const count = reply.updatedCount;
  const short = operation !== "addLabel" && operation !== "removeLabel" && count !== taskIds.length;
  if (typeof count !== "number" || short) {
    throw new Error(`/task/bulk: sent ${taskIds.length} task(s), server answered count ${String(count)}`);
  }
  return count;
};

// A project's tasks as the server exports them: the project's name and slug, and
// each task with its labels by name and color. The document is handed back as the
// server wrote it, fields a newer server adds included; import picks out only the
// fields it sends.
//
// A reply without the project or the task list is refused rather than written
// out: import refuses that document anyway, and it would leave a file that looks
// like an export of an empty project.
export const exportProjectTasks = async (projectId: string): Promise<TaskExport> => {
  const exported = zeroRecord(await readExport(pathParam(projectId)));
  if (exported.project === null || typeof exported.project !== "object" || !Array.isArray(exported.tasks)) {
    throw new Error(`/task/export/${projectId}: server answered without a project and its tasks`);
  }
  return exported;
};

export type ImportedTask = ImportTasksBody["tasks"][number];

// One task's outcome. The server reports each task on its own, so a partial
// import still answers 200 and the failures are only found here.
// id and number are the created task's, and empty and zero on a failure.
type ImportOutcome = { success: boolean; id: string; number: number; title: string; error: string; warnings: string[] };

export type ImportResult = { total: number; successful: number; failed: number; tasks: ImportOutcome[] };

// Creates the given tasks in a project. The server takes a status it does not
// know or a priority it does not accept and coerces it, which it reports as a
// warning on that task rather than as a failure.
//
// The summary is checked against what was sent: a reply that accounts for fewer
// tasks than the request carried (none at all, or a truncated list) would
// otherwise read as an import that went through. Its success count is checked
// against the outcomes too, since the command fails on the count: a failed
// outcome the count leaves out would be printed and still exit 0. With the
// lengths equal, that also fixes the failure count.
export const importProjectTasks = async (projectId: string, tasks: ImportedTask[]): Promise<ImportResult> => {
  const summary = zeroRecord(zeroRecord(await postImport(pathParam(projectId), { tasks })).results);
  const result: ImportResult = {
    total: summary.total ?? 0,
    successful: summary.successful ?? 0,
    failed: summary.failed ?? 0,
    tasks: zeroList(summary.tasks).map(outcome),
  };
  if (
    result.total !== tasks.length ||
    result.successful + result.failed !== tasks.length ||
    result.tasks.length !== tasks.length ||
    result.successful !== result.tasks.filter((t) => t.success).length
  ) {
    throw new Error(
      `/task/import/${projectId}: sent ${tasks.length} task(s), server reported ${result.total} (${result.successful} imported, ${result.failed} failed)`,
    );
  }
  return result;
};

// The document types each outcome as anything with a success flag; what the
// server writes is the flag, an error on a failure, the task, and warnings when
// a field was coerced.
const outcome = (raw: unknown): ImportOutcome => {
  const o = (raw ?? {}) as {
    success?: unknown;
    error?: unknown;
    task?: { id?: unknown; number?: unknown; title?: unknown } | null;
    warnings?: unknown;
  };
  const success = o.success === true;
  return {
    success,
    id: typeof o.task?.id === "string" ? o.task.id : "",
    number: typeof o.task?.number === "number" ? o.task.number : 0,
    title: typeof o.task?.title === "string" ? o.task.title : "",
    error: reason(o.error),
    warnings: Array.isArray(o.warnings) ? o.warnings.filter((w): w is string => typeof w === "string") : [],
  };
};

export const moveTask = async (taskId: string, projectId: string): Promise<void> => {
  await putTaskMove(pathParam(taskId), { destinationProjectId: projectId });
};

export const deleteTask = async (taskId: string): Promise<void> => {
  await removeTask(pathParam(taskId));
};

// Copies a task within its project: the copy keeps the source's column,
// priority, assignee, dates, labels and description, and only the title can
// differ — an absent or blank one keeps the source's. The reply is the stored
// task, which names the assignee as userId, resolves no name and carries no
// labels, as the other write routes answer.
export const duplicateTask = async (taskId: string, title?: string): Promise<Task> => {
  const copied = zeroRecord(await postDuplicate(pathParam(taskId), title === undefined ? {} : { title }));
  return task(copied, { assigneeId: copied.userId, assigneeName: null, labels: null });
};

// Where an uploaded image is used, which decides how the server scopes it.
export type ImageSurface = "description" | "comment";

// An image going onto a task: what it is called, what it is, how big it is,
// and where it will be used.
export type TaskImage = { filename: string; contentType: string; size: number; surface: ImageSurface };

// The staged upload a task image becomes: the object key finalize asks for,
// the presigned URL the bytes go to, and the headers the PUT must carry,
// Content-Type among them.
export type StagedImage = { key: string; uploadUrl: string; headers: Record<string, string> };

// The stored image a finalized upload became: the id an embed references and
// the URL it is read back from.
export type StoredImage = { id: string; url: string };

// Issues the presigned upload for an image going onto a task. Nothing is
// stored yet: the bytes still have to be PUT to uploadUrl and the key
// finalized before the asset exists.
export const stageTaskImage = async (taskId: string, wanted: TaskImage): Promise<StagedImage> => {
  const u = zeroRecord(await createTaskImageUpload(pathParam(taskId), { ...wanted }));
  return { key: u.key ?? "", uploadUrl: u.uploadUrl ?? "", headers: u.headers ?? {} };
};

// Records the uploaded bytes as the task's image. A refusal means the upload
// is gone or was already finalized, which the caller reports as it came.
export const finalizeTaskImage = async (taskId: string, wanted: TaskImage & { key: string }): Promise<StoredImage> => {
  const a = zeroRecord(await finalizeTaskImageUpload(pathParam(taskId), { ...wanted }));
  return { id: a.id ?? "", url: a.url ?? "" };
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
    createdAt: isoTime(c, "createdAt"),
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
    createdAt: isoTime(a, "createdAt"),
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
  createdAt: isoTime(a, "createdAt"),
});

// A task's history, oldest first like its comments. The server sends it newest
// first.
export const listActivities = async (taskId: string): Promise<Activity[]> =>
  zeroList(await getActivities(pathParam(taskId)))
    .map(activity)
    .reverse();

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
  startTime: isoTime(t, "startTime"),
  endTime: isoTimePtr(t, "endTime"),
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
  const [year, month, day] = [value.slice(0, 4), value.slice(5, 7), value.slice(8, 10)].map(Number) as [
    number,
    number,
    number,
  ];
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
    throw new Error(
      `${field} ${JSON.stringify(value)} is not a real date and time in ISO 8601 with an offset, such as 2026-01-31T09:00:00Z`,
    );
  }
  return value;
};

// A write the server did not echo back is not reported as done, whatever its
// status: it may well have happened, but printing an entry with no id as the
// one just written would claim more than the reply said.
const echoed = (entry: TimeEntry, route: string, wantId?: string): TimeEntry => {
  if (entry.id === "" || (wantId !== undefined && entry.id !== wantId)) {
    throw new Error(
      `${route}: server answered with time entry ${JSON.stringify(entry.id)}; the write is not confirmed`,
    );
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
    throw new Error(
      `reading time entry ${entryId} before the update got id ${JSON.stringify(read.id)}, start ${read.startTime}; not writing`,
    );
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
    changes.startTime === undefined
      ? (await readForWrite(entryId)).startTime
      : checkTimestamp("start", changes.startTime);
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
    throw new Error(
      `time entry ${entryId} already stopped at ${read.endTime}; change its end with \`kaneo time update ${shellWord(entryId)} --end <time>\``,
    );
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
export const linkTasks = async (sourceTaskId: string, targetTaskId: string, relationType: string): Promise<Relation> =>
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
    : {
        id: t.id ?? "",
        number: t.number ?? null,
        title: t.title ?? "",
        status: t.status ?? "",
        projectId: t.projectId ?? "",
      };

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
  createdAt: isoTime(n, "createdAt"),
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
  createdAt: isoTime(l, "createdAt"),
  updatedAt: isoTime(l, "updatedAt"),
  deletionStartedAt: isoTimePtr(l, "deletionStartedAt"),
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
    throw new Error(
      `reading label ${labelId} before the update got id ${quoted(before.id)}, name ${quoted(before.name)}; not writing`,
    );
  }
  const after = labelRecord(
    zeroRecord(await putLabel(pathParam(labelId), { name: name ?? before.name, color: changes.color ?? before.color })),
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
      const hint = `; the label may be partly deleted, run \`kaneo label rm ${shellWord(labelId)} --yes\` again to finish`;
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

// A project's calendar feed: a secret link that serves the project's scheduled
// tasks as an iCalendar document to anyone holding it. token is that secret —
// the subscribe URL is built from it, and the document itself is read through
// calendarFeedIcs, which needs no key because the route is public.
export type CalendarFeed = {
  id: string;
  projectId: string;
  token: string;
  labelIds: string[];
  timeZone: string;
  createdAt: string;
};

const calendarFeed = (f: GenCalendarFeed): CalendarFeed => ({
  id: f.id ?? "",
  projectId: f.projectId ?? "",
  token: f.token ?? "",
  labelIds: f.labelIds ?? [],
  timeZone: f.timeZone ?? "",
  createdAt: isoTime(f, "createdAt"),
});

export const listCalendarFeeds = async (projectId: string): Promise<CalendarFeed[]> =>
  zeroList(await readCalendarFeeds(pathParam(projectId))).map(calendarFeed);

// Creates a feed matching tasks that carry any of the labels, by label id.
// timeZone is the zone all-day dates are read in; "" leaves the server's
// default (UTC) rather than sending a zone nobody asked for.
export const createCalendarFeed = async (
  projectId: string,
  labelIds: string[],
  timeZone: string,
): Promise<CalendarFeed> =>
  calendarFeed(
    zeroRecord(
      await postCalendarFeed(pathParam(projectId), {
        labelIds,
        ...(timeZone === "" ? {} : { timeZone }),
      }),
    ),
  );

// Revokes a feed by id, which stops its link from serving. The server answers
// with {success: true} and nothing about the feed that was revoked.
export const revokeCalendarFeed = async (projectId: string, id: string): Promise<{ success: boolean }> => {
  const reply = zeroRecord(await removeCalendarFeed(pathParam(projectId), pathParam(id)));
  return { success: reply.success ?? false };
};

// The iCalendar document a feed's link serves. The route is public — the token
// is the credential — so the call is anonymous, asks for the document's own
// media type, and the body comes back as the text it is rather than as JSON.
// The token rides in the URL, so the call is marked credentialInUrl: the
// transport refuses it over plain HTTP to a non-loopback host, on the first
// hop and on every redirect, the way it refuses to send the key there.
export const calendarFeedIcs = async (token: string): Promise<string> =>
  readCalendarFeed(pathParam(token), {
    anonymous: true,
    text: true,
    credentialInUrl: true,
    headers: { Accept: "text/calendar" },
  });

// A link from a task to something outside the board.
//
// The integration is the one thing that tells a link somebody added by hand from
// one an integration brought in: integrationType is null for the former, since
// there is no integration behind it. resourceType says what the link points at
// rather than where it came from — `url` for a manual link, and e.g. `issue`,
// `pull_request` or `branch` for one a provider brought in — and it is
// open-ended, being whatever the integration wrote, so nothing here enumerates
// it. The integration's own row is left out: the type is what a reader can act
// on, and the id would name a record this CLI never reads.
export type ExternalLink = {
  id: string;
  taskId: string;
  resourceType: string;
  externalId: string;
  url: string;
  title: string | null;
  integrationType: string | null;
  createdAt: string;
  updatedAt: string;
};

const externalLink = (l: GenExternalLink): ExternalLink => ({
  id: l.id ?? "",
  taskId: l.taskId ?? "",
  resourceType: l.resourceType ?? "",
  externalId: l.externalId ?? "",
  url: l.url ?? "",
  title: l.title ?? null,
  integrationType: l.integration?.type ?? null,
  createdAt: isoTime(l, "createdAt"),
  updatedAt: isoTime(l, "updatedAt"),
});

// The links a task holds, both the ones an integration brought in and the ones
// added by hand.
export const listExternalLinks = async (taskId: string): Promise<ExternalLink[]> =>
  zeroList(await readExternalLinks(pathParam(taskId))).map(externalLink);

// A custom field definition on a project: the template every task's value for
// it refers back to by fieldId. options is the choice list of a dropdown or
// multiselect field and is absent otherwise; the document leaves its shape
// open, so it is kept as the server sent it.
export type CustomField = {
  id: string;
  projectId: string;
  name: string;
  type: string;
  required: boolean;
  defaultValue: string | null;
  options: Json;
  position: number;
  createdAt: string;
  updatedAt: string;
};

const customField = (f: GenFieldDefinition): CustomField => ({
  id: f.id ?? "",
  projectId: f.projectId ?? "",
  name: f.name ?? "",
  type: f.type ?? "",
  required: f.required ?? false,
  defaultValue: f.defaultValue ?? null,
  options: (f.options ?? null) as Json,
  position: f.position ?? 0,
  createdAt: isoTime(f, "createdAt"),
  updatedAt: isoTime(f, "updatedAt"),
});

// A project's field definitions, in position order.
export const listCustomFields = async (projectId: string): Promise<CustomField[]> =>
  zeroList(await readCustomFields(pathParam(projectId))).map(customField);

// One stored value, with the definition's name, position and type denormalized
// onto it so a listing needs no second read. Only fields somebody set have a
// row: a field never touched has none, so a listing shows what is held rather
// than every definition.
export type CustomFieldValue = {
  id: string;
  taskId: string;
  fieldId: string;
  value: string | null;
  fieldName: string;
  fieldPosition: number;
  fieldType: string;
  fieldOptions: Json;
};

const fieldValue = (v: GenFieldValue): CustomFieldValue => ({
  id: v.id ?? "",
  taskId: v.taskId ?? "",
  fieldId: v.fieldId ?? "",
  value: v.value ?? null,
  fieldName: v.fieldName ?? "",
  fieldPosition: v.fieldPosition ?? 0,
  fieldType: v.fieldType ?? "",
  fieldOptions: (v.fieldOptions ?? null) as Json,
});

// Every value held in a project, across all its tasks.
export const listProjectFieldValues = async (projectId: string): Promise<CustomFieldValue[]> =>
  zeroList(await readProjectFieldValues(pathParam(projectId))).map(fieldValue);

// The values one task holds.
export const listTaskFieldValues = async (taskId: string): Promise<CustomFieldValue[]> =>
  zeroList(await readTaskFieldValues(pathParam(taskId))).map(fieldValue);

// The distinct values tasks use for each of a project's fields, which is what
// a filter on them can offer.
export type CustomFieldFilter = { fieldId: string; fieldName: string; fieldType: string; values: string[] };

export const listFieldFilterValues = async (projectId: string): Promise<CustomFieldFilter[]> =>
  zeroList(await readFieldFilterValues(pathParam(projectId))).map((f) => ({
    fieldId: f.fieldId ?? "",
    fieldName: f.fieldName ?? "",
    fieldType: f.fieldType ?? "",
    values: zeroList(f.values),
  }));

// The payload for creating a field. defaultValue and options are sent only
// when given: the route stores what it is sent, and an empty options list is
// not the same as none for a choice field.
export type NewCustomField = {
  name: string;
  type: string;
  required: boolean;
  defaultValue?: string;
  options?: string[];
};

export const createCustomField = async (projectId: string, wanted: NewCustomField): Promise<CustomField> =>
  customField(
    zeroRecord(
      await postCustomField({
        projectId,
        name: wanted.name,
        type: unchecked<NonNullable<CreateCustomFieldBody["type"]>>(wanted.type),
        required: wanted.required,
        ...(wanted.defaultValue === undefined ? {} : { defaultValue: wanted.defaultValue }),
        ...(wanted.options === undefined ? {} : { options: wanted.options }),
      }),
    ),
  );

// Writes a new position for fields of a project. The document leaves the reply
// untyped; the server answers the project's fields in their new order, which
// is what the listing would give back.
export const reorderCustomFields = async (projectId: string, fieldIds: string[]): Promise<CustomField[]> => {
  const reply = await putFieldOrder(pathParam(projectId), {
    fields: fieldIds.map((id, position) => ({ id, position })),
  });
  // Rows are checked for an id alone: every other field the mapping lacks is
  // filled with its empty value, which would let a row that is no field pass.
  const isField = (f: unknown): boolean => {
    if (f === null || typeof f !== "object") return false;
    const { id } = f as { id?: unknown };
    return typeof id === "string" && id !== "";
  };
  if (!Array.isArray(reply) || !reply.every(isField)) {
    throw new Error(
      `PUT /custom-field/reorder/${projectId}: the fields were reordered, but the reply is not a list of them; \`kaneo field ls\` shows the new order`,
    );
  }
  return (reply as GenFieldDefinition[]).map(customField);
};

// The saved row of a set value. value is what the server stored, which is the
// trimmed text it was sent.
export type CustomFieldSetting = { id: string; taskId: string; fieldId: string; value: string | null };

const fieldSetting = (v: GenFieldSettingReply): CustomFieldSetting => ({
  id: v.id ?? "",
  taskId: v.taskId ?? "",
  fieldId: v.fieldId ?? "",
  value: v.value ?? null,
});

// Creates or replaces the value one task holds for one field.
export const setCustomFieldValue = async (
  taskId: string,
  fieldId: string,
  value: string,
): Promise<CustomFieldSetting> => fieldSetting(zeroRecord(await putFieldValue({ taskId, fieldId, value })));

// Deletes a field definition. The server removes the definition row; the
// values tasks hold for it go with it.
export const deleteCustomField = async (fieldId: string): Promise<CustomField> =>
  customField(zeroRecord(await removeCustomField(pathParam(fieldId))));

// A project's link to a Gitea repository.
//
// The access token itself is never returned: maskedAccessToken is the only view
// of it the server gives. webhookSecret comes back only for a caller holding
// workspace:manage_settings — empty for anyone else — since it is the value
// pasted into the webhook Gitea posts to. isActive is nullable: an integration
// row can carry no flag at all, which reads as neither on nor off.
export type GiteaIntegration = {
  id: string;
  projectId: string;
  baseUrl: string;
  repositoryOwner: string;
  repositoryName: string;
  maskedAccessToken: string;
  webhookUrl: string | null;
  webhookSecret: string | null;
  branchPattern: string | null;
  commentTaskLinkOnGiteaIssue: boolean | null;
  isActive: boolean | null;
  createdAt: string;
  updatedAt: string;
};

const giteaIntegration = (g: GenGiteaIntegration | undefined): GiteaIntegration | null => {
  // A null reply is the server saying the project has no integration, which is
  // an answer rather than a failure; an absent one (a 2xx with no body) reads
  // the same way.
  if (g === null || g === undefined) return null;
  return {
    id: g.id ?? "",
    projectId: g.projectId ?? "",
    baseUrl: g.baseUrl ?? "",
    repositoryOwner: g.repositoryOwner ?? "",
    repositoryName: g.repositoryName ?? "",
    maskedAccessToken: g.maskedAccessToken ?? "",
    webhookUrl: g.webhookUrl ?? null,
    webhookSecret: g.webhookSecret ?? null,
    branchPattern: g.branchPattern ?? null,
    commentTaskLinkOnGiteaIssue: g.commentTaskLinkOnGiteaIssue ?? null,
    isActive: g.isActive ?? null,
    createdAt: isoTime(g, "createdAt"),
    updatedAt: isoTime(g, "updatedAt"),
  };
};

// The Gitea instance and repository an integration command works against, and
// the token that reaches them. accessToken is optional where the server lets
// the stored one answer instead: verify reuses it only when the base URL is the
// saved integration's, and connect keeps it when the field is left out.
export type GiteaTarget = {
  baseUrl: string;
  accessToken?: string;
  repositoryOwner: string;
  repositoryName: string;
};

const giteaTarget = (
  wanted: GiteaTarget,
): Pick<VerifyGiteaAccessBody, "baseUrl" | "accessToken" | "repositoryOwner" | "repositoryName"> => ({
  baseUrl: wanted.baseUrl,
  ...(wanted.accessToken === undefined ? {} : { accessToken: wanted.accessToken }),
  repositoryOwner: wanted.repositoryOwner,
  repositoryName: wanted.repositoryName,
});

// The integration a project has, or null when it has none.
export const getGiteaIntegration = async (projectId: string): Promise<GiteaIntegration | null> =>
  giteaIntegration(await readGiteaIntegration(pathParam(projectId)));

// Links a project to a Gitea repository, or re-links it: the server verifies
// the token reaches the repository before storing, and keeps the webhook secret
// an earlier link generated. accessToken left out keeps the stored token.
//
// The route answers with the stored integration, never null, so a reply that
// reads as none is a reply that cannot be reported as a link that was made.
export const createGiteaIntegration = async (projectId: string, wanted: GiteaTarget): Promise<GiteaIntegration> => {
  const body: CreateGiteaIntegrationBody = {
    baseUrl: wanted.baseUrl,
    repositoryOwner: wanted.repositoryOwner,
    repositoryName: wanted.repositoryName,
    ...(wanted.accessToken === undefined ? {} : { accessToken: wanted.accessToken }),
  };
  const created = giteaIntegration(await postGiteaIntegration(pathParam(projectId), body));
  if (created === null) {
    throw new Error(`/gitea-integration/project/${projectId}: server answered without the integration`);
  }
  return created;
};

// The two settings the update route takes; everything else about the link —
// the instance, the repository, the token — is changed by connecting again.
export type GiteaIntegrationChanges = UpdateGiteaIntegrationBody;

// Changes isActive or commentTaskLinkOnGiteaIssue and keeps the rest. The
// server's update is partial, so only the fields given are sent.
export const updateGiteaIntegration = async (
  projectId: string,
  changes: GiteaIntegrationChanges,
): Promise<GiteaIntegration> => {
  const updated = giteaIntegration(await patchGiteaIntegration(pathParam(projectId), changes));
  if (updated === null) {
    throw new Error(`/gitea-integration/project/${projectId}: server answered without the integration`);
  }
  return updated;
};

// Unlinks the project. The reply is the server's own two fields.
export const deleteGiteaIntegration = async (projectId: string): Promise<{ success: boolean; message: string }> => {
  const deleted = zeroRecord<GenGiteaDeleteResult>(await removeGiteaIntegration(pathParam(projectId)));
  return { success: deleted.success ?? false, message: deleted.message ?? "" };
};

// A repository a Gitea token can reach. The fields keep Gitea's own names
// (full_name, html_url) mapped to the camelCase the rest of this client uses.
export type GiteaRepository = {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  htmlUrl: string;
};

const giteaRepository = (r: GenGiteaRepository): GiteaRepository => ({
  id: r.id ?? 0,
  name: r.name ?? "",
  fullName: r.full_name ?? "",
  owner: r.owner?.login ?? "",
  private: r.private ?? false,
  htmlUrl: r.html_url ?? "",
});

// The repositories the token can reach on the instance, for picking one to
// link. accessToken is required here: unlike verify and connect, this route
// has no saved-token path.
export const listGiteaRepositories = async (wanted: {
  projectId: string;
  baseUrl: string;
  accessToken: string;
}): Promise<GiteaRepository[]> =>
  zeroList(
    zeroRecord(
      await postGiteaRepositories({
        projectId: wanted.projectId,
        baseUrl: wanted.baseUrl,
        accessToken: wanted.accessToken,
      }),
    ).repositories,
  ).map(giteaRepository);

// What a verification found. Every check is reported rather than failing the
// request: a URL that is not a Gitea instance, a repository the token cannot
// see and a token short on issue permissions are all 200 answers here, with
// the reason in the fields.
export type GiteaVerification = {
  isInstalled: boolean;
  hasRequiredPermissions: boolean;
  repositoryExists: boolean;
  repositoryPrivate: boolean | null;
  missingPermissions: string[];
  message: string;
  failureReason: string | null;
};

const giteaVerification = (v: GenGiteaVerificationResult | undefined): GiteaVerification => ({
  isInstalled: v?.isInstalled ?? false,
  hasRequiredPermissions: v?.hasRequiredPermissions ?? false,
  repositoryExists: v?.repositoryExists ?? false,
  repositoryPrivate: v?.repositoryPrivate ?? null,
  missingPermissions: zeroList(v?.missingPermissions),
  message: v?.message ?? "",
  failureReason: v?.failureReason ?? null,
});

// Checks the instance, the token and the repository without storing anything.
// accessToken left out asks the server to verify with the saved token, which
// it does only when the base URL is the saved integration's.
export const verifyGiteaAccess = async (wanted: { projectId: string } & GiteaTarget): Promise<GiteaVerification> =>
  giteaVerification(zeroRecord(await postGiteaVerify({ projectId: wanted.projectId, ...giteaTarget(wanted) })));

// What an issue import did. errors lists the issues it could not bring in,
// each with its reason; the counts still cover every issue it looked at.
export type GiteaImportResult = {
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
};

// Imports the linked repository's open issues as tasks. Issues that already
// have a task are refreshed rather than duplicated.
export const importGiteaIssues = async (projectId: string): Promise<GiteaImportResult> => {
  const r = zeroRecord<GenGiteaImportResult>(await postGiteaImport({ projectId }));
  return {
    imported: r.imported ?? 0,
    updated: r.updated ?? 0,
    skipped: r.skipped ?? 0,
    errors: zeroList(r.errors),
  };
};

// A project's link to a GitLab project. The token itself is never returned:
// maskedAccessToken is the part of it a caller with manage_settings sees, and
// "" for anyone else — webhookSecret and webhookUrl are answered the same
// way, since the secret is what a caller pastes into GitLab's webhook form.
// A field the server leaves out reads as null, the way the rest of this file
// reads an absent optional.
export type GitlabIntegration = {
  id: string;
  projectId: string;
  baseUrl: string;
  projectPath: string;
  tokenType: "private" | "bearer";
  maskedAccessToken: string;
  webhookUrl: string;
  webhookSecret: string;
  branchPattern: string | null;
  commentTaskLinkOnGitlabIssue: boolean | null;
  isActive: boolean | null;
  createdAt: string;
  updatedAt: string;
};

const gitlabIntegration = (raw: NonNullable<GenGitlabIntegration>): GitlabIntegration => ({
  id: raw.id ?? "",
  projectId: raw.projectId ?? "",
  baseUrl: raw.baseUrl ?? "",
  projectPath: raw.projectPath ?? "",
  // The server defaults to the PRIVATE-TOKEN header form; anything but
  // "bearer" is read the way it writes a token it does not know.
  tokenType: raw.tokenType === "bearer" ? "bearer" : "private",
  maskedAccessToken: raw.maskedAccessToken ?? "",
  webhookUrl: raw.webhookUrl ?? "",
  webhookSecret: raw.webhookSecret ?? "",
  branchPattern: raw.branchPattern ?? null,
  commentTaskLinkOnGitlabIssue: raw.commentTaskLinkOnGitlabIssue ?? null,
  isActive: raw.isActive ?? null,
  createdAt: isoTime(raw, "createdAt"),
  updatedAt: isoTime(raw, "updatedAt"),
});

// A write's reply is the stored link; a null is a reply the server should
// never send, since the write either happened or failed, and reading it as
// "no integration" would report the opposite of what occurred.
const writtenGitlab = (reply: GenGitlabIntegration | null | undefined, path: string): GitlabIntegration => {
  if (reply === null || reply === undefined) {
    throw new Error(`${path}: the server answered without the integration`);
  }
  return gitlabIntegration(reply);
};

// The stored link, or null when the project has none. The masked token and
// webhook secret come back empty for a caller that may not manage the
// workspace's settings; that is the server's answer, passed through.
export const getGitlabIntegration = async (projectId: string): Promise<GitlabIntegration | null> => {
  const reply = await readGitlabIntegration(pathParam(projectId));
  return reply === null || reply === undefined ? null : gitlabIntegration(reply);
};

// The request bodies the check-before-connect calls take. The access token is
// a secret, so the CLI reads it from stdin and the body is built here rather
// than exposed as a flag.
export type GitlabProjectQuery = ListGitlabProjectsBody;
export type GitlabAccessCheck = VerifyGitlabAccessBody;
export type GitlabLink = CreateGitlabIntegrationBody;
export type GitlabLinkChanges = UpdateGitlabIntegrationBody;

// A project on the GitLab instance the token is a member of. The fields keep
// GitLab's own names: path_with_namespace is what --project-path takes.
export type GitlabProject = {
  id: number;
  name: string;
  path_with_namespace: string;
  name_with_namespace: string;
  visibility: string;
  web_url: string;
};

const gitlabProject = (p: GenGitlabProject): GitlabProject => ({
  id: p.id ?? 0,
  name: p.name ?? "",
  path_with_namespace: p.path_with_namespace ?? "",
  name_with_namespace: p.name_with_namespace ?? "",
  visibility: p.visibility ?? "",
  web_url: p.web_url ?? "",
});

// The projects the token can see, for picking one to link. The token travels
// in the body, never in the URL.
export const listGitlabProjects = async (query: GitlabProjectQuery): Promise<GitlabProject[]> =>
  zeroList(zeroRecord(await postGitlabProjects(query)).projects).map(gitlabProject);

// What the server found when it checked the token against the instance and
// the project. A check that fails for a reason it can name — not a GitLab
// instance, a redirect, a project the token cannot see — is answered in this
// body rather than as an error; only a token GitLab rejects outright comes
// back as a failure.
export type GitlabVerification = {
  isInstalled: boolean;
  hasRequiredPermissions: boolean;
  projectExists: boolean;
  projectVisibility: string | null;
  missingPermissions: string[];
  message: string;
  failureReason: "not_a_gitlab_instance" | "redirected" | "project_not_found" | null;
};

const gitlabVerification = (v: GenGitlabVerificationResult): GitlabVerification => ({
  isInstalled: v.isInstalled ?? false,
  hasRequiredPermissions: v.hasRequiredPermissions ?? false,
  projectExists: v.projectExists ?? false,
  projectVisibility: v.projectVisibility ?? null,
  missingPermissions: zeroList(v.missingPermissions),
  message: v.message ?? "",
  failureReason: v.failureReason ?? null,
});

export const verifyGitlabAccess = async (query: GitlabAccessCheck): Promise<GitlabVerification> =>
  gitlabVerification(zeroRecord(await postGitlabVerify(query)));

// Links the project to a GitLab project. The server reuses the stored token
// only while the GitLab URL is unchanged, so omitting accessToken here means
// "keep it" — a changed URL without a new token is the server's error to give.
export const createGitlabIntegration = async (projectId: string, body: GitlabLink): Promise<GitlabIntegration> =>
  writtenGitlab(await postGitlabIntegration(pathParam(projectId), body), `/gitlab-integration/project/${projectId}`);

// Changes the stored link's settings; only what is passed changes, and the
// server keeps the token and every other field.
export const updateGitlabIntegration = async (
  projectId: string,
  changes: GitlabLinkChanges,
): Promise<GitlabIntegration> =>
  writtenGitlab(
    await patchGitlabIntegration(pathParam(projectId), changes),
    `/gitlab-integration/project/${projectId}`,
  );

export type GitlabDeleteResult = { success: boolean; message: string };

// Unlinks the project. The server answers 404 when there is no link, which
// the transport reports like any other failure.
export const deleteGitlabIntegration = async (projectId: string): Promise<GitlabDeleteResult> => {
  const r = zeroRecord(await removeGitlabIntegration(pathParam(projectId)));
  return { success: r.success ?? false, message: r.message ?? "" };
};

// What one import run did. errors lists the issues that failed; the counts
// are still the server's, and a partial import is not an error here.
export type GitlabImportResult = {
  imported: number;
  updated: number;
  skipped: number;
  errors?: string[];
};

export const importGitlabIssues = async (projectId: string): Promise<GitlabImportResult> => {
  const r = zeroRecord(await postGitlabImport({ projectId }));
  return {
    imported: r.imported ?? 0,
    updated: r.updated ?? 0,
    skipped: r.skipped ?? 0,
    ...(r.errors === undefined ? {} : { errors: zeroList(r.errors) }),
  };
};

// ---- GitHub integration ----
//
// The GitHub surface of `kaneo integration github`. Three of its routes —
// repositories, verify and connect — sit behind the server's user-session
// check, which an API key alone does not pass on v2.32.0, so against that
// release they answer 403 until the web app's GitHub sign-in has run. The
// calls are made the same way regardless: a server that accepts the key
// answers them, and the refusal the key-only server gives is itself the
// answer.

// The GitHub App this instance is configured with. accountConnected is about
// the key's user rather than the App: linking a GitHub account is a web-app
// flow, and it is what the repository routes need before they will answer
// anything but a session refusal.
export type GitHubAppInfo = {
  appName: string | null;
  accountConnected: boolean;
  accountLinkingAvailable: boolean;
};

export const githubAppInfo = async (): Promise<GitHubAppInfo> => {
  const info = zeroRecord(await readGitHubAppInfo());
  return {
    appName: info.appName ?? null,
    accountConnected: info.accountConnected ?? false,
    accountLinkingAvailable: info.accountLinkingAvailable ?? false,
  };
};

// A repository the installed App reaches. The field names stay GitHub's own —
// full_name, html_url, installation_id — because the server echoes them from
// GitHub's API, and --json keeps them so a value reads the same here as it
// does there.
type GitHubRepository = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  owner: { login: string; avatar_url: string; type: string };
  description: string | null;
  html_url: string;
  permissions?: { admin: boolean; push: boolean; pull: boolean };
  updated_at: string;
  installation_id: number;
};

const gitHubRepository = (r: GenGitHubRepository): GitHubRepository => ({
  id: r.id ?? 0,
  name: r.name ?? "",
  full_name: r.full_name ?? "",
  private: r.private ?? false,
  owner: {
    login: r.owner?.login ?? "",
    avatar_url: r.owner?.avatar_url ?? "",
    type: r.owner?.type ?? "",
  },
  description: r.description ?? null,
  html_url: r.html_url ?? "",
  permissions: r.permissions,
  updated_at: isoTime(r, "updated_at"),
  installation_id: r.installation_id ?? 0,
});

// One App installation and the repositories under it. account is null for an
// installation GitHub attributes to no account; repositories holds full names
// and is empty when the server could not list them.
type GitHubInstallation = {
  id: number;
  account: { login: string; type: string } | null;
  repositories: string[];
};

const gitHubInstallation = (i: GenGitHubInstallation): GitHubInstallation => ({
  id: i.id ?? 0,
  account:
    i.account === null || i.account === undefined ? null : { login: i.account.login ?? "", type: i.account.type ?? "" },
  repositories: zeroList(i.repositories),
});

// One page of the repositories the App reaches. The server pages
// installations and each installation's repositories separately; nextPage is
// the cursor to pass back for the following page and is null once both are
// exhausted.
export type GitHubRepositoryPage = {
  repositories: GitHubRepository[];
  installations: GitHubInstallation[];
  total: number;
  nextPage: { installationPage: number; repositoryPage: number } | null;
};

export const listGitHubRepositories = async (
  projectId: string,
  page: { installationPage?: string; repositoryPage?: string } = {},
): Promise<GitHubRepositoryPage> => {
  const params: ListGitHubRepositoriesParams = {};
  if (page.installationPage !== undefined) params.installationPage = page.installationPage;
  if (page.repositoryPage !== undefined) params.repositoryPage = page.repositoryPage;
  const reply = zeroRecord(await readGitHubRepositories(pathParam(projectId), params));
  return {
    repositories: zeroList(reply.repositories).map(gitHubRepository),
    installations: zeroList(reply.installations).map(gitHubInstallation),
    total: reply.total ?? 0,
    nextPage: reply.nextPage ?? null,
  };
};

// What verify reports about a repository before it is linked: whether the App
// is installed on it and holds the permissions Kaneo needs. Problems are data
// rather than errors — the route answers 200 either way — so the result is
// returned as sent for the caller to read. settingsUrl and installationUrl are
// absent rather than null when there is nowhere to point.
export type GitHubVerification = {
  isInstalled: boolean;
  installationId: number | null;
  repositoryExists: boolean | null;
  repositoryPrivate: boolean | null;
  permissions: Record<string, string> | null;
  hasRequiredPermissions: boolean;
  missingPermissions: string[];
  message: string;
  settingsUrl: string | null;
  installationUrl: string | null;
};

export const verifyGitHubRepository = async (
  projectId: string,
  repositoryOwner: string,
  repositoryName: string,
): Promise<GitHubVerification> => {
  const body: VerifyGitHubInstallationBody = { projectId, repositoryOwner, repositoryName };
  const reply = zeroRecord(await postGitHubVerification(body));
  return {
    isInstalled: reply.isInstalled ?? false,
    installationId: reply.installationId ?? null,
    repositoryExists: reply.repositoryExists ?? null,
    repositoryPrivate: reply.repositoryPrivate ?? null,
    permissions: reply.permissions ?? null,
    hasRequiredPermissions: reply.hasRequiredPermissions ?? false,
    missingPermissions: zeroList(reply.missingPermissions),
    message: reply.message ?? "",
    settingsUrl: reply.settingsUrl ?? null,
    installationUrl: reply.installationUrl ?? null,
  };
};

// The progress of a GitHub issue import, as both the import route and the
// integration read report it.
export type GitHubImportResult = {
  runId: string;
  pending: boolean;
  imported: number;
  updated: number;
  skipped: number;
};

const importResult = (r: GenIssueImportResult): GitHubImportResult => ({
  runId: r.runId ?? "",
  pending: r.pending ?? false,
  imported: r.imported ?? 0,
  updated: r.updated ?? 0,
  skipped: r.skipped ?? 0,
});

// The integration a project is linked to. The optional fields are the ones a
// reply may leave out: importProgress only rides along while the server holds
// a run for the linked repository, and branchPattern and
// commentTaskLinkOnGitHubIssue only when the stored config carries them —
// both default on the server, so an absent one reads as the default there.
// isActive is null only on replies that carry no row flag at all.
export type GitHubIntegration = {
  id: string;
  projectId: string;
  repositoryOwner: string;
  repositoryName: string;
  installationId: number | null;
  requiresVerification: boolean;
  importProgress: GitHubImportResult | null;
  branchPattern: string | null;
  commentTaskLinkOnGitHubIssue: boolean | null;
  isActive: boolean | null;
  createdAt: string;
  updatedAt: string;
};

const gitHubIntegration = (i: GenCreatedGitHubIntegration): GitHubIntegration => ({
  id: i.id ?? "",
  projectId: i.projectId ?? "",
  repositoryOwner: i.repositoryOwner ?? "",
  repositoryName: i.repositoryName ?? "",
  installationId: i.installationId ?? null,
  requiresVerification: i.requiresVerification ?? false,
  importProgress: i.importProgress ? importResult(i.importProgress) : null,
  branchPattern: i.branchPattern ?? null,
  commentTaskLinkOnGitHubIssue: i.commentTaskLinkOnGitHubIssue ?? null,
  isActive: i.isActive ?? null,
  createdAt: isoTime(i, "createdAt"),
  updatedAt: isoTime(i, "updatedAt"),
});

// The project's GitHub integration, or null when it has none.
export const getGitHubIntegration = async (projectId: string): Promise<GitHubIntegration | null> => {
  const reply = (await readGitHubIntegration(pathParam(projectId))) ?? null;
  return reply === null ? null : gitHubIntegration(reply);
};

// Links the project to a repository the App installation reaches. The server
// verifies ownership and admin access first, answers the existing integration
// when the same repository is already linked, and refuses a different one with
// 409 — disconnect first to switch.
export const connectGitHubRepository = async (
  projectId: string,
  repositoryOwner: string,
  repositoryName: string,
): Promise<GitHubIntegration> => {
  const body: CreateGitHubIntegrationBody = { repositoryOwner, repositoryName };
  return gitHubIntegration(zeroRecord(await postGitHubIntegration(pathParam(projectId), body)));
};

// Writes the settings a caller names and leaves the rest as stored. A changes
// object that serializes to nothing — empty, or every field undefined — is
// refused here rather than sent: the route answers the current integration
// either way, which would look like a change that was not. The route answers
// 404 for a project with no integration, so a 200 carrying none is a reply
// that confirms nothing was written and is refused the way a write the server
// did not echo is.
export const updateGitHubIntegration = async (
  projectId: string,
  changes: UpdateGitHubIntegrationBody,
): Promise<GitHubIntegration> => {
  if (Object.values(changes).every((value) => value === undefined)) {
    throw new Error("no GitHub integration settings to change");
  }
  const reply = (await patchGitHubIntegration(pathParam(projectId), changes)) ?? null;
  if (reply === null) throw new Error(`/github-integration/project/${projectId}: server did not echo the update`);
  return gitHubIntegration(reply);
};

// What the delete route answers.
export type GitHubDeleteResult = {
  success: boolean;
  message: string;
};

export const deleteGitHubIntegration = async (projectId: string): Promise<GitHubDeleteResult> => {
  const reply = zeroRecord(await removeGitHubIntegration(pathParam(projectId)));
  return { success: reply.success ?? false, message: reply.message ?? "" };
};

// Runs a GitHub issue import to completion. The route is resumable: it answers
// 202 with pending while a run has pages left and 200 once done, and the next
// request continues the same run when it carries the runId the last reply
// named. A call without runId resumes an unfinished run or starts a new one,
// so repeating the request is safe. The runId is sent only once the server has
// named one — an empty one would be refused.
//
// The import lock is held for the length of one request's pages, and another
// client's request holding it is answered 429 with Retry-After: 1; that is
// waited out the way a busy label delete is, five times in a row at most, the
// count starting over after each page that went through.
//
// The counts a pending reply reports are the only progress the route shows,
// and only an issue's own page moves them: the pages that finish an issue's
// labels and comments and every pull-request page report the same numbers
// however much they do, so a run can hold them for a stretch and still be
// working. A run reporting the same counts IMPORT_STALL_LIMIT requests in a
// row is given up on as stuck — its progress is saved after each page, so
// the same command resumes it — rather than polled for ever.
export const importGitHubIssues = async (projectId: string, runId?: string): Promise<GitHubImportResult> => {
  let run = runId;
  let busy = 0;
  let lastCounts = "";
  let held = 0;
  for (;;) {
    const body: ImportGitHubIssuesBody = { projectId };
    if (run !== undefined && run !== "") body.runId = run;
    let reply: GenIssueImportResult;
    try {
      reply = zeroRecord(await postGitHubIssueImport(body));
    } catch (e) {
      if (e instanceof KaneoApiError && e.statusCode === 429 && busy < IMPORT_BUSY_RETRIES) {
        busy++;
        await Bun.sleep(IMPORT_BUSY_WAIT_MS);
        continue;
      }
      throw e;
    }
    const result = importResult(reply);
    if (result.pending !== true) return result;
    busy = 0;
    if (result.runId !== "") run = result.runId;
    const counts = `${result.imported}/${result.updated}/${result.skipped}`;
    held = counts === lastCounts ? held + 1 : 1;
    lastCounts = counts;
    if (held >= IMPORT_STALL_LIMIT) {
      // The project is always named: the run is saved under the project this
      // call resolved, which need not be the one the reader's settings pick.
      const resume = `kaneo integration github import -p ${shellWord(projectId)}${
        run === undefined || run === "" ? "" : ` --run-id ${shellWord(run)}`
      }`;
      throw new Error(
        `the GitHub import's counts have not changed in ${IMPORT_STALL_LIMIT} requests; the run is saved, so \`${resume}\` resumes it`,
      );
    }
  }
};

// The server's own numbers: the lock's 429 carries Retry-After: 1. The stall
// limit is set far past the stretch one issue's own pages, or a pull-request
// tail of ordinary size, can hold the same counts for; a run that still holds
// them is stuck or too large to finish in one invocation, and resumes either
// way.
const IMPORT_BUSY_RETRIES = 5;
const IMPORT_BUSY_WAIT_MS = 1000;
const IMPORT_STALL_LIMIT = 100;

// ===== Instance, public boards and avatars =====
//
// The routes in this section are the ones the document marks security: [] —
// the instance's own status and configuration, the public project board and
// its description pages, and user avatars — plus the avatar writes, which do
// take the key. The anonymous ones are called with anonymous so a profile's
// api_key_command is not run for a route that never needed it.

// Whether the instance has any users and any admin yet: what the sign-up page
// asks before it offers a form.
export const instanceStatus = async (): Promise<GenInstanceStatus> =>
  zeroRecord(await readInstanceStatus({ anonymous: true }));

// The instance's public configuration. The server sends fields the pinned
// document does not name (instanceName, hasImageUploads, ...), which the
// transport passes through untouched; the type names only what is documented.
export const instanceConfig = async (): Promise<GenConfig> => zeroRecord(await readInstanceConfig({ anonymous: true }));

// The better-auth session the credential resolves to, or null when there is
// none. The session's token is a credential in its own right and is left out
// of what is reported.
export type AuthSession = {
  user: { id: string; name: string; email: string };
  session: {
    id: string;
    userId: string;
    createdAt: string;
    expiresAt: string;
    ipAddress: string | null;
    userAgent: string | null;
  };
};

type SessionReply = {
  user?: { id?: string; name?: string; email?: string } | undefined;
  session?:
    | {
        id?: string;
        userId?: string;
        createdAt?: string;
        expiresAt?: string;
        ipAddress?: string | null;
        userAgent?: string | null;
      }
    | undefined;
} | null;

export const authSession = async (): Promise<AuthSession | null> => {
  const reply = await kaneoFetch<SessionReply>("/auth/get-session", { method: "GET" });
  if (reply === null || reply === undefined) return null;
  const user = reply.user ?? {};
  const session = reply.session ?? {};
  return {
    user: { id: user.id ?? "", name: user.name ?? "", email: user.email ?? "" },
    session: {
      id: session.id ?? "",
      userId: session.userId ?? "",
      createdAt: isoTime(session, "createdAt"),
      expiresAt: isoTime(session, "expiresAt"),
      ipAddress: session.ipAddress ?? null,
      userAgent: session.userAgent ?? null,
    },
  };
};

// What the public project listing is asked for, on top of the paging the read
// itself drives. sortBy and sortOrder are the document's enums; anything else
// is refused by the command before it gets here.
export type PublicBoardFilters = {
  status?: string;
  priority?: string;
  assigneeId?: string;
  sortBy?: NonNullable<GetPublicProjectParams["sortBy"]>;
  sortOrder?: NonNullable<GetPublicProjectParams["sortOrder"]>;
  dueBefore?: string;
  dueAfter?: string;
  limit?: number;
};

const publicParams = (filters: PublicBoardFilters, page: number, relatedPage: number): GetPublicProjectParams => ({
  ...(filters.status === undefined || filters.status === "" ? {} : { status: filters.status }),
  ...(filters.priority === undefined || filters.priority === "" ? {} : { priority: filters.priority }),
  ...(filters.assigneeId === undefined || filters.assigneeId === "" ? {} : { assigneeId: filters.assigneeId }),
  page,
  relatedPage,
  ...(filters.limit === undefined ? {} : { limit: filters.limit }),
  ...(filters.sortBy === undefined ? {} : { sortBy: filters.sortBy }),
  ...(filters.sortOrder === undefined ? {} : { sortOrder: filters.sortOrder }),
  ...(filters.dueBefore === undefined || filters.dueBefore === "" ? {} : { dueBefore: filters.dueBefore }),
  ...(filters.dueAfter === undefined || filters.dueAfter === "" ? {} : { dueAfter: filters.dueAfter }),
});

const readPublicBoard = async (
  projectId: string,
  filters: PublicBoardFilters,
  stopAt?: (page: Task[]) => Task | undefined,
): Promise<Reading> =>
  readPages(
    async (page, related) => {
      const response = zeroRecord(
        await readPublicProject(pathParam(projectId), publicParams(filters, page, related), { anonymous: true }),
      );
      // The page is the board fields beside its pagination block, so it stands
      // in for the data the keyed listing nests them under.
      return { data: response as GenBoard, pagination: response.pagination };
    },
    projectId,
    stopAt,
    true,
  );

// A public project's columns and tasks, every page of them, read without a
// key: the route is the one a shared board link is served by. The merge and
// the moved-under-the-reader rereads are the keyed board's own.
export const getPublicBoard = async (projectId: string, filters: PublicBoardFilters = {}): Promise<Board> => {
  let read = await readPublicBoard(projectId, filters);
  for (let again = 0; read.moved && again < REREADS; again++) read = await readPublicBoard(projectId, filters);
  if (read.moved) console.error(changed(projectId));
  return read.board;
};

// One task by number on a public board, for the task description route that
// names tasks by id: the number is what a reader of the board has, so it is
// resolved the way findTaskByNumber resolves it on the keyed board.
export const findPublicTaskByNumber = async (
  projectId: string,
  number: number,
): Promise<{ board: Board; task: Task | undefined }> => {
  const stopAt = (page: Task[]): Task | undefined => page.find((task) => task.number === number);
  let read = await readPublicBoard(projectId, {}, stopAt);
  for (let again = 0; read.stopped === undefined && read.moved && again < REREADS; again++) {
    read = await readPublicBoard(projectId, {}, stopAt);
  }
  if (read.stopped === undefined && read.moved) console.error(changed(projectId));
  return { board: read.board, task: read.stopped };
};

// A description read whole: the pages are contiguous slices of one text, so
// the content is their concatenation and the version is the one they were all
// read under. The first page's version is pinned onto every later offset, so
// an edit mid-read is answered 409 rather than spliced into the text.
export type Description = { content: string; version: string };

// The server serves a description in 32K-character pages, so this many pages
// is a text of hundreds of megabytes — far past any real description. The cap
// exists for a nextOffset that keeps advancing without end: without it the
// read would hold the process in a request loop.
const DESCRIPTION_PAGES = 8192;

const readDescription = async (
  fetchPage: (offset: number, version: string | undefined) => Promise<GenDescriptionPage>,
): Promise<Description> => {
  let content = "";
  let version: string | undefined;
  for (let offset = 0, pages = 0; ; pages++) {
    if (pages === DESCRIPTION_PAGES) {
      throw new Error(`description read passed ${DESCRIPTION_PAGES} pages and nextOffset still had not ended the text`);
    }
    const page = zeroRecord(await fetchPage(offset, version));
    content += page.content ?? "";
    // The first page that names a version pins every later offset to it; one
    // that names none leaves the read unpinned, as it was.
    version ??= page.version || undefined;
    const next = page.nextOffset;
    if (next === null || next === undefined) break;
    // A next offset that does not advance would reread the same page for
    // ever, and answering the text read so far would pass a prefix off as the
    // whole description; the read fails instead.
    if (next <= offset) {
      throw new Error(`description page at offset ${offset} answered nextOffset ${next}, which does not advance`);
    }
    offset = next;
  }
  return { content, version: version ?? "" };
};

// The public project description, every page of it.
export const getPublicProjectDescription = (projectId: string): Promise<Description> =>
  readDescription((offset, version) =>
    readPublicDescription(pathParam(projectId), { offset, version }, { anonymous: true }),
  );

// The public task description, every page of it. taskId is the task's id,
// which the board listing carries.
export const getPublicTaskDescription = (projectId: string, taskId: string): Promise<Description> =>
  readDescription((offset, version) =>
    readPublicTaskDescription(pathParam(projectId), pathParam(taskId), { offset, version }, { anonymous: true }),
  );

// Bytes a binary route answered with, and the content type it was served as.
export type Download = { data: Uint8Array; contentType: string };

const toDownload = async (blob: Blob): Promise<Download> => ({
  data: new Uint8Array(await blob.arrayBuffer()),
  contentType: blob.type,
});

// An asset's bytes. Assets can belong to the private side of a board, so the
// key is sent when one is configured; a public asset answers without it.
export const downloadAsset = async (assetId: string): Promise<Download> =>
  toDownload(await readAsset(pathParam(assetId), { blob: true }));

// A user's avatar image, served without authentication: the route is how a
// shared board shows its members' faces. The path names the avatar record's
// id, which changes whenever the image is replaced — not the user's.
export const downloadAvatar = async (avatarId: string): Promise<Download> =>
  toDownload(await readAvatar(pathParam(avatarId), { blob: true, anonymous: true }));

// Sets the credential's own avatar: the image's bytes as base64 and the type
// they are, which the command reads off the file.
export const uploadAvatar = async (contentType: string, data: string): Promise<GenUserAvatar> =>
  zeroRecord(await putAvatar({ contentType, data } satisfies UploadUserAvatarBody));

// Removes the credential's own avatar.
export const deleteAvatar = async (): Promise<GenUserAvatarDeleted> => zeroRecord(await removeAvatar());

// ---- Chat integrations: slack, discord, telegram ----

// The six events a chat integration can be told about. A reply carries all
// six; a write carries only the toggles it means to change, which the server
// merges into the stored set rather than replacing it.
export type IntegrationEvents = {
  taskCreated: boolean;
  taskStatusChanged: boolean;
  taskPriorityChanged: boolean;
  taskTitleChanged: boolean;
  taskDescriptionChanged: boolean;
  taskCommentCreated: boolean;
};

export type IntegrationEventChanges = Partial<IntegrationEvents>;

const integrationEvents = (e: IntegrationEventChanges | undefined): IntegrationEvents => ({
  taskCreated: e?.taskCreated === true,
  taskStatusChanged: e?.taskStatusChanged === true,
  taskPriorityChanged: e?.taskPriorityChanged === true,
  taskTitleChanged: e?.taskTitleChanged === true,
  taskDescriptionChanged: e?.taskDescriptionChanged === true,
  taskCommentCreated: e?.taskCommentCreated === true,
});

// Slack and Discord answer the same shape: the channel the messages go to, the
// webhook URL masked down to its non-secret parts, and the event toggles. The
// stored secret itself never comes back — webhookConfigured says there is one.
export type WebhookIntegration = {
  id: string;
  projectId: string;
  channelName: string | null;
  webhookConfigured: boolean;
  maskedWebhookUrl: string;
  events: IntegrationEvents;
  isActive: boolean | null;
  createdAt: string;
  updatedAt: string;
};

// Telegram's row names the chat rather than a channel, and the bot token
// masked the way the server masks it (the part before the colon, then the
// secret half shortened).
export type TelegramIntegration = {
  id: string;
  projectId: string;
  chatId: string;
  threadId: number | null;
  chatLabel: string | null;
  botTokenConfigured: boolean;
  maskedBotToken: string;
  events: IntegrationEvents;
  isActive: boolean | null;
  createdAt: string;
  updatedAt: string;
};

const webhookIntegration = (i: GenSlackIntegration | GenDiscordIntegration | undefined): WebhookIntegration | null => {
  if (i === null || i === undefined) return null;
  return {
    id: i.id ?? "",
    projectId: i.projectId ?? "",
    channelName: i.channelName ?? null,
    webhookConfigured: i.webhookConfigured === true,
    maskedWebhookUrl: i.maskedWebhookUrl ?? "",
    events: integrationEvents(i.events),
    isActive: i.isActive ?? null,
    createdAt: isoTime(i, "createdAt"),
    updatedAt: isoTime(i, "updatedAt"),
  };
};

const telegramIntegration = (i: GenTelegramIntegration | undefined): TelegramIntegration | null => {
  if (i === null || i === undefined) return null;
  return {
    id: i.id ?? "",
    projectId: i.projectId ?? "",
    chatId: i.chatId ?? "",
    threadId: i.threadId ?? null,
    chatLabel: i.chatLabel ?? null,
    botTokenConfigured: i.botTokenConfigured === true,
    maskedBotToken: i.maskedBotToken ?? "",
    events: integrationEvents(i.events),
    isActive: i.isActive ?? null,
    createdAt: isoTime(i, "createdAt"),
    updatedAt: isoTime(i, "updatedAt"),
  };
};

// What connecting a webhook chat integration takes. The webhook URL is the
// secret the events are delivered through; the server checks its shape only.
export type NewWebhookIntegration = {
  webhookUrl: string;
  channelName?: string;
  events?: IntegrationEventChanges;
};

// Only the fields passed are sent; the server keeps the rest and merges the
// event toggles into the stored set. channelName accepts null to clear it.
export type WebhookIntegrationChanges = {
  webhookUrl?: string;
  channelName?: string | null;
  isActive?: boolean;
  events?: IntegrationEventChanges;
};

// What connecting a Telegram integration takes. The bot token is the secret;
// the chat is checked for shape only, not against Telegram.
export type NewTelegramIntegration = {
  botToken: string;
  chatId: string;
  threadId?: number;
  chatLabel?: string;
  events?: IntegrationEventChanges;
};

// Only the fields passed are sent; threadId and chatLabel accept null to
// clear them.
export type TelegramIntegrationChanges = {
  botToken?: string;
  chatId?: string;
  threadId?: number | null;
  chatLabel?: string | null;
  isActive?: boolean;
  events?: IntegrationEventChanges;
};

export const getSlackIntegration = async (projectId: string): Promise<WebhookIntegration | null> =>
  webhookIntegration(await readSlackIntegration(pathParam(projectId)));

export const createSlackIntegration = async (
  projectId: string,
  wanted: NewWebhookIntegration,
): Promise<WebhookIntegration | null> => webhookIntegration(await postSlackIntegration(pathParam(projectId), wanted));

export const updateSlackIntegration = async (
  projectId: string,
  changes: WebhookIntegrationChanges,
): Promise<WebhookIntegration | null> => webhookIntegration(await patchSlackIntegration(pathParam(projectId), changes));

export const deleteSlackIntegration = async (projectId: string): Promise<{ success: boolean }> =>
  zeroRecord(await removeSlackIntegration(pathParam(projectId)));

export const getDiscordIntegration = async (projectId: string): Promise<WebhookIntegration | null> =>
  webhookIntegration(await readDiscordIntegration(pathParam(projectId)));

export const createDiscordIntegration = async (
  projectId: string,
  wanted: NewWebhookIntegration,
): Promise<WebhookIntegration | null> => webhookIntegration(await postDiscordIntegration(pathParam(projectId), wanted));

export const updateDiscordIntegration = async (
  projectId: string,
  changes: WebhookIntegrationChanges,
): Promise<WebhookIntegration | null> =>
  webhookIntegration(await patchDiscordIntegration(pathParam(projectId), changes));

export const deleteDiscordIntegration = async (projectId: string): Promise<{ success: boolean }> =>
  zeroRecord(await removeDiscordIntegration(pathParam(projectId)));

export const getTelegramIntegration = async (projectId: string): Promise<TelegramIntegration | null> =>
  telegramIntegration(await readTelegramIntegration(pathParam(projectId)));

export const createTelegramIntegration = async (
  projectId: string,
  wanted: NewTelegramIntegration,
): Promise<TelegramIntegration | null> =>
  telegramIntegration(await postTelegramIntegration(pathParam(projectId), wanted));

export const updateTelegramIntegration = async (
  projectId: string,
  changes: TelegramIntegrationChanges,
): Promise<TelegramIntegration | null> =>
  telegramIntegration(await patchTelegramIntegration(pathParam(projectId), changes));

export const deleteTelegramIntegration = async (projectId: string): Promise<{ success: boolean }> =>
  zeroRecord(await removeTelegramIntegration(pathParam(projectId)));

// Adds a link by hand: the URL is the whole of what the server needs, the
// title only a label for it. The reply is the stored link minus the
// integration join the listing carries — a hand-added link has none, so its
// type reads as null the same way.
export const createExternalLink = async (
  taskId: string,
  wanted: { url: string; title?: string },
): Promise<ExternalLink> => {
  const created = zeroRecord(
    await postExternalLink(pathParam(taskId), {
      url: wanted.url,
      ...(wanted.title === undefined ? {} : { title: wanted.title }),
    }),
  );
  return {
    id: created.id ?? "",
    taskId: created.taskId ?? "",
    resourceType: created.resourceType ?? "",
    externalId: created.externalId ?? "",
    url: created.url ?? "",
    title: created.title ?? null,
    integrationType: null,
    createdAt: isoTime(created, "createdAt"),
    updatedAt: isoTime(created, "updatedAt"),
  };
};

// Removes a link from a task. The reply names the link that was removed; a
// link that is not on the task is the server's 404 to report.
export const deleteExternalLink = async (taskId: string, linkId: string): Promise<string> => {
  const removed = zeroRecord(await removeExternalLink(pathParam(taskId), pathParam(linkId)));
  return removed.id ?? "";
};

export type CheckResult = {
  serverOperations: number;
  clientOperations: number;
  covered: Operation[];
  // What this client calls but the server does not offer. Each entry is a
  // command that will fail against this server.
  missing: Operation[];
  // What the server offers and this client does not use yet, with where it is
  // served and the first tag the document gives it.
  newOnServer: ServerOperation[];
  // What the pinned document serves and the server's does not — the reverse
  // of newOnServer: the operations a server upgrade can make available. Like
  // newOnServer it is reported, not a failure: the client calls nothing here.
  notOnServer: ServerOperation[];
  // Request fields of a covered operation whose server definition differs from
  // what this client sends (see requestDrift).
  requestDrift: Drift[];
};

type Document = {
  paths?: Record<string, Record<string, { operationId?: string; tags?: unknown } | undefined> | undefined>;
};

// The comparison between this client and a server. The document is served
// without authentication, so the call is anonymous and works before any key is
// configured, or when a profile's api_key_command fails; it goes
// through the transport like every other call so it lands under /api, since the
// site root answers 200 with the web app's HTML for any path.
export const checkApi = async (): Promise<CheckResult> => {
  const document = zeroRecord(await kaneoFetch<Document>("/openapi", { method: "GET", anonymous: true }));
  const onServer = serverOperations(document);
  const seen = new Set(onServer.map((operation) => operation.id));

  const used = new Set(OPERATIONS.map((operation) => operation.id));
  return {
    serverOperations: onServer.length,
    clientOperations: OPERATIONS.length,
    covered: OPERATIONS.filter((operation) => seen.has(operation.id)),
    missing: OPERATIONS.filter((operation) => !seen.has(operation.id)),
    newOnServer: onServer.filter((operation) => !used.has(operation.id)),
    notOnServer: pinnedOperations.filter((operation) => !seen.has(operation.id)),
    requestDrift: requestDrift(
      clientShapes(pinnedRequests as Record<string, RequestShape>, OPERATIONS),
      requestShapes(document, used),
    ),
  };
};

// A failure's reason. The import route writes a string, but other routes have
// answered with {"message": ...}, and a failure reported without its reason is
// one the reader cannot act on.
const reason = (error: unknown): string => {
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === "string") return message;
  return error === undefined || error === null ? "" : JSON.stringify(error);
};

// A project's Mattermost integration: the incoming webhook task events are
// posted to. The webhook URL is a credential, so the server returns only its
// masked form and whether one is set; the events come back whole, the unset
// ones filled with the server's defaults. isActive is null on rows written
// before the column meant anything, and the delivery query counts only true.
export type MattermostIntegration = {
  id: string;
  projectId: string;
  channelName: string | null;
  webhookConfigured: boolean;
  maskedWebhookUrl: string;
  events: GenIntegrationEvents;
  isActive: boolean | null;
  createdAt: string;
  updatedAt: string;
};

const mattermostIntegration = (i: NonNullable<GenMattermostIntegration>): MattermostIntegration => ({
  id: i.id ?? "",
  projectId: i.projectId ?? "",
  channelName: i.channelName ?? null,
  webhookConfigured: i.webhookConfigured ?? false,
  maskedWebhookUrl: i.maskedWebhookUrl ?? "",
  // These replies carry no schema check, so a toggle the server left out reads
  // as off rather than failing the whole read.
  events: {
    taskCreated: i.events?.taskCreated ?? false,
    taskStatusChanged: i.events?.taskStatusChanged ?? false,
    taskPriorityChanged: i.events?.taskPriorityChanged ?? false,
    taskTitleChanged: i.events?.taskTitleChanged ?? false,
    taskDescriptionChanged: i.events?.taskDescriptionChanged ?? false,
    taskCommentCreated: i.events?.taskCommentCreated ?? false,
  },
  isActive: i.isActive ?? null,
  createdAt: isoTime(i, "createdAt"),
  updatedAt: isoTime(i, "updatedAt"),
});

// A project's generic webhook integration: the outgoing webhook task events
// are POSTed to, signed with the secret when one is set. Like Mattermost's, the
// URL and the secret come back masked only; events come back whole.
export type GenericWebhookIntegration = {
  id: string;
  projectId: string;
  webhookConfigured: boolean;
  maskedWebhookUrl: string | null;
  secretConfigured: boolean;
  maskedSecret: string | null;
  events: GenGenericWebhookEvents;
  dueDateReminderLeadTimeMinutes: number;
  isActive: boolean | null;
  createdAt: string;
  updatedAt: string;
};

const genericWebhookIntegration = (i: NonNullable<GenGenericWebhookIntegration>): GenericWebhookIntegration => ({
  id: i.id ?? "",
  projectId: i.projectId ?? "",
  webhookConfigured: i.webhookConfigured ?? false,
  maskedWebhookUrl: i.maskedWebhookUrl ?? null,
  secretConfigured: i.secretConfigured ?? false,
  maskedSecret: i.maskedSecret ?? null,
  events: {
    taskCreated: i.events?.taskCreated ?? false,
    taskStatusChanged: i.events?.taskStatusChanged ?? false,
    taskPriorityChanged: i.events?.taskPriorityChanged ?? false,
    taskTitleChanged: i.events?.taskTitleChanged ?? false,
    taskDescriptionChanged: i.events?.taskDescriptionChanged ?? false,
    taskCommentCreated: i.events?.taskCommentCreated ?? false,
    taskDeleted: i.events?.taskDeleted ?? false,
    taskMoved: i.events?.taskMoved ?? false,
    taskDueDateChanged: i.events?.taskDueDateChanged ?? false,
    taskAssigneeChanged: i.events?.taskAssigneeChanged ?? false,
    taskUnassigned: i.events?.taskUnassigned ?? false,
    dueDateReminder: i.events?.dueDateReminder ?? false,
  },
  // The server fills the default (1440) when the stored config leaves it out.
  dueDateReminderLeadTimeMinutes: i.dueDateReminderLeadTimeMinutes ?? 1440,
  isActive: i.isActive ?? null,
  createdAt: isoTime(i, "createdAt"),
  updatedAt: isoTime(i, "updatedAt"),
});

// The bodies the two writes take, named for what they are rather than for the
// routes they go to. On create webhookUrl is required; on update every field is
// optional and an event toggle merges into the stored set.
export type NewMattermostIntegration = CreateMattermostIntegrationBody;
export type MattermostIntegrationChanges = UpdateMattermostIntegrationBody;
export type NewGenericWebhookIntegration = CreateGenericWebhookIntegrationBody;
export type GenericWebhookIntegrationChanges = UpdateGenericWebhookIntegrationBody;

// What a removal answers, the document's deletedSchema both providers share.
export type IntegrationRemoved = { success: boolean };

// The integration a project has, or null when it has none: both providers
// answer null rather than 404 for the missing one.
export const getMattermostIntegration = async (projectId: string): Promise<MattermostIntegration | null> => {
  const found = await readMattermostIntegration(pathParam(projectId));
  return found === null || found === undefined ? null : mattermostIntegration(found);
};

export const createMattermostIntegration = async (
  projectId: string,
  wanted: NewMattermostIntegration,
): Promise<MattermostIntegration | null> => {
  const created = await postMattermost(pathParam(projectId), { ...wanted });
  return created === null || created === undefined ? null : mattermostIntegration(created);
};

// Only the fields in changes are sent; the server keeps the rest and merges
// the event toggles it is given into the stored set.
export const updateMattermostIntegration = async (
  projectId: string,
  changes: MattermostIntegrationChanges,
): Promise<MattermostIntegration | null> => {
  const updated = await patchMattermost(pathParam(projectId), { ...changes });
  return updated === null || updated === undefined ? null : mattermostIntegration(updated);
};

// The server refuses with 404 when the project has no integration to remove.
export const deleteMattermostIntegration = async (projectId: string): Promise<IntegrationRemoved> =>
  zeroRecord(await removeMattermost(pathParam(projectId)));

export const getGenericWebhookIntegration = async (projectId: string): Promise<GenericWebhookIntegration | null> => {
  const found = await readGenericWebhookIntegration(pathParam(projectId));
  return found === null || found === undefined ? null : genericWebhookIntegration(found);
};

export const createGenericWebhookIntegration = async (
  projectId: string,
  wanted: NewGenericWebhookIntegration,
): Promise<GenericWebhookIntegration | null> => {
  const created = await postGenericWebhook(pathParam(projectId), { ...wanted });
  return created === null || created === undefined ? null : genericWebhookIntegration(created);
};

// A null secret clears the stored one; the other fields behave as Mattermost's.
export const updateGenericWebhookIntegration = async (
  projectId: string,
  changes: GenericWebhookIntegrationChanges,
): Promise<GenericWebhookIntegration | null> => {
  const updated = await patchGenericWebhook(pathParam(projectId), { ...changes });
  return updated === null || updated === undefined ? null : genericWebhookIntegration(updated);
};

export const deleteGenericWebhookIntegration = async (projectId: string): Promise<IntegrationRemoved> =>
  zeroRecord(await removeGenericWebhook(pathParam(projectId)));

import {
  addComment,
  getProject,
  listComments,
  listWorkspaces,
  TimestampError,
  WriteReplyError,
  type Comment,
  type Task,
} from "../api/kaneo";
import { debug, type App } from "../cli/app";
import { hard } from "../cli/failopen";
import { hookEnv, runHook } from "../cli/hook";
import { taskRef } from "../cli/lookup";
import { format, RUNNING, type Marker } from "./marker";
import * as store from "./store";
import { shellWord } from "../output/output";
import type { Attachment } from "./store";

// Recording a session as working on a task. `session attach` and
// `task create --attach` are the same act reached two ways, so it lives here
// once: two copies would drift, and the marker, the attachment, the history and
// the hook would stop being one thing a session did.

export const env = (name: string): string => process.env[name] ?? "";

// The directory a marker records. Empty when it cannot be read: a session in a
// directory that has since been deleted is still worth recording.
export const cwd = (): string => {
  try {
    return process.cwd();
  } catch {
    return "";
  }
};

// The session this process belongs to, or "" when the environment names none.
// Whether that is fatal is the caller's: `session attach` says so itself, and
// `task create --attach` has to refuse before it creates anything.
export const currentSessionId = (): string => store.currentId(env);

// The attachment a task is recorded as, before the board lookups fill in the
// project and workspace it belongs to.
export const attachmentOf = (task: Task): Attachment => ({ taskId: task.id, number: task.number, title: task.title });

// Records this session as working on a task: the marker in a comment, the
// attachment and the history line beside it, and the attach hook. nextStep is
// what the marker records as the step to come, and may be empty.
//
// The task is resolved by the caller, since `session attach` is given a reference
// and `task create --attach` already holds what it made. Failing after the
// marker is posted is a hard failure: the server has a marker for this session
// that nothing here knows about.
export const attachTask = async (app: App, sessionId: string, task: Task, nextStep: string): Promise<Attachment> => {
  // Looked up before the marker is posted, so the lookups do not widen the
  // window where the server has a marker and this host has no record.
  const attachment = attachmentOf(task);
  const slug = await describeBoard(task, attachment, "attach");

  const marker = store.describe(env, cwd(), RUNNING);
  marker.nextStep = nextStep;
  // Confirmed before anything is written here, so a marker this machine has no
  // record of is one the server kept. A listing that could not be made is a hard
  // failure here, since it would leave the attachment to say what it cannot show.
  const posted = await postMarker(
    task.id,
    marker,
    task.number,
    "nothing is recorded here for it",
    `\`kaneo session attach ${shellWord(taskRef(attachment.projectSlug, task.number, attachment.projectId, attachment.taskId))}\` records it here, and posts a second marker; \`kaneo session status\` shows what is held here`,
  );
  await confirmMarker(task.id, task.number, posted, format(marker), "hard");
  try {
    store.save(store.sessionStore(), sessionId, attachment);
  } catch (e) {
    // The marker is already on the server. Reporting success here would
    // leave `session next` believing nothing is attached, and a retry
    // would post a second marker.
    throw hard(
      `attached ${taskRef(attachment.projectSlug, attachment.number, attachment.projectId, attachment.taskId)} on the server, but could not record it locally: ${(e as Error).message}`,
    );
  }
  try {
    // Appended after the attachment is in place: a history line for an
    // attachment that was never written would name a session as attached
    // when nothing reads it as one.
    store.appendHistory(store.sessionStore(), sessionId, "attach", attachment, new Date());
  } catch (e) {
    // The attachment is saved, so `session next` works; what is missing is
    // the record a check after close relies on, which is worth failing over.
    throw hard(
      `attached ${taskRef(attachment.projectSlug, attachment.number, attachment.projectId, attachment.taskId)}, but could not add it to the session history: ${(e as Error).message}`,
    );
  }

  await runHook(app, "attach", hookEnv("attach", sessionId, task.id, task.number, slug));
  return attachment;
};

// Posts a session marker as a comment of a task and answers the comment the
// server wrote. attach, next and close all post one, so this is the one place
// that does: three would drift, and the one that drifts is the one nobody
// notices.
//
// The reply is returned rather than confirmed here, because when to confirm is
// the caller's decision: `session close` has a local record to bring up to date
// first, and confirming a marker before that record is written is what leaves
// this machine holding a task the server has let go of.
//
// `held` is what the caller's machine is left holding when the reply cannot be
// read and `wayOut` what to run next, both of which differ between the commands.
// A second marker is harmless to the board, which reads the newest one per
// session, so the way out may be to post it again.
export const postMarker = async (
  taskId: string,
  marker: Marker,
  number: number,
  held: string,
  wayOut: string,
): Promise<Comment> => {
  try {
    return await addComment(taskId, format(marker));
  } catch (e) {
    // The server writes the comment before the reply is read, so an unreadable
    // time in the reply means the marker is already there. Staying quiet, as a
    // fail-open command does for a failed request, would leave a retry to post
    // a second one.
    if (e instanceof TimestampError) {
      const inner = e instanceof WriteReplyError ? e.timestamp.message : e.message;
      throw hard(
        `posted the marker on #${number} on the server, but could not read its reply (${inner}); ${held}; ${wayOut}`,
      );
    }
    throw e;
  }
};

// Whether a listing that could not be made fails the command outright, or is an
// ordinary error a fail-open command swallows.
//
// Only `session attach` needs it hard: it confirms before it records the
// attachment, so a marker it cannot confirm has to stop the attach rather than be
// recorded anyway. `session next` records nothing here. `session close` confirms
// after it has cleared the attachment and written the history, so a listing it
// cannot read leaves the close done here and its marker unverified, which is the
// same state a failed post leaves and what fail-open already stays quiet about.
export type ListingFailure = "hard" | "fail-open";

// Confirms the server kept a marker just posted, by looking for it among the
// task's comments and checking the text it stored is the text that was sent.
//
// The post answers with the comment's id, and a listing without it says the
// server does not hold what was just written. The id alone does not say the
// marker survived: a server that dropped or rewrote the body would leave a
// comment that parses as nothing, so the stored text is compared with what was
// submitted — the server keeps comment text verbatim (measured against
// v2.32.0), so a difference is a marker this board cannot read. Both that and
// a reply carrying no id are hard failures whatever the caller asked for, since
// the marker is on the server either way and a fail-open command would swallow
// the only report of it.
export const confirmMarker = async (
  taskId: string,
  number: number,
  posted: Comment,
  body: string,
  listingFailure: ListingFailure,
): Promise<void> => {
  // A reply carrying no id cannot be looked for, which is a different failure
  // from one that was looked for and is not there.
  if (posted.id === "") {
    throw hard(
      `posted the marker on #${number} but the reply carried no id to confirm it by; check kaneo comment ls ${shellWord(taskId)} before retrying`,
    );
  }
  let listed: Comment[];
  try {
    listed = await listComments(taskId);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const message = `posted the marker on #${number} but could not list its comments to confirm it: ${reason}; check kaneo comment ls ${shellWord(taskId)} before retrying`;
    if (listingFailure === "hard") throw hard(message);
    throw new Error(message);
  }
  const held = listed.find((comment) => comment.id === posted.id);
  if (held === undefined) {
    throw hard(
      `posted the marker on #${number} but it is not among its comments; check kaneo comment ls ${shellWord(taskId)} before retrying`,
    );
  }
  if (held.content !== body) {
    throw hard(
      `posted the marker on #${number} but the server stored different text; check kaneo comment ls ${shellWord(taskId)} before retrying`,
    );
  }
};

// Fills in which project and workspace the task is on, which the attachment keeps
// as well as answers the project's slug for the attach hook.
//
// op names the command doing the lookup, so a debug line says which of them
// could not place the board.
//
// Best effort: failing the attach over a name a statusline wants would leave the
// session unattached. A lookup that fails leaves its fields unset, which a reader
// treats as absent.
export const describeBoard = async (task: Task, attachment: Attachment, op: string): Promise<string> => {
  // Never filled from the cwd's project: that is the wrong answer this field
  // exists to avoid, so an unknown project stays unknown.
  attachment.projectId = task.projectId;
  if (attachment.projectId === "") {
    debug(`${op}: task ${task.id} carries no projectId; board not recorded`);
    return "";
  }
  let project;
  try {
    project = await getProject(attachment.projectId);
  } catch (e) {
    debug(`${op}: project ${attachment.projectId} lookup failed: ${(e as Error).message}`);
    return "";
  }
  attachment.projectName = project.name;
  // The slug is what the task reference is written as, so a reader that has the
  // attachment can print "slug#number" without looking the project up again.
  attachment.projectSlug = project.slug;
  attachment.workspaceId = project.workspaceId;
  if (attachment.workspaceId === "") return project.slug;

  let workspaces;
  try {
    workspaces = await listWorkspaces();
  } catch (e) {
    debug(`${op}: workspace lookup failed: ${(e as Error).message}`);
    return project.slug;
  }
  for (const workspace of workspaces) {
    if (workspace.id !== attachment.workspaceId) continue;
    attachment.workspaceName = workspace.name;
    break;
  }
  return project.slug;
};

// Rewrites the local attachment of every session holding this task with what
// the task carries now — its number and board after a move — so `session
// status` does not keep printing the project it had at attach time.
// Answers how many records were rewritten.
//
// The board fields are re-derived rather than kept: the old project's slug
// would otherwise survive beside the new projectId and name a board the task
// is no longer on. History lines are left alone — they record what was known
// at the moment, which a move does not change.
export const refreshHolders = async (task: Task): Promise<number> =>
  store.updateForTask(store.sessionStore(), task.id, async (held) => {
    held.number = task.number;
    held.title = task.title;
    delete held.projectId;
    delete held.projectName;
    delete held.projectSlug;
    delete held.workspaceId;
    delete held.workspaceName;
    await describeBoard(task, held, "move");
  });

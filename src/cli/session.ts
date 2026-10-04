import { apiKey, debug, halfLeft, type App } from "./app";
import { addComment, getProject, listWorkspaces, type Task } from "../api/kaneo";
import { minimumArgs, noArgs, type RunContext } from "./args";
import { failOpen, hard, strictFlag } from "./failopen";
import { hookEnv, runHook } from "./hook";
import { resolveTask } from "./task";
import { CLOSED, format, RUNNING } from "../session/marker";
import * as store from "../session/store";
import type { Attachment } from "../session/store";
import type { Json } from "../output/json";

const env = (name: string): string => process.env[name] ?? "";

// The directory a marker records. Empty when it cannot be read: a session in a
// directory that has since been deleted is still worth recording.
const cwd = (): string => {
  try {
    return process.cwd();
  } catch {
    return "";
  }
};

const requireSessionId = (): string => {
  const id = store.currentId(env);
  if (id === "") throw new Error("no session id: set KANEO_SESSION_ID");
  return id;
};

export const sessionCommand = {
  name: "session",
  short: "Tie the current agent session to a task",
  long:
    "Tie the current agent session to a task.\n\n" +
    "Tasks have no custom fields, so the association is written as a marker in a\n" +
    "task comment. The session is identified by KANEO_SESSION_ID, falling back to\n" +
    "CLAUDE_CODE_SESSION_ID.",
  children: [
    {
      name: "attach",
      use: "attach <task> [next step...]",
      short: "Record that this session is working on a task",
      args: minimumArgs(1),
      flags: [strictFlag],
      run: failOpen(async ({ args, app }: RunContext<App>) => {
        const sessionId = requireSessionId();
        apiKey(app);
        // From here on the lookups and the marker post share one budget, the way
        // they shared one context.
        const task = await resolveTask(app, args[0]!);

        // Looked up before the marker is posted, so the lookups do not widen the
        // window where the server has a marker and this host has no record.
        const attachment = attachmentOf(task);
        const slug = await describeBoard(app, task, attachment);

        const marker = store.describe(env, cwd(), RUNNING);
        marker.nextStep = args.slice(1).join(" ");
        await addComment(task.id, format(marker));
        try {
          store.save(store.sessionStore(), sessionId, attachment);
        } catch (e) {
          // The marker is already on the server. Reporting success here would
          // leave `session next` believing nothing is attached, and a retry
          // would post a second marker.
          throw hard(`attached #${task.number} on the server, but could not record it locally: ${(e as Error).message}`);
        }
        try {
          // Appended after the attachment is in place: a history line for an
          // attachment that was never written would name a session as attached
          // when nothing reads it as one.
          store.appendHistory(store.sessionStore(), sessionId, "attach", attachment, new Date());
        } catch (e) {
          // The attachment is saved, so `session next` works; what is missing is
          // the record a check after close relies on, which is worth failing over.
          throw hard(`attached #${task.number}, but could not add it to the session history: ${(e as Error).message}`);
        }

        await runHook(app, "attach", hookEnv("attach", sessionId, task.id, task.number, slug));

        app.out.human(`attached: #${task.number} ${task.title}`);
        app.out.data(attachment);
      }),
    },
    {
      name: "next",
      use: "next <next step...> [--task <task>]",
      short: "Record what this session will do next",
      long:
        "Record what this session will do next.\n\n" +
        "Without --task, the task this session attached to is used. The task is\n" +
        "named by a flag rather than a leading argument so that a next step which\n" +
        "happens to start with a number is not mistaken for one.",
      args: minimumArgs(1),
      flags: [
        {
          name: "task",
          type: "string" as const,
          usage: "task to record against, by number or id; defaults to the attached one",
          defaultValue: "",
        },
        strictFlag,
      ],
      run: failOpen(async ({ args, flags, app }: RunContext<App>) => {
        apiKey(app);
        const { taskId, number } = await targetTask(app, String(flags.task ?? ""));
        const step = args.join(" ").trim();
        if (step === "") throw new Error("no next step given");

        const marker = store.describe(env, cwd(), RUNNING);
        marker.nextStep = step;
        await addComment(taskId, format(marker));

        app.out.human(`#${number} next: ${step}`);
        // A Go map, which its encoder writes with the keys sorted. The report is
        // built in that order rather than sorted here, for the same bytes.
        app.out.data({ nextStep: step, number, taskId });
      }),
    },
    {
      name: "close",
      use: "close [--task <task>]",
      short: "Mark this session's task as no longer held",
      long:
        "Mark a task this session was working on as no longer held.\n\n" +
        "Without --task, the task in the attachment is closed: the one a plain\n" +
        "`session attach` took, and the one whose attachment file is then removed.\n" +
        "With --task, that task is closed instead, as slug#number (the form\n" +
        "`session status` prints), a number in the current project, or an id. That\n" +
        "releases one of several a session may hold. The attachment is only removed\n" +
        "when it is that task, so a session attached elsewhere stays attached there,\n" +
        "and a task this session attached earlier can be closed with no attachment\n" +
        "at all.",
      args: noArgs("kaneo session close"),
      flags: [
        {
          name: "task",
          type: "string" as const,
          usage: "task to close, as slug#number, number or id; defaults to the attached one",
          defaultValue: "",
        },
        strictFlag,
      ],
      run: failOpen(async ({ flags, app }: RunContext<App>) => {
        const sessionId = requireSessionId();
        const sessions = store.sessionStore();
        const attached = store.load(sessions, sessionId);
        const named = String(flags.task ?? "").trim();
        if (named === "" && attached === undefined) throw new Error("this session is not attached to a task");
        apiKey(app);
        // A named task is allowed with no attachment: a session that attached,
        // re-attached elsewhere and now wants the first one released is the case
        // --task is for, so the attachment is not the gate.
        const task = named === "" ? undefined : await resolveTask(app, named);
        // What the marker is written against and what the attachment holds can
        // differ once one of several tasks is named, so the attachment is only
        // dropped for the task it actually names.
        const holds = attached !== undefined && (task === undefined || attached.taskId === task.id);
        // The close line is written from the attachment's record when the named
        // task is the one held, so it carries the board as an unnamed close does.
        const closed = holds ? attached! : attachmentOf(task!);

        const marker = store.describe(env, cwd(), CLOSED);
        marker.nextStep = `Session ended. Resume with \`claude --resume ${sessionId}\`.`;
        await addComment(closed.taskId, format(marker));
        // A task closed by name that the attachment does not hold has no board on
        // record here, so it is looked up as attach does, with the same best
        // effort. After the marker: the lookups only fill the history line, and
        // spending the time budget on them first could time out the close itself.
        if (!holds) await describeBoard(app, task!, closed);
        try {
          // History first: a failed append then leaves the attachment in place,
          // where the other order would drop it and leave the history ending in
          // an attach with no close.
          store.appendHistory(sessions, sessionId, "close", closed, new Date());
        } catch (e) {
          throw hard(
            `closed #${closed.number} on the server, but could not add it to the session history (still attached here): ${(e as Error).message}`,
          );
        }
        try {
          if (holds) store.clear(sessions, sessionId);
        } catch (e) {
          // Re-running close would post a second marker; what is left is only
          // the local file, so the message names that.
          throw hard(`closed #${closed.number} and recorded it, but could not remove the attachment: ${(e as Error).message}`);
        }
        await runHook(app, "close", hookEnv("close", sessionId, closed.taskId, closed.number, ""));

        app.out.human(`closed: #${closed.number} ${closed.title}`);
        app.out.data({ number: closed.number, taskId: closed.taskId });
      }),
    },
    {
      name: "status",
      short: "Show what this session holds, and what it has held",
      long:
        "Show what this session holds, and what it has held.\n\n" +
        "Read from the files this session wrote under the config directory: no\n" +
        "request is made and no API key is needed, so it answers on a machine\n" +
        "that cannot reach a board. The attachment is what the session holds now,\n" +
        "and the history every attach and close since, which close keeps.",
      args: noArgs("kaneo session status"),
      // Accepted so a hook can pass --strict to every session command alike;
      // status is not fail-open, so there is nothing for it to turn off.
      flags: [strictFlag],
      run: async ({ app }: RunContext<App>) => {
        const sessionId = requireSessionId();
        const sessions = store.sessionStore();
        const attached = store.load(sessions, sessionId) ?? null;
        const { entries, skipped } = store.readHistory(sessions, sessionId);

        if (attached === null) app.out.human("attached: none");
        else app.out.human(`attached: ${ref(attached.projectSlug, attached.number)} ${attached.title}`);
        for (const entry of entries) {
          const line = entry as Record<string, Json | undefined>;
          const slug = typeof line["projectSlug"] === "string" ? line["projectSlug"] : undefined;
          app.out.human(
            `${String(line["at"] ?? "")}  ${String(line["event"] ?? "").padEnd(6)} ${ref(slug, String(line["number"] ?? ""))} ${String(line["title"] ?? "")}`,
          );
        }
        // Only where a person reads it: the JSON already carries every entry that
        // was read, and a count of the ones that were not has nothing to add to it.
        if (skipped > 0) app.out.status(`skipped ${skipped} unreadable history line(s)`);

        app.out.data({ sessionId, attached, history: entries });
      },
    },
  ],
};

// The task reference people write, "slug#number". A record written before the
// slug was kept, or whose lookup failed, has only the number.
const ref = (slug: string | undefined, number: number | string): string => `${slug ?? ""}#${number}`;

// The attachment a task is recorded as, before the board lookups fill in the
// project and workspace it belongs to.
const attachmentOf = (task: Task): Attachment => ({ taskId: task.id, number: task.number, title: task.title });

// Fills in which project and workspace the task is on, which the attachment keeps
// as well as answers the project's slug for the attach hook.
//
// Best effort: failing the attach over a name a statusline wants would leave the
// session unattached. A lookup that fails leaves its fields unset, which a reader
// treats as absent.
const describeBoard = async (app: App, task: Task, attachment: Attachment): Promise<string> => {
  // The marker post that follows shares this budget. Slow lookups may spend only
  // half of what is left, so they cannot starve it.
  const signal = halfLeft(app);

  // Never filled from the cwd's project: that is the wrong answer this field
  // exists to avoid, so an unknown project stays unknown.
  attachment.projectId = task.projectId;
  if (attachment.projectId === "") {
    debug(`attach: task ${task.id} carries no projectId; board not recorded`);
    return "";
  }
  let project;
  try {
    project = await getProject(attachment.projectId, signal);
  } catch (e) {
    debug(`attach: project ${attachment.projectId} lookup failed: ${(e as Error).message}`);
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
    workspaces = await listWorkspaces(signal);
  } catch (e) {
    debug(`attach: workspace lookup failed: ${(e as Error).message}`);
    return project.slug;
  }
  for (const workspace of workspaces) {
    if (workspace.id !== attachment.workspaceId) continue;
    attachment.workspaceName = workspace.name;
    break;
  }
  return project.slug;
};

// Picks the task a command acts on: the one named explicitly, otherwise the one
// this session attached to.
const targetTask = async (app: App, ref: string): Promise<{ taskId: string; number: number }> => {
  if (ref.trim() !== "") {
    const named = await resolveTask(app, ref);
    return { taskId: named.id, number: named.number };
  }
  const sessionId = requireSessionId();
  const attached = store.load(store.sessionStore(), sessionId);
  if (attached === undefined) {
    throw new Error(
      "this session is not attached to a task; name one, or run 'kaneo session attach' first",
    );
  }
  return { taskId: attached.taskId, number: attached.number };
};
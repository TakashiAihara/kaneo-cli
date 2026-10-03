import { apiKey, debug, taskProject, type App } from "./app";
import { addComment, getProject, listWorkspaces, type Task } from "../api/kaneo";
import { minimumArgs, noArgs, type RunContext } from "./args";
import { failOpen, hard, strictFlag } from "./failopen";
import { hookEnv, runHook } from "./hook";
import { resolveTask } from "./task";
import { CLOSED, format, RUNNING } from "../session/marker";
import * as store from "../session/store";
import type { Attachment } from "../session/store";

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
        const started = Date.now();
        const task = await resolveTask(taskProject(app), args[0]!);

        // Looked up before the marker is posted, so the lookups do not widen the
        // window where the server has a marker and this host has no record.
        const attachment: Attachment = { taskId: task.id, number: task.number, title: task.title };
        const slug = await describeBoard(app, task, attachment, started);

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
        const { taskId, number } = await targetTask(taskProject(app), String(flags.task ?? ""));
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
      short: "Mark this session's task as no longer held",
      args: noArgs("kaneo session close"),
      flags: [strictFlag],
      run: failOpen(async ({ app }: RunContext<App>) => {
        const sessionId = requireSessionId();
        const attached = store.load(store.sessionStore(), sessionId);
        if (attached === undefined) throw new Error("this session is not attached to a task");
        apiKey(app);

        const marker = store.describe(env, cwd(), CLOSED);
        marker.nextStep = `Session ended. Resume with \`claude --resume ${sessionId}\`.`;
        await addComment(attached.taskId, format(marker));
        store.clear(store.sessionStore(), sessionId);
        await runHook(app, "close", hookEnv("close", sessionId, attached.taskId, attached.number, ""));

        app.out.human(`closed: #${attached.number} ${attached.title}`);
        app.out.data({ number: attached.number, taskId: attached.taskId });
      }),
    },
  ],
};

// Fills in which project and workspace the task is on, and answers the project's
// slug, which the attach hook needs and the attachment does not keep.
//
// Best effort: failing the attach over a name a statusline wants would leave the
// session unattached. A lookup that fails leaves its fields unset, which a reader
// treats as absent.
const describeBoard = async (
  app: App,
  task: Task,
  attachment: Attachment,
  started: number,
): Promise<string> => {
  // The marker post that follows shares this budget. Slow lookups may spend only
  // half of what is left, so they cannot starve it.
  const signal = AbortSignal.timeout(Math.max(0, (app.timeoutMs - (Date.now() - started)) / 2));

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
const targetTask = async (projectId: string, ref: string): Promise<{ taskId: string; number: number }> => {
  if (ref.trim() !== "") {
    const named = await resolveTask(projectId, ref);
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
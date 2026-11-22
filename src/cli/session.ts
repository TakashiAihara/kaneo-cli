import { apiKey, taskProject, type App } from "./app";
import { minimumArgs, noArgs, type RunContext } from "./args";
import { failOpen, hard, strictFlag } from "./failopen";
import { hookEnv, runHook } from "./hook";
import { resolveTask } from "./task";
import { listComments } from "../api/kaneo";
import { CLOSED, format, RUNNING, holding, shortId, type Marker } from "../session/marker";
import * as store from "../session/store";
import { attachmentOf, attachTask, confirmMarker, cwd, describeBoard, env, postMarker } from "../session/attach";
import type { Json } from "../output/json";
import { shellWord } from "../output/output";
import { allowArchivedFlag, guardProject, placesNothing, taskRef, writeAccess, type ProjectAccess } from "./lookup";

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
    "CLAUDE_CODE_SESSION_ID, COPILOT_AGENT_SESSION_ID, DEVIN_SESSION_ID, and the\n" +
    "Devin CLI session this process runs under, detected on Linux only through\n" +
    "the session lock an ancestor process holds.",
  children: [
    {
      name: "attach",
      use: "attach <task> [next step...]",
      short: "Record that this session is working on a task",
      args: minimumArgs(1),
      flags: [strictFlag, allowArchivedFlag],
      run: failOpen(async ({ args, flags, app }: RunContext<App>) => {
        const sessionId = requireSessionId();
        apiKey(app);
        const task = await resolveTask(app, args[0]!, undefined, writeAccess(flags));
        const attachment = await attachTask(app, sessionId, task, args.slice(1).join(" "));
        app.out.human(
          `attached: ${taskRef(attachment.projectSlug, attachment.number, attachment.projectId, attachment.taskId)} ${attachment.title}`,
        );
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
        allowArchivedFlag,
      ],
      run: failOpen(async ({ args, flags, app }: RunContext<App>) => {
        apiKey(app);
        const { taskId, number, reference } = await targetTask(app, String(flags.task ?? ""), writeAccess(flags));
        const step = args.join(" ").trim();
        if (step === "") throw new Error("no next step given");

        const marker = store.describe(env, cwd(), RUNNING);
        marker.nextStep = step;
        // `session next` keeps no local record of the marker, so there is nothing
        // here to disagree with the server over a listing that could not be made:
        // the write landed and an unreachable board is what fail-open is for.
        const posted = await postMarker(
          taskId,
          marker,
          number,
          "this command keeps no local record, so nothing here is out of step",
          `it can be run again, that would only post a second marker; \`kaneo comment ls ${shellWord(reference)}\` shows it`,
        );
        await confirmMarker(taskId, number, posted, format(marker), "fail-open");

        app.out.human(`${reference} next: ${step}`);
        // A Go map, which its encoder writes with the keys sorted. The report is
        // built in that order rather than sorted here, for the same bytes.
        app.out.data({ nextStep: step, number, taskId });
      }),
    },
    {
      name: "close",
      use: "close [--task <task>] [--session <id>]",
      short: "Mark a task's session hold as ended",
      long:
        "Mark a task a session was working on as no longer held.\n\n" +
        "Without --task or --session, the task in this session's attachment is\n" +
        "closed: the one a plain `session attach` took, and the one whose\n" +
        "attachment file is then removed. With --task, that task is closed\n" +
        "instead, as slug#number (the form `session status` prints), a number,\n" +
        "or an id. A bare number names the held task when the attachment\n" +
        "carries its project — it wins over the current project's task of\n" +
        "that number — and is read in the current project otherwise. That\n" +
        "releases one of several a session may hold. The attachment is only\n" +
        "removed when it is that task, so a session attached elsewhere stays\n" +
        "attached there, and a task this session attached earlier can be\n" +
        "closed with no attachment at all.\n\n" +
        "With --session <id>, the hold of another session is released instead:\n" +
        "a closed marker is posted for that session id on the task --task names.\n" +
        "This is the way to let go of a session whose host can no longer run the\n" +
        "close itself — an imported board can carry markers for hosts that are\n" +
        "gone — since nothing on this machine records that session.",
      args: noArgs("kaneo session close"),
      flags: [
        {
          name: "task",
          type: "string" as const,
          usage: "task to close, as slug#number, number or id; required with --session",
          defaultValue: "",
        },
        {
          name: "session",
          type: "string" as const,
          usage: "release another session's hold on --task, by session id",
          defaultValue: "",
        },
        strictFlag,
        allowArchivedFlag,
      ],
      run: failOpen(async ({ flags, changed, app }: RunContext<App>) => {
        const releasing = String(flags.session ?? "").trim();
        // An explicitly passed --session that is empty must not fall through
        // to a plain close, which would let go of this session's hold instead.
        if (changed.has("session") && releasing === "") throw hard("--session needs a session id");
        if (releasing !== "") {
          await releaseHold(app, releasing, String(flags.task ?? "").trim());
          return;
        }
        const sessionId = requireSessionId();
        const sessions = store.sessionStore();
        const attached = store.load(sessions, sessionId);
        const named = String(flags.task ?? "").trim();
        if (named === "" && attached === undefined) throw new Error("this session is not attached to a task");
        apiKey(app);
        // A named task is allowed with no attachment: a session that attached,
        // re-attached elsewhere and now wants the first one released is the case
        // --task is for, so the attachment is not the gate.
        // The held task named the way the attachment knows it is taken as held
        // without a lookup, which a task the server no longer has would fail.
        const namesHeld = attached !== undefined && heldAs(app, attached, named);
        const slugs = new Map<string, string>();
        const task = named === "" || namesHeld ? undefined : await resolveTask(app, named, slugs, writeAccess(flags));
        // What the marker is written against and what the attachment holds can
        // differ once one of several tasks is named, so the attachment is only
        // dropped for the task it actually names.
        const holds = attached !== undefined && (task === undefined || attached.taskId === task.id);
        // The close line is written from the attachment's record when the named
        // task is the one held, so it carries the board as an unnamed close does.
        const closed = holds ? attached! : attachmentOf(task!);
        // A marker is a comment write, so the project it lands on is checked
        // the way a named task's is: an archived one refuses without
        // --allow-archived. A record that never learned its project has none
        // to check.
        const projectId = task?.projectId ?? closed.projectId;
        if (projectId !== undefined && projectId !== "") await guardProjectForMarker(projectId, writeAccess(flags));
        // The reference the retry hint names: the attachment's record for a
        // held task, the lookup's for one named without it. --task is part of
        // it, since a bare `session close` would close what is attached rather
        // than post a second marker against the task this one went to.
        const closing = taskRef(
          closed.projectSlug ?? slugs.get(task?.projectId ?? ""),
          closed.number,
          closed.projectId ?? task?.projectId,
          closed.taskId,
        );

        const marker = store.describe(env, cwd(), CLOSED);
        marker.nextStep = `Session ended. Resume with \`claude --resume ${sessionId}\`.`;
        // A held task the server can no longer place (deleted, or not in any
        // workspace the key reaches) can never take the marker, so the
        // attachment is released anyway rather than left for every later close
        // to fail on. The marker is then never written, even if the task comes
        // back. A task named but not held is not released: there is nothing of
        // it here to release.
        const posted = await postMarker(
          closed.taskId,
          marker,
          closed.number,
          "the attachment and history here are unchanged",
          `\`kaneo session close --task ${shellWord(closing)}\` again finishes closing here, and posts a second close marker`,
        ).catch((e: unknown) => {
          if (holds && placesNothing(e)) return undefined;
          throw e;
        });
        // A task closed by name that the attachment does not hold has no board on
        // record here, so it is looked up as attach does, with the same best
        // effort. After the marker: the lookups only fill the history line, and
        // spending the time budget on them first could time out the close itself.
        if (!holds) await describeBoard(task!, closed, "close");
        try {
          // History first: a failed append then leaves the attachment in place,
          // where the other order would drop it and leave the history ending in
          // an attach with no close.
          store.appendHistory(sessions, sessionId, "close", closed, new Date());
        } catch (e) {
          throw hard(
            `closed ${taskRef(closed.projectSlug, closed.number, closed.projectId, closed.taskId)} on the server, but could not add it to the session history (still attached here): ${(e as Error).message}`,
          );
        }
        try {
          if (holds) store.clear(sessions, sessionId);
        } catch (e) {
          // Re-running close would post a second marker; what is left is only
          // the local file, so the message names that.
          throw hard(
            `closed ${taskRef(closed.projectSlug, closed.number, closed.projectId, closed.taskId)} and recorded it, but could not remove the attachment: ${(e as Error).message}`,
          );
        }
        await runHook(app, "close", hookEnv("close", sessionId, closed.taskId, closed.number, ""));

        // Confirmed last of all, so a marker this close cannot confirm fails on a
        // machine that no longer says it holds the task. The trade-off is that a
        // marker the server did not keep leaves the board's last marker saying
        // running while this machine says closed; `session close --task <N>`
        // posts it again. Held back the other way, a close whose marker was lost
        // would leave the session attached to a task it has left.
        // After the hook: the session has let go of the task, which is what the
        // hook follows. The exit is still 1, since the board was not told.
        if (posted === undefined) {
          throw hard(
            `released ${taskRef(closed.projectSlug, closed.number, closed.projectId, closed.taskId)} ${closed.title} here, but the server can no longer place its task (deleted, or out of this key's reach), so no close marker was written`,
          );
        }
        await confirmMarker(closed.taskId, closed.number, posted, format(marker), "fail-open");

        app.out.human(
          `closed: ${taskRef(closed.projectSlug, closed.number, closed.projectId, closed.taskId)} ${closed.title}`,
        );
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
        else
          app.out.human(
            `attached: ${taskRef(attached.projectSlug, attached.number, attached.projectId, attached.taskId)} ${attached.title}`,
          );
        for (const entry of entries) {
          const line = entry as Record<string, Json | undefined>;
          const slug = typeof line["projectSlug"] === "string" ? line["projectSlug"] : undefined;
          const taskId = typeof line["taskId"] === "string" ? line["taskId"] : undefined;
          app.out.human(
            `${String(line["at"] ?? "")}  ${String(line["event"] ?? "").padEnd(6)} ${taskRef(slug, String(line["number"] ?? ""), typeof line["projectId"] === "string" ? line["projectId"] : undefined, taskId)} ${String(line["title"] ?? "")}`,
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

// Releases another session's hold on a task: the closed marker is posted for
// the session id --session names, on the task --task resolves to.
//
// This machine has no record of that session — it ran on a host that is gone,
// or its marker arrived with an imported board — so there is no attachment to
// clear and no history to append. What is left is the marker itself, which is
// the whole of what the board reads a hold from. The hold is confirmed to be
// there before the close is written: a closed marker for a session that was
// never holding the task records an ending that never began, and the board
// would then show the real hold as closed.
const releaseHold = async (app: App, releasing: string, named: string): Promise<void> => {
  apiKey(app);
  // The refusals here are hard errors rather than fail-open ones: --session is
  // an explicitly manual release that no hook invokes, and a refusal that
  // exited 0 would report a release that never ran.
  if (named === "") {
    throw hard(
      "--session releases another session's hold, which this machine has no record of; name the task with --task",
    );
  }
  // This session's own hold is what a plain close is for; releasing it by name
  // here would post a second marker for a hold about to be let go anyway.
  if (releasing === store.currentId(env)) {
    throw hard("--session names another session; this session's own hold is closed by a plain 'kaneo session close'");
  }
  const slugs = new Map<string, string>();
  // The hold being released is the named session's, so a bare --task number is
  // read on the board that session's record names: this machine can hold the
  // record of a session that ran here and is gone now. With no record — the
  // usual case — or no project on it, the number is read in the current
  // project, as a plain --task is.
  const held = store.load(store.sessionStore(), releasing);
  const task = await resolveTask(app, releaseRef(held, named), slugs);
  const closed = attachmentOf(task);
  await describeBoard(task, closed, "close");
  const reference = taskRef(
    closed.projectSlug ?? slugs.get(task.projectId),
    closed.number,
    closed.projectId,
    closed.taskId,
  );

  const comments = await listComments(task.id);
  if (!holding(comments).some((marker) => marker.sessionId === releasing)) {
    throw hard(`session ${releasing} is not holding ${reference}`);
  }

  const marker: Marker = {
    // The session being released, not this one: the marker is read back by the
    // id it carries, which is the only thing that makes it that session's close.
    sessionId: releasing,
    host: "",
    cwd: "",
    branch: "",
    state: CLOSED,
    nextStep: `Session ended. Resume with \`claude --resume ${releasing}\`.`,
    createdAt: "",
  };
  const posted = await postMarker(
    task.id,
    marker,
    task.number,
    "the task keeps showing that session as holding it",
    `\`kaneo session close --session ${shellWord(releasing)} --task ${shellWord(reference)}\` again finishes it, and posts a second close marker`,
  );
  await confirmMarker(task.id, task.number, posted, format(marker), "fail-open");

  app.out.human(`released: session ${shortId(releasing)} on ${reference} ${task.title}`);
  app.out.data({ number: task.number, session: releasing, taskId: task.id });
};

// The reference a --task value resolves to when releasing another session's
// hold. A bare number names a task on the board the releasing session's
// record carries — the hold is that session's, so its project is the one the
// number means there — and is left as typed when there is no record, the
// record carries no project, or the value names a board, a ticket id or a
// task id itself.
export const releaseRef = (held: store.Attachment | undefined, named: string): string => {
  const projectId = held?.projectId ?? "";
  return projectId !== "" && /^\d+$/.test(named) ? `${projectId}#${named}` : named;
};

// Picks the task a command acts on: the one named explicitly, otherwise the one
// this session attached to. reference is the task written the way a task
// reference writes it — board and number — so a hint that asks the reader to
// look at it or to run again names the board the write went to.
const targetTask = async (
  app: App,
  ref: string,
  access: ProjectAccess = {},
): Promise<{ taskId: string; number: number; reference: string }> => {
  if (ref.trim() !== "") {
    const slugs = new Map<string, string>();
    const named = await resolveTask(app, ref, slugs, access);
    return {
      taskId: named.id,
      number: named.number,
      reference: taskRef(slugs.get(named.projectId), named.number, named.projectId, named.id),
    };
  }
  const sessionId = requireSessionId();
  const attached = store.load(store.sessionStore(), sessionId);
  if (attached === undefined) {
    throw new Error("this session is not attached to a task; name one, or run 'kaneo session attach' first");
  }
  // The marker this command posts is a comment write, so the project the
  // attachment names is checked the way a named task's is. A record that
  // never learned its project has none to check.
  if (attached.projectId !== undefined && attached.projectId !== "")
    await guardProjectForMarker(attached.projectId, access);
  return {
    taskId: attached.taskId,
    number: attached.number,
    reference: taskRef(attached.projectSlug, attached.number, attached.projectId, attached.taskId),
  };
};

// The archived check guardProject makes reads the project first, and a project
// the server can no longer place fails that read before the marker post is
// ever tried. A gone project has no archived state to check, and the post is
// what knows how to report that its task cannot take the marker — for a held
// task it is also what releases the attachment — so the read's "nothing here"
// answer is left to it. Every other failure still stops the command here.
const guardProjectForMarker = async (projectId: string, access: ProjectAccess): Promise<void> => {
  try {
    await guardProject(projectId, access);
  } catch (e) {
    if (!placesNothing(e)) throw e;
  }
};

// Whether a --task value names the held task in a form close can recognise
// without asking the server: its id, its slug#number or slug-number (any case,
// as the slug lookup reads it), or a bare number equal to the held one, which
// the held task wins over the current project's task of that number. Without a
// slug on record, `#N` is not matched: it would read as the current project's
// task.
const heldAs = (app: App, held: store.Attachment, named: string): boolean => {
  if (named === held.taskId) return true;
  const slug = held.projectSlug ?? "";
  if (slug !== "") {
    const lower = named.toLowerCase();
    if (lower === taskRef(slug, held.number, held.projectId, held.taskId).toLowerCase()) return true;
    // The dash form the server and UI write (`slug-N`) names the same task.
    if (lower === `${slug}-${held.number}`.toLowerCase()) return true;
  }
  if (!/^\d+$/.test(named) || Number(named) !== held.number) return false;
  // A bare number is ambiguous — the current project can hold a task of the
  // same number — and the held task wins it whenever the attachment's project
  // is known: resolving would pick the current project's task, a different
  // one whenever the session works in another project. With no project on
  // record the bare number means the held one only when no single project is
  // configured to resolve it against.
  const pid = held.projectId ?? "";
  return pid !== "" || taskProject(app) === pid;
};

import { apiKey, type App } from "./app";
import { minimumArgs, noArgs, type RunContext } from "./args";
import { failOpen, hard, strictFlag } from "./failopen";
import { hookEnv, runHook } from "./hook";
import { resolveTask } from "./task";
import { CLOSED, RUNNING } from "../session/marker";
import * as store from "../session/store";
import { attachmentOf, attachTask, confirmMarker, cwd, describeBoard, env, postMarker } from "../session/attach";
import type { Json } from "../output/json";

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
        const task = await resolveTask(app, args[0]!);
        const attachment = await attachTask(app, sessionId, task, args.slice(1).join(" "));
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
        // `session next` keeps no local record of the marker, so there is nothing
        // here to disagree with the server over a listing that could not be made:
        // the write landed and an unreachable board is what fail-open is for.
        const posted = await postMarker(taskId, marker);
        await confirmMarker(taskId, number, posted, "fail-open");

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
        const posted = await postMarker(closed.taskId, marker);
        // A task closed by name that the attachment does not hold has no board on
        // record here, so it is looked up as attach does, with the same best
        // effort. After the marker: the lookups only fill the history line, and
        // spending the time budget on them first could time out the close itself.
        if (!holds) await describeBoard(task!, closed);
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

        // Confirmed last of all, so a marker this close cannot confirm fails on a
        // machine that no longer says it holds the task. The trade-off is that a
        // marker the server did not keep leaves the board's last marker saying
        // running while this machine says closed; `session close --task <N>`
        // posts it again. Held back the other way, a close whose marker was lost
        // would leave the session attached to a task it has left.
        await confirmMarker(closed.taskId, closed.number, posted, "fail-open");

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
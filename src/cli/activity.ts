import { apiKey, workspace, type App } from "./app";
import {
  addActivity,
  listActivities,
  listWorkspaceActivities,
  type Activity,
  type WorkspaceActivity,
} from "../api/kaneo";
import { minimumArgs, rangeArgs, type RunContext } from "./args";
import { resolveWorkspace } from "./lookup";
import { resolveTask } from "./task";

// An event's details are in eventData, shown after its message. The server
// writes {} for events with nothing to add, which says nothing either.
const activityLine = (a: Activity): string => {
  const data = a.eventData === null || JSON.stringify(a.eventData) === "{}" ? "" : JSON.stringify(a.eventData);
  const body = [a.content, data].filter((s) => s !== "").join("  ");
  return `${a.createdAt}  ${a.type}  ${body.replaceAll("\n", "\n  ")}`.trimEnd();
};

// A workspace entry reads like a task's history line with who did it and which
// task it was on added: the feed spans projects, so the task reference carries
// its project's slug the way a task reference does.
const workspaceActivityLine = (a: WorkspaceActivity): string => {
  const data = a.eventData === null || JSON.stringify(a.eventData) === "{}" ? "" : JSON.stringify(a.eventData);
  const body = [a.excerpt ?? "", data].filter((s) => s !== "").join("  ");
  const who = a.userName ?? a.externalUserName ?? "";
  const task = a.taskNumber === null ? `${a.projectSlug} ${a.taskTitle}` : `${a.projectSlug}#${a.taskNumber} ${a.taskTitle}`;
  return [a.createdAt, a.type, who, body, task].filter((s) => s !== "").join("  ").replaceAll("\n", "\n  ");
};

// --data takes a JSON object, since that is what the server stores.
const eventData = (text: string): Record<string, unknown> | null => {
  if (text === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`--data is not JSON: ${text}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`--data must be a JSON object: ${text}`);
  }
  return value as Record<string, unknown>;
};

export const activityCommand = {
  name: "activity",
  short: "Read and record a task's history",
  children: [
    {
      name: "list",
      aliases: ["ls"],
      use: "list [task]",
      short: "List a task's history, or with no task the workspace's recent activity",
      long:
        "List a task's history: comments and events such as status changes.\n\n" +
        "With no task the listing is instead the workspace's recent activity\n" +
        "feed, the same rows across every project in it, newest first. The\n" +
        "workspace is the configured one (-w, KANEO_WORKSPACE or .kaneo.json);\n" +
        "a task argument always means the task's own history, whatever -w says.",
      args: rangeArgs(0, 1),
      run: async ({ args, app }: RunContext<App>) => {
        apiKey(app);
        if (args.length === 0) {
          const activities = await listWorkspaceActivities(await resolveWorkspace(workspace(app)));
          for (const a of activities) app.out.human(workspaceActivityLine(a));
          app.out.data(activities);
          return;
        }
        const task = await resolveTask(app, args[0]!);
        const activities = await listActivities(task.id);
        for (const a of activities) app.out.human(activityLine(a));
        app.out.data(activities);
      },
    },
    {
      name: "add",
      use: "add <task> <type> [message...]",
      // Only an entry in the history: the task itself does not change, and no
      // route removes an event once written.
      short: "Record an entry in a task's history (does not change the task; cannot be removed on its own)",
      args: minimumArgs(2),
      flags: [{ name: "data", type: "string" as const, usage: "event details as a JSON object", defaultValue: "" }],
      run: async ({ args, flags, app }: RunContext<App>) => {
        apiKey(app);
        // Comments have their own route, which checks what this one does not,
        // and from Kaneo 2.27.0 the server refuses them here.
        if (args[1] === "comment") throw new Error("type comment is a comment: use `kaneo comment add`");
        const data = eventData(String(flags.data ?? ""));
        const task = await resolveTask(app, args[0]!);
        const a = await addActivity(task.id, args[1]!, args.slice(2).join(" "), data);
        app.out.human(`recorded ${a.type} on #${task.number}`);
        app.out.data(a);
      },
    },
  ],
};

import { apiKey, type App } from "./app";
import {
  addTimeEntry,
  checkTimestamp,
  getTimeEntryById,
  listTimeEntries,
  stopTimeEntry,
  updateTimeEntryById,
  type ListedTimeEntry,
  type TimeEntry,
} from "../api/kaneo";
import { exactArgs, type RunContext } from "./args";
import { resolveTask } from "./task";

// Whole minutes are what a person reads a log in; the seconds are in --json.
const elapsed = (seconds: number): string =>
  `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;

const entryLine = (entry: TimeEntry | ListedTimeEntry): string =>
  [
    entry.id,
    `${entry.startTime} -> ${entry.endTime ?? "running"}`,
    entry.duration === null ? "" : elapsed(entry.duration),
    // A task's listing holds everybody's entries, so it says whose each one is.
    "userName" in entry ? (entry.userName ?? "(removed user)") : "",
    entry.description,
  ]
    .filter((part) => part !== "")
    .join("  ");

const TIME_FLAGS = [
  { name: "start", type: "string" as const, usage: "start time, ISO 8601 with an offset", defaultValue: "" },
  { name: "end", type: "string" as const, usage: "end time, ISO 8601 with an offset", defaultValue: "" },
  { name: "description", shorthand: "d", type: "string" as const, usage: "what the time was spent on", defaultValue: "" },
];

export const timeCommand = {
  name: "time",
  short: "Track time spent on tasks",
  children: [
    {
      name: "list",
      aliases: ["ls"],
      use: "list <task>",
      short: "List the time logged against a task",
      args: exactArgs(1),
      run: async ({ args, app }: RunContext<App>) => {
        apiKey(app);
        const task = await resolveTask(app, args[0]!);
        const entries = await listTimeEntries(task.id);
        for (const entry of entries) app.out.human(entryLine(entry));
        app.out.data(entries);
      },
    },
    {
      name: "get",
      use: "get <entry-id>",
      short: "Show one time entry",
      args: exactArgs(1),
      run: async ({ args, app }: RunContext<App>) => {
        apiKey(app);
        const entry = await getTimeEntryById(args[0]!);
        app.out.human(entryLine(entry));
        app.out.data(entry);
      },
    },
    {
      name: "add",
      aliases: ["start"],
      use: "add <task>",
      short: "Log time against a task, or start a timer when no --end is given",
      long:
        "Log time against a task, or start a timer when no --end is given.\n\n" +
        "Without --start the entry starts now, by this machine's clock. A finished\n" +
        "entry needs both --start and --end.",
      args: exactArgs(1),
      flags: [
        { ...TIME_FLAGS[0]!, usage: "start time, ISO 8601 with an offset (default now)" },
        { ...TIME_FLAGS[1]!, usage: "end time, ISO 8601 with an offset; leave out to start a running timer" },
        TIME_FLAGS[2]!,
      ],
      run: async ({ args, flags, changed, app }: RunContext<App>) => {
        // Read before the board is fetched, so the start is when it was typed.
        const now = new Date().toISOString();
        // An end with no start would start now, and a finished entry that starts
        // the moment it is logged is almost never what was meant.
        if (changed.has("end") && !changed.has("start")) {
          throw new Error("--end needs --start; leave out both to start a running timer now");
        }
        // Refused before the board is fetched for the task, which costs a request.
        if (changed.has("start")) checkTimestamp("start", String(flags.start ?? ""));
        if (changed.has("end")) checkTimestamp("end", String(flags.end ?? ""));
        apiKey(app);
        const task = await resolveTask(app, args[0]!);
        const entry = await addTimeEntry(task.id, {
          startTime: changed.has("start") ? String(flags.start ?? "") : now,
          ...(changed.has("end") ? { endTime: String(flags.end ?? "") } : {}),
          description: String(flags.description ?? ""),
        });
        app.out.human(
          entry.endTime === null ? `started ${entry.id} on #${task.number}` : `logged ${entry.id} on #${task.number}`,
        );
        app.out.data(entry);
      },
    },
    {
      name: "update",
      use: "update <entry-id>",
      short: "Change a time entry's start, end or description",
      long:
        "Change a time entry's start, end or description.\n\n" +
        "A field left out keeps its value. The server has no way to clear an end once set.",
      args: exactArgs(1),
      flags: TIME_FLAGS,
      run: async ({ args, flags, changed, app }: RunContext<App>) => {
        // Only a flag that was passed is a change: `--description ""` clears it.
        const changes: { startTime?: string; endTime?: string; description?: string } = {};
        if (changed.has("start")) changes.startTime = String(flags.start ?? "");
        if (changed.has("end")) changes.endTime = String(flags.end ?? "");
        if (changed.has("description")) changes.description = String(flags.description ?? "");
        if (Object.keys(changes).length === 0) {
          throw new Error("nothing to change: pass --start, --end or --description");
        }
        apiKey(app);
        const entry = await updateTimeEntryById(args[0]!, changes);
        app.out.human(`updated ${entryLine(entry)}`);
        app.out.data(entry);
      },
    },
    {
      name: "stop",
      use: "stop <entry-id>",
      short: "Stop a running timer now",
      long:
        "Stop a running timer now, by this machine's clock.\n\n" +
        "It takes the entry rather than the task because a task's timers are\n" +
        "everybody's, and the server lets anyone who can edit the task stop any of\n" +
        "them; `kaneo time ls <task>` shows whose each one is.",
      args: exactArgs(1),
      // By task would be handier, but picking the caller's own timer needs the
      // caller's user id. v2.29.2 has /user/me for that, the deployed server
      // (checked 2026-10-04) does not, and get-active-member answers 400 for
      // an API key.
      run: async ({ args, app }: RunContext<App>) => {
        const now = new Date().toISOString();
        apiKey(app);
        const stopped = await stopTimeEntry(args[0]!, now);
        app.out.human(`stopped ${entryLine(stopped)}`);
        app.out.data(stopped);
      },
    },
  ],
};

import { apiKey, project, type App } from "./app";
import { boardTasks, getBoard, type Task } from "../api/kaneo";
import type { FlagValues } from "./args";

// The tasks in a project.
//
// Only the listing is here: the rest of `task` arrives with the step that ports
// it, and a command half-built would be worse than one that is not.
export const taskCommand = {
  name: "task",
  aliases: ["t"],
  short: "Work with tasks",
  children: [
    {
      name: "list",
      aliases: ["ls"],
      short: "List the tasks in a project",
      args: (args: string[]) => {
        const first = args[0];
        if (first !== undefined) {
          throw new Error(`unknown command ${JSON.stringify(first)} for "kaneo task list"`);
        }
      },
      flags: [
        { name: "status", type: "string" as const, usage: "only tasks in this column", defaultValue: "" },
        { name: "priority", type: "string" as const, usage: "only tasks with this priority", defaultValue: "" },
        {
          name: "all",
          type: "bool" as const,
          // Done tasks accumulate without bound, so the listing hides them
          // unless asked. --status done still shows them, since that is an
          // explicit request.
          usage: "include tasks in the done column",
          defaultValue: "false",
        },
      ],
      run: async ({ flags, app }: { flags: FlagValues; app: App }) => {
        apiKey(app);
        const tasks = filterTasks(
          boardTasks(await getBoard(project(app))),
          String(flags.status ?? ""),
          String(flags.priority ?? ""),
          flags.all === true,
        );
        for (const task of tasks) app.out.human(taskLine(task));
        app.out.data(tasks);
      },
    },
  ],
};

const filterTasks = (tasks: Task[], status: string, priority: string, includeDone: boolean): Task[] =>
  tasks.filter(
    (task) =>
      (status === "" || task.status === status) &&
      (priority === "" || task.priority === priority) &&
      (includeDone || status !== "" || task.status !== "done"),
  );

const taskLine = (task: Task): string =>
  `#${String(task.number).padEnd(4)} [${task.priority.padEnd(11)}] ${task.status.padEnd(13)} ${task.title}`;

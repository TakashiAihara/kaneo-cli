import {
  findPublicTaskByNumber,
  getPublicBoard,
  getPublicProjectDescription,
  getPublicTaskDescription,
  type PublicBoardFilters,
} from "../api/kaneo";
import { exactArgs, rangeArgs, type FlagValues, type RunContext } from "./args";
import type { App } from "./app";
import { taskLine } from "./task";

// The board a public link shares: readable without a key, which is the whole
// point of the route. The project is named by id — the value the public URL
// carries — since resolving a slug would need a keyed listing a keyless
// caller does not have.
export const publicCommand = {
  name: "public",
  short: "Read what a public project link shares, without a key",
  children: [
    {
      name: "project",
      use: "project <project-id>",
      short: "Show a public project's board",
      args: exactArgs(1),
      flags: [
        { name: "status", type: "string" as const, usage: "only tasks in this column", defaultValue: "" },
        { name: "priority", type: "string" as const, usage: "only tasks of this priority", defaultValue: "" },
        {
          name: "assignee-id",
          type: "string" as const,
          usage: "only tasks assigned to this user id",
          defaultValue: "",
        },
        {
          name: "sort-by",
          type: "string" as const,
          usage: "sort tasks by createdAt, priority, dueDate, position, title or number",
          defaultValue: "",
        },
        { name: "sort-order", type: "string" as const, usage: "asc or desc", defaultValue: "" },
        { name: "due-before", type: "string" as const, usage: "only tasks due before this instant", defaultValue: "" },
        { name: "due-after", type: "string" as const, usage: "only tasks due after this instant", defaultValue: "" },
        {
          name: "limit",
          type: "string" as const,
          usage: "tasks per page, 1 to 100 (the server decides the pages)",
          defaultValue: "",
        },
      ],
      run: async ({ args, flags, changed, app }: RunContext<App>) => {
        const board = await getPublicBoard(args[0]!, publicFilters(flags, changed));
        app.out.human(`## ${board.projectName} (${board.projectSlug})`);
        for (const column of board.columns) {
          app.out.human("");
          app.out.human(`### ${column.name}`);
          for (const task of column.tasks) app.out.human(taskLine(task));
        }
        app.out.data(board);
      },
    },
    {
      name: "description",
      use: "description <project-id> [task]",
      short: "Read a public project's or one of its tasks' description",
      long:
        "Read a public project's description, or with a second argument one task's.\n\n" +
        "The task is named by its id, or by its number on the board (#3 or 3),\n" +
        "which is resolved through the public board itself.",
      args: rangeArgs(1, 2),
      run: async ({ args, app }: RunContext<App>) => {
        const projectId = args[0]!;
        const named = args[1];
        if (named === undefined) {
          const description = await getPublicProjectDescription(projectId);
          printDescription(app, description);
          return;
        }
        // A bare or #-led number is the task's place on the board; anything
        // else is the task id the board listing carries.
        const numbered = /^#?\d+$/.test(named) ? Number(named.replace(/^#/, "")) : undefined;
        const taskId = numbered === undefined ? named : await publicTaskId(projectId, numbered);
        const description = await getPublicTaskDescription(projectId, taskId);
        printDescription(app, description);
      },
    },
  ],
};

const printDescription = (app: App, description: { content: string; version: string }): void => {
  if (description.content !== "") app.out.human(description.content);
  app.out.data(description);
};

// The task id a board number names on a public board, or the error that says
// the board does not have it.
const publicTaskId = async (projectId: string, number: number): Promise<string> => {
  const { task } = await findPublicTaskByNumber(projectId, number);
  if (task === undefined) throw new Error(`the public board of project ${projectId} has no task #${number}`);
  return task.id;
};

const SORT_BY = ["createdAt", "priority", "dueDate", "position", "title", "number"] as const;
const SORT_ORDER = ["asc", "desc"] as const;

const publicFilters = (flags: FlagValues, changed: ReadonlySet<string>): PublicBoardFilters => ({
  ...(changed.has("status") ? { status: String(flags.status ?? "") } : {}),
  ...(changed.has("priority") ? { priority: String(flags.priority ?? "") } : {}),
  ...(changed.has("assignee-id") ? { assigneeId: String(flags["assignee-id"] ?? "") } : {}),
  ...(changed.has("sort-by") ? { sortBy: wantedEnum("--sort-by", String(flags["sort-by"] ?? ""), SORT_BY) } : {}),
  ...(changed.has("sort-order")
    ? { sortOrder: wantedEnum("--sort-order", String(flags["sort-order"] ?? ""), SORT_ORDER) }
    : {}),
  ...(changed.has("due-before") ? { dueBefore: String(flags["due-before"] ?? "") } : {}),
  ...(changed.has("due-after") ? { dueAfter: String(flags["due-after"] ?? "") } : {}),
  ...(changed.has("limit") ? { limit: wantedLimit(String(flags.limit ?? "")) } : {}),
});

// A sort field the document's enum names, refused where it was typed rather
// than sent for the server to answer 400.
const wantedEnum = <T extends string>(flag: string, given: string, allowed: readonly T[]): T => {
  if (!allowed.includes(given as T)) {
    throw new Error(`${flag} ${JSON.stringify(given)} is not one of: ${allowed.join(", ")}`);
  }
  return given as T;
};

// A page size the document's bounds name: a whole number from 1 to 100.
const wantedLimit = (given: string): number => {
  const limit = /^\d+$/.test(given) ? Number(given) : Number.NaN;
  if (!(limit >= 1 && limit <= 100)) {
    throw new Error(`--limit ${JSON.stringify(given)} is not a whole number from 1 to 100`);
  }
  return limit;
};

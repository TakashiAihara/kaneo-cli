import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { getContext } from "../context";
import { unwrap } from "../api/client";
import { fetchBoard, resolveTaskId, type BoardTask } from "../api/board";
import { printJson, printTable, log } from "../output";
import type { components } from "../api/schema";

type Task = components["schemas"]["Task"];
type TaskWithAssignee = components["schemas"]["TaskWithAssignee"];

const PRIORITIES = ["no-priority", "low", "medium", "high", "urgent"] as const;
type Priority = (typeof PRIORITIES)[number];

function parsePriority(value: string): Priority {
  if ((PRIORITIES as readonly string[]).includes(value)) return value as Priority;
  throw new InvalidArgumentError(`must be one of: ${PRIORITIES.join(", ")}`);
}

function taskRef(t: { number?: number | null; id: string }): string {
  return t.number != null ? `#${t.number}` : t.id;
}

function shortDate(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "";
}

export function registerTask(program: Command): void {
  const task = program.command("task").description("Work with tasks");

  task
    .command("list")
    .description("List tasks of a project, grouped by column")
    .requiredOption("--project <id>", "project id")
    .option("--status <slug>", "filter by column slug")
    .option("--priority <priority>", `filter: ${PRIORITIES.join(" | ")}`, parsePriority)
    .option("--assignee <userId>", "filter by assignee user id")
    .action(async (opts, cmd: Command) => {
      const { client, flags } = getContext(cmd);
      const query: Record<string, string> = {};
      if (opts.status) query.status = opts.status;
      if (opts.priority) query.priority = opts.priority;
      if (opts.assignee) query.assigneeId = opts.assignee;
      const board = await fetchBoard(client, opts.project, query);
      if (flags.json) {
        printJson(board);
        return;
      }
      const columns = [
        { header: "NUM", value: (t: BoardTask) => taskRef(t) },
        { header: "TITLE", value: (t: BoardTask) => t.title },
        { header: "PRIORITY", value: (t: BoardTask) => t.priority },
        { header: "DUE", value: (t: BoardTask) => shortDate(t.dueDate) },
        { header: "ASSIGNEE", value: (t: BoardTask) => t.assigneeName ?? "" },
      ];
      let printedAny = false;
      for (const col of board.columns) {
        if (col.tasks.length === 0) continue;
        if (printedAny) console.log("");
        console.log(`${col.name} (${col.slug}) — ${col.tasks.length}`);
        printTable(col.tasks, columns);
        printedAny = true;
      }
      if (!printedAny) console.log("no tasks");
    });

  task
    .command("view <task>")
    .description("Show one task (id, or #number with --project)")
    .option("--project <id>", "project id (needed when referencing by number)")
    .action(async (ref: string, opts, cmd: Command) => {
      const { client, flags } = getContext(cmd);
      const id = await resolveTaskId(client, ref, opts.project);
      const t = unwrap<TaskWithAssignee>(await client.GET("/task/{id}", { params: { path: { id } } }));
      if (flags.json) {
        printJson(t);
        return;
      }
      console.log(`${taskRef(t)} ${t.title}`);
      console.log(`id:        ${t.id}`);
      console.log(`project:   ${t.projectId}`);
      console.log(`status:    ${t.status}`);
      console.log(`priority:  ${t.priority}`);
      if (t.assigneeName || t.assigneeId) console.log(`assignee:  ${t.assigneeName ?? t.assigneeId}`);
      if (t.startDate) console.log(`start:     ${shortDate(t.startDate)}`);
      if (t.dueDate) console.log(`due:       ${shortDate(t.dueDate)}`);
      console.log(`created:   ${shortDate(t.createdAt)}`);
      if (t.description) {
        console.log("");
        console.log(t.description);
      }
    });

  task
    .command("create <title>")
    .description("Create a task")
    .requiredOption("--project <id>", "project id")
    .option("-d, --description <text>", "description", "")
    .option("-p, --priority <priority>", PRIORITIES.join(" | "), parsePriority, "no-priority")
    .option("-s, --status <slug>", "target column slug (default: the project's first column)")
    .option("--due <date>", "due date (ISO 8601)")
    .option("--start <date>", "start date (ISO 8601)")
    .option("--assignee <userId>", "assignee user id")
    .action(async (title: string, opts, cmd: Command) => {
      const { client, flags } = getContext(cmd);
      let status: string | undefined = opts.status;
      if (!status) {
        // API は status (column slug) 必須。省略時は board から先頭 column を引いて補う
        const board = await fetchBoard(client, opts.project);
        status = board.columns[0]?.slug;
        if (!status) {
          log(`kaneo: project ${opts.project} has no columns; pass --status explicitly`);
          process.exit(1);
        }
      }
      const t = unwrap<Task>(
        await client.POST("/task/{projectId}", {
          params: { path: { projectId: opts.project } },
          body: {
            title,
            description: opts.description,
            priority: opts.priority,
            status,
            ...(opts.due ? { dueDate: opts.due } : {}),
            ...(opts.start ? { startDate: opts.start } : {}),
            ...(opts.assignee ? { userId: opts.assignee } : {}),
          },
        }),
      );
      if (flags.json) {
        printJson(t);
        return;
      }
      console.log(`created ${taskRef(t)} ${t.title} (${t.id})`);
    });

  task
    .command("edit <task>")
    .description("Edit task fields (id, or #number with --project)")
    .option("--project <id>", "project id (needed when referencing by number)")
    .option("--title <title>")
    .option("-d, --description <text>")
    .option("-p, --priority <priority>", PRIORITIES.join(" | "), parsePriority)
    .option("-s, --status <slug>", "move to another column")
    .option("--due <date>", "due date (ISO 8601)")
    .option("--assignee <userId>", "assign to user")
    .option("--unassign", "clear the assignee")
    .action(async (ref: string, opts, cmd: Command) => {
      const { client, flags } = getContext(cmd);
      if (opts.assignee && opts.unassign) {
        log("kaneo: --assignee and --unassign are mutually exclusive");
        process.exit(2);
      }
      // 全量 PUT は position まで要求するので、部分編集はフィールド別エンドポイントに分ける
      const edits: Array<() => Promise<unknown>> = [];
      const id = await resolveTaskId(client, ref, opts.project);
      const path = { params: { path: { id } } };
      if (opts.title !== undefined)
        edits.push(() => client.PUT("/task/title/{id}", { ...path, body: { title: opts.title } }));
      if (opts.description !== undefined)
        edits.push(() =>
          client.PUT("/task/description/{id}", { ...path, body: { description: opts.description } }),
        );
      if (opts.priority !== undefined)
        edits.push(() => client.PUT("/task/priority/{id}", { ...path, body: { priority: opts.priority } }));
      if (opts.status !== undefined)
        edits.push(() => client.PUT("/task/status/{id}", { ...path, body: { status: opts.status } }));
      if (opts.due !== undefined)
        edits.push(() => client.PUT("/task/due-date/{id}", { ...path, body: { dueDate: opts.due } }));
      if (opts.assignee !== undefined)
        edits.push(() => client.PUT("/task/assignee/{id}", { ...path, body: { userId: opts.assignee } }));
      if (opts.unassign)
        edits.push(() => client.PUT("/task/assignee/{id}", { ...path, body: { userId: null } }));
      if (edits.length === 0) {
        log("kaneo: nothing to edit — pass at least one field flag (see kaneo task edit --help)");
        process.exit(2);
      }
      let last: unknown;
      for (const edit of edits) {
        last = unwrap((await edit()) as { data?: unknown; error?: unknown; response: Response });
      }
      if (flags.json) {
        printJson(last);
        return;
      }
      console.log(`updated ${ref}`);
    });

  task
    .command("move <task>")
    .description("Move a task to another project (id, or #number with --project)")
    .requiredOption("--to-project <id>", "destination project id")
    .option("--project <id>", "source project id (needed when referencing by number)")
    .option("-s, --status <slug>", "destination column slug (default: destination's first column)")
    .action(async (ref: string, opts, cmd: Command) => {
      const { client, flags } = getContext(cmd);
      const id = await resolveTaskId(client, ref, opts.project);
      const result = unwrap<components["schemas"]["MoveTaskResult"]>(
        await client.PUT("/task/move/{id}", {
          params: { path: { id } },
          body: {
            destinationProjectId: opts.toProject,
            ...(opts.status ? { destinationStatus: opts.status } : {}),
          },
        }),
      );
      if (flags.json) {
        printJson(result);
        return;
      }
      console.log(`moved ${ref} -> project ${opts.toProject}`);
    });

  task
    .command("delete <task>")
    .description("Delete a task permanently (id, or #number with --project)")
    .option("--project <id>", "project id (needed when referencing by number)")
    .action(async (ref: string, opts, cmd: Command) => {
      const { client, flags } = getContext(cmd);
      const id = await resolveTaskId(client, ref, opts.project);
      const result = unwrap(await client.DELETE("/task/{id}", { params: { path: { id } } }));
      if (flags.json) {
        printJson(result);
        return;
      }
      console.log(`deleted ${ref}`);
    });
}

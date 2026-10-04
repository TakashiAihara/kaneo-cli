import { writeSync } from "node:fs";
import { apiKey, project, taskProject, type App } from "./app";
import {
  bulkUpdate,
  createTask,
  deleteRelation,
  deleteTask,
  descriptionDeferred,
  exportProjectTasks,
  findTaskByNumber,
  getBoard,
  getTask,
  importProjectTasks,
  listColumns,
  linkTasks,
  listExternalLinks,
  listRelations,
  moveTask,
  PRIORITIES,
  priorityRank,
  projectTasks,
  RELATION_TYPES,
  setTaskAssignee,
  setTaskDescription,
  setTaskDueDate,
  setStartAndPosition,
  checkTimestamp,
  MAX_TASK_POSITION,
  setTaskPriority,
  setTaskStatus,
  taskSummary,
  type ExternalLink,
  type BulkOperation,
  type ImportedTask,
  type NewTask,
  type Relation,
  setTaskTitle,
  type Task,
} from "../api/kaneo";
import type { Json } from "../output/json";
import { exactArgs, minimumArgs, noArgs, rangeArgs, type FlagValues, type RunContext } from "./args";
import { readInput, sourceName } from "./input";
import { withProject } from "./lookup";

export const taskCommand = {
  name: "task",
  aliases: ["t"],
  short: "Work with tasks",
  children: [
    {
      name: "list",
      aliases: ["ls"],
      short: "List the tasks in a project",
      args: noArgs("kaneo task list"),
      flags: [
        { name: "status", type: "string" as const, usage: "only tasks in this column", defaultValue: "" },
        { name: "priority", type: "string" as const, usage: "only tasks with this priority", defaultValue: "" },
        {
          name: "all",
          type: "bool" as const,
          // Finished and filed-away work accumulates without bound, and neither
          // a planned task nor an archived one is on the board, so the listing
          // hides all three unless asked. --status done still shows them, since
          // that is an explicit request.
          usage: "include tasks in the done, planned and archived columns",
          defaultValue: "false",
        },
      ],
      run: async ({ flags, app }: { flags: FlagValues; app: App }) => {
        apiKey(app);
        const status = String(flags.status ?? "");
        const priority = String(flags.priority ?? "");
        // Asked of the server, which filters before it pages, and of the answer
        // as well (see TaskFilters).
        const board = await withProject(app, project(app), (id) => getBoard(id, { status, priority }));
        const tasks = filterTasks(projectTasks(board), status, priority, flags.all === true);
        for (const task of tasks) app.out.human(taskLine(task));
        app.out.data(tasks);
      },
    },
    {
      name: "get",
      use: "get <task>",
      short: "Show one task",
      args: exactArgs(1),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        const task = await withDescription(await resolveTask(app, args[0]!));
        // The links are read as well, so a task is shown whole. A read of them
        // that fails fails the command: a task whose links could not be read
        // looks exactly like a task that has none.
        const relations = await listRelations(task.id);
        app.out.human(`#${task.number}  ${task.title}`);
        app.out.human(`status    ${task.status}`);
        app.out.human(`priority  ${task.priority}`);
        if (task.startDate !== null) app.out.human(`start     ${task.startDate}`);
        if (task.dueDate !== null) app.out.human(`due       ${task.dueDate}`);
        if (relations.length > 0) {
          app.out.human("");
          app.out.human("relations");
          for (const relation of relations) app.out.human(`  ${relationLine(relation, task.id)}`);
        }
        if (task.description !== "") {
          app.out.human("");
          app.out.human(task.description);
        }
        app.out.data({ ...task, relations });
      },
    },
    {
      name: "create",
      use: "create <title>",
      short: "Create a task in a project",
      // Several words are one title: `task create fix the parser` is one task,
      // not three.
      args: minimumArgs(1),
      flags: [
        {
          name: "description",
          shorthand: "d",
          type: "string" as const,
          usage: "task description; - reads stdin",
          defaultValue: "",
        },
        {
          name: "description-file",
          type: "string" as const,
          usage: "read the description from a file; - reads stdin",
          defaultValue: "",
        },
        {
          name: "priority",
          type: "string" as const,
          usage: "urgent, high, medium, low or no-priority (default medium)",
          defaultValue: "",
        },
        {
          name: "status",
          type: "string" as const,
          usage: "column slug to create the task in (default to-do)",
          defaultValue: "",
        },
        { name: "due-date", type: "string" as const, usage: "due date", defaultValue: "" },
        { name: "assignee", type: "string" as const, usage: "user id to assign", defaultValue: "" },
      ],
      run: async ({ args, flags, changed, app }: RunContext<App>) => {
        apiKey(app);
        const wanted: NewTask = {
          title: args.join(" "),
          description: await descriptionOf(flags, changed),
          priority: String(flags.priority ?? ""),
          status: String(flags.status ?? ""),
          dueDate: String(flags["due-date"] ?? ""),
          assigneeId: String(flags.assignee ?? ""),
        };
        const task = await withProject(app, project(app), (id) => createTask(id, wanted));
        app.out.human(`created #${task.number} ${task.title}`);
        app.out.data(task);
      },
    },
    {
      name: "update",
      aliases: ["edit"],
      use: "update <task>",
      short: "Change a task's title, description, status, priority, start date or position; the rest is kept",
      args: exactArgs(1),
      flags: [
        { name: "title", type: "string" as const, usage: "new title", defaultValue: "" },
        {
          name: "description",
          shorthand: "d",
          type: "string" as const,
          usage: "new description; - reads stdin, empty clears it",
          defaultValue: "",
        },
        {
          name: "description-file",
          type: "string" as const,
          usage: "read the new description from a file; - reads stdin",
          defaultValue: "",
        },
        { name: "status", type: "string" as const, usage: "column id to move the task to", defaultValue: "" },
        {
          name: "priority",
          type: "string" as const,
          usage: `one of: ${PRIORITIES.join(", ")}`,
          defaultValue: "",
        },
        {
          name: "start-date",
          type: "string" as const,
          usage: "when the task starts: 2026-10-31 or 2026-10-31T09:00+09:00; empty clears it",
          defaultValue: "",
        },
        {
          name: "position",
          type: "string" as const,
          usage: "sort key within its column, lower first; other tasks keep theirs",
          defaultValue: "",
        },
      ],
      run: async ({ args, flags, changed, app }: RunContext<App>) => {
        // Only a flag that was passed is a change: `-d ""` clears the description
        // and leaving the flag out has to keep it.
        const pass = (name: string) => changed.has(name);
        const wantsDescription = pass("description") || pass("description-file");
        if (
          !pass("title") &&
          !wantsDescription &&
          !pass("priority") &&
          !pass("status") &&
          !pass("start-date") &&
          !pass("position")
        ) {
          throw new Error(
            "nothing to update: pass --title, --description, --description-file, --status, --priority, --start-date or --position",
          );
        }

        // What can be judged here is judged before the first write, so an
        // invocation that cannot be carried out leaves the task as it was. A
        // status is the one field the CLI cannot judge: only the server knows
        // which columns the project has, so it is written first and a column the
        // project does not have stops the rest of the change from landing.
        const title = pass("title") ? wantedTitle(String(flags.title ?? "")) : undefined;
        const status = pass("status") ? wantedStatus(String(flags.status ?? "").trim()) : undefined;
        const description = wantsDescription ? await descriptionOf(flags, changed) : undefined;
        const priority = pass("priority") ? knownPriority(String(flags.priority ?? "").trim()) : undefined;
        const startDate = pass("start-date") ? wantedStartDate(String(flags["start-date"] ?? "")) : undefined;
        const position = pass("position") ? wantedPosition(String(flags.position ?? "")) : undefined;

        apiKey(app);
        const task = await resolveTask(app, args[0]!);
        // The server refuses a start after the due date on the full update, and
        // that update comes last, so its refusal would arrive after the other
        // fields of this command had landed. The start it would check is the one
        // being set or, for --position alone, the one already stored: task due
        // and bulk --due do not check the range, so a stored start can already be
        // past the due date. (The null checks only narrow the types: a null date
        // parses to NaN, which compares false anyway.)
        if (startDate !== undefined || position !== undefined) {
          const start = startDate === undefined ? task.startDate : startDate;
          if (start !== null && task.dueDate !== null && Date.parse(start) > Date.parse(task.dueDate)) {
            throw new Error(
              startDate === undefined
                ? `#${task.number} starts ${start}, after its due date ${task.dueDate}, and the server refuses that on the update --position goes through; move the start with --start-date (or clear it with --start-date "") in the same command`
                : `--start-date ${start} is after #${task.number}'s due date ${task.dueDate}`,
            );
          }
        }

        // Each field that has its own endpoint is written by it rather than by
        // PUT /task/{id}, which requires title, priority, status, projectId and
        // position: sending them means reading the task first and writing those
        // values back, and a change made elsewhere in between would be
        // overwritten. The per-field endpoints also keep the activity row the
        // server writes for the field that changed. A start date and a position
        // have no endpoint of their own, so only they go through the full update
        // and take that risk.
        const wrote: string[] = [];
        const landed = () => `${names(wrote)} ${wrote.length === 1 ? "was" : "were"} updated`;
        const write = async (field: string, put: () => Promise<void>): Promise<void> => {
          try {
            await put();
          } catch (e) {
            // The first write failing means nothing landed, so its own error is
            // the whole story. After one that succeeded, the failure has to say
            // what did land or the task is left half changed with no word.
            if (wrote.length === 0) throw e;
            throw new Error(`${landed()}; ${field} failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          wrote.push(field);
        };
        if (status !== undefined) await write("status", () => setTaskStatus(task.id, status));
        if (title !== undefined) await write("title", () => setTaskTitle(task.id, title));
        if (description !== undefined) await write("description", () => setTaskDescription(task.id, description));
        if (priority !== undefined) await write("priority", () => setTaskPriority(task.id, priority));
        // Last, so the full update it goes through reads the task with the writes
        // above already in it and sends them back rather than undoing them.
        if (startDate !== undefined || position !== undefined) {
          const fields = [...(startDate === undefined ? [] : ["start date"]), ...(position === undefined ? [] : ["position"])];
          await write(names(fields), async () => {
            await setStartAndPosition(task.id, {
              ...(startDate === undefined ? {} : { startDate }),
              ...(position === undefined ? {} : { position }),
            });
          });
        }

        // Read the task back by id rather than by the number it was given as: the
        // board listing leaves a task out of every column once it has been
        // archived or only planned, and it leaves a description over 64 KiB out,
        // so a read that went by the board would call this command's own write a
        // mismatch for a task it just moved.
        //
        // Every field written is checked against what was sent, since a write the
        // server did not store is not an update. The fields not written are ones
        // this command never read and so cannot judge.
        let after: Task;
        try {
          after = await getTask(task.id);
        } catch (e) {
          throw new Error(
            `${landed()}; reading the task back failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        for (const [field, sent] of [
          ["title", title],
          ["description", description],
          ["priority", priority],
          ["status", status],
        ] as const) {
          if (sent === undefined || after[field] === sent) continue;
          // A description is reported by its length alone: printing one that did
          // not land fills a terminal with text nobody can read to the end of.
          throw new Error(
            `${landed()}, but task #${after.number} ${
              field === "description"
                ? `description reads back differently from the one that was sent (${after.description.length} characters read, ${sent.length} sent)`
                : `${field} reads back as ${JSON.stringify(after[field])}, not ${JSON.stringify(sent)}`
            }`,
          );
        }
        // The labels come from the task resolved above, since only the board
        // listing carries them and this report is shaped as `task get` shapes it.
        showTask({ ...after, labels: task.labels }, app);
      },
    },
    {
      name: "status",
      use: "status <task> <status>",
      short: "Move a task to another column",
      long:
        "Move a task to another column.\n\n" +
        "A status is a column slug. `kaneo column ls` lists the columns a project has;\n" +
        "the defaults are to-do, in-progress, in-review and done.",
      args: exactArgs(2),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        const task = await resolveTask(app, args[0]!);
        const status = args[1]!.trim();
        await setTaskStatus(task.id, status);
        app.out.human(`#${task.number} -> ${status}`);
        app.out.data({ id: task.id, number: task.number, status });
      },
    },
    {
      name: "priority",
      use: "priority <task> <priority>",
      short: "Change a task's priority",
      long: `Change a task's priority.\n\nOne of: ${PRIORITIES.join(", ")}.`,
      args: exactArgs(2),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        const task = await resolveTask(app, args[0]!);
        const priority = knownPriority(args[1]!.trim());
        await setTaskPriority(task.id, priority);
        app.out.human(`#${task.number} priority ${priority}`);
        app.out.data({ id: task.id, number: task.number, priority });
      },
    },
    {
      name: "assign",
      use: "assign <task> [user-id]",
      short: "Assign a task, or clear the assignee when no user is given",
      args: rangeArgs(1, 2),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        const task = await resolveTask(app, args[0]!);
        const user = args[1] ?? "";
        await setTaskAssignee(task.id, user);
        app.out.human(user === "" ? `#${task.number} unassigned` : `#${task.number} assigned to ${user}`);
        app.out.data({ assigneeId: user, id: task.id, number: task.number });
      },
    },
    {
      name: "due",
      use: "due <task> [date]",
      short: "Set a task's due date, or clear it when no date is given",
      long:
        "Set a task's due date, or clear it when no date is given.\n\n" +
        "The date is a calendar date (2026-10-31, read as midnight UTC) or a date and\n" +
        "time with an offset (2026-10-31T09:00+09:00).",
      args: rangeArgs(1, 2),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        // An empty date is refused rather than read as "clear": `task due 1 "$DATE"`
        // with DATE unset would otherwise wipe the date and exit 0.
        const given = args[1]?.trim();
        if (given === "") throw new Error("the date is empty; leave it out to clear the due date");
        const date = given === undefined ? "" : instant(given, "the due date");
        apiKey(app);
        const task = await resolveTask(app, args[0]!);
        const updated = await setTaskDueDate(task.id, date);
        app.out.human(
          updated.dueDate === null ? `#${task.number} no due date` : `#${task.number} due ${updated.dueDate}`,
        );
        app.out.data({ id: task.id, number: task.number, dueDate: updated.dueDate });
      },
    },
    {
      name: "bulk",
      use: "bulk <task>... <one change flag>",
      short: "Apply one change to many tasks in one request",
      long:
        "Apply one change to many tasks in one request.\n\n" +
        "Exactly one change flag is taken. Every task has to be in the same workspace.\n" +
        "The count reported is what the server changed, which can be fewer than the\n" +
        "tasks named: a label is not added twice, nor removed from a task without it.\n\n" +
        "A label is named by its id, as kaneo label ls --json shows it.\n\n" +
        "This goes through the server's bulk route, which differs from the one-task\n" +
        "commands in two ways: --delete does not remove the tasks' attachments from\n" +
        "storage, and --due does not reset the reminders already sent for a task.",
      args: minimumArgs(1),
      flags: [
        { name: "status", type: "string" as const, usage: "move every task to this column", defaultValue: "" },
        { name: "priority", type: "string" as const, usage: `set the priority: ${PRIORITIES.join(", ")}`, defaultValue: "" },
        { name: "assign", type: "string" as const, usage: "assign every task to this user id", defaultValue: "" },
        { name: "unassign", type: "bool" as const, usage: "clear every task's assignee", defaultValue: "false" },
        { name: "due", type: "string" as const, usage: "set the due date: 2026-10-31 or 2026-10-31T09:00+09:00", defaultValue: "" },
        { name: "clear-due", type: "bool" as const, usage: "clear every task's due date", defaultValue: "false" },
        { name: "add-label", type: "string" as const, usage: "add the label with this id", defaultValue: "" },
        { name: "remove-label", type: "string" as const, usage: "remove the label with this id", defaultValue: "" },
        { name: "delete", type: "bool" as const, usage: "delete every task (needs --yes)", defaultValue: "false" },
        { name: "yes", type: "bool" as const, usage: "confirm --delete", defaultValue: "false" },
      ],
      run: async ({ args, flags, changed, app }: { args: string[]; flags: FlagValues; changed: ReadonlySet<string>; app: App }) => {
        const [flag, operation, value] = bulkChange(flags, changed);
        if (flags.yes === true && operation !== "delete") throw new Error("--yes only confirms --delete");
        apiKey(app);
        // The same task named twice is one task to the server, and counting it
        // twice would make the report read as a task it skipped.
        const { tasks: resolved, slugs } = await resolveTasks(app, args);
        const named = [...new Map(resolved.map((t) => [t.id, t])).values()];
        // A number is only unique on its board, so tasks from several projects
        // are named with the project in front, by slug where a board was read.
        const several = new Set(named.map((t) => t.projectId)).size > 1;
        const projectName = (id: string) => slugs.get(id) ?? id;
        const numbers = named.map((t) => `${several ? projectName(t.projectId) : ""}#${t.number}`).join(" ");
        if (operation === "delete" && flags.yes !== true) {
          throw new Error(
            `refusing to delete ${named.length} task(s) (${numbers}) without --yes; this also removes their comments, where session history is kept`,
          );
        }
        if (operation === "updateStatus") await checkStatus(named, value!, projectName);
        const ids = named.map((t) => t.id);
        const updated = await bulkUpdate(ids, operation, value);
        app.out.human(
          `${flag}${value === null ? "" : ` ${value}`}: the server changed ${updated} of the ${ids.length} task(s) named (${numbers})`,
        );
        app.out.data({ operation, value, taskIds: ids, updatedCount: updated });
      },
    },
    {
      name: "export",
      short: "Write a project's tasks as JSON, in the form task import reads",
      long:
        "Write a project's tasks as JSON, in the form task import reads.\n\n" +
        "The document is the server's export: the project's name and slug, and each\n" +
        "task's title, description, status, priority, dates, assignee id and labels.\n" +
        "It is written to stdout as JSON whatever the output mode, so it can be\n" +
        "redirected to a file.",
      args: noArgs("kaneo task export"),
      run: async ({ app }: { app: App }) => {
        apiKey(app);
        const exported = await withProject(app, project(app), (id) => exportProjectTasks(id));
        // The export is the payload in both modes: a human asking for it wants the
        // file, and a summary instead would leave nothing to redirect. Only a
        // terminal gets the text with control characters replaced; a file gets
        // the document byte for byte, which `--human > file` would otherwise not.
        if (app.out.mode.json || app.out.filter !== undefined) app.out.data(exported as Json);
        else if (app.out.terminal) app.out.human(JSON.stringify(exported, null, 2));
        else writeSync(1, `${JSON.stringify(exported, null, 2)}\n`);
        app.out.status(`exported ${exported.tasks.length} task(s) from ${exported.project.slug}`);
      },
    },
    {
      name: "import",
      use: "import <file>",
      short: "Create tasks in a project from a JSON file (- reads stdin)",
      long:
        "Create tasks in a project from a JSON file (- reads stdin).\n\n" +
        "The file is what task export writes, or {\"tasks\": [...]}, or a bare array\n" +
        "of tasks. Each task needs a title and a status; description, priority,\n" +
        "startDate, dueDate and userId are optional. Labels are not imported: an\n" +
        "export names them without the ids the server would need.\n\n" +
        "A status the project has no column for, or a priority outside the fixed\n" +
        "list, is refused before anything is sent: the server would replace it, and\n" +
        "a task put in planned shows on no column. A task the server cannot create\n" +
        "(an assignee outside the workspace) is reported as failed, and the command\n" +
        "exits non-zero when any task failed. Running the file again creates every\n" +
        "task again, including the ones that went through.",
      args: exactArgs(1),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        // The file is read and checked before anything is sent, so a typo in the
        // path or a broken document creates nothing.
        const { tasks, labelled } = importedTasks(await readInput(args[0]!), args[0]!);
        const result = await withProject(app, project(app), async (id) => {
          checkImport(tasks, await listColumns(id), args[0]!);
          return importProjectTasks(id, tasks);
        });
        if (labelled > 0) app.out.status(`labels on ${labelled} task(s) were not imported`);
        for (const t of result.tasks) {
          if (t.success) app.out.human(`created  #${t.number} ${t.title}`);
          else app.out.human(`failed   ${t.title}: ${t.error}`);
          for (const warning of t.warnings) app.out.human(`warning  ${t.title}: ${warning}`);
        }
        app.out.human(`imported ${result.successful} of ${result.total} task(s)`);
        app.out.data(result as Json);
        if (result.failed > 0) throw new Error(`${result.failed} of ${result.total} task(s) were not imported`);
      },
    },
    {
      name: "move",
      use: "move <task> --to <project>",
      short: "Move a task to another project",
      args: exactArgs(1),
      flags: [{ name: "to", type: "string" as const, usage: "destination project id, slug or name", defaultValue: "" }],
      run: async ({ args, flags, app }: { args: string[]; flags: FlagValues; app: App }) => {
        const target = String(flags.to ?? "");
        if (target === "") throw new Error("no destination: pass --to <project>");
        apiKey(app);
        const task = await resolveTask(app, args[0]!);
        const projectId = await withProject(app, target, async (id) => {
          await moveTask(task.id, id);
          return id;
        });
        app.out.human(`#${task.number} moved to ${target}`);
        app.out.data({ id: task.id, projectId });
      },
    },
    {
      name: "rm",
      aliases: ["delete"],
      use: "rm <task>",
      short: "Delete a task",
      args: exactArgs(1),
      flags: [{ name: "yes", type: "bool" as const, usage: "confirm the deletion", defaultValue: "false" }],
      run: async ({ args, flags, app }: { args: string[]; flags: FlagValues; app: App }) => {
        apiKey(app);
        const task = await resolveTask(app, args[0]!);
        // Deleting a task takes its comments with it, and the session history
        // lives in those. Requiring the flag keeps that from happening by a slip
        // of the hand.
        if (flags.yes !== true) {
          throw new Error(
            `refusing to delete #${task.number} ${JSON.stringify(task.title)} without --yes; this also removes its comments, where session history is kept`,
          );
        }
        await deleteTask(task.id);
        app.out.human(`deleted #${task.number} ${task.title}`);
        app.out.data({ id: task.id, number: task.number });
      },
    },
    {
      name: "link",
      use: "link <task> <other-task> --type <type>",
      short: "Relate two tasks",
      long:
        `Relate two tasks.\n\n` +
        `The type carries the direction: subtask makes the first task the parent,\n` +
        `blocks makes it the one doing the blocking, and related has neither.\n` +
        `One of: ${RELATION_TYPES.join(", ")}.`,
      args: exactArgs(2),
      flags: [
        {
          name: "type",
          type: "string" as const,
          usage: `relation type (required): ${RELATION_TYPES.join(", ")}`,
          defaultValue: "",
        },
      ],
      run: async ({ args, flags, app }: { args: string[]; flags: FlagValues; app: App }) => {
        // Refused before anything is asked of the server: a link written with a
        // type nobody chose has to be undone before it can be written again.
        const relationType = givenType(flags);
        if (relationType === "") throw new Error(`pass --type: ${typeChoices}`);
        apiKey(app);
        const first = await resolveTask(app, args[0]!);
        const second = await resolveTask(app, args[1]!);
        const relation = await linkTasks(first.id, second.id, relationType);
        app.out.human(`#${first.number} ${relationWord(relationType, true)} #${second.number}`);
        app.out.data({ ...relation, sourceTask: taskSummary(first), targetTask: taskSummary(second) });
      },
    },
    {
      name: "unlink",
      use: "unlink <relation-id> | <task> <other-task>",
      short: "Remove the link between two tasks",
      long:
        `Remove the link between two tasks.\n\n` +
        `One argument is a relation id. Two are the two tasks, whose link is\n` +
        `removed whichever way round it runs; two tasks related more than once\n` +
        `need --type, one of ${RELATION_TYPES.join(", ")}, or the relation id itself.`,
      args: rangeArgs(1, 2),
      flags: [
        {
          name: "type",
          type: "string" as const,
          usage: `relation type: ${RELATION_TYPES.join(", ")}`,
          defaultValue: "",
        },
      ],
      run: async ({ args, flags, app }: { args: string[]; flags: FlagValues; app: App }) => {
        const relationType = givenType(flags);
        // One word is a relation id, and only a relation can be acted on alone.
        // A task number there means the other task was left out, and --type would
        // be ignored by an id that already names one relation, so both are
        // refused. A task id cannot be told from a relation id without asking the
        // server, and goes to the delete, which answers not found.
        if (args.length === 1) {
          const word = args[0]!;
          if (asNumber(word.startsWith("#") ? word.slice(1) : word) !== undefined) {
            throw new Error(`one argument is a relation id; to unlink two tasks give both: unlink ${word} <other-task>`);
          }
          if (relationType !== "") throw new Error("--type picks among the links of two tasks; a relation id already names one");
          apiKey(app);
          // The delete reply carries no task summaries, so this line names the
          // two tasks by id.
          const removed = await deleteRelation(word);
          app.out.human(`unlinked ${removed.sourceTaskId} ${relationWord(removed.relationType, true)} ${removed.targetTaskId}`);
          app.out.data(removed);
          return;
        }
        apiKey(app);
        const first = await resolveTask(app, args[0]!);
        const second = await resolveTask(app, args[1]!);
        const between = (await listRelations(first.id)).filter(
          (relation) =>
            (relationType === "" || relation.relationType === relationType) &&
            ((relation.sourceTaskId === first.id && relation.targetTaskId === second.id) ||
              (relation.sourceTaskId === second.id && relation.targetTaskId === first.id)),
        );
        if (between.length === 0) {
          throw new Error(
            `no ${relationType === "" ? "" : `${relationType} `}relation between #${first.number} and #${second.number}`,
          );
        }
        if (between.length > 1) {
          const listed = between.map((relation) => `${relation.relationType} ${relation.id}`).join(", ");
          throw new Error(
            `#${first.number} and #${second.number} are related more than once (${listed}): pass --type or a relation id`,
          );
        }
        // Worded the way the link runs, not the way the two tasks were given:
        // `unlink 2 1` on a link where #1 blocks #2 still reads "#1 blocks #2".
        const relation = between[0]!;
        const [source, target] = relation.sourceTaskId === first.id ? [first, second] : [second, first];
        const removed = await deleteRelation(relation.id);
        app.out.human(`unlinked #${source.number} ${relationWord(relation.relationType, true)} #${target.number}`);
        app.out.data({ ...removed, sourceTask: relation.sourceTask, targetTask: relation.targetTask });
      },
    },
    {
      name: "links",
      use: "links <task>",
      short: "List a task's relations",
      args: exactArgs(1),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        const task = await resolveTask(app, args[0]!);
        const relations = await listRelations(task.id);
        for (const relation of relations) app.out.human(relationLine(relation, task.id));
        app.out.data(relations);
      },
    },
    {
      name: "external-links",
      aliases: ["xlinks"],
      use: "external-links <task>",
      short: "List a task's external links",
      long:
        "List the links a task holds to what is outside the board.\n\n" +
        "A link an integration brought in is marked with the integration it came\n" +
        "through, which is what tells it apart from one added by hand.",
      args: exactArgs(1),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        const task = await resolveTask(app, args[0]!);
        const links = await listExternalLinks(task.id);
        for (const link of links) app.out.human(externalLinkLine(link));
        app.out.data(links);
      },
    },
  ],
};

// The relation types, named the way a person reads a choice out loud.
const typeChoices = `${RELATION_TYPES.slice(0, -1).join(", ")} or ${RELATION_TYPES[RELATION_TYPES.length - 1]!}`;

// The type --type asked for, or "" when it was not given. Refused rather than
// guessed, because a type is a word nobody reads back off the board: the wrong
// one has to be undone before the right one can be written.
const givenType = (flags: FlagValues): string => {
  const wanted = String(flags.type ?? "");
  if (wanted !== "" && !RELATION_TYPES.includes(wanted)) {
    throw new Error(`unknown relation type ${JSON.stringify(wanted)}; use one of: ${RELATION_TYPES.join(", ")}`);
  }
  return wanted;
};

// How each relation type reads from the two ends of a link, the source first and
// the target second. The type alone reads the wrong way round from one end: what
// blocks a task is what the other task is blocked by, and a subtask link has a
// parent at one end and a child at the other.
const relationWords: Record<string, [string, string]> = {
  blocks: ["blocks", "blocked by"],
  subtask: ["parent of", "subtask of"],
  related: ["related", "related"],
};

// The widest of those words, which is where every line's next column starts.
const RELATION_WORD_WIDTH = Math.max(...Object.values(relationWords).flat().map((word) => word.length));

// A type this CLI has no word for is shown as the server spelled it: the link is
// still there, whatever it is called.
const relationWord = (relationType: string, fromSource: boolean): string =>
  relationWords[relationType]?.[fromSource ? 0 : 1] ?? relationType;

const relationLine = (relation: Relation, taskId: string): string => {
  const fromSource = relation.sourceTaskId === taskId;
  const other = fromSource ? relation.targetTask : relation.sourceTask;
  const otherId = fromSource ? relation.targetTaskId : relation.sourceTaskId;
  const word = relationWord(relation.relationType, fromSource);
  // A task the server gave no number would read as #0, so it is named by id.
  return `${word.padEnd(RELATION_WORD_WIDTH)}  ${other === null || other.number === null ? otherId : `#${other.number}  ${other.title}`}`;
};

// Turns a reference into a task.
//
// A reference is a task id, a number with or without a leading '#', or a
// project's id, slug or name followed by '#' and that number. The last form is
// what follows `kaneo ` in KANEO_TASK_REF and in the references people write
// (`kaneo kaneo-cli#3`), so one copied from there names its own board.
//
// Numbers are what a person reads off the board, so they have to work wherever an
// id does — and a number is answered from the board rather than fetched as an id,
// because sending it as one makes the server answer 400 for a reason that names
// neither the task nor the number. The read stops at the page holding it, so the
// pages after that one are not read.
//
// An empty project is not refused here: a reference may be an id, which needs no
// board, so only a number asks for one.
export const resolveTask = async (app: App, ref: string, slugs?: Map<string, string>): Promise<Task> => {
  const wanted = ref.trim();
  if (wanted === "") throw new Error("no task given");

  const named = namedReference(wanted);
  if (named !== undefined) {
    return numberOn(app, named.project, named.number, "the reference", slugs);
  }

  const number = asNumber(wanted.startsWith("#") ? wanted.slice(1) : wanted);
  if (number === undefined) return getTask(wanted);
  const projectId = taskProject(app);
  if (projectId === "") {
    throw new Error(`task #${number} needs a project: pass --project or set KANEO_PROJECT`);
  }
  const origin = app.cfg.origin.project ?? "unset";
  return numberOn(app, projectId, number, origin === "repo-map" ? `the repo map for ${app.cfg.repo}` : origin, slugs);
};

// Several references at once. All are resolved before the caller writes
// anything, so one that does not resolve leaves every task as it was.
//
// The slugs of the boards read on the way come back too, so a report can name a
// project the way a reference does. A task named by id read no board, and its
// project has no slug here.
const resolveTasks = async (app: App, refs: string[]): Promise<{ tasks: Task[]; slugs: Map<string, string> }> => {
  const slugs = new Map<string, string>();
  const tasks: Task[] = [];
  for (const ref of refs) tasks.push(await resolveTask(app, ref, slugs));
  return { tasks, slugs };
};

// `<project>#<number>`: the project named before the hash, and a number on it.
//
// A hash with nothing in front of it names no project, so `#12` is a number and
// `BET#1` is a project and a number. A task id is a cuid and never holds a hash,
// so a value with one is a reference only when what follows the last hash is a
// number; anything else is passed on as an id.
const namedReference = (wanted: string): { project: string; number: number } | undefined => {
  const at = wanted.lastIndexOf("#");
  if (at < 1) return undefined;
  const number = asNumber(wanted.slice(at + 1));
  return number === undefined ? undefined : { project: wanted.slice(0, at), number };
};

// The task a number names on one project's board.
//
// The failure names the project it looked in and the layer that named it,
// because "no task #12" on its own cannot be acted on: the reader has to know
// which board to look somewhere else on.
//
// slugs, when given, collects the slug of the board read, so a caller naming
// several projects can name them the way a reference does.
const numberOn = async (
  app: App,
  value: string,
  number: number,
  origin: string,
  slugs?: Map<string, string>,
): Promise<Task> => {
  const { board, task: found } = await withProject(app, value, (id) => findTaskByNumber(id, number));
  slugs?.set(board.projectId, board.projectSlug);
  if (found === undefined) {
    // --project only steers a bare number; a reference names its board itself.
    const hint = origin === "the reference" ? "check the number" : "pass --project to look elsewhere";
    throw new Error(`no task #${number} in project ${board.projectSlug} (${board.projectId}, from ${origin}); ${hint}`);
  }
  // The board listing does not always carry projectId on each task, but a task
  // found here is on this project by definition.
  if (found.projectId === "") found.projectId = board.projectId;
  return found;
};

// A task found by number with its description in full. A description above
// 64 KiB is left out of the listing, and the listing is the only route that
// carries the labels, so only the description is taken from the task detail.
// Of the commands that resolve a task, only `task get` prints it, so only it pays
// the extra request; the listings print such a description as empty (#254).
const withDescription = async (task: Task): Promise<Task> =>
  descriptionDeferred(task) ? { ...task, description: (await getTask(task.id)).description } : task;

// Go's strconv.Atoi: a whole decimal integer and nothing else, so a reference
// that merely starts with digits stays a task id.
const asNumber = (text: string): number | undefined =>
  /^[+-]?\d+$/.test(text) ? Number.parseInt(text, 10) : undefined;

// A priority the server accepts, checked where it was typed.
//
// Refused rather than sent: the list of priorities is fixed, and a command that
// only names one has nothing to do with the server's answer but fail.
const knownPriority = (priority: string): string => {
  if (priorityRank(priority) === PRIORITIES.length) {
    throw new Error(`unknown priority ${JSON.stringify(priority)}; use one of: ${PRIORITIES.join(", ")}`);
  }
  return priority;
};

// A title as it was typed, refused only when it holds nothing to read. The
// server takes whitespace, and a task whose title is one space is a task nobody
// can pick out of a board listing.
const wantedTitle = (title: string): string => {
  if (title.trim() === "") throw new Error("empty --title");
  return title;
};

// A status with a column in it. Which column that is has to be asked of the
// server, and its answer names the columns the project has; what can be refused
// here is the empty value, which would move the task nowhere.
const wantedStatus = (status: string): string => {
  if (status === "") throw new Error("empty --status");
  return status;
};

// A start date, or null to clear it. Only an empty value clears, as `-d ""`
// clears a description; one that is not a date, spaces included, is refused
// before the first write, so a typo does not land the other fields of the same
// command without it.
const wantedStartDate = (given: string): string | null => (given === "" ? null : instant(given, "--start-date"));

// A date as the ISO instant it names: a calendar date alone (midnight UTC), or a
// date and time with an offset, as the time commands take one.
//
// Anything else is refused rather than handed to the server's Date: a time
// without an offset would be read in the server's zone, a bare number or a month
// and day as some day of 2001, and an impossible date such as 2026-02-30 would
// roll over to March. Each of those stores another instant than the one typed,
// and compares equal to it afterwards.
const instant = (given: string, label: string): string => {
  const full = /^\d{4}-\d{2}-\d{2}$/.test(given) ? `${given}T00:00:00Z` : given;
  try {
    checkTimestamp(label, full);
  } catch {
    throw new Error(
      `${label} ${JSON.stringify(given)} is not a date (2026-10-31) or a date and time with an offset (2026-10-31T09:00+09:00)`,
    );
  }
  return new Date(full).toISOString();
};

// A position as the route takes it: a whole number from 0 up to the largest the
// server stores.
const wantedPosition = (given: string): number => {
  const text = given.trim();
  const position = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!(position <= MAX_TASK_POSITION)) {
    throw new Error(`--position ${JSON.stringify(given)} is not a whole number from 0 to ${MAX_TASK_POSITION}`);
  }
  return position;
};

// Fields named as one English list, so a sentence reporting several of them
// reads as one sentence: "status and title were updated".
const names = (fields: string[]): string =>
  fields.length === 1 ? fields[0]! : `${fields.slice(0, -1).join(", ")} and ${fields[fields.length - 1]}`;

// The description a command line asked for: as it was typed, or from a file or
// stdin, which is how a long one is passed without a shell holding it.
//
// Two sources at once is a contradiction rather than a choice between them, so
// it is refused rather than one of them quietly winning.
//
// Text that was read and turned out to be nothing but whitespace is refused as
// well: `-d ""` is how a description is cleared, so a pipe or a file that
// carried nothing is far more likely to be a mistake than a request to clear
// the description. A description typed on the command line is taken as typed,
// whitespace and all, since nothing went missing on the way to it.
const descriptionOf = async (flags: FlagValues, changed: ReadonlySet<string>): Promise<string> => {
  const typed = changed.has("description");
  const fromFile = changed.has("description-file");
  if (typed && fromFile) throw new Error("pass --description or --description-file, not both");

  let source: string | undefined;
  if (fromFile) source = String(flags["description-file"] ?? "");
  else if (typed && String(flags.description ?? "") === "-") source = "-";
  if (source === undefined) return String(flags.description ?? "");

  const read = await readInput(source);
  if (read.trim() === "") {
    throw new Error(`empty description from ${sourceName(source)}; pass -d "" for an empty description`);
  }
  return read;
};

// The task `task update` just wrote, in the lines `task get` opens with. Its
// relations are left out: the update did not touch them, and reading them is a
// request of its own.
const showTask = (task: Task, app: App): void => {
  app.out.human(`#${task.number}  ${task.title}`);
  app.out.human(`status    ${task.status}`);
  app.out.human(`priority  ${task.priority}`);
  if (task.startDate !== null) app.out.human(`start     ${task.startDate}`);
  if (task.dueDate !== null) app.out.human(`due       ${task.dueDate}`);
  if (task.description !== "") {
    app.out.human("");
    app.out.human(task.description);
  }
  app.out.data(task);
};

// The statuses the listing leaves out unless they are asked for by name:
// finished and filed-away work accumulates without bound. A --status naming one
// of them is that question asked, so it shows them anyway.
const HIDDEN = ["done", "planned", "archived"];

const filterTasks = (tasks: Task[], status: string, priority: string, all: boolean): Task[] =>
  tasks.filter(
    (task) =>
      (status === "" || task.status === status) &&
      (priority === "" || task.priority === priority) &&
      (all || status !== "" || !HIDDEN.includes(task.status)),
  );

const taskLine = (task: Task): string =>
  `#${String(task.number).padEnd(4)} [${task.priority.padEnd(11)}] ${task.status.padEnd(13)} ${task.title}`;

// One external link as a person reads it: the URL, then whatever the provider or
// the author called it, then the integration it came through when it came through
// one at all. The second column is left out rather than padded when the title is
// absent or empty, since a blank one reads as a link that lost its name.
const externalLinkLine = (link: ExternalLink): string =>
  `${link.url}${link.title ? `  ${link.title}` : ""}${
    link.integrationType === null ? "" : `  (${link.integrationType} ${link.resourceType})`
  }`;

// The one change a bulk run makes, as the server's operation and value.
//
// Exactly one is taken: the server applies one operation per request, and
// picking one of several would silently drop the rest.
const bulkChange = (flags: FlagValues, changed: ReadonlySet<string>): [string, BulkOperation, string | null] => {
  // A value flag passed as "" is a mistake, not an absent flag: reading it as
  // absent would report "none was given" about a flag the caller did give.
  for (const name of ["status", "priority", "assign", "due", "add-label", "remove-label"]) {
    if (changed.has(name) && String(flags[name] ?? "").trim() === "") throw new Error(`--${name} is empty`);
  }
  const text = (name: string) => String(flags[name] ?? "").trim();
  const given: [string, BulkOperation, string | null][] = [];
  if (text("status") !== "") given.push(["--status", "updateStatus", text("status")]);
  if (text("priority") !== "") given.push(["--priority", "updatePriority", text("priority")]);
  if (text("assign") !== "") given.push(["--assign", "updateAssignee", text("assign")]);
  if (flags.unassign === true) given.push(["--unassign", "updateAssignee", null]);
  if (text("due") !== "") given.push(["--due", "updateDueDate", instant(text("due"), "--due")]);
  if (flags["clear-due"] === true) given.push(["--clear-due", "updateDueDate", null]);
  if (text("add-label") !== "") given.push(["--add-label", "addLabel", text("add-label")]);
  if (text("remove-label") !== "") given.push(["--remove-label", "removeLabel", text("remove-label")]);
  if (flags.delete === true) given.push(["--delete", "delete", null]);
  if (given.length !== 1) {
    const named = given.length === 0 ? "none was given" : `got ${given.map(([flag]) => flag).join(", ")}`;
    throw new Error(
      `pass exactly one of --status, --priority, --assign, --unassign, --due, --clear-due, --add-label, --remove-label, --delete; ${named}`,
    );
  }
  const [flag, operation, value] = given[0]!;
  // Refused here for the reason task priority refuses it: the list is fixed.
  if (operation === "updatePriority" && priorityRank(value!) === PRIORITIES.length) {
    throw new Error(`unknown priority ${JSON.stringify(value)}; use one of: ${PRIORITIES.join(", ")}`);
  }
  return [flag, operation, value];
};

// Statuses the server takes without a column holding them.
const VIRTUAL_STATUSES = ["planned", "archived"];

// Refuses a status that one of the tasks' projects has no column for, before
// anything is sent.
//
// The server checks and writes one project at a time without a transaction, so a
// status missing from the second project is refused only after the first
// project's tasks have moved, and the 400 reads as if nothing changed.
const checkStatus = async (tasks: Task[], status: string, projectName: (id: string) => string): Promise<void> => {
  const projects = new Set(tasks.map((t) => t.projectId));
  // One project is checked and written in one step, so the server's own 400
  // comes before any write.
  if (projects.size < 2 || VIRTUAL_STATUSES.includes(status)) return;
  for (const projectId of projects) {
    const columns = await listColumns(projectId);
    if (!columns.some((c) => c.slug === status)) {
      const numbers = tasks.filter((t) => t.projectId === projectId).map((t) => `#${t.number}`).join(" ");
      throw new Error(
        `project ${projectName(projectId)} (${numbers}) has no column ${JSON.stringify(status)}; its columns are ${columns.map((c) => c.slug).join(", ")}`,
      );
    }
  }
};

// The tasks a document holds, in the body the import route takes.
//
// An export carries labels and nothing the route takes for them, so only the
// fields the route reads are sent, as written: a title or status is checked for
// being blank but not trimmed. Title and status are checked here because the
// server's answer for a missing one names an array index, not the task.
const importedTasks = (text: string, source: string): { tasks: ImportedTask[]; labelled: number } => {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`${source}: not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const list = Array.isArray(doc) ? doc : (doc as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(list)) throw new Error(`${source}: expected a task export, {"tasks": [...]} or an array of tasks`);
  if (list.length === 0) throw new Error(`${source}: no tasks to import`);
  // An export carries labels the route has no field for; they are counted so the
  // command can say they were left behind.
  const labelled = list.filter((t) => Array.isArray(t?.labels) && t.labels.length > 0).length;
  const tasks = list.map((raw, at) => {
    const t = (raw ?? {}) as Record<string, unknown>;
    // A field of the wrong type is refused rather than dropped: a dropped
    // priority or date would create the task without it and say nothing.
    for (const name of ["title", "status", "description", "priority", "startDate", "dueDate", "userId"]) {
      const value = t[name];
      const nullable = name === "startDate" || name === "dueDate" || name === "userId";
      if (value !== undefined && typeof value !== "string" && !(nullable && value === null)) {
        throw new Error(`${source}: task ${at + 1} has ${name} ${JSON.stringify(value)}, which is not ${nullable ? "a string or null" : "a string"}`);
      }
    }
    const field = (name: string): string | undefined => (typeof t[name] === "string" ? (t[name] as string) : undefined);
    const nullable = (name: string): string | null | undefined => (t[name] === null ? null : field(name));
    const title = field("title");
    const status = field("status");
    if (title === undefined || title.trim() === "") throw new Error(`${source}: task ${at + 1} has no title`);
    if (status === undefined || status.trim() === "") throw new Error(`${source}: task ${at + 1} has no status`);
    const out: ImportedTask = { title, status };
    for (const name of ["description", "priority"] as const) {
      const value = field(name);
      if (value !== undefined) out[name] = value;
    }
    for (const name of ["startDate", "dueDate", "userId"] as const) {
      const value = nullable(name);
      if (value === undefined) continue;
      // The server turns the string into a Date without checking it, so an
      // unparsable one would fail that task with an error that names neither
      // the field nor the value. A date is sent as the instant it was read as.
      if (name !== "userId" && value !== null && value !== "") {
        out[name] = instant(value, `${source}: task ${at + 1}'s ${name}`);
        continue;
      }
      out[name] = value;
    }
    return out;
  });
  return { tasks, labelled };
};

// Refuses what the server would quietly replace: a status this project has no
// column for (it becomes planned, which no column shows) and a priority outside
// the fixed list (it becomes no-priority).
const checkImport = (tasks: ImportedTask[], columns: { slug: string }[], source: string): void => {
  const slugs = columns.map((c) => c.slug);
  tasks.forEach((t, at) => {
    if (!slugs.includes(t.status) && !VIRTUAL_STATUSES.includes(t.status)) {
      throw new Error(
        `${source}: task ${at + 1} has status ${JSON.stringify(t.status)}, which this project has no column for; its columns are ${slugs.join(", ")}`,
      );
    }
    if (t.priority !== undefined && t.priority !== "" && priorityRank(t.priority) === PRIORITIES.length) {
      throw new Error(`${source}: task ${at + 1} has priority ${JSON.stringify(t.priority)}; use one of: ${PRIORITIES.join(", ")}`);
    }
  });
};

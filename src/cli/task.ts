import { writeSync } from "node:fs";
import { basename } from "node:path";
import { holding } from "../session/marker";
import { apiKey, project, taskProject, workspace, type App } from "./app";
import {
  bulkUpdate,
  createExternalLink,
  currentUser,
  deleteExternalLink,
  duplicateTask,
  finalizeTaskImage,
  findDeferredTaskDescriptions,
  getProject,
  getTaskDescription,
  listMembers,
  afterWrite,
  createTask,
  deleteRelation,
  deleteTask,
  descriptionDeferred,
  exportProjectTasks,
  findTaskByNumber,
  getBoard,
  getTask,
  getTaskByTicketId,
  importProjectTasks,
  listColumns,
  linkTasks,
  listExternalLinks,
  listMyTasks,
  listComments,
  listRelations,
  listTaskFieldValues,
  moveTask,
  PRIORITIES,
  priorityRank,
  projectTasks,
  RELATION_TYPES,
  setCustomFieldValue,
  setTaskAssignee,
  setTaskDescription,
  setTaskDueDate,
  setStartAndPosition,
  checkTimestamp,
  MAX_TASK_POSITION,
  setTaskPriority,
  setTaskStatus,
  stageTaskImage,
  taskSummary,
  type AssignedTask,
  type ExternalLink,
  type BulkOperation,
  type ImageSurface,
  type ImportedTask,
  type NewTask,
  type Relation,
  setTaskTitle,
  type Task,
} from "../api/kaneo";
import type { Json } from "../output/json";
import { exactArgs, minimumArgs, noArgs, rangeArgs, type FlagValues, type RunContext } from "./args";
import { readInput, sourceName } from "./input";
import { shellWord } from "../output/output";
import { KaneoApiError, putUpload } from "../api/http";
import { resolveWorkspace, slugOr, withProject, workspaceInReference } from "./lookup";
import { resolveField } from "./field";
import { attachTask, currentSessionId } from "../session/attach";
import { BAD_ID, validSessionId } from "../session/store";
import { sharedReference, similarOpenTasks } from "./similar";

// The user id a person's wording of an assignee stands for: `me`, a member's id
// or a member's name. An id is tried before a name so a member named like
// another's id cannot capture it. The members are those of the workspace the
// task's own project is in, whatever workspace is configured.
const resolveAssignee = (task: Task, given: string): Promise<string> =>
  resolveAssigneeIn(task.projectId, `the project of task #${task.number}`, given);

// The same for a project named by its id, where `of` says in words which project
// that is, since a task create has no task yet to name it by.
const resolveAssigneeIn = async (projectId: string, of: string, given: string): Promise<string> => {
  const value = given.trim();
  if (value === "") throw new Error("the user is empty; give a member's id or name, `me`, or leave it out to clear the assignee");
  if (value.toLowerCase() === "me") {
    const id = (
      await currentUser().catch((e: unknown) => {
        if (e instanceof KaneoApiError && e.statusCode === 404 && !e.messages.includes("User not found")) {
          throw new Error(`${e.message}; \`me\` needs /user/me, which this server does not have (Kaneo before v2.28.0); give a member's id or name instead`);
        }
        if (e instanceof KaneoApiError && e.statusCode === 404) {
          throw new Error(`${e.message}; the server has no user for this API key; give a member's id or name instead`);
        }
        throw e;
      })
    ).id;
    if (id === "") throw new Error("the server did not say which user the API key is; give a member's id or name instead");
    return id;
  }
  const read = await getProject(projectId).catch((e: unknown) => {
    throw new Error(`reading project ${projectId}, ${of}, to find its workspace: ${(e as Error).message}`);
  });
  const workspaceId = read.workspaceId;
  if (workspaceId === "") {
    throw new Error(`reading project ${projectId}, ${of}, did not say which workspace it is in, so its members cannot be listed`);
  }
  const members = await listMembers(workspaceId);
  if (members.some((m) => m.id === value)) return value;
  const named = members.filter((m) => m.name.toLowerCase() === value.toLowerCase());
  if (named.length === 0) {
    throw new Error(
      `no member of workspace ${workspaceId} has the id or name ${JSON.stringify(value)}; \`kaneo workspace members -w ${shellWord(workspaceId)}\` lists them`,
    );
  }
  if (named.length > 1) {
    throw new Error(
      `${named.length} members of workspace ${workspaceId} are named ${JSON.stringify(value)} (${named.map((m) => m.id).join(", ")}); give the id (\`kaneo workspace members -w ${shellWord(workspaceId)}\` lists them)`,
    );
  }
  return named[0]!.id;
};

export const taskCommand = {
  name: "task",
  aliases: ["t"],
  short: "Work with tasks",
  children: [
    {
      name: "list",
      aliases: ["ls"],
      short: "List the tasks in a project",
      long:
        "List the tasks in a project.\n\n" +
        "With --mine the listing is instead the open tasks assigned to you across the\n" +
        "whole workspace: the project setting is not used, the server returns at most\n" +
        "100 (stderr says when it cut the list), and --status, --priority, --all and\n" +
        "--description are refused because the server takes no filter for it.",
      args: noArgs("kaneo task list"),
      flags: [
        { name: "status", type: "string" as const, usage: "only tasks in this column", defaultValue: "" },
        { name: "priority", type: "string" as const, usage: "only tasks with this priority", defaultValue: "" },
        {
          name: "mine",
          type: "bool" as const,
          usage: "the open tasks assigned to you across the workspace, whatever the project",
          defaultValue: "false",
        },
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
        {
          name: "description",
          type: "string" as const,
          usage: "only tasks whose description contains this text",
          defaultValue: "",
        },
      ],
      run: async ({ flags, changed, app }: { flags: FlagValues; changed: ReadonlySet<string>; app: App }) => {
        apiKey(app);
        // A value flag passed as "" is a mistake, not an absent flag, as bulk
        // reads them. Checked before --mine, whose refusal of the flag would
        // otherwise never see the empty value it was given.
        if (changed.has("description") && String(flags.description ?? "").trim() === "") throw new Error("--description is empty");
        if (flags.mine === true) {
          // The server lists open tasks only and takes no filter (as of v2.32.0), so a flag that
          // narrows or widens the listing would be accepted and do nothing.
          for (const name of ["status", "priority", "all", "description"]) {
            if (flags[name] !== undefined && flags[name] !== "" && flags[name] !== false) {
              throw new Error(`--${name} cannot be combined with --mine`);
            }
          }
          const mine = await listMyTasks(await resolveWorkspace(workspace(app)));
          for (const task of mine.tasks) app.out.human(assignedLine(task));
          if (mine.total > mine.tasks.length) {
            console.error(`(showing ${mine.tasks.length} of ${mine.total} assigned tasks)`);
          }
          app.out.data(mine.tasks);
          return;
        }
        const status = String(flags.status ?? "");
        const priority = String(flags.priority ?? "");
        const query = String(flags.description ?? "").trim();
        if (query.length > 256) throw new Error("--description is longer than 256 characters");
        // Asked of the server, which filters before it pages, and of the answer
        // as well (see TaskFilters).
        const board = await withProject(project(app), (id) => getBoard(id, { status, priority }));
        const everything = projectTasks(board);
        // A description the listing deferred is not on the task to match, so
        // the deferred ones are asked of the server by id and the rest are
        // matched here, both case-insensitively as the server matches.
        const described =
          query === ""
            ? everything
            : await describedTasks(board.projectId, everything, query);
        const tasks = filterTasks(described, status, priority, flags.all === true);
        for (const task of tasks) app.out.human(taskLine(task));
        // The columns left out are not otherwise visible, so a count of the
        // listing reads as a count of the project. On stderr in every mode, as
        // warnSimilar does, so stdout stays the array it was; counted under the
        // same --status and --priority, so it is the tasks --all would add.
        const left = filterTasks(described, status, priority, true).length - tasks.length;
        if (left > 0) console.error(`(${left} done / planned / archived ${left === 1 ? "task" : "tasks"} left out; --all to include them)`);
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
        // The sessions holding the task are read the same way, and fail the
        // command the same way: a task whose comments could not be read looks
        // exactly like a task nobody holds, which is what a second session
        // attaching to it would be told.
        const sessions = await heldBy(task);
        app.out.human(`#${task.number}  ${task.title}`);
        app.out.human(`status    ${task.status}`);
        app.out.human(`priority  ${task.priority}`);
        if (task.startDate !== null) app.out.human(`start     ${task.startDate}`);
        if (task.dueDate !== null) app.out.human(`due       ${task.dueDate}`);
        if (relations.length > 0) {
          app.out.human("");
          app.out.human("relations");
          const projects = await relatedProjects(relations, task.projectId);
          for (const relation of relations) app.out.human(`  ${relationLine(relation, task.id, projects)}`);
        }
        if (sessions.length > 0) {
          app.out.human("");
          app.out.human("sessions");
          for (const held of sessions) {
            app.out.human(`  ${held.sessionId.slice(0, 8)} @${held.host} ${held.cwd} (${held.branch})`);
          }
        }
        if (task.description !== "") {
          app.out.human("");
          app.out.human(task.description);
        }
        app.out.data({ ...task, relations, sessions });
      },
    },
    {
      name: "describe",
      use: "describe <task>",
      short: "Print a task's description",
      long:
        "Print a task's description in full.\n\n" +
        "The listing leaves out a description above 64 KiB; this reads it\n" +
        "through the route that pages large descriptions, so it is the way to\n" +
        "see one of those.",
      args: exactArgs(1),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        const task = await resolveTask(app, args[0]!);
        const description = await getTaskDescription(task.id);
        app.out.human(description);
        app.out.data(description);
      },
    },
    {
      name: "create",
      use: "create <title>",
      short: "Create a task in a project",
      long:
        "Create a task in a project.\n\n" +
        "The title is the words after create, or --title as task update takes it;\n" +
        "not both.\n\n" +
        "With --attach this session is attached to the new task as `session attach`\n" +
        "would do it, which is what keeps the new number from having to be carried by\n" +
        "hand to the next command. A title naming a reference an open task already\n" +
        "names refuses the create unless --force is given; a title merely worded like\n" +
        "one is created, with the tasks it resembles reported on stderr.",
      // Several words are one title: `task create fix the parser` is one task,
      // not three. --title is the other way to give it, as task update takes it,
      // so the arguments are checked in run, where the flag can be seen.
      flags: [
        { name: "title", type: "string" as const, usage: "task title, instead of the words after create", defaultValue: "" },
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
        {
          name: "start-date",
          type: "string" as const,
          usage: "start date: a date, or a date and time with an offset",
          defaultValue: "",
        },
        {
          name: "due-date",
          type: "string" as const,
          usage: "due date: a date, or a date and time with an offset",
          defaultValue: "",
        },
        { name: "assignee", type: "string" as const, usage: "member id, member name or `me`, as task assign takes them", defaultValue: "" },
        {
          name: "attach",
          type: "bool" as const,
          usage: "attach this session to the new task, as `session attach` would",
          defaultValue: "false",
        },
        {
          name: "next",
          type: "string" as const,
          usage: "first step to record on the new task; needs --attach",
          defaultValue: "",
        },
        {
          name: "force",
          type: "bool" as const,
          usage: "create the task even when an open task names the same reference",
          defaultValue: "false",
        },
      ],
      run: async ({ args, flags, changed, app }: RunContext<App>) => {
        if (changed.has("title") && args.length > 0) throw new Error("give the title once: as words after create or as --title, not both");
        if (!changed.has("title")) minimumArgs(1)(args);
        // As task update does, before the key is asked for: what is typed wrong
        // is said before what is missing from the environment.
        const title = changed.has("title") ? wantedTitle(String(flags.title ?? "")) : wantedTitle(args.join(" "), "empty title");
        apiKey(app);
        const wanted: NewTask = {
          title,
          description: await descriptionOf(flags, changed),
          priority: String(flags.priority ?? ""),
          status: String(flags.status ?? ""),
          startDate: wantedStartDate(String(flags["start-date"] ?? "")) ?? "",
          dueDate: String(flags["due-date"] ?? "") === "" ? "" : instant(String(flags["due-date"]), "--due-date"),
          assigneeId: String(flags.assignee ?? ""),
        };
        // As task update refuses it, before anything is written.
        if (Date.parse(wanted.startDate) > Date.parse(wanted.dueDate)) {
          throw new Error(`--start-date ${wanted.startDate} is after --due-date ${wanted.dueDate}`);
        }
        const attach = flags.attach === true;
        // As typed, the way `session attach` takes its step: the same act has to
        // record the same text whichever command was reached for it.
        const next = String(flags.next ?? "");
        const force = flags.force === true;
        // Refused before anything is asked of the server: a next step with no
        // attachment to write it on would be dropped, and a step dropped reads
        // as one that was recorded. What decides it is the flag having been
        // passed rather than what it holds, since `--next ""` asks for a step to
        // be recorded as much as any other value does.
        if (changed.has("next") && !attach) throw new Error("--next needs --attach");
        let session = "";
        if (attach) {
          // Checked before the create rather than after it, so a create that could
          // not be attached leaves nothing behind to close by hand.
          session = currentSessionId();
          if (session === "") throw new Error("--attach needs a session id: set KANEO_SESSION_ID");
          // The store refuses the id only after the marker is posted, which is too
          // late to leave nothing behind.
          if (!validSessionId(session)) throw new Error(`--attach: ${BAD_ID}`);
        }

        let open: Task[] = [];
        const task = await withProject(project(app), async (id) => {
          // Before anything is created, so a name that matches nobody leaves no
          // task behind. An empty one is no assignee, as it was before names.
          if (wanted.assigneeId !== "") wanted.assigneeId = await resolveAssigneeIn(id, `the project the task is created in`, wanted.assigneeId);
          // Inside the resolution because withProject needs its first request to
          // carry the project (see withProject in src/cli/lookup.ts), so the board
          // and the create are written as the one project a slug or a name
          // resolves to. --force skips the read: the caller has said the duplicate
          // is wanted.
          if (!force) {
            open = projectTasks(await getBoard(id));
            refuseDuplicate(wanted.title, open);
          }
          return afterWrite(`created ${JSON.stringify(wanted.title)}`, `\`kaneo task ls -p ${shellWord(id)}\` shows it`, createTask(id, wanted));
        });
        // After the create, since the warning is about a task that now exists.
        if (!force) warnSimilar(wanted.title, open);
        if (attach) {
          try {
            await attachTask(app, session, task, next);
          } catch (e) {
            // The task exists, so the message names it: a caller told only that
            // the attach failed would not know what to close or to keep.
            throw new Error(
              `created #${task.number} ${task.title} but could not attach this session: ${(e as Error).message}`,
            );
          }
        }
        app.out.human(`created #${task.number} ${task.title}`);
        if (attach) app.out.human(`attached: #${task.number} ${task.title}`);
        app.out.data(task);
      },
    },
    {
      name: "update",
      aliases: ["edit"],
      use: "update <task>",
      short: "Change a task's title, description, status, priority, assignee, start date or position; the rest is kept",
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
          name: "assignee",
          type: "string" as const,
          usage: "member id, member name or `me`, as task assign takes them; empty clears the assignee",
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
          !pass("assignee") &&
          !pass("start-date") &&
          !pass("position")
        ) {
          throw new Error(
            "nothing to update: pass --title, --description, --description-file, --status, --priority, --assignee, --start-date or --position",
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
        // Resolved before the first write, since a name that matches no member
        // has to leave the task as it was.
        const wantedAssignee = String(flags.assignee ?? "");
        const assignee = !pass("assignee") ? undefined : wantedAssignee.trim() === "" ? "" : await resolveAssignee(task, wantedAssignee);
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
        if (assignee !== undefined) await write("assignee", () => setTaskAssignee(task.id, assignee));
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
        if (assignee !== undefined && (after.assigneeId ?? "") !== assignee) {
          throw new Error(`${landed()}, but task #${after.number} assignee reads back as ${JSON.stringify(after.assigneeId)}, not ${JSON.stringify(assignee)}`);
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
        const after = await taskAfterWrite(task, "status was set");
        readBack("status", after.status, status);
        app.out.human(`#${after.number} -> ${after.status}`);
        app.out.data(after);
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
        const after = await taskAfterWrite(task, "priority was set");
        readBack("priority", after.priority, priority);
        app.out.human(`#${after.number} priority ${after.priority}`);
        app.out.data(after);
      },
    },
    {
      name: "assign",
      use: "assign <task> [user]",
      short: "Assign a task, or clear the assignee when no user is given",
      long:
        "Assign a task, or clear the assignee when no user is given.\n\n" +
        "The user is a member's id, a member's name (matched whole, ignoring case) or\n" +
        "`me` for the API key's own user. Names and ids are matched against the members\n" +
        "of the task's workspace: an id that is not one of them is refused, as is a\n" +
        "name that matches no member or more than one.",
      args: rangeArgs(1, 2),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        const task = await resolveTask(app, args[0]!);
        const user = args[1] === undefined ? "" : await resolveAssignee(task, args[1]);
        await setTaskAssignee(task.id, user);
        const after = await taskAfterWrite(task, user === "" ? "assignee was cleared" : "assignee was set");
        readBack("assignee", after.assigneeId, user);
        // The name the server resolved the id to, which is what a person reads
        // off the board; the id itself where the server named nobody.
        app.out.human(
          after.assigneeId === null
            ? `#${after.number} unassigned`
            : `#${after.number} assigned to ${after.assigneeName ?? after.assigneeId}`,
        );
        app.out.data(after);
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
        { name: "assign", type: "string" as const, usage: "assign every task to this member (id, name or `me`, as task assign takes them)", defaultValue: "" },
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
        const projectName = (id: string) => slugOr(slugs.get(id) ?? "", id);
        const numbers = named.map((t) => `${several ? projectName(t.projectId) : ""}#${t.number}`).join(" ");
        if (operation === "delete" && flags.yes !== true) {
          throw new Error(
            `refusing to delete ${named.length} task(s) (${numbers}) without --yes; this also removes their comments, where session history is kept`,
          );
        }
        if (operation === "updateStatus") await checkStatus(named, value!, projectName);
        const ids = named.map((t) => t.id);
        // Every task is in one workspace, so the first one's project says whose
        // members are meant. Resolved before the request, which changes all or none.
        const change = flag === "--assign" ? await resolveAssignee(named[0]!, value!) : value;
        const updated = await bulkUpdate(ids, operation, change);
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
        // Named by id: two projects can share a name.
        let projectId = "";
        const exported = await withProject(project(app), (id) => {
          projectId = id;
          return exportProjectTasks(id);
        });
        // The export is the payload in both modes: a human asking for it wants the
        // file, and a summary instead would leave nothing to redirect. Only a
        // terminal gets the text with control characters replaced; a file gets
        // the document byte for byte, which `--human > file` would otherwise not.
        if (app.out.mode.json || app.out.filter !== undefined) app.out.data(exported as Json);
        else if (app.out.terminal) app.out.human(JSON.stringify(exported, null, 2));
        else writeSync(1, `${JSON.stringify(exported, null, 2)}\n`);
        app.out.status(`exported ${exported.tasks.length} task(s) from ${slugOr(exported.project.slug, projectId)}`);
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
        "export names them without the ids the server would need, and once the\n" +
        "import has run, how many tasks had them is said on stderr.\n\n" +
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
        const result = await withProject(project(app), async (id) => {
          checkImport(tasks, await listColumns(id), args[0]!);
          return importProjectTasks(id, tasks);
        });
        // On stderr in every mode, as task ls says what it left out: a script
        // reading the JSON report would otherwise never learn the labels were
        // dropped, since the report is the server's and does not name them; an
        // entry added to its warnings would read as the server's own.
        if (labelled > 0) console.error(`labels on ${labelled} task(s) were not imported`);
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
        // The destination is resolved before the task is read back, so the two are
        // compared as what the server was given rather than as what was typed.
        const projectId = await withProject(
          target,
          async (id) => {
            await moveTask(task.id, id);
            return id;
          },
          { sameWorkspaceAs: task.projectId },
        );
        const after = await taskAfterWrite(task, "project was set");
        readBack("project", after.projectId, projectId);
        // The destination as it was typed: the read-back above has already
        // confirmed the task sits on the project the value resolved to, so a
        // reader is shown what they asked for rather than the id behind it.
        app.out.human(`#${after.number} moved to ${target}`);
        app.out.data(after);
      },
    },
    {
      name: "duplicate",
      use: "duplicate <task>",
      short: "Copy a task",
      long:
        "Copy a task within its project.\n\n" +
        "The copy keeps the source's column, priority, assignee, dates, labels\n" +
        "and description; --title gives it a different title, and --to moves\n" +
        "the copy to another project afterwards.",
      args: exactArgs(1),
      flags: [
        { name: "title", type: "string" as const, usage: "title for the copy (default: the same title)", defaultValue: "" },
        { name: "to", type: "string" as const, usage: "move the copy to this project (id, slug or name)", defaultValue: "" },
      ],
      run: async ({ args, flags, changed, app }: { args: string[]; flags: FlagValues; changed: ReadonlySet<string>; app: App }) => {
        // An empty --title is refused before the copy is made: the server reads
        // a blank one as no title at all and would keep the source's, which is
        // not what was asked.
        const title = changed.has("title") ? wantedTitle(String(flags.title ?? "")) : undefined;
        const to = String(flags.to ?? "");
        if (changed.has("to") && to.trim() === "") throw new Error("empty --to");
        apiKey(app);
        const task = await resolveTask(app, args[0]!);
        // The destination is resolved before the copy is made, so a --to that
        // names no project fails before anything is written. The source's own
        // project is refused for the same reason: the move would fail after
        // the copy existed, leaving it behind. A project in another workspace
        // would strand the copy the same way — the server moves a task only
        // within its own workspace — and the probe is a read that answers a
        // project in any workspace the key reaches, so the two workspaces are
        // compared here, while nothing is written yet.
        let destId = "";
        if (to !== "") {
          let destWorkspace = "";
          destId = await withProject(
            to,
            async (id) => {
              const project = await getProject(id);
              destWorkspace = project.workspaceId;
              return id;
            },
            { sameWorkspaceAs: task.projectId },
          );
          if (destId === task.projectId) {
            throw new Error(`--to ${JSON.stringify(to)} is the project the task is already in`);
          }
          const sourceWorkspace = (await getProject(task.projectId)).workspaceId;
          if (destWorkspace !== sourceWorkspace) {
            throw new Error(
              `--to ${JSON.stringify(to)} names a project in another workspace; the server moves a task only within its own workspace`,
            );
          }
        }
        const copy = await duplicateTask(task.id, title);
        let shown = copy;
        if (destId !== "") {
          try {
            await moveTask(copy.id, destId);
          } catch (e) {
            throw new Error(
              `duplicated #${task.number} as #${copy.number}, but moving the copy to ${to} failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          shown = await taskAfterWrite(copy, "the copy was moved");
          readBack("project", shown.projectId, destId);
        }
        app.out.human(`duplicated #${task.number} as #${shown.number} ${shown.title}`);
        app.out.data(shown);
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
        const projects = await relatedProjects(relations, task.projectId);
        for (const relation of relations) app.out.human(relationLine(relation, task.id, projects));
        app.out.data(relations);
      },
    },
    {
      name: "external-links",
      aliases: ["xlinks"],
      use: "external-links <task>",
      short: "List, add or remove a task's external links",
      long:
        "List the links a task holds to what is outside the board.\n\n" +
        "A link an integration brought in is marked with the integration it came\n" +
        "through, which is what tells it apart from one added by hand. --add\n" +
        "puts a link on by hand, --rm takes one off by its id (the ids are in\n" +
        "the --json listing), and with neither the links are only listed.",
      args: exactArgs(1),
      flags: [
        { name: "add", type: "string" as const, usage: "add an external link with this URL", defaultValue: "" },
        { name: "title", type: "string" as const, usage: "title for the link --add creates", defaultValue: "" },
        { name: "rm", type: "string" as const, usage: "remove the link with this id", defaultValue: "" },
      ],
      run: async ({ args, flags, changed, app }: { args: string[]; flags: FlagValues; changed: ReadonlySet<string>; app: App }) => {
        const add = String(flags.add ?? "");
        const rm = String(flags.rm ?? "");
        const title = String(flags.title ?? "");
        // A value flag passed as "" is a mistake, not an absent flag, as bulk
        // reads them.
        for (const name of ["add", "rm", "title"]) {
          if (changed.has(name) && String(flags[name] ?? "").trim() === "") throw new Error(`--${name} is empty`);
        }
        if (add !== "" && rm !== "") throw new Error("pass --add or --rm, not both");
        if (title !== "" && add === "") throw new Error("--title only names a link --add creates");
        let url = "";
        if (add !== "") {
          url = add.trim();
          let parsed: URL;
          try {
            parsed = new URL(url);
          } catch {
            throw new Error(`--add ${JSON.stringify(add)} is not a URL`);
          }
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error(`--add ${JSON.stringify(add)} is not an http or https URL`);
          }
          if (title.trim().length > 200) throw new Error("--title is longer than 200 characters");
        }
        apiKey(app);
        const task = await resolveTask(app, args[0]!);
        // What the write left is named when the follow-up read fails, as
        // taskAfterWrite names it: a bare read failure would read as a write
        // that never happened, and the caller would retry a write that landed.
        let wrote = "";
        if (add !== "") {
          await createExternalLink(task.id, { url, ...(title.trim() === "" ? {} : { title: title.trim() }) });
          wrote = "the link was added";
        }
        if (rm !== "") {
          const removed = await deleteExternalLink(task.id, rm.trim());
          if (removed !== rm.trim()) {
            throw new Error(`the server answered a different link id (${JSON.stringify(removed)}); check \`kaneo task external-links\``);
          }
          wrote = "the link was removed";
        }
        let links: ExternalLink[];
        try {
          links = await listExternalLinks(task.id);
        } catch (e) {
          throw wrote === ""
            ? e
            : new Error(`${wrote}, but listing the links failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        for (const link of links) app.out.human(externalLinkLine(link));
        app.out.data(links);
      },
    },
    {
      name: "field",
      use: "field <task> [<name> <value...>]",
      short: "Read or set a task's custom field values",
      long:
        "Read or set a task's custom field values.\n\n" +
        "With the task alone, the values it holds are listed — only fields\n" +
        "somebody set a value on appear. With a field name or id and a value,\n" +
        "the value is set; the words after the name make the value, so a text\n" +
        "value with spaces needs no quoting. A multiselect value is a JSON\n" +
        "array of the field's options, as the web app writes it. The field is\n" +
        "resolved in the task's own project.",
      args: (args: string[]) => {
        if (args.length !== 1 && args.length < 3) {
          throw new Error("field takes a task, or a task, a field and a value: kaneo task field <task> [<name> <value...>]");
        }
      },
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        const task = await resolveTask(app, args[0]!);
        if (args.length === 1) {
          const values = (await listTaskFieldValues(task.id)).sort((a, b) => a.fieldPosition - b.fieldPosition);
          for (const value of values) app.out.human(`${value.fieldName}  ${value.fieldType}  ${value.value ?? "(unset)"}`);
          app.out.data(values);
          return;
        }
        const field = await resolveField(task.projectId, args[1]!, `for task #${task.number}`);
        const value = args.slice(2).join(" ");
        const set = await setCustomFieldValue(task.id, field.id, value);
        app.out.human(`set ${field.name} on #${task.number}`);
        app.out.data(set);
      },
    },
    {
      name: "upload",
      use: "upload <task> <file>",
      short: "Upload an image for a task",
      long:
        "Upload an image to a task and print where it can be read back.\n\n" +
        "The file is staged, PUT to the storage the server presigns, and\n" +
        "finalized; the answer is the asset's URL, which a description or a\n" +
        "comment embeds. --surface says where the image will be used. This is\n" +
        "not `task attach`: attach also writes the reference into the\n" +
        "description, while upload only stores the image.",
      args: exactArgs(2),
      flags: [
        {
          name: "surface",
          type: "string" as const,
          usage: "where the image is used: description or comment",
          defaultValue: "description",
        },
      ],
      run: async ({ args, flags, app }: { args: string[]; flags: FlagValues; app: App }) => {
        const surface = String(flags.surface ?? "description") as ImageSurface;
        if (surface !== "description" && surface !== "comment") {
          throw new Error(`unknown surface ${JSON.stringify(String(flags.surface ?? ""))}; use description or comment`);
        }
        const file = await imageFile(args[1]!);
        apiKey(app);
        const task = await resolveTask(app, args[0]!);
        const staged = { filename: file.name, contentType: file.type, size: file.size, surface };
        const upload = await stageTaskImage(task.id, staged);
        await putUpload(upload.uploadUrl, upload.headers, file.bytes);
        const asset = await finalizeTaskImage(task.id, { ...staged, key: upload.key });
        app.out.human(`uploaded ${file.name}: ${asset.url}`);
        app.out.data({ id: asset.id, url: asset.url, taskId: task.id, taskNumber: task.number, filename: file.name, contentType: file.type, size: file.size, surface });
      },
    },
  ],
};

// The relation types, named the way a person reads a choice out loud.
const typeChoices = `${RELATION_TYPES.slice(0, -1).join(", ")} or ${RELATION_TYPES[RELATION_TYPES.length - 1]!}`;

// Refuses a title that already names open work by the same issue reference.
//
// A refusal rather than a warning: the second copy is what nobody wanted, and it
// leaves a number on the board that then has to be closed by hand. --force is
// there for the duplicate that is wanted.
const refuseDuplicate = (title: string, open: Task[]): void => {
  const shared = sharedReference(title, open);
  if (shared === undefined) return;
  throw new Error(
    `an open task already names ${shared.reference}: ${namedTasks(shared.tasks)}; pass --force to create anyway`,
  );
};

// Reports open tasks worded like this one, on stderr so the JSON a script reads on
// stdout stays a document it can parse.
//
// A warning and not a refusal, because alike wording cannot tell a second copy
// from the next piece of work (see SIMILAR_TITLE in src/cli/similar.ts); the
// reference check above is what refuses.
const warnSimilar = (title: string, open: Task[]): void => {
  const alike = similarOpenTasks(title, open);
  if (alike.length > 0) console.error(`similar open tasks: ${namedTasks(alike)}`);
};

// How either message names a task: by number and title, as `task ls` prints them,
// so the work is recognisable the same way in both.
const namedTasks = (tasks: Task[]): string => tasks.map((task) => `#${task.number} ${task.title}`).join("; ");

// The sessions holding a task, as `board --json` reports them under sessions[]
// but for the task fields, which the task around them already has. updatedAt is
// the time of the session's newest marker, not of its first: a session that
// attached, closed and attached again has no single attach time to give.
const heldBy = async (task: Task) => {
  let comments;
  try {
    comments = await listComments(task.id);
  } catch (e) {
    throw new Error(`comments for #${task.number}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return holding(comments).map((marker) => ({
    sessionId: marker.sessionId,
    host: marker.host,
    branch: marker.branch,
    cwd: marker.cwd,
    updatedAt: marker.createdAt,
    ...(marker.nextStep === "" ? {} : { nextStep: marker.nextStep }),
  }));
};

// The task a write left behind, read by id, carrying the labels of the task
// resolved above: only the board listing has them, and this is shaped as
// `task get` shapes it, so its JSON is what `task get --json` prints without the
// relations and sessions. wrote is what the report says was written, named as a person reads
// the field off the board.
//
// A read that fails is reported with the write that has already landed, as `task
// update` words it. Without that a failed read reads as a failed write, and the
// caller retries a write that landed.
const taskAfterWrite = async (task: Task, wrote: string): Promise<Task> => {
  let after: Task;
  try {
    after = await getTask(task.id);
  } catch (e) {
    throw new Error(
      `${wrote} on #${task.number} but reading the task back failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return { ...after, labels: task.labels };
};

// The value the server holds after a write, and the failure when it is not the
// one that was sent.
//
// A 200 does not say the value was taken: one that clamps a priority, or
// resolves the assignee to somebody else, answers the same way. Printing the
// value that was sent would report a write that did not happen, so what came
// back is what is printed and a difference fails.
const readBack = (field: string, read: string | null, sent: string): void => {
  // A task with nobody on it reads as null, which is what an empty value asks
  // for, so the two are the same answer rather than a difference.
  if ((read ?? "") !== sent) {
    throw new Error(`${field} is ${JSON.stringify(read)} after setting it to ${JSON.stringify(sent)}`);
  }
};

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

// How the other end of each link is named when it is on another board: the
// project's slug, or its id when it has none, which a reference accepts as well.
// Only projects other than the shown task's own are read.
const relatedProjects = async (relations: Relation[], ownProjectId: string): Promise<Map<string, string>> => {
  const names = new Map<string, string>();
  for (const relation of relations) {
    for (const end of [relation.sourceTask, relation.targetTask]) {
      if (end === null || end.projectId === "" || end.projectId === ownProjectId || names.has(end.projectId)) continue;
      const project = await getProject(end.projectId);
      names.set(end.projectId, project.slug === "" ? end.projectId : project.slug);
    }
  }
  return names;
};

const relationLine = (relation: Relation, taskId: string, projects: Map<string, string>): string => {
  const fromSource = relation.sourceTaskId === taskId;
  const other = fromSource ? relation.targetTask : relation.sourceTask;
  const otherId = fromSource ? relation.targetTaskId : relation.sourceTaskId;
  const word = relationWord(relation.relationType, fromSource);
  // A task the server gave no number would read as #0, so it is named by id.
  // One on another board carries that board in front, as a reference writes it,
  // because a bare #N would open the task of that number on the current board.
  const named =
    other === null || other.number === null
      ? otherId
      : `${projects.get(other.projectId) ?? ""}#${other.number}  ${other.title}`;
  return `${word.padEnd(RELATION_WORD_WIDTH)}  ${named}`;
};

// Turns a reference into a task.
//
// A reference is a task id, a number with or without a leading '#', a project's
// id, slug or name followed by '#' and that number, or a project slug and a
// number joined by a dash (`BET-1`). The '#' form is what follows `kaneo ` in
// KANEO_TASK_REF and in the references people write (`kaneo kaneo-cli#3`), so
// one copied from there names its own board. The dash form is how the Kaneo
// server and UI write a task; the server resolves it, so it is one request and
// its errors (404, 403, 409 for a slug that names more than one project) are
// shown as the server wrote them. A server before v2.30.0 has no such route, and
// the dash form is not tried another way there.
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
    return numberOn(named.project, named.number, "the reference", slugs);
  }

  if (isTicketId(wanted)) return getTaskByTicketId(wanted);

  const number = asNumber(wanted.startsWith("#") ? wanted.slice(1) : wanted);
  if (number === undefined) return getTask(wanted);
  const projectId = taskProject(app);
  if (projectId === "") {
    throw new Error(`task #${number} needs a project: pass --project or set KANEO_PROJECT`);
  }
  const origin = app.cfg.origin.project ?? "unset";
  return numberOn(projectId, number, origin === "repo-map" ? `the repo map for ${app.cfg.repo}` : origin, slugs);
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

// `<slug>-<number>`: the form the Kaneo server and UI write a task as (`BET-1`),
// which the server resolves itself (`GET /task/by-ticket-id/{ticketId}`).
//
// The last dash splits it, because a slug may hold dashes (`kaneo-cli-3`). That
// is the server's own split, `^(.+)-(\d+)$`, so a value is a ticket id here
// exactly when the server would read it as one. A task id is a cuid2 and holds
// no dash, so a value that fits is never an id.
const isTicketId = (wanted: string): boolean => {
  const at = wanted.lastIndexOf("-");
  return at >= 1 && /^\d+$/.test(wanted.slice(at + 1));
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
  value: string,
  number: number,
  origin: string,
  slugs?: Map<string, string>,
): Promise<Task> => {
  const { board, task: found } = await withProject(value, (id) => findTaskByNumber(id, number), { explain: () => workspaceInReference(value, number) });
  slugs?.set(board.projectId, board.projectSlug);
  if (found === undefined) {
    // --project only steers a bare number; a reference names its board itself.
    const hint = origin === "the reference" ? "check the number" : "pass --project to look elsewhere";
    throw new Error(`no task #${number} in project ${board.projectSlug === "" ? "" : `${board.projectSlug} `}(${board.projectId}, from ${origin}); ${hint}`);
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
// can pick out of a board listing. The words after create are not --title, so
// they are refused under their own name.
const wantedTitle = (title: string, refusal = "empty --title"): string => {
  if (title.trim() === "") throw new Error(refusal);
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

// The largest file `task upload` reads before the server is asked. The cap
// the server enforces at prepare is its own configurable one, so this only
// refuses a file too large to be an image at all, before its bytes are held
// in memory.
const MAX_IMAGE_BYTES = 1024 * 1024 * 1024;

// The image `task upload` stores: its bytes, its name as a basename rather
// than the path it was found at, and the content type the extension gives it,
// which is what the server would have been sent for the same file. The
// basename is node:path's own, splitting on the platform's separator only: a
// backslash is part of the name off Windows, as it is to the filesystem that
// just read the file. An empty file is refused before any request: the server
// takes no zero-byte image.
const imageFile = async (path: string): Promise<{ name: string; type: string; size: number; bytes: Uint8Array }> => {
  const file = Bun.file(path);
  if (file.size > MAX_IMAGE_BYTES) throw new Error(`${path} is too large to upload`);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (e) {
    throw new Error(`reading ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (bytes.byteLength === 0) throw new Error(`${path} is empty`);
  return {
    name: basename(path),
    type: file.type === "" ? "application/octet-stream" : file.type,
    size: bytes.byteLength,
    bytes,
  };
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

// The tasks whose description contains the query. A description the listing
// deferred is not on the task to match, so the server is asked which deferred
// descriptions match and their ids stand in for the text; the rest are matched
// here. Both sides compare case-insensitively, as the server does. The search
// is asked only when the listing actually deferred a description: with none,
// every description is already on its task and the answer would be empty.
const describedTasks = async (projectId: string, tasks: Task[], query: string): Promise<Task[]> => {
  const deferred = tasks.some(descriptionDeferred)
    ? new Set(await findDeferredTaskDescriptions(projectId, query))
    : new Set<string>();
  const needle = query.toLowerCase();
  return tasks.filter((task) => deferred.has(task.id) || task.description.toLowerCase().includes(needle));
};

const assignedLine = (task: AssignedTask): string =>
  `${task.projectSlug}#${String(task.number ?? "").padEnd(4)} [${task.priority.padEnd(11)}] ${task.status.padEnd(13)} ${task.title}`;

export const taskLine = (task: Task): string =>
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

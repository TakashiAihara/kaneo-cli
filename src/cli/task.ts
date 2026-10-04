import { apiKey, project, taskProject, type App } from "./app";
import {
  createTask,
  deleteRelation,
  deleteTask,
  descriptionDeferred,
  findTaskByNumber,
  getBoard,
  getTask,
  linkTasks,
  listRelations,
  moveTask,
  PRIORITIES,
  priorityRank,
  projectTasks,
  RELATION_TYPES,
  setTaskAssignee,
  setTaskDescription,
  setTaskPriority,
  setTaskStatus,
  taskSummary,
  type NewTask,
  type Relation,
  setTaskTitle,
  type Task,
} from "../api/kaneo";
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
      short: "Change a task's title, description, status or priority; the rest is kept",
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
      ],
      run: async ({ args, flags, changed, app }: RunContext<App>) => {
        // Only a flag that was passed is a change: `-d ""` clears the description
        // and leaving the flag out has to keep it.
        const pass = (name: string) => changed.has(name);
        const wantsDescription = pass("description") || pass("description-file");
        if (!pass("title") && !wantsDescription && !pass("priority") && !pass("status")) {
          throw new Error(
            "nothing to update: pass --title, --description, --description-file, --status or --priority",
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

        apiKey(app);
        const task = await resolveTask(app, args[0]!);

        // Each field is written by its own endpoint rather than by PUT
        // /task/{id}, which requires title, priority, status, projectId and
        // position: sending them means reading the task first and writing those
        // values back, and a change made elsewhere in between would be
        // overwritten. The per-field endpoints also keep the activity row the
        // server writes for the field that changed.
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
export const resolveTask = async (app: App, ref: string): Promise<Task> => {
  const wanted = ref.trim();
  if (wanted === "") throw new Error("no task given");

  const named = namedReference(wanted);
  if (named !== undefined) {
    return numberOn(app, named.project, named.number, "the reference");
  }

  const number = asNumber(wanted.startsWith("#") ? wanted.slice(1) : wanted);
  if (number === undefined) return getTask(wanted);
  const projectId = taskProject(app);
  if (projectId === "") {
    throw new Error(`task #${number} needs a project: pass --project or set KANEO_PROJECT`);
  }
  const origin = app.cfg.origin.project ?? "unset";
  return numberOn(app, projectId, number, origin === "repo-map" ? `the repo map for ${app.cfg.repo}` : origin);
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
const numberOn = async (app: App, value: string, number: number, origin: string): Promise<Task> => {
  const { board, task: found } = await withProject(app, value, (id) => findTaskByNumber(id, number));
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

import { apiKey, project, taskProject, type App } from "./app";
import {
  boardTasks,
  createTask,
  deleteRelation,
  deleteTask,
  getBoard,
  getTask,
  linkTasks,
  listRelations,
  moveTask,
  PRIORITIES,
  priorityRank,
  RELATION_TYPES,
  setTaskAssignee,
  setTaskPriority,
  setTaskStatus,
  taskSummary,
  type NewTask,
  type Relation,
  type Task,
} from "../api/kaneo";
import { exactArgs, minimumArgs, noArgs, rangeArgs, type FlagValues } from "./args";
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
          boardTasks(await withProject(app, project(app), (id) => getBoard(id))),
          String(flags.status ?? ""),
          String(flags.priority ?? ""),
          flags.all === true,
        );
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
        const task = await resolveTask(app, args[0]!);
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
        { name: "description", shorthand: "d", type: "string" as const, usage: "task description", defaultValue: "" },
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
      run: async ({ args, flags, app }: { args: string[]; flags: FlagValues; app: App }) => {
        apiKey(app);
        const wanted: NewTask = {
          title: args.join(" "),
          description: String(flags.description ?? ""),
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
        const priority = args[1]!.trim();
        // Refused here rather than sent: the server's list of priorities is
        // fixed, and this command has nothing else to do with the answer.
        if (priorityRank(priority) === PRIORITIES.length) {
          throw new Error(
            `unknown priority ${JSON.stringify(priority)}; use one of: ${PRIORITIES.join(", ")}`,
          );
        }
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
// neither the task nor the number.
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
  const board = await withProject(app, value, (id) => getBoard(id));
  const found = boardTasks(board).find((task) => task.number === number);
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

// Go's strconv.Atoi: a whole decimal integer and nothing else, so a reference
// that merely starts with digits stays a task id.
const asNumber = (text: string): number | undefined =>
  /^[+-]?\d+$/.test(text) ? Number.parseInt(text, 10) : undefined;

const filterTasks = (tasks: Task[], status: string, priority: string, includeDone: boolean): Task[] =>
  tasks.filter(
    (task) =>
      (status === "" || task.status === status) &&
      (priority === "" || task.priority === priority) &&
      (includeDone || status !== "" || task.status !== "done"),
  );

const taskLine = (task: Task): string =>
  `#${String(task.number).padEnd(4)} [${task.priority.padEnd(11)}] ${task.status.padEnd(13)} ${task.title}`;
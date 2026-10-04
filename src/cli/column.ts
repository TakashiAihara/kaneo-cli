import { apiKey, project, type App } from "./app";
import {
  createColumn,
  deleteColumn,
  listColumns,
  renameColumn,
  reorderColumns,
  type Column,
} from "../api/kaneo";
import { KaneoApiError } from "../api/http";
import { exactArgs, minimumArgs, noArgs, type FlagValues } from "./args";

// The columns of the resolved project, and the changes to them.
export const columnCommand = {
  name: "column",
  aliases: ["col"],
  short: "Work with a project's columns",
  children: [
    {
      name: "list",
      aliases: ["ls"],
      short: "List a project's columns in board order",
      args: noArgs("kaneo column list"),
      run: async ({ app }: { app: App }) => {
        apiKey(app);
        const columns = await listColumns(project(app));
        printColumns(app, columns);
        app.out.data(columns);
      },
    },
    {
      name: "create",
      use: "create <name...>",
      short: "Add a column to the end of a project",
      long:
        "Add a column to the end of a project.\n\n" +
        "The server derives the slug from the name, and that slug is what a task's\n" +
        "status has to be set to in order to land in the column.",
      // Several words are one name: `column create Waiting on review` names the
      // column "Waiting on review" rather than complaining about a second word.
      args: minimumArgs(1),
      flags: [
        {
          name: "final",
          type: "bool" as const,
          usage: "a done state: tasks in it count as completed on the board and get no overdue reminders",
          defaultValue: "false",
        },
        { name: "icon", type: "string" as const, usage: "icon name", defaultValue: "" },
        { name: "color", type: "string" as const, usage: "color, stored as given", defaultValue: "" },
      ],
      run: async ({ args, flags, app }: { args: string[]; flags: FlagValues; app: App }) => {
        apiKey(app);
        const created = await createColumn(project(app), {
          name: newName(args),
          icon: String(flags.icon ?? ""),
          color: String(flags.color ?? ""),
          isFinal: flags.final === true,
        });
        app.out.human(`created column ${created.slug} ${created.name}`);
        app.out.data(created);
      },
    },
    {
      name: "rename",
      use: "rename <column> <new name...>",
      short: "Rename a column",
      long:
        "Rename a column.\n\n" +
        "The slug is derived from the name when the column is created, so a rename\n" +
        "leaves it as it was, and so leaves every task's status in the column.",
      args: minimumArgs(2),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        const found = await resolveColumn(project(app), args[0]!);
        const renamed = await renameColumn(found.id, newName(args.slice(1)));
        app.out.human(`renamed column ${renamed.slug} ${renamed.name}`);
        app.out.data(renamed);
      },
    },
    {
      name: "reorder",
      use: "reorder <column>...",
      short: "Put a project's columns in a new order",
      long:
        "Put a project's columns in a new order.\n\n" +
        "Every column has to be named exactly once, by id, slug or name: the server only\n" +
        "moves the columns it is sent, so a column left out would keep its old\n" +
        "position and share it with whichever column took that place.",
      args: minimumArgs(1),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        const projectId = project(app);
        const order = newOrder(await listColumns(projectId), args);
        const columns = await reorderColumns(
          projectId,
          order.map((column) => column.id),
        );
        printColumns(app, columns);
        app.out.data(columns);
      },
    },
    {
      name: "rm",
      aliases: ["delete"],
      use: "rm <column>",
      short: "Delete a column",
      long:
        "Delete a column.\n\n" +
        "Only an empty column can go: the server refuses one that still holds tasks.\n" +
        "Deleting one also deletes the workflow rules that send tasks to it, since\n" +
        "a rule cannot point at a column that is not there.",
      args: exactArgs(1),
      flags: [{ name: "yes", type: "bool" as const, usage: "confirm the deletion", defaultValue: "false" }],
      run: async ({ args, flags, app }: { args: string[]; flags: FlagValues; app: App }) => {
        apiKey(app);
        const projectId = project(app);
        const found = await resolveColumn(projectId, args[0]!);
        // Only an empty column can go, but its id and place on the board do not
        // come back: a column created again under the same name gets a new id
        // and the last position.
        if (flags.yes !== true) {
          throw new Error(`refusing to delete column ${found.slug} without --yes`);
        }
        const deleted = await deleteColumn(found.id).catch((err: unknown) => {
          if (err instanceof KaneoApiError && err.statusCode === 409) {
            throw new Error(
              `column ${found.slug} still holds tasks; move them out first (kaneo task ls -p ${projectId} --status ${found.slug} lists them)`,
            );
          }
          throw err;
        });
        app.out.human(`deleted column ${deleted.slug}`);
        app.out.data(deleted);
      },
    },
  ],
};

// The column a reference names, if any.
//
// A reference is a column id, a slug or a name. The id is what the routes address
// the column by and the slug is what a task's status holds; both are unique in a
// project, so they win. A name is what a person sees on the board, but two
// columns can share one, and a name that does is refused rather than guessed.
// All of it is read off the listing rather than by asking the server, so a word
// that is none of these is a mistake this names rather than one answered by 404.
const findColumn = (columns: Column[], ref: string): Column | undefined => {
  const wanted = ref.trim();
  const exact = columns.find((column) => column.id === wanted || column.slug === wanted);
  if (exact !== undefined) return exact;
  const named = columns.filter((column) => column.name === wanted);
  if (named.length > 1) {
    throw new Error(`${named.length} columns are named ${JSON.stringify(wanted)}; name one by its slug (${named.map((c) => c.slug).join(", ")})`);
  }
  return named[0];
};

// The same, refused rather than undefined when nothing matches, so a caller that
// cannot go on does not have to say what is missing.
//
// Exported because a command outside this file has to name a column the same way
// this one does — `workflow set` takes one — and a second copy of these rules
// would be a second answer to the same reference.
export const resolveColumn = async (projectId: string, ref: string): Promise<Column> => {
  const found = findColumn(await listColumns(projectId), ref);
  if (found !== undefined) return found;
  throw new Error(`no column ${JSON.stringify(ref.trim())} in this project; kaneo column ls lists them`);
};

// The name the words make, refused when blank: the server takes an empty name on
// a rename and would leave a column with nothing to show on the board.
const newName = (words: string[]): string => {
  const name = words.join(" ").trim();
  if (name === "") throw new Error("a column name cannot be blank");
  return name;
};

// One column as a person reads it: the slug a task's status would carry, padded
// so the names line up, and marked when the board counts the column as done.
const columnLine = (column: Column, width: number): string =>
  `${column.slug.padEnd(width)}  ${column.name}${column.isFinal ? "  (final)" : ""}`;

const printColumns = (app: App, columns: Column[]): void => {
  const width = columns.reduce((at, column) => Math.max(at, column.slug.length), 0);
  for (const column of columns) app.out.human(columnLine(column, width));
};

// The order a list of references describes, or a refusal naming every way the
// list falls short.
//
// The refusal is raised before anything is written, because the server moves only
// the columns it is sent: naming three of four columns would leave the fourth at
// its old position, sharing it with another.
const newOrder = (columns: Column[], refs: string[]): Column[] => {
  const ordered: Column[] = [];
  const taken = new Set<string>();
  const unknown: string[] = [];
  const repeated: string[] = [];
  for (const ref of refs) {
    const wanted = ref.trim();
    const found = findColumn(columns, wanted);
    if (found === undefined) unknown.push(wanted);
    else if (taken.has(found.id)) repeated.push(wanted);
    else {
      taken.add(found.id);
      ordered.push(found);
    }
  }
  const missing = columns.filter((column) => !taken.has(column.id)).map((column) => column.slug);
  const wrong = [
    ...(unknown.length === 0 ? [] : [`unknown: ${unknown.join(", ")}`]),
    ...(repeated.length === 0 ? [] : [`repeated: ${repeated.join(", ")}`]),
    ...(missing.length === 0 ? [] : [`missing: ${missing.join(", ")}`]),
  ];
  if (wrong.length > 0) {
    throw new Error(`every column of this project has to be named exactly once: ${wrong.join("; ")}`);
  }
  return ordered;
};
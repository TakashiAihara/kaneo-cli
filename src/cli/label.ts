import { apiKey, workspace, type App } from "./app";
import {
  attachLabel,
  createLabel,
  deleteLabel,
  detachLabel,
  getLabel,
  listTaskLabels,
  listWorkspaceLabels,
  updateLabel,
  type LabelChanges,
  type LabelRecord,
} from "../api/kaneo";
import { exactArgs, maximumArgs, minimumArgs, type FlagValues } from "./args";
import { resolveTask } from "./task";
import { shellWord } from "../output/output";

const labelLine = (label: LabelRecord): string =>
  `${label.id}  ${label.name}  (${label.color})${label.deletionStartedAt === null ? "" : `  deleting; \`kaneo label rm ${label.id} --yes\` to finish`}`;

// A label in the given list by id or by name. Names are what a person types
// and the server keeps them unique among a workspace's labels and among one
// task's copies, so a name matches at most one. An id is matched first: ids
// are what scripts pass on from a listing, and one that happens to equal some
// label's name must still mean the label it identifies (that label's name is
// then reachable only through its own id).
const pick = (labels: LabelRecord[], ref: string, where: string, hint: string): LabelRecord => {
  const found = labels.find((l) => l.id === ref) ?? labels.find((l) => l.name === ref);
  if (found === undefined) throw new Error(`no label ${JSON.stringify(ref)} ${where}; see \`${hint}\``);
  return found;
};

// The workspace's own labels, without the copies attached to tasks: those are
// the ones the web app offers to pick from.
const workspaceLabels = async (app: App): Promise<LabelRecord[]> =>
  (await listWorkspaceLabels(workspace(app))).filter((l) => l.taskId === null);

const resolveWorkspaceLabel = async (app: App, ref: string): Promise<LabelRecord> =>
  pick(await workspaceLabels(app), ref, "in this workspace", "kaneo label list");

export const labelCommand = {
  name: "label",
  aliases: ["lbl"],
  short: "Work with labels",
  children: [
    {
      name: "list",
      aliases: ["ls"],
      use: "list [task]",
      short: "List the workspace's labels, or the labels on a task",
      args: maximumArgs(1),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        const labels =
          args[0] === undefined
            ? await workspaceLabels(app)
            : await listTaskLabels((await resolveTask(app, args[0])).id);
        for (const label of labels) app.out.human(labelLine(label));
        app.out.data(labels);
      },
    },
    {
      name: "get",
      use: "get <label>",
      short: "Show one label, by id or by name",
      args: exactArgs(1),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        // Resolved the way every other subcommand resolves a label, id first.
        // An id of any row, a task copy included, goes to the server as it is,
        // and so does everything when no workspace is set to look names up in.
        const ref = args[0]!;
        const rows = app.cfg.workspaceId === "" ? [] : await listWorkspaceLabels(workspace(app));
        const named = rows.some((l) => l.id === ref) ? undefined : rows.find((l) => l.taskId === null && l.name === ref);
        const label = await getLabel(named?.id ?? ref);
        app.out.human(labelLine(label));
        app.out.data(label);
      },
    },
    {
      name: "create",
      use: "create <name...>",
      short: "Create a label in the workspace",
      args: minimumArgs(1),
      flags: [
        {
          name: "color",
          type: "string" as const,
          usage: "color; the web app's are gray, dark-gray, purple, teal, green, yellow, orange, pink, red, and a #hex works too",
          defaultValue: "gray",
        },
      ],
      run: async ({ args, flags, app }: { args: string[]; flags: FlagValues; app: App }) => {
        apiKey(app);
        // The server answers a taken name with the label already there and
        // leaves it as it was, which reads as success; the listing taken
        // before the write is what tells the two apart.
        const name = args.join(" ").trim();
        const existed = (await workspaceLabels(app)).some((l) => l.name === name);
        const label = await createLabel(workspace(app), name, String(flags.color ?? "gray"));
        app.out.human(existed ? `exists ${labelLine(label)}; use \`kaneo label update\` to change it` : `created ${labelLine(label)}`);
        app.out.data(label);
      },
    },
    {
      name: "update",
      use: "update <label>",
      short: "Rename or recolor a label; its copies on tasks follow",
      args: exactArgs(1),
      flags: [
        { name: "name", type: "string" as const, usage: "new name", defaultValue: "" },
        { name: "color", type: "string" as const, usage: "new color", defaultValue: "" },
      ],
      run: async ({ args, flags, changed, app }: { args: string[]; flags: FlagValues; changed: ReadonlySet<string>; app: App }) => {
        apiKey(app);
        const changes: LabelChanges = {};
        if (changed.has("name")) changes.name = String(flags.name);
        if (changed.has("color")) changes.color = String(flags.color);
        if (changes.name === undefined && changes.color === undefined) throw new Error("nothing to change: pass --name or --color");
        const labels = await workspaceLabels(app);
        const label = pick(labels, args[0]!, "in this workspace", "kaneo label list");
        // A workspace keeps one label per name, and the server reports the
        // collision as an internal error, so a taken name is refused here.
        const taken = labels.find((l) => l.id !== label.id && l.name === changes.name?.trim());
        if (taken !== undefined) throw new Error(`label ${JSON.stringify(taken.name)} already exists (${taken.id}); pick another name`);
        const { after } = await updateLabel(label.id, changes);
        app.out.human(`updated ${labelLine(after)}`);
        app.out.data(after);
      },
    },
    {
      name: "rm",
      aliases: ["delete"],
      use: "rm <label>",
      short: "Delete a label from the workspace and from every task carrying it",
      args: exactArgs(1),
      flags: [{ name: "yes", type: "bool" as const, usage: "confirm the deletion", defaultValue: "false" }],
      run: async ({ args, flags, app }: { args: string[]; flags: FlagValues; app: App }) => {
        apiKey(app);
        const label = await resolveWorkspaceLabel(app, args[0]!);
        // The deletion reaches every task the label is on, and there is no
        // undo: the copies are gone, not detached.
        if (flags.yes !== true) {
          throw new Error(`refusing to delete label ${JSON.stringify(label.name)} without --yes; it is removed from every task that carries it`);
        }
        const deleted = await deleteLabel(label.id);
        app.out.human(`deleted label ${label.name}`);
        app.out.data(deleted);
      },
    },
    {
      name: "attach",
      use: "attach <task> <label>",
      short: "Put a workspace label on a task",
      args: exactArgs(2),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        const task = await resolveTask(app, args[0]!);
        const label = await resolveWorkspaceLabel(app, args[1]!);
        const copy = await attachLabel(label.id, task.id);
        app.out.human(`labeled #${task.number} ${label.name}`);
        app.out.data(copy);
      },
    },
    {
      name: "detach",
      use: "detach <task> <label>",
      short: "Take a label off a task",
      args: exactArgs(2),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        const task = await resolveTask(app, args[0]!);
        // The server detaches by the copy's id, so the label is looked up on the
        // task itself: a copy on another task would otherwise be taken off that
        // task. Ids come before names here as everywhere: a copy's id, then the
        // workspace label's id `label list` prints (no copy carries it, so it is
        // read as that label's name), then a name.
        const ref = args[1]!;
        const copies = await listTaskLabels(task.id);
        const byId = copies.some((c) => c.id === ref);
        const asWorkspaceLabel = byId || app.cfg.workspaceId === "" ? undefined : (await workspaceLabels(app)).find((l) => l.id === ref);
        const copy = pick(copies, asWorkspaceLabel?.name ?? ref, `on #${task.number}`, `kaneo label list ${shellWord(task.id)}`);
        const removed = await detachLabel(copy.id);
        app.out.human(`unlabeled #${task.number} ${copy.name}`);
        app.out.data(removed);
      },
    },
  ],
};

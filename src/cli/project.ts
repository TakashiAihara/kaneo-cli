import { apiKey, project, workspace, type App } from "./app";
import {
  archived,
  createProject,
  getProject,
  listProjectsIn,
  setProjectArchived,
  updateProject,
  type Project,
  type ProjectChanges,
} from "../api/kaneo";
import { exactArgs, maximumArgs, minimumArgs, noArgs, type FlagValues } from "./args";

// `archive` and `unarchive` are the same request with the opposite verb, so they
// are built from one place rather than written out twice.
//
// Archiving is how a finished project leaves the board. Dropping it from the repo
// map would do that too, but it would also lose the record that the repository
// ever had that work, so the board filters on the server's own archived flag
// instead and the mapping stays put. Nothing is deleted, and unarchive puts it
// back.
const archiveCommand = (verb: "archive" | "unarchive") => {
  const archived = verb === "archive";
  return {
    name: verb,
    use: `${verb} [project-id]`,
    short: `${verb === "archive" ? "A" : "U"}${verb.slice(1)} a project`,
    args: maximumArgs(1),
    run: async ({ args, app }: { args: string[]; app: App }) => {
      apiKey(app);
      const id = args[0] ?? project(app);
      await setProjectArchived(id, archived);
      app.out.human(`${archived ? "archived" : "unarchived"} ${id}`);
      app.out.data({ archived, project: id });
    },
  };
};

// The projects in a workspace, and the changes to one of them.
export const projectCommand = {
  name: "project",
  aliases: ["proj"],
  short: "Work with projects",
  children: [
    {
      name: "list",
      aliases: ["ls"],
      short: "List the projects in a workspace",
      args: noArgs("kaneo project list"),
      flags: [
        {
          name: "archived",
          type: "bool" as const,
          usage: "include archived projects, so one can be found again to unarchive",
          defaultValue: "false",
        },
      ],
      run: async ({ flags, app }: { flags: FlagValues; app: App }) => {
        apiKey(app);
        const projects: Project[] = await listProjectsIn(
          workspace(app),
          flags.archived === true,
        );
        for (const project of projects) {
          app.out.human(
            archived(project)
              ? `${project.id}  ${project.name}  (archived)`
              : `${project.id}  ${project.name}`,
          );
        }
        app.out.data(projects);
      },
    },
    {
      name: "get",
      use: "get [project-id]",
      short: "Show one project",
      // The id falls back to the resolved project, which is what makes `project
      // get` usable with no argument inside a repository.
      args: maximumArgs(1),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        const found = await getProject(args[0] ?? project(app));
        app.out.human(`${found.id}  ${found.name}`);
        if (found.description !== "") app.out.human(found.description);
        app.out.data(found);
      },
    },
    {
      name: "create",
      use: "create <name>",
      short: "Create a project in a workspace",
      // Several words are one name: `project create Alpha Two` names the project
      // "Alpha Two" rather than complaining about a second argument.
      args: minimumArgs(1),
      flags: [
        { name: "icon", type: "string" as const, usage: "icon name (default Layers)", defaultValue: "" },
        { name: "slug", type: "string" as const, usage: "url slug", defaultValue: "" },
        { name: "description", shorthand: "d", type: "string" as const, usage: "project description", defaultValue: "" },
      ],
      run: async ({ args, flags, app }: { args: string[]; flags: FlagValues; app: App }) => {
        apiKey(app);
        const created = await createProject({
          name: args.join(" "),
          workspaceId: workspace(app),
          icon: String(flags.icon ?? ""),
          slug: String(flags.slug ?? ""),
          description: String(flags.description ?? ""),
        });
        app.out.human(`created ${created.id}  ${created.name}`);
        app.out.data(created);
      },
    },
    {
      name: "update",
      use: "update <project-id>",
      short: "Change a project's name, slug, description or icon; the rest is kept",
      // The id is required rather than resolved like `project get`: resolution
      // falls back to .kaneo.json and the repos map, so an update typed inside a
      // checkout would quietly hit whichever project that repo maps to.
      args: exactArgs(1),
      flags: [
        { name: "name", type: "string" as const, usage: "new name", defaultValue: "" },
        {
          name: "slug",
          type: "string" as const,
          usage: "new url slug (the prefix of task identifiers)",
          defaultValue: "",
        },
        {
          name: "description",
          shorthand: "d",
          type: "string" as const,
          usage: "new description; empty clears it",
          defaultValue: "",
        },
        { name: "icon", type: "string" as const, usage: "new icon name", defaultValue: "" },
      ],
      run: async ({ args, flags, changed, app }: { args: string[]; flags: FlagValues; changed: ReadonlySet<string>; app: App }) => {
        // Only a flag that was passed is a change: `--description ""` clears the
        // description, and leaving the flag out has to keep it.
        const changes: ProjectChanges = {};
        for (const field of ["name", "slug", "description", "icon"] as const) {
          if (changed.has(field)) changes[field] = String(flags[field] ?? "");
        }
        if (Object.keys(changes).length === 0) {
          throw new Error("nothing to change: pass --name, --slug, --description or --icon");
        }

        apiKey(app);
        const { before, after } = await updateProject(args[0]!, changes);
        app.out.human(`updated ${after.id}`);
        for (const [field, from, to] of [
          ["name", before.name, after.name],
          ["slug", before.slug, after.slug],
          ["description", before.description, after.description],
          ["icon", before.icon, after.icon],
        ] as const) {
          if (from !== to) app.out.human(`  ${field}  ${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
        }
        // The slug is the prefix of every task identifier, so changing it renames
        // them all and the reader has to be told.
        if (before.slug !== after.slug) app.out.human(`  task identifiers now start with ${after.slug}`);
        // A map's keys come out sorted, which is the order the report has.
        app.out.data({ from: before, to: after });
      },
    },
    archiveCommand("archive"),
    archiveCommand("unarchive"),
  ],
};

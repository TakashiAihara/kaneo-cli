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
import { allProjects, resolveWorkspace, withProject, type ProjectIn } from "./lookup";

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
      const projectId = await withProject(app, id, async (projectId) => {
        await setProjectArchived(projectId, archived);
        return projectId;
      });
      app.out.human(`${archived ? "archived" : "unarchived"} ${id}`);
      app.out.data({ archived, project: projectId });
    },
  };
};

// One project, named the way a listing prints it.
//
// Across workspaces a project is only unique inside its own, so the slug and the
// workspace it is in are what tell two of them apart; inside one workspace the
// name already says enough and the line stays as it was.
const projectLine = (project: Project, workspaceName = ""): string => {
  const columns = [project.id, project.name];
  if (workspaceName !== "") columns.push(`[${project.slug}]`, `(${workspaceName})`);
  if (archived(project)) columns.push("(archived)");
  return columns.join("  ");
};

// A project as the JSON report carries it when it came from more than one
// workspace: the same fields as a single-workspace listing, plus the workspace it
// belongs to at the end, where a reader looking for it will look last.
const named = ({ project, workspaceName }: ProjectIn) => ({ ...project, workspaceName });

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
        {
          name: "all-workspaces",
          shorthand: "A",
          type: "bool" as const,
          usage: "list every workspace the key can reach, naming the workspace each project is in",
          defaultValue: "false",
        },
      ],
      run: async ({ flags, app }: { flags: FlagValues; app: App }) => {
        apiKey(app);
        const includeArchived = flags.archived === true;
        const acrossAll = flags["all-workspaces"] === true;
        // One list either way. Only whether a workspace is part of each entry
        // differs, and it can only be named when the listing covers more than one.
        const found = acrossAll
          ? await allProjects(app, includeArchived)
          : (await listProjectsIn(await resolveWorkspace(app, workspace(app)), includeArchived)).map(
              (project) => ({ project, workspaceName: "" }),
            );
        for (const { project, workspaceName } of found) app.out.human(projectLine(project, workspaceName));
        app.out.data(acrossAll ? found.map(named) : found.map((entry) => entry.project));
      },
    },
    {
      name: "find",
      use: "find <text>",
      short: "Find projects by name or slug, in every workspace",
      // Substring rather than an exact match, because what is being searched for
      // is half-remembered: `find be` has to reach `Beta`. Archived projects are
      // included, since one that has been archived is exactly the one somebody is
      // most often looking for.
      args: exactArgs(1),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        const wanted = args[0]!.toLowerCase();
        const found = (await allProjects(app, true)).filter(
          (p) =>
            p.project.name.toLowerCase().includes(wanted) || p.project.slug.toLowerCase().includes(wanted),
        );
        if (found.length === 0) throw new Error(`no project matches ${JSON.stringify(args[0])}`);
        for (const { project, workspaceName } of found) app.out.human(projectLine(project, workspaceName));
        app.out.data(found.map(named));
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
        const found = await withProject(app, args[0] ?? project(app), (id) => getProject(id));
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
        const wanted = {
          name: args.join(" "),
          icon: String(flags.icon ?? ""),
          slug: String(flags.slug ?? ""),
          description: String(flags.description ?? ""),
        };
        const created = await createProject({ ...wanted, workspaceId: await resolveWorkspace(app, workspace(app)) });
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
        // The read of the project comes first inside updateProject, so a value the
        // server does not know is retried before anything is written rather than
        // after.
        const { before, after } = await withProject(app, args[0]!, (id) => updateProject(id, changes));
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

import { apiKey, project, workspace, type App } from "./app";
import {
  archived,
  createProject,
  deleteProject,
  getProject,
  listProjectsIn,
  reorderProjects,
  setProjectArchived,
  updateProject,
  type Project,
  type ProjectChanges,
} from "../api/kaneo";
import { exactArgs, maximumArgs, minimumArgs, noArgs, type FlagValues } from "./args";
import { allProjects, firstMatch, resolveWorkspace, withProject, type ProjectIn } from "./lookup";

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

// The key a name derives, by the rule the Kaneo web app uses for a project made
// there (generateProjectSlug in apps/web/src/lib/generate-project-id.ts), so a
// project made here gets the kind of key its users already see: the first three
// letters of a single word, or the initials of the first three words, upper
// case, from any script. Every task identifier of the project starts with it,
// and the server takes an empty one, so a name with no letter or number derives
// nothing and that is reported rather than sent.
export const deriveSlug = (name: string): string => {
  const words = name
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));

  if (words.length === 0) return "";

  // By code point, so a letter outside the BMP is not cut in half, and from the
  // first letter or number, since a key has to start with one to be typed back.
  const fromFirst = (word: string) => {
    const points = Array.from(word);
    return points.slice(points.findIndex((c) => /[\p{L}\p{N}]/u.test(c)));
  };
  if (words.length === 1) return fromFirst(words[0]!).slice(0, 3).join("");
  return words
    .slice(0, 3)
    .map((word) => fromFirst(word)[0])
    .join("");
};

// The description the create route cannot carry, written by the update that
// follows the create. The project exists by then, so a failure names it: a
// message that only said the description could not be set would leave a project
// behind that nothing says is there.
const withDescription = async (created: Project, description: string): Promise<Project> => {
  try {
    const { after } = await updateProject(created.id, { description });
    return after;
  } catch (e) {
    throw new Error(
      `created project ${created.id} but could not set its description: ${(e as Error).message}; set it with \`kaneo project update ${created.id} -d TEXT\``,
    );
  }
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
        {
          name: "slug",
          type: "string" as const,
          usage: "url slug, the prefix of task identifiers (default: derived from the name, as the web app does)",
          defaultValue: "",
        },
        { name: "description", shorthand: "d", type: "string" as const, usage: "project description", defaultValue: "" },
      ],
      run: async ({ args, flags, app }: { args: string[]; flags: FlagValues; app: App }) => {
        apiKey(app);
        const name = args.join(" ");
        const workspaceId = await resolveWorkspace(app, workspace(app));
        // A slug that was given is the caller's own spelling of the prefix every
        // task identifier will carry, so it is trimmed and sent as it was typed.
        const given = String(flags.slug ?? "").trim();
        const slug = given === "" ? deriveSlug(name) : given;
        if (slug === "") throw new Error(`cannot derive a slug from the name ${JSON.stringify(name)}: pass --slug`);
        // A derived key is one to three characters, so two names share one
        // easily (Alpha Beta, Apple Banana), and a server before v2.31 takes the
        // second without a word. A key the caller typed is theirs to answer for.
        if (given === "") {
          const taken = (await listProjectsIn(workspaceId, true)).find((p) => p.slug === slug);
          if (taken !== undefined) {
            throw new Error(`the slug ${slug} derived from the name is used by project ${taken.id} (${taken.name}): pass --slug`);
          }
        }
        const created = await createProject({
          name,
          workspaceId,
          icon: String(flags.icon ?? ""),
          slug,
        });
        const description = String(flags.description ?? "");
        // Without one asked for this is the project as the create left it, and
        // only one request is made.
        const saved = description === "" ? created : await withDescription(created, description);
        app.out.human(`created ${saved.id}  ${saved.name}`);
        app.out.human(`  task identifiers start with ${saved.slug}`);
        app.out.data(saved);
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
    {
      name: "rm",
      aliases: ["delete"],
      use: "rm <project>",
      short: "Delete a project and everything in it",
      long:
        "Delete a project and everything in it.\n\n" +
        "Archiving is the reversible way to take a project off the board; this one\n" +
        "leaves nothing behind to bring back.",
      // Required rather than resolved from the settings, as `project update` is:
      // resolution falls back to .kaneo.json and the repos map, and a delete typed
      // inside a checkout would quietly take whichever project that repo maps to.
      // What is given is still resolved the way the rest of the CLI resolves a
      // project — by id, slug or name across the workspaces the key can reach —
      // so the refusal has to name the project that was read.
      args: exactArgs(1),
      flags: [{ name: "yes", type: "bool" as const, usage: "confirm the deletion", defaultValue: "false" }],
      run: async ({ args, flags, app }: { args: string[]; flags: FlagValues; app: App }) => {
        apiKey(app);
        const found = await withProject(app, args[0]!, (id) => getProject(id));
        // Everything in the project goes with it — its tasks, their comments and
        // links, its columns, its workflow rules — and the server keeps no copy,
        // so there is nothing to restore from; archive is the reversible way off
        // the board. A name or a slug was accepted here, so the refusal says
        // which project it resolved to rather than echoing the word typed.
        if (flags.yes !== true) {
          throw new Error(
            `refusing to delete project ${found.name} [${found.slug}] (${found.id}) without --yes; kaneo project archive ${found.id} keeps it`,
          );
        }
        const deleted = await deleteProject(found.id);
        // Named as it was read, since that is the project the confirmation spoke
        // for; the reply is the server's own record of what it removed, and that
        // is what the report carries.
        app.out.human(`deleted ${found.id}  ${found.name}`);
        app.out.data(deleted);
      },
    },
    {
      name: "reorder",
      use: "reorder <project>...",
      short: "Put a workspace's projects in a new order",
      long:
        "Put a workspace's projects in a new order.\n\n" +
        "Every project has to be named exactly once, by id, slug or name. The server\n" +
        "keeps the rank of a project left out of the request and fills the named ones\n" +
        "into the slots around it, so naming a subset would rearrange those slots\n" +
        "rather than move them to the front. An archived project is not named and\n" +
        "keeps the place it holds.",
      args: minimumArgs(1),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        const workspaceId = await resolveWorkspace(app, workspace(app));
        // The archived projects are read as well, so naming one is reported as
        // what it is rather than as a word the workspace does not hold: the
        // server would take its id, this command will not.
        const order = newProjectOrder(await listProjectsIn(workspaceId, true), args);
        const reply = await reorderProjects(workspaceId, order.map((project) => project.id));
        // The reply holds the whole workspace, archived projects included; the
        // ones that are on it are what this command changed the order of.
        for (const project of reply.filter((project) => !archived(project))) app.out.human(projectLine(project));
        app.out.data(reply);
      },
    },
  ],
};

// The project a reference names, if any.
//
// Matched the way every other reference to a project is matched, so that this
// command answers to the same words `--project` does: an id exactly, then a slug
// exactly and case-folded, then a name exactly and case-folded. The keys are
// tried in turn rather than together, so a value that is an id and also spells
// somebody's slug is still read as the id it is. A workspace's projects are not
// unique by slug or name, so whichever key matched more than one is refused with
// their ids rather than resolved to the first of them.
const findProject = (projects: Project[], ref: string): Project | undefined => {
  const wanted = ref.trim();
  const found = firstMatch(projects, wanted, (project) => project.id, [
    (project) => project.slug,
    (project) => project.name,
  ]);
  if (found.length > 1) {
    throw new Error(
      `${found.length} projects match ${JSON.stringify(wanted)}; name one by its id (${found.map((project) => project.id).join(", ")})`,
    );
  }
  return found[0];
};

// The order a list of references describes, or a refusal naming every way the
// list falls short.
//
// Raised before anything is written, because the server keeps the rank of a
// project left out of the payload: naming half of them would reorder those half
// within the slots around the one left behind, which is not the order anybody
// typed.
//
// A reference is matched against the projects that are not archived first: an
// archived project may share a name or a slug with an active one, and only when
// nothing active answers to the word is it looked for among the archived, to say
// why it was refused.
const newProjectOrder = (projects: Project[], refs: string[]): Project[] => {
  const active = projects.filter((project) => !archived(project));
  const shelved = projects.filter((project) => archived(project));
  const ordered: Project[] = [];
  const taken = new Set<string>();
  const unknown: string[] = [];
  const kept: string[] = [];
  const repeated: string[] = [];
  for (const ref of refs) {
    const wanted = ref.trim();
    const found = findProject(active, wanted);
    if (found === undefined) {
      const isShelved = firstMatch(shelved, wanted, (project) => project.id, [(project) => project.slug, (project) => project.name]).length > 0;
      (isShelved ? kept : unknown).push(wanted);
    } else if (taken.has(found.id)) repeated.push(wanted);
    else {
      taken.add(found.id);
      ordered.push(found);
    }
  }
  // An archived project is not in the order at all, so it is not missing from it.
  const missing = active.filter((project) => !taken.has(project.id)).map((project) => project.slug);
  const wrong = [
    ...(unknown.length === 0 ? [] : [`unknown: ${unknown.join(", ")}`]),
    ...(kept.length === 0 ? [] : [`archived: ${kept.join(", ")} (it keeps its place)`]),
    ...(repeated.length === 0 ? [] : [`repeated: ${repeated.join(", ")}`]),
    ...(missing.length === 0 ? [] : [`missing: ${missing.join(", ")}`]),
  ];
  if (wrong.length > 0) {
    throw new Error(`every project in this workspace that is not archived has to be named exactly once: ${wrong.join("; ")}`);
  }
  return ordered;
};
